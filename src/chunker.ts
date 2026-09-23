import { readFileSync } from "node:fs";
import { join } from "node:path";

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
 * Small files become a single whole-file chunk; larger files are split into
 * overlapping line windows so relevant sections can be ranked independently
 * without losing the surrounding lines that give them meaning.
 */
export function chunkFile(root: string, relPath: string, options: ChunkOptions = {}): Chunk[] {
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

  return splitIntoWindows(relPath, lines, opts);
}

function splitIntoWindows(
  relPath: string,
  lines: string[],
  opts: Required<ChunkOptions>
): Chunk[] {
  const chunks: Chunk[] = [];
  const step = Math.max(1, opts.windowLines - opts.overlapLines);

  for (let start = 0; start < lines.length; start += step) {
    const end = Math.min(start + opts.windowLines, lines.length);
    chunks.push({
      filePath: relPath,
      startLine: start + 1,
      endLine: end,
      text: lines.slice(start, end).join("\n"),
      isWholeFile: false,
    });
    if (end === lines.length) break;
  }

  return chunks;
}

/** Convenience: chunk many files at once. */
export function chunkFiles(root: string, relPaths: string[], options: ChunkOptions = {}): Chunk[] {
  return relPaths.flatMap((relPath) => chunkFile(root, relPath, options));
}
