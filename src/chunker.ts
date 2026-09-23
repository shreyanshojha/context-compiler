import { readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { buildAstChunks } from "./astChunker.js";

export interface Chunk {
  /** Repo-relative file path this chunk came from. */
  filePath: string;
  /** 1-indexed, inclusive line range within the file. */
  startLine: number;
  endLine: number;
  /** The chunk's raw text. */
  text: string;
  /** True if this chunk is the entire file. */
  isWholeFile: boolean;
}

export interface ChunkOptions {
  /** Files at or below this many lines are kept as one whole-file chunk. */
  wholeFileLineThreshold?: number;
  /** Line-window size used to split larger files. */
  windowLines?: number;
  /** Overlap between consecutive windows, in lines. */
  overlapLines?: number;
}

const DEFAULTS: Required<ChunkOptions> = {
  wholeFileLineThreshold: 120,
  windowLines: 120,
  overlapLines: 20,
};

/**
 * Splits text into lines the way a human counting lines would, not the way
 * `String.split("\n")` alone does: a file ending in a trailing newline (the
 * overwhelming majority of real source files) otherwise produces one extra
 * synthetic "line" -- an empty string past the real end of the file -- which
 * both inflates every reported endLine by one and, worse, can surface as its
 * own separate near-empty chunk when the segment before it in the packing
 * pass is already at windowLines capacity and can't absorb it. Found via a
 * real-world stress test against Angular's core/common/forms packages: 43
 * chunks across the run were nothing but that single phantom blank line.
 * Stripping exactly one trailing empty element when the text actually ends
 * in "\n" removes only that artifact -- genuine blank lines the author left
 * before EOF are never touched, since split() only ever adds the one
 * synthetic entry regardless of how many real blank lines precede it.
 */
export function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (text.endsWith("\n")) lines.pop();
  return lines;
}

/**
 * Read a file and split it into one or more chunks.
 * Small files become a single whole-file chunk. Larger files in a language
 * with a tree-sitter grammar (JS/TS/TSX/Python) are split at function/class
 * boundaries where possible, so a function doesn't get cut in half across
 * two chunks -- see astChunker.ts. Anything else (unsupported language, no
 * grammar available, no real boundaries in the file) falls back to fixed-
 * size overlapping line windows, same as before.
 */
export async function chunkFile(root: string, relPath: string, options: ChunkOptions = {}): Promise<Chunk[]> {
  const opts = { ...DEFAULTS, ...options };
  const absPath = join(root, relPath);
  const text = readFileSync(absPath, "utf8");
  const lines = splitLines(text);

  if (lines.length <= opts.wholeFileLineThreshold) {
    return [
      {
        filePath: relPath,
        startLine: 1,
        endLine: lines.length,
        text,
        isWholeFile: true,
      },
    ];
  }

  let chunks: Chunk[] | null = null;
  try {
    chunks = await buildAstChunks(text, extname(relPath).toLowerCase(), relPath, opts);
  } catch {
    // Grammar failed to load or the file didn't actually parse as its
    // extension's language -- fall through to plain line-window splitting
    // rather than failing the whole run over one file's chunking.
  }
  chunks ??= splitLineRangeIntoWindows(relPath, lines, 1, lines.length, opts);

  return dropEmptyChunks(chunks);
}

/**
 * A leftover filler segment that's nothing but blank lines (or, previously,
 * comment-only stretches too small to pack with a neighbor -- see the
 * windowLines-capacity note on packSegments in astChunker.ts) still shows up
 * on real code from time to time: found via a stress test against Django's
 * db/forms/core packages, five two-line chunks that were nothing but a
 * blank-line gap between two class members whose neighboring chunk was
 * already at windowLines capacity and couldn't absorb it. A chunk with no
 * actual content is worse than not existing -- it still costs an embedding
 * call and a slot in the budget for zero information -- so it's dropped
 * here rather than patched at each place a filler segment can originate.
 * The one-chunk-minimum guard keeps a genuinely all-blank file from ending
 * up with zero chunks.
 */
function dropEmptyChunks(chunks: Chunk[]): Chunk[] {
  if (chunks.length <= 1) return chunks;
  const nonEmpty = chunks.filter((c) => c.text.trim().length > 0);
  return nonEmpty.length > 0 ? nonEmpty : chunks;
}

/**
 * Split the 1-indexed, inclusive line range [startLine, endLine] of `lines`
 * into overlapping windows of at most `windowLines`, or return it as a
 * single chunk if it already fits. Used both for whole-file fallback
 * splitting and, by astChunker.ts, to sub-split any one boundary-aligned
 * segment (a function, or the filler between two functions) that's still
 * bigger than one window on its own.
 */
export function splitLineRangeIntoWindows(
  filePath: string,
  lines: string[],
  startLine: number,
  endLine: number,
  opts: Required<ChunkOptions>
): Chunk[] {
  if (endLine - startLine + 1 <= opts.windowLines) {
    return [
      {
        filePath,
        startLine,
        endLine,
        text: lines.slice(startLine - 1, endLine).join("\n"),
        isWholeFile: false,
      },
    ];
  }

  const chunks: Chunk[] = [];
  const step = Math.max(1, opts.windowLines - opts.overlapLines);

  for (let start = startLine; start <= endLine; start += step) {
    const end = Math.min(start + opts.windowLines - 1, endLine);
    chunks.push({
      filePath,
      startLine: start,
      endLine: end,
      text: lines.slice(start - 1, end).join("\n"),
      isWholeFile: false,
    });
    if (end === endLine) break;
  }

  return chunks;
}

/** Convenience: chunk many files at once. */
export async function chunkFiles(root: string, relPaths: string[], options: ChunkOptions = {}): Promise<Chunk[]> {
  const perFile = await Promise.all(relPaths.map((relPath) => chunkFile(root, relPath, options)));
  return perFile.flat();
}
