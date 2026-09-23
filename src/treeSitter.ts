import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "web-tree-sitter";

/**
 * Shared tree-sitter setup (WASM grammar loading, parser construction) used
 * by both astImportGraph.ts and astChunker.ts -- kept in one place so the
 * two features can't drift on which grammar file backs which extension, and
 * so the WASM runtime is only initialized once per process regardless of
 * which feature triggers it first.
 */

export const WASM_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "wasm");

export const GRAMMAR_BY_EXT: Record<string, string> = {
  ".js": "tree-sitter-javascript.wasm",
  ".jsx": "tree-sitter-javascript.wasm",
  ".mjs": "tree-sitter-javascript.wasm",
  ".cjs": "tree-sitter-javascript.wasm",
  ".ts": "tree-sitter-typescript.wasm",
  ".tsx": "tree-sitter-tsx.wasm",
  ".py": "tree-sitter-python.wasm",
};

let initPromise: Promise<void> | undefined;
const languageCache = new Map<string, Parser.Language>();

function ensureInit(): Promise<void> {
  if (!initPromise) initPromise = Parser.init();
  return initPromise;
}

export async function loadLanguage(wasmFile: string): Promise<Parser.Language> {
  let lang = languageCache.get(wasmFile);
  if (lang) return lang;
  await ensureInit();
  lang = await Parser.Language.load(join(WASM_DIR, wasmFile));
  languageCache.set(wasmFile, lang);
  return lang;
}

// One Parser instance per grammar, reused across every file parsed with
// that grammar, rather than constructing (and setLanguage-ing) a fresh one
// per file. web-tree-sitter's parser is fully reusable across parse() calls
// as long as the same language stays set, and at repo scale (thousands of
// files) skipping that repeated construction is measurable.
const parserCache = new Map<string, Parser>();

async function getParser(wasmFile: string): Promise<{ parser: Parser; lang: Parser.Language }> {
  const lang = await loadLanguage(wasmFile);
  let parser = parserCache.get(wasmFile);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(lang);
    parserCache.set(wasmFile, parser);
  }
  return { parser, lang };
}

/** Parse `text` as `ext`'s language. Returns null if there's no grammar for that extension. */
export async function parseAs(text: string, ext: string): Promise<{ tree: Parser.Tree; lang: Parser.Language } | null> {
  const wasmFile = GRAMMAR_BY_EXT[ext];
  if (!wasmFile) return null;
  const { parser, lang } = await getParser(wasmFile);
  const tree = parser.parse(text);
  return { tree, lang };
}

// Compiling a tree-sitter query (parsing its S-expression source into a
// matcher) is real, measurable work -- NOT free like constructing a regex
// literal. Caching by (grammar, query source) matters at repo scale: found
// via profiling a 7,000+ file real-world repo, where recompiling the same
// static query for every single file (instead of once) accounted for the
// overwhelming majority of the import graph's build time (34s of a 50s
// total run -- multiple seconds saved per thousand files once cached).
const queryCache = new Map<string, Parser.Query>();

export function getQuery(lang: Parser.Language, wasmFile: string, source: string): Parser.Query {
  const cacheKey = `${wasmFile}::${source}`;
  let query = queryCache.get(cacheKey);
  if (!query) {
    query = lang.query(source);
    queryCache.set(cacheKey, query);
  }
  return query;
}
