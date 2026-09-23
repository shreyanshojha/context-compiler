import { readFileSync, existsSync, statSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { join, relative } from "node:path";
import { createRequire } from "node:module";
import type { Ignore } from "ignore";

// The `ignore` package is CJS with a default-export-shaped .d.ts that
// doesn't line up cleanly with NodeNext + esModuleInterop resolution
// (its default import type resolves to a non-callable namespace). Loading
// it via createRequire sidesteps that mismatch; the type-only import above
// still gives us proper typing for the returned instance.
const require = createRequire(import.meta.url);
const ignoreFactory: (options?: { ignorecase?: boolean }) => Ignore = require("ignore");

/** Directories we never descend into, regardless of .gitignore. */
const ALWAYS_SKIP_DIRS = new Set([".git", "node_modules", ".DS_Store"]);

/**
 * Filenames we never treat as candidate content, regardless of .gitignore.
 * Notably the tool's own embedding cache: without this, the cache file
 * written into the repo after one run becomes a "new file" the walker picks
 * up on the *next* run, silently changing the chunk count and making output
 * non-deterministic between runs on an otherwise-unchanged repo.
 */
const ALWAYS_SKIP_FILES = new Set([".context-compiler-cache.json"]);

/**
 * Extensions treated as binary/non-text; never chunked or embedded. This is
 * a fast path (skips even opening the file) for the common cases, not the
 * only line of defense -- see isBinaryContent below for why an extension
 * list alone isn't enough.
 */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg", ".bmp", ".tiff", ".avif", ".heic",
  ".woff", ".woff2", ".ttf", ".eot", ".otf",
  ".zip", ".tar", ".gz", ".7z", ".dmg", ".iso",
  ".pdf", ".mp4", ".mp3", ".mov", ".wav",
  ".exe", ".dll", ".so", ".dylib", ".wasm", ".class", ".jar", ".o", ".a", ".pyc", ".pyo", ".node",
  ".db", ".sqlite", ".sqlite3", ".bin", ".dat",
  ".lock",
]);

/** Files above this size are skipped even if textual (likely generated/data). */
export const MAX_FILE_BYTES = 512 * 1024; // 512 KB

/** How many leading bytes to inspect when sniffing for binary content. */
const BINARY_SNIFF_BYTES = 8000;

/**
 * Content-based binary detection, used as a fallback behind the extension
 * list above: read up to the first 8,000 bytes and look for a NUL byte, the
 * same heuristic tools like git and `grep -I` use. Genuine text essentially
 * never contains one; almost every real binary format does very early (a
 * WASM module, for instance, opens with the magic bytes `\0asm` -- the very
 * first byte is a NUL).
 *
 * Found necessary via a real-world test with real OpenAI embeddings: this
 * project's own bundled `wasm/*.wasm` tree-sitter grammar files -- not on
 * the extension list at the time -- were being walked as candidate text,
 * read as UTF-8 (producing dense decode garbage, not an error, since
 * `readFileSync(..., "utf8")` never throws on invalid bytes), and chunked
 * like any other file. The garbage was dense enough under BPE tokenization
 * that several resulting chunks exceeded OpenAI's 8,192-token embedding
 * input limit, hard-failing the entire run with an opaque 400 error rather
 * than a clear "skipped binary file" -- and a line-count-based chunking
 * threshold has no way to catch this on its own, since one "line" of binary
 * data can tokenize far denser than 120 lines of real code. An extension
 * list can never be complete (this exact bug is proof), so content
 * sniffing is the actual fix; the extension list stays as a cheap fast path
 * that avoids opening a file at all for the common, unambiguous cases.
 */
function isBinaryContent(absPath: string): boolean {
  let fd: number;
  try {
    fd = openSync(absPath, "r");
  } catch {
    return false; // unreadable here -- let the later real read surface the error
  }
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const bytesRead = readSync(fd, buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}

export interface WalkOptions {
  /** Absolute path to the repo root. */
  root: string;
  /** Extra ignore patterns beyond .gitignore (gitignore syntax). */
  extraIgnores?: string[];
}

/**
 * Walk a repo directory, respecting .gitignore, and return relative paths
 * of candidate text files (binary and oversized files excluded).
 */
export function walkRepo(options: WalkOptions): string[] {
  const { root, extraIgnores = [] } = options;
  const ig = buildIgnore(root, extraIgnores);
  const results: string[] = [];

  walkDir(root, root, ig, results);
  return results.sort();
}

function buildIgnore(root: string, extraIgnores: string[]): Ignore {
  const ig = ignoreFactory();
  const gitignorePath = join(root, ".gitignore");
  if (existsSync(gitignorePath)) {
    ig.add(readFileSync(gitignorePath, "utf8"));
  }
  if (extraIgnores.length > 0) {
    ig.add(extraIgnores);
  }
  return ig;
}

function walkDir(root: string, dir: string, ig: Ignore, results: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return; // unreadable directory (permissions, symlink loop, etc.)
  }

  for (const name of entries) {
    const abs = join(dir, name);
    const rel = relative(root, abs);

    if (ALWAYS_SKIP_DIRS.has(name)) continue;
    if (ALWAYS_SKIP_FILES.has(name)) continue;
    if (rel && ig.ignores(rel)) continue;

    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue; // broken symlink, race condition, etc.
    }

    if (stat.isDirectory()) {
      // .gitignore can match directories with a trailing slash; check that too.
      if (ig.ignores(rel + "/")) continue;
      walkDir(root, abs, ig, results);
    } else if (stat.isFile()) {
      if (isCandidateFile(rel, abs, stat.size)) {
        results.push(rel);
      }
    }
  }
}

function isCandidateFile(relPath: string, absPath: string, sizeBytes: number): boolean {
  if (sizeBytes === 0 || sizeBytes > MAX_FILE_BYTES) return false;
  const ext = extname(relPath);
  if (BINARY_EXTENSIONS.has(ext)) return false;
  if (isBinaryContent(absPath)) return false;
  return true;
}

function extname(path: string): string {
  const idx = path.lastIndexOf(".");
  if (idx <= path.lastIndexOf("/")) return "";
  return path.slice(idx).toLowerCase();
}
