import type Parser from "web-tree-sitter";
import { parseAs } from "./treeSitter.js";
import { splitLineRangeIntoWindows, splitLines, type Chunk, type ChunkOptions } from "./chunker.js";

/**
 * Function/class-boundary-aware chunking for large JS/TS/TSX/Python files,
 * used instead of blind fixed-size line windows when a grammar is available.
 *
 * The problem this solves: a plain line window can (and often does) cut a
 * function in half, splitting it across two chunks that each only get part
 * of the logic -- worse embeddings for both halves, and a coding agent that
 * only receives one half. Aligning chunk boundaries to real syntax means a
 * function or class is either whole in one chunk or, if it's genuinely
 * larger than the window size, deliberately sub-split (still better than an
 * arbitrary cut, since at least the common case -- most functions -- stays
 * intact).
 *
 * Two passes: first split the file into boundary-aligned segments (each
 * function/class is its own segment; everything else is grouped into filler
 * segments between them), then greedily pack consecutive segments back
 * together up to windowLines. The packing pass matters in practice: a file
 * with many small top-level exports (`export const X = 1;`, one-line type
 * aliases, etc.) would otherwise produce one tiny chunk per statement --
 * found on a real-world stress test against axios, where one-line
 * `index.d.ts` declarations were each becoming their own chunk. Packing
 * keeps small boundaries and filler together while still never merging
 * *across* a large function (a segment that alone exceeds windowLines is
 * flushed and sub-split on its own, never combined with a neighbor).
 *
 * A class is just another top-level boundary in that first pass -- but a
 * class that alone exceeds windowLines used to fall straight into the same
 * blind line-window fallback as an oversized function, cutting it apart
 * with no regard for method boundaries. `chunkClassByMembers` below applies
 * the exact same segment-then-pack algorithm one level down, this time
 * over the class's own members (methods, fields, nested classes), so an
 * oversized class still keeps each of its methods whole wherever possible.
 * The recursion is real: a member that is itself an oversized class (a
 * nested class, or `class Foo { ... }` big enough to need it) gets the same
 * treatment again, one level deeper.
 */

const JS_BOUNDARY_TYPES = new Set([
  "function_declaration",
  "class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "export_statement",
]);

const PY_BOUNDARY_TYPES = new Set(["function_definition", "class_definition", "decorated_definition"]);

// Class-body member types actually produced by the grammars in use (verified
// by parsing sample code, not guessed from docs): tree-sitter-javascript
// calls a class field `field_definition`; tree-sitter-typescript (and by
// extension tree-sitter-tsx) calls the *same* syntax `public_field_definition`
// regardless of its real visibility (a `#private` field is still that node
// type, just with a `private_property_identifier` child) -- both names are
// included so plain-JS and TS/TSX files are handled the same way.
const JS_CLASS_MEMBER_TYPES = new Set([
  "method_definition",
  "field_definition",
  "public_field_definition",
  "class_static_block",
  "abstract_method_signature",
  // A TS overload group -- several signature-only declarations followed by
  // one real implementation, e.g. `get(url: string): Observable<Object>;`
  // repeated with different parameter lists before the actual `get(...) {
  // ... }` -- represents each signature as its own `method_signature` node,
  // distinct from `method_definition`. Without this, a real-world file
  // found on a stress test against Angular's HttpClient (many heavily
  // overloaded, heavily-documented methods) treated every signature as
  // unclassified filler; the JSDoc block above each one is often 20-90
  // lines, so several of these in a row blew past windowLines as raw
  // unaligned filler and fell back to a blind sliding-window cut -- the
  // exact problem class-member splitting exists to avoid.
  "method_signature",
]);

const PY_CLASS_MEMBER_TYPES = new Set(["function_definition", "decorated_definition", "class_definition"]);

const JS_CLASS_NODE_TYPES = new Set(["class_declaration", "class"]); // "class" is an anonymous class *expression*, e.g. `const Foo = class { ... }`

/**
 * A plain `const foo = 1` isn't worth its own chunk, but `const foo = () =>
 * {...}` is a real function definition written with `const` syntax -- treat
 * it as a boundary only when its declarator's value is actually a function.
 */
function isFunctionValuedDeclaration(node: Parser.SyntaxNode): boolean {
  if (node.type !== "lexical_declaration" && node.type !== "variable_declaration") return false;
  return node.descendantsOfType(["arrow_function", "function_expression"]).length > 0;
}

/** Same idea as above, for `const Foo = class { ... }` -- an anonymous class expression assigned to a variable. */
function isClassValuedDeclaration(node: Parser.SyntaxNode): boolean {
  if (node.type !== "lexical_declaration" && node.type !== "variable_declaration") return false;
  return node.descendantsOfType(["class"]).length > 0;
}

function isBoundary(node: Parser.SyntaxNode, ext: string): boolean {
  if (ext === ".py") return PY_BOUNDARY_TYPES.has(node.type);
  return JS_BOUNDARY_TYPES.has(node.type) || isFunctionValuedDeclaration(node) || isClassValuedDeclaration(node);
}

function isClassMember(node: Parser.SyntaxNode, ext: string): boolean {
  return ext === ".py" ? PY_CLASS_MEMBER_TYPES.has(node.type) : JS_CLASS_MEMBER_TYPES.has(node.type);
}

/**
 * Given a node that was flagged as a boundary (which may be a wrapper --
 * `export class Foo {}`, `export default class {}`, `const Foo = class {}`,
 * or Python's `@decorator\nclass Foo:`), find the actual class-like node
 * inside it. Returns null for a boundary that isn't a class at all (an
 * ordinary function, interface, etc.) -- the caller falls back to plain
 * line-window splitting in that case, same as before this existed.
 */
function findClassLikeNode(node: Parser.SyntaxNode, ext: string): Parser.SyntaxNode | null {
  if (ext === ".py") {
    if (node.type === "class_definition") return node;
    if (node.type === "decorated_definition") {
      return node.namedChildren.find((c) => c.type === "class_definition") ?? null;
    }
    return null;
  }

  if (JS_CLASS_NODE_TYPES.has(node.type)) return node;

  // export_statement wraps a class_declaration (and, for a decorated class,
  // a preceding decorator sibling); lexical_declaration/variable_declaration
  // wrap a variable_declarator whose value is the class expression.
  for (const child of node.namedChildren) {
    if (JS_CLASS_NODE_TYPES.has(child.type)) return child;
    if (child.type === "variable_declarator") {
      const value = child.childForFieldName("value");
      if (value && JS_CLASS_NODE_TYPES.has(value.type)) return value;
    }
  }
  return null;
}

/** The class_body (JS/TS) or block (Python) node holding a class's members. */
function getClassBodyNode(classNode: Parser.SyntaxNode, ext: string): Parser.SyntaxNode | null {
  const viaField = classNode.childForFieldName("body");
  if (viaField) return viaField;
  const bodyTypes = ext === ".py" ? ["block"] : ["class_body"];
  return classNode.namedChildren.find((c) => bodyTypes.includes(c.type)) ?? null;
}

interface Segment {
  startLine: number; // 1-indexed, inclusive
  endLine: number;
  /**
   * Set only when this segment corresponds to exactly one boundary node
   * (never for filler, and cleared by packSegments the moment a segment
   * gets merged with a neighbor) -- that's what lets chunksForSegment tell
   * "this oversized range IS one function/class" apart from "this oversized
   * range is several small things packed together that just happen to add
   * up past windowLines" -- only the former is worth sub-splitting by
   * syntax rather than by raw line count.
   */
  node?: Parser.SyntaxNode;
}

/**
 * Attempt boundary-aware chunking. Returns null (caller falls back to plain
 * line-window splitting) when there's no grammar for this extension, the
 * file fails to parse, or it parses but has no recognizable boundaries at
 * all (e.g. a config-like file of flat top-level statements) -- in the
 * no-boundaries case the caller's fallback produces an identical result
 * anyway, so returning null there is just avoiding a needless second pass.
 */
export async function buildAstChunks(
  text: string,
  ext: string,
  filePath: string,
  opts: Required<ChunkOptions>
): Promise<Chunk[] | null> {
  const parsed = await parseAs(text, ext);
  if (!parsed) return null;

  const lines = splitLines(text);
  const topLevel = parsed.tree.rootNode.namedChildren;
  const boundaryNodes = topLevel.filter((n) => isBoundary(n, ext));
  if (boundaryNodes.length === 0) return null;

  const segments = toSegments(boundaryNodes, 1, lines.length);
  const packed = packSegments(segments, opts.windowLines);

  const chunks: Chunk[] = [];
  for (const seg of packed) chunks.push(...chunksForSegment(seg, lines, ext, filePath, opts));
  return chunks;
}

/**
 * Decides how to render one packed segment into chunks. A segment that's
 * still within windowLines is emitted as-is. One that's oversized *and*
 * still traceable to a single boundary node gets one more chance: if that
 * node is a class, split it again by its own members before falling back
 * to a blind line-window cut for whatever's left over (a member that's
 * itself too big, or a class with no members at all).
 */
function chunksForSegment(
  seg: Segment,
  lines: string[],
  ext: string,
  filePath: string,
  opts: Required<ChunkOptions>
): Chunk[] {
  const size = seg.endLine - seg.startLine + 1;
  if (size > opts.windowLines && seg.node) {
    const classNode = findClassLikeNode(seg.node, ext);
    if (classNode) {
      const memberChunks = chunkClassByMembers(classNode, seg.startLine, seg.endLine, lines, ext, filePath, opts);
      if (memberChunks) return memberChunks;
    }
  }
  return splitLineRangeIntoWindows(filePath, lines, seg.startLine, seg.endLine, opts);
}

/**
 * Re-applies the segment-then-pack algorithm to one class's members instead
 * of the whole file's top level. `rangeStart`/`rangeEnd` are the class's own
 * (absolute, 1-indexed) line span -- covering any leading decorator(s) and
 * the `class Foo extends ... {` signature line as filler before the first
 * member, and the closing `}` as filler after the last. A decorator on an
 * individual member (`@Input() name: string;`, `@HostListener(...)` above a
 * method) is its own AST sibling, *not* nested inside the member it
 * decorates -- it lands in the filler segment immediately before that
 * member, which packSegments then merges forward into the member's segment,
 * so the decorator and what it decorates always end up in the same chunk.
 *
 * Returns null (caller falls back to a plain line-window cut of the whole
 * class) when the class has no body or no recognized members -- an empty
 * class, or a class whose grammar-reported body shape wasn't matched.
 */
function chunkClassByMembers(
  classNode: Parser.SyntaxNode,
  rangeStart: number,
  rangeEnd: number,
  lines: string[],
  ext: string,
  filePath: string,
  opts: Required<ChunkOptions>
): Chunk[] | null {
  const bodyNode = getClassBodyNode(classNode, ext);
  if (!bodyNode) return null;

  const memberNodes = bodyNode.namedChildren.filter((n) => isClassMember(n, ext));
  if (memberNodes.length === 0) return null;

  const segments = toSegments(memberNodes, rangeStart, rangeEnd);
  const packed = packSegments(segments, opts.windowLines);

  const chunks: Chunk[] = [];
  for (const seg of packed) chunks.push(...chunksForSegment(seg, lines, ext, filePath, opts));
  return chunks;
}

/**
 * Partitions [rangeStart, rangeEnd] into contiguous segments: each boundary
 * node is its own (node-tagged) segment, and every line not covered by one
 * is filler. Used both for a whole file's top level (rangeStart=1,
 * rangeEnd=file length) and, by chunkClassByMembers, for one class's member
 * list (rangeStart/rangeEnd = that class's own line span) -- the boundary
 * nodes are always in document order and always fall within the given
 * range, so the same cursor-sweep logic works at either level.
 */
function toSegments(boundaryNodes: Parser.SyntaxNode[], rangeStart: number, rangeEnd: number): Segment[] {
  const segments: Segment[] = [];
  let cursor = rangeStart; // next 1-indexed line not yet assigned to a segment

  for (const node of boundaryNodes) {
    const nodeStart = node.startPosition.row + 1;
    const nodeEnd = node.endPosition.row + 1;
    if (nodeStart > cursor) segments.push({ startLine: cursor, endLine: nodeStart - 1 });
    segments.push({ startLine: nodeStart, endLine: nodeEnd, node });
    cursor = nodeEnd + 1;
  }
  if (cursor <= rangeEnd) segments.push({ startLine: cursor, endLine: rangeEnd });

  return segments;
}

/**
 * Greedily merges consecutive segments so long as the combined line count
 * stays within windowLines. A segment that alone already exceeds
 * windowLines is emitted on its own (chunksForSegment sub-splits it
 * afterward) rather than ever being combined with a neighbor. Merging two
 * segments together means the result no longer maps to a single boundary
 * node, so `node` is cleared on merge -- see the Segment.node doc comment.
 */
function packSegments(segments: Segment[], windowLines: number): Segment[] {
  const packed: Segment[] = [];

  for (const seg of segments) {
    const last = packed[packed.length - 1];
    const mergedSize = last ? seg.endLine - last.startLine + 1 : Infinity;
    if (last && mergedSize <= windowLines) {
      last.endLine = seg.endLine;
      last.node = undefined;
    } else {
      packed.push({ ...seg });
    }
  }

  return packed;
}
