import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { EmbeddingProvider } from "./embeddings.js";

interface CacheFile {
  /** Bump if the on-disk format ever changes shape, to invalidate old caches safely. */
  version: 1;
  entries: Record<string, number[]>;
}

/**
 * Wraps any EmbeddingProvider with a content-hash-keyed, on-disk cache.
 * A chunk's text is hashed (sha256); if that exact text was embedded before,
 * the stored vector is reused and the underlying provider is never called
 * for it. This is what makes repeated runs on a mostly-unchanged repo cheap:
 * only genuinely new or edited chunks get sent to the embedding API.
 */
export class CachingEmbeddingProvider implements EmbeddingProvider {
  private cache: Map<string, number[]>;
  private dirty = false;

  constructor(
    private inner: EmbeddingProvider,
    private cachePath: string
  ) {
    this.cache = loadCache(cachePath);
  }

  async embed(texts: string[]): Promise<number[][]> {
    const hashes = texts.map(hashText);
    const results: (number[] | undefined)[] = hashes.map((h) => this.cache.get(h));

    const missIndices: number[] = [];
    const missTexts: string[] = [];
    results.forEach((r, i) => {
      if (r === undefined) {
        missIndices.push(i);
        missTexts.push(texts[i]);
      }
    });

    if (missTexts.length > 0) {
      const fresh = await this.inner.embed(missTexts);
      missIndices.forEach((idx, j) => {
        results[idx] = fresh[j];
        this.cache.set(hashes[idx], fresh[j]);
      });
      this.dirty = true;
      this.save();
    }

    return results as number[][];
  }

  /** Number of cache entries currently held (for diagnostics/tests). */
  size(): number {
    return this.cache.size;
  }

  private save(): void {
    if (!this.dirty) return;
    const file: CacheFile = { version: 1, entries: Object.fromEntries(this.cache) };
    writeFileSync(this.cachePath, JSON.stringify(file), "utf8");
    this.dirty = false;
  }
}

function hashText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function loadCache(cachePath: string): Map<string, number[]> {
  if (!existsSync(cachePath)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf8")) as CacheFile;
    if (raw.version !== 1 || !raw.entries) return new Map();
    return new Map(Object.entries(raw.entries));
  } catch {
    // Corrupt or unreadable cache — treat as empty rather than failing the run.
    return new Map();
  }
}
