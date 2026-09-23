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
  const lines = text.split("\n");

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

  try {
    const astChunks = await buildAstChunks(text, extname(relPath).toLowerCase(), relPath, opts);
    if (astChunks) return astChunks;
  } catch {
    // Grammar failed to load or the file didn't actually parse as its
    // extension's language -- fall through to plain line-window splitting
    // rather than failing the whole run over one file's chunking.
  }

  return splitLineRangeIntoWindows(relPath, lines, 1, lines.length, opts);
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
