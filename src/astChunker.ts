import type Parser from "web-tree-sitter";
import { parseAs } from "./treeSitter.js";
import { splitLineRangeIntoWindows, type Chunk, type ChunkOptions } from "./chunker.js";

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
 */

const JS_BOUNDARY_TYPES = new Set([
  "function_declaration",
  "class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "export_statement",
]);

const PY_BOUNDARY_TYPES = new Set(["function_definition", "class_definition", "decorated_definition"]);

/**
 * A plain `const foo = 1` isn't worth its own chunk, but `const foo = () =>
 * {...}` is a real function definition written with `const` syntax -- treat
 * it as a boundary only when its declarator's value is actually a function.
 */
function isFunctionValuedDeclaration(node: Parser.SyntaxNode): boolean {
  if (node.type !== "lexical_declaration" && node.type !== "variable_declaration") return false;
  return node.descendantsOfType(["arrow_function", "function_expression"]).length > 0;
}

function isBoundary(node: Parser.SyntaxNode, ext: string): boolean {
  if (ext === ".py") return PY_BOUNDARY_TYPES.has(node.type);
  return JS_BOUNDARY_TYPES.has(node.type) || isFunctionValuedDeclaration(node);
}

interface Segment {
  startLine: number; // 1-indexed, inclusive
  endLine: number;
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

  const lines = text.split("\n");
  const topLevel = parsed.tree.rootNode.namedChildren;
  const boundaryNodes = topLevel.filter((n) => isBoundary(n, ext));
  if (boundaryNodes.length === 0) return null;

  const segments = toSegments(boundaryNodes, lines.length);
  const packed = packSegments(segments, opts.windowLines);

  const chunks: Chunk[] = [];
  for (const seg of packed) {
    chunks.push(...splitLineRangeIntoWindows(filePath, lines, seg.startLine, seg.endLine, opts));
  }
  return chunks;
}

/** Partitions the whole file into contiguous segments: each boundary node is its own segment, and every line not covered by one is filler. */
function toSegments(boundaryNodes: Parser.SyntaxNode[], totalLines: number): Segment[] {
  const segments: Segment[] = [];
  let cursor = 1; // next 1-indexed line not yet assigned to a segment

  for (const node of boundaryNodes) {
    const nodeStart = node.startPosition.row + 1;
    const nodeEnd = node.endPosition.row + 1;
    if (nodeStart > cursor) segments.push({ startLine: cursor, endLine: nodeStart - 1 });
    segments.push({ startLine: nodeStart, endLine: nodeEnd });
    cursor = nodeEnd + 1;
  }
  if (cursor <= totalLines) segments.push({ startLine: cursor, endLine: totalLines });

  return segments;
}

/**
 * Greedily merges consecutive segments so long as the combined line count
 * stays within windowLines. A segment that alone already exceeds
 * windowLines is emitted on its own (splitLineRangeIntoWindows sub-splits it
 * afterward) rather than ever being combined with a neighbor.
 */
function packSegments(segments: Segment[], windowLines: number): Segment[] {
  const packed: Segment[] = [];

  for (const seg of segments) {
    const last = packed[packed.length - 1];
    const mergedSize = last ? seg.endLine - last.startLine + 1 : Infinity;
    if (last && mergedSize <= windowLines) {
      last.endLine = seg.endLine;
    } else {
      packed.push({ ...seg });
    }
  }

  return packed;
}
