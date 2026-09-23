import { readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "web-tree-sitter";
import { ImportGraph } from "./importGraph.js";

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

const WASM_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "wasm");

const GRAMMAR_BY_EXT: Record<string, string> = {
  ".js": "tree-sitter-javascript.wasm",
  ".jsx": "tree-sitter-javascript.wasm",
  ".mjs": "tree-sitter-javascript.wasm",
  ".cjs": "tree-sitter-javascript.wasm",
  ".ts": "tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-tsx.wasm",
  ".py": "tree-sitter-python.wasm",
};

// Matches import ... from '...'; export ... from '...'; require('...'); import('...')
// across JS, TS, and TSX -- all four share these node shapes since the TS/TSX
// grammars are supersets of the JS grammar for this syntax.
const JS_IMPORT_QUERY = `
(import_statement source: (string (string_fragment) @spec))
(export_statement source: (string (string_fragment) @spec))
(call_expression
  function: (identifier) @fn
  arguments: (arguments (string (string_fragment) @spec))
  (#eq? @fn "require"))
(call_expression
  function: (import)
  arguments: (arguments (string (string_fragment) @spec)))
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

let initPromise: Promise<void> | undefined;
const languageCache = new Map<string, Parser.Language>();

async function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  return initPromise;
}

async function loadLanguage(wasmFile: string): Promise<Parser.Language> {
  let lang = languageCache.get(wasmFile);
  if (lang) return lang;
  await ensureInit();
  lang = await Parser.Language.load(join(WASM_DIR, wasmFile));
  languageCache.set(wasmFile, lang);
  return lang;
}

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

  for (const relPath of relPaths) {
    const ext = extname(relPath);
    const wasmFile = GRAMMAR_BY_EXT[ext];
    if (!wasmFile) continue;

    let text: string;
    try {
      text = readFileSync(join(root, relPath), "utf8");
    } catch {
      continue;
    }

    let specifiers: string[];
    try {
      specifiers = ext === ".py" ? await extractPythonImports(text, relPath) : await extractJsImports(text, wasmFile);
    } catch {
      // Grammar failed to load, or the file doesn't actually parse as this
      // language (e.g. a .js file with syntax the grammar can't handle) --
      // skip this file's edges rather than aborting the whole graph build.
      continue;
    }

    for (const spec of specifiers) {
      const resolved = resolveImport(relPath, spec, knownFiles);
      if (resolved) graph.addEdge(relPath, resolved);
    }
  }

  return graph;
}

async function extractJsImports(text: string, wasmFile: string): Promise<string[]> {
  const lang = await loadLanguage(wasmFile);
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(text);
  const query = lang.query(JS_IMPORT_QUERY);

  const specifiers: string[] = [];
  for (const match of query.matches(tree.rootNode)) {
    for (const capture of match.captures) {
      if (capture.name === "spec") specifiers.push(capture.node.text);
    }
  }
  return specifiers;
}

async function extractPythonImports(text: string, relPath: string): Promise<string[]> {
  const lang = await loadLanguage(GRAMMAR_BY_EXT[".py"]);
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(text);

  const specifiers: string[] = [];

  for (const queryString of [PY_PLAIN_IMPORT_QUERY, PY_FROM_IMPORT_QUERY]) {
    const query = lang.query(queryString);
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

function resolveImport(fromFile: string, specifier: string, knownFiles: Set<string>): string | null {
  const bases: string[] = [];

  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    bases.push(normalize(join(dirname(fromFile), specifier)));
  } else {
    bases.push(normalize(specifier));
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
