import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
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

/** Extensions treated as binary/non-text; never chunked or embedded. */
const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".svg",
  ".woff", ".woff2", ".ttf", ".eot",
  ".zip", ".tar", ".gz", ".7z",
  ".pdf", ".mp4", ".mp3", ".mov", ".wav",
  ".exe", ".dll", ".so", ".dylib",
  ".lock",
]);

/** Files above this size are skipped even if textual (likely generated/data). */
export const MAX_FILE_BYTES = 512 * 1024; // 512 KB

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
      if (isCandidateFile(rel, stat.size)) {
        results.push(rel);
      }
    }
  }
}

function isCandidateFile(relPath: string, sizeBytes: number): boolean {
  if (sizeBytes === 0 || sizeBytes > MAX_FILE_BYTES) return false;
  const ext = extname(relPath);
  if (BINARY_EXTENSIONS.has(ext)) return false;
  return true;
}

function extname(path: string): string {
  const idx = path.lastIndexOf(".");
  if (idx <= path.lastIndexOf("/")) return "";
  return path.slice(idx).toLowerCase();
}
