import { readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import type Parser from "web-tree-sitter";
import { ImportGraph } from "./importGraph.js";
import { GRAMMAR_BY_EXT, parseAs, getQuery } from "./treeSitter.js";
import { loadPathAliases, aliasCandidates, type PathAliasMap } from "./pathAliases.js";

/**
 * Real-parser import extraction (JS/TS/TSX/Python), replacing the old
 * regex-based scan for these languages. Uses web-tree-sitter (WASM) rather
 * than native tree-sitter bindings specifically to avoid native compilation
 * and cross-grammar peer-dependency/ABI conflicts -- see the wasm/ dir.
 *
 * Correctness win over the regex this replaces: the regex matched any
 * `require(...)`/`import(...)`-shaped text anywhere in a file, including
 * inside strings, comments, or a function merely *named* `require`. The AST
 * only matches real import/require/export-from syntax.
 */

// Matches import ... from '...'; require('...'); import('...') -- across JS,
// TS, and TSX, since the TS/TSX grammars are supersets of the JS grammar for
// this syntax. Deliberately does NOT include `export ... from '...'` -- that's
// a re-export, tracked separately below so barrel files (a file that only
// re-exports another file's contents) can be followed transitively rather
// than treated as a dead end. See applyBarrelClosure.
const JS_IMPORT_QUERY = `
(import_statement source: (string (string_fragment) @spec))
(call_expression
  function: (identifier) @fn
  arguments: (arguments (string (string_fragment) @spec))
  (#eq? @fn "require"))
(call_expression
  function: (import)
  arguments: (arguments (string (string_fragment) @spec)))
`;

// `export * from '...'` / `export { x } from '...'` -- a re-export, not a
// use of the imported names by this file. Kept separate from JS_IMPORT_QUERY
// specifically so a barrel file's re-exports can be followed transitively.
const JS_REEXPORT_QUERY = `
(export_statement source: (string (string_fragment) @spec))
`;

// Plain `import x`, `import x.y`, `import x as y` -- captures the dotted
// module path as written (dots converted to '/' later, same as the old regex).
const PY_PLAIN_IMPORT_QUERY = `
(import_statement name: (dotted_name) @spec)
(import_statement name: (aliased_import name: (dotted_name) @spec))
`;

// `from x import y` / `from x.y import z` -- only the absolute-looking form
// (module_name is a plain dotted_name, not a relative_import). The relative
// form (`from . import x`, `from .x import y`) needs the leading dots
// counted, which a declarative query can't do -- handled by walking the tree
// directly in extractPythonRelativeImports below.
const PY_FROM_IMPORT_QUERY = `
(import_from_statement module_name: (dotted_name) @spec)
`;

/**
 * Build an import graph using real parsing for JS/TS/TSX/Python, falling
 * back silently to "no edges for this file" if its grammar can't be loaded
 * or the file fails to parse (malformed source, unsupported syntax) --
 * consistent with the old regex behavior of never failing the whole run
 * over one unparseable file.
 */
export async function buildAstImportGraph(root: string, relPaths: string[]): Promise<ImportGraph> {
  const graph = new ImportGraph();
  const knownFiles = new Set(relPaths);
  const aliasMap = loadPathAliases(root);
  // Directed: file -> the file(s) it re-exports from ("export * from './x'").
  // Used after the main pass to follow barrel files transitively -- see
  // applyBarrelClosure's own comment for why a direct edge alone isn't enough.
  const reexportAdjacency = new Map<string, string[]>();

  for (const relPath of relPaths) {
    const ext = extname(relPath);
    if (!GRAMMAR_BY_EXT[ext]) continue;

    let text: string;
    try {
      text = readFileSync(join(root, relPath), "utf8");
    } catch {
      continue;
    }

    let imports: string[];
    let reexports: string[];
    try {
      if (ext === ".py") {
        imports = await extractPythonImports(text, relPath);
        reexports = [];
      } else {
        ({ imports, reexports } = await extractJsImports(text, ext));
      }
    } catch {
      // Grammar failed to load, or the file doesn't actually parse as this
      // language (e.g. a .js file with syntax the grammar can't handle) --
      // skip this file's edges rather than aborting the whole graph build.
      continue;
    }

    for (const spec of imports) {
      const resolved = resolveImport(relPath, spec, knownFiles, aliasMap);
      if (resolved) graph.addEdge(relPath, resolved);
    }
    for (const spec of reexports) {
      const resolved = resolveImport(relPath, spec, knownFiles, aliasMap);
      if (resolved) {
        graph.addEdge(relPath, resolved);
        const list = reexportAdjacency.get(relPath);
        if (list) list.push(resolved);
        else reexportAdjacency.set(relPath, [resolved]);
      }
    }
  }

  applyBarrelClosure(graph, reexportAdjacency, relPaths);
  return graph;
}

/**
 * A barrel file (`export * from './deepImpl'`) creates a direct edge to
 * deepImpl.ts, but a *consumer* of the barrel only gets a direct edge to the
 * barrel itself -- one hop short of the file that actually has the code. The
 * ranker's structural boost only checks direct edges (see ranker.ts's
 * isConnected usage), so without this, importing through a barrel got none
 * of the structural signal a direct import would have. This closes that gap:
 * anything connected to a barrel also gets connected to whatever the barrel
 * (transitively, through a chain of barrels) ultimately re-exports.
 *
 * A cycle guard makes this safe against `export * from` cycles, which are
 * invalid JS but shouldn't be able to hang the graph build over malformed
 * input either way.
 */
function applyBarrelClosure(
  graph: ImportGraph,
  reexportAdjacency: Map<string, string[]>,
  relPaths: string[]
): void {
  if (reexportAdjacency.size === 0) return;

  const closureCache = new Map<string, Set<string>>();
  function closureOf(file: string, visiting: Set<string>): Set<string> {
    const cached = closureCache.get(file);
    if (cached) return cached;
    if (visiting.has(file)) return new Set();

    visiting.add(file);
    const result = new Set<string>();
    for (const next of reexportAdjacency.get(file) ?? []) {
      result.add(next);
      for (const deeper of closureOf(next, visiting)) result.add(deeper);
    }
    visiting.delete(file);
    closureCache.set(file, result);
    return result;
  }

  for (const file of relPaths) {
    for (const neighbor of [...graph.neighbors(file)]) {
      const closure = closureOf(neighbor, new Set());
      for (const target of closure) {
        if (target !== file) graph.addEdge(file, target);
      }
    }
  }
}

async function extractJsImports(text: string, ext: string): Promise<{ imports: string[]; reexports: string[] }> {
  const parsed = await parseAs(text, ext);
  if (!parsed) return { imports: [], reexports: [] };
  const { tree, lang } = parsed;

  const imports: string[] = [];
  const importQuery = getQuery(lang, GRAMMAR_BY_EXT[ext], JS_IMPORT_QUERY);
  for (const match of importQuery.matches(tree.rootNode)) {
    for (const capture of match.captures) {
      if (capture.name === "spec") imports.push(capture.node.text);
    }
  }

  const reexports: string[] = [];
  const reexportQuery = getQuery(lang, GRAMMAR_BY_EXT[ext], JS_REEXPORT_QUERY);
  for (const match of reexportQuery.matches(tree.rootNode)) {
    for (const capture of match.captures) {
      if (capture.name === "spec") reexports.push(capture.node.text);
    }
  }

  return { imports, reexports };
}

async function extractPythonImports(text: string, relPath: string): Promise<string[]> {
  const parsed = await parseAs(text, ".py");
  if (!parsed) return [];
  const { tree, lang } = parsed;

  const specifiers: string[] = [];

  for (const queryString of [PY_PLAIN_IMPORT_QUERY, PY_FROM_IMPORT_QUERY]) {
    const query = getQuery(lang, GRAMMAR_BY_EXT[".py"], queryString);
    for (const match of query.matches(tree.rootNode)) {
      for (const capture of match.captures) {
        if (capture.name === "spec") specifiers.push(capture.node.text.replace(/\./g, "/"));
      }
    }
  }

  specifiers.push(...extractPythonRelativeImports(tree.rootNode, relPath));
  return specifiers;
}

/**
 * Handles `from . import x`, `from .x import y`, `from ..x.y import z` --
 * cases a declarative query can't resolve because the number of leading
 * dots changes which directory the import is relative to, and a bare
 * `from . import helpers` has no dotted_name at all (the imported *names*
 * are themselves the modules: `helpers` -> `<package>/helpers.py`).
 *
 * Returns specifiers already expressed as slash-paths relative to the
 * importing file's directory (e.g. "./app", "../pkg/sub"), which
 * resolveImport's relative-path branch already knows how to handle.
 */
function extractPythonRelativeImports(root: Parser.SyntaxNode, relPath: string): string[] {
  const specifiers: string[] = [];
  const fromDir = dirname(relPath);

  walk(root, (node) => {
    if (node.type !== "import_from_statement") return;
    const moduleNameNode = node.childForFieldName("module_name");
    if (!moduleNameNode || moduleNameNode.type !== "relative_import") return;

    const importPrefix = moduleNameNode.children.find((c) => c.type === "import_prefix");
    const dotCount = importPrefix ? importPrefix.text.length : 1;
    const dottedName = moduleNameNode.children.find((c) => c.type === "dotted_name");

    // One dot = the current package (same directory as this file). Each
    // additional dot goes up one more directory level.
    let baseDir = fromDir;
    for (let i = 1; i < dotCount; i++) baseDir = dirname(baseDir);

    if (dottedName) {
      // from .app import Flask  /  from ..pkg.sub import x
      specifiers.push(joinAsSpecifier(baseDir, dottedName.text.replace(/\./g, "/")));
    } else {
      // from . import helpers[, other]  -- the imported names are the
      // modules themselves, each living directly in baseDir. There can be
      // several comma-separated "name" fields, and the SDK only exposes
      // childForFieldName (singular), so a cursor walk collects them all.
      for (const nameField of childrenForField(node, "name")) {
        const plain = nameField.type === "aliased_import" ? nameField.childForFieldName("name") : nameField;
        if (plain && plain.type === "dotted_name") {
          specifiers.push(joinAsSpecifier(baseDir, plain.text.replace(/\./g, "/")));
        }
      }
    }
  });

  return specifiers;
}

/** All children of `node` whose grammar field name is `fieldName` (there is no plural childForFieldName in this SDK version). */
function childrenForField(node: Parser.SyntaxNode, fieldName: string): Parser.SyntaxNode[] {
  const result: Parser.SyntaxNode[] = [];
  const cursor = node.walk();
  if (cursor.gotoFirstChild()) {
    do {
      if (cursor.currentFieldName() === fieldName) result.push(cursor.currentNode());
    } while (cursor.gotoNextSibling());
  }
  cursor.delete();
  return result;
}

/**
 * Builds a repo-root-relative path (e.g. "pkg/app"), deliberately WITHOUT a
 * leading "./" -- resolveImport treats a leading dot as "still relative to
 * the importing file's directory," which these already aren't: baseDir was
 * already walked up from the importing file's directory by the caller, so
 * this is the final path and must go through resolveImport's bare/absolute
 * branch (a plain normalize(), no further joining) or it gets joined twice.
 */
function joinAsSpecifier(baseDir: string, modulePath: string): string {
  return baseDir === "." ? modulePath : `${baseDir}/${modulePath}`;
}

function walk(node: Parser.SyntaxNode, visit: (node: Parser.SyntaxNode) => void): void {
  visit(node);
  for (const child of node.children) walk(child, visit);
}

/**
 * Resolve an import specifier relative to the importing file against the
 * known file set. Only relative/local imports (`./foo`, `../bar`, or a
 * dotted local python module) can resolve -- bare package specifiers
 * ("react", "os") never match anything in the repo and are dropped.
 */
const CANDIDATE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".py", "/index.ts", "/index.js"];

function resolveImport(
  fromFile: string,
  specifier: string,
  knownFiles: Set<string>,
  aliasMap: PathAliasMap | null
): string | null {
  const bases: string[] = [];

  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    bases.push(normalize(join(dirname(fromFile), specifier)));
  } else {
    // Not a relative path -- could be a bare package ("react", never
    // resolvable), a tsconfig-aliased specifier ("@/utils"), or a
    // Python-style absolute local import. Try both the plain repo-root
    // interpretation and every alias pattern that matches; a genuine
    // external package simply won't match anything in either case.
    bases.push(normalize(specifier));
    bases.push(...aliasCandidates(specifier, aliasMap).map(normalize));
  }

  for (const base of bases) {
    for (const ext of CANDIDATE_EXTS) {
      const candidate = normalizeRel(base + ext);
      if (knownFiles.has(candidate)) return candidate;
    }
  }
  return null;
}

function normalizeRel(p: string): string {
  return relative("", normalize(p)).split("\\").join("/");
}

function extname(path: string): string {
  const idx = path.lastIndexOf(".");
  if (idx <= path.lastIndexOf("/")) return "";
  return path.slice(idx).toLowerCase();
}
