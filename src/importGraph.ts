import { readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { buildAstImportGraph } from "./astImportGraph.js";
import { loadPathAliases, aliasCandidates, type PathAliasMap } from "./pathAliases.js";

/**
 * A file-level, undirected adjacency graph built from static import/require
 * statements -- a heuristic signal to nudge ranking, not a compiler.
 */
export class ImportGraph {
  private edges = new Map<string, Set<string>>();

  addEdge(a: string, b: string): void {
    if (a === b) return;
    this.getOrCreate(a).add(b);
    this.getOrCreate(b).add(a);
  }

  neighbors(file: string): Set<string> {
    return this.edges.get(file) ?? new Set();
  }

  isConnected(a: string, b: string): boolean {
    return this.neighbors(a).has(b);
  }

  private getOrCreate(file: string): Set<string> {
    let set = this.edges.get(file);
    if (!set) {
      set = new Set();
      this.edges.set(file, set);
    }
    return set;
  }
}

// Matches: import ... from 'x'; export ... from "x"; require('x'); import('x')
const JS_IMPORT_RE = /(?:from|require\(|import\()\s*['"]([^'"]+)['"]/g;
// Matches: from x import y | from .x import y | import x
const PY_IMPORT_RE = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/gm;

/**
 * Build an import graph for a set of repo-relative files. Uses real parsing
 * (tree-sitter, via astImportGraph.ts) for JS/TS/TSX/Python, which is what
 * actually understands import syntax rather than pattern-matching it --
 * see astImportGraph.ts's header comment for the correctness win this gets
 * over the regex scan (e.g. not matching a function merely named `require`).
 *
 * Falls back to the regex-based scan only if the AST path fails entirely
 * (e.g. web-tree-sitter's WASM runtime can't initialize in this environment)
 * so the structural boost degrades gracefully instead of the whole run
 * failing over an import-graph nicety.
 */
export async function buildImportGraph(root: string, relPaths: string[]): Promise<ImportGraph> {
  try {
    return await buildAstImportGraph(root, relPaths);
  } catch {
    return buildImportGraphRegex(root, relPaths);
  }
}

/**
 * The original regex-based scan, kept as the fallback path above and
 * exported for tests that want to exercise it directly. Deliberately naive:
 * it's a heuristic signal to nudge ranking, not a compiler, and needs to
 * work across languages without per-language tooling.
 */
export function buildImportGraphRegex(root: string, relPaths: string[]): ImportGraph {
  const graph = new ImportGraph();
  const knownFiles = new Set(relPaths);
  const aliasMap = loadPathAliases(root);

  for (const relPath of relPaths) {
    const ext = extname(relPath);
    if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py"].includes(ext)) continue;

    let text: string;
    try {
      text = readFileSync(join(root, relPath), "utf8");
    } catch {
      continue;
    }

    const specifiers = ext === ".py" ? extractPythonImports(text) : extractJsImports(text);
    for (const spec of specifiers) {
      const resolved = resolveImport(relPath, spec, knownFiles, aliasMap);
      if (resolved) graph.addEdge(relPath, resolved);
    }
  }

  return graph;
}

function extractJsImports(text: string): string[] {
  const specifiers: string[] = [];
  for (const match of text.matchAll(JS_IMPORT_RE)) {
    if (match[1]) specifiers.push(match[1]);
  }
  return specifiers;
}

function extractPythonImports(text: string): string[] {
  const specifiers: string[] = [];
  for (const match of text.matchAll(PY_IMPORT_RE)) {
    const spec = match[1] ?? match[2];
    if (spec) specifiers.push(spec.replace(/\./g, "/"));
  }
  return specifiers;
}

/**
 * Resolve an import specifier relative to the importing file against the
 * known file set. Only relative/local imports (`./foo`, `../bar`, or a
 * dotted local python module) can resolve — bare package specifiers
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
    // Relative import: resolve against the importing file's directory.
    bases.push(normalize(join(dirname(fromFile), specifier)));
  } else {
    // Not a relative path — could be a bare package ("react", "os", never
    // resolvable), a tsconfig-aliased specifier ("@/utils"), or a
    // Python-style absolute local import ("pyutils/helpers" after
    // dot-to-slash conversion). Try the repo-root interpretation and every
    // matching alias pattern; a genuine external package won't match either.
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
