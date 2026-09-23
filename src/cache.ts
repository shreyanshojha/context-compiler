import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { EmbeddingProvider } from "./embeddings.js";

interface CacheFile {
  /** Bump if the on-disk format ever changes shape, to invalidate old caches safely. */
  version: 2;
  entries: Record<string, number[]>;
}

/**
 * Wraps any EmbeddingProvider with a content-hash-keyed, on-disk cache.
 * A chunk's text is hashed (sha256) together with the *provider's own
 * namespace*; if that exact text was already embedded by that same
 * provider/model, the stored vector is reused and the underlying provider is
 * never called for it. This is what makes repeated runs on a mostly-unchanged
 * repo cheap: only genuinely new or edited chunks get sent to the embedding
 * API.
 *
 * Real bug found and fixed (Round 9): the cache key used to be the content
 * hash alone, with no notion of which provider or model produced a stored
 * vector. Found via a real run on the user's own machine: a repo directory
 * was first used for a `--provider fake` demo (FakeEmbeddingProvider, 1024
 * dimensions), which wrote `.context-compiler-cache.json` next to it. The
 * same directory was later reused for a real run with a real OPENAI_API_KEY
 * (OpenAIEmbeddingProvider, 1536 dimensions) -- same files, same content
 * hashes, same cache file. Every unchanged chunk's hash still matched its old
 * entry, so the cache happily handed back 1024-dimension fake vectors
 * side-by-side with fresh 1536-dimension real OpenAI vectors in the very same
 * ranking pass: `Vector length mismatch: 1536 vs 1024`. Nothing about this
 * requires two *different* providers on purpose -- switching `--provider`
 * between runs against the same repo, or a future model-name bump for the
 * same provider, hits the identical failure. Fixed by folding each
 * `EmbeddingProvider`'s own `namespace` (e.g. "openai:text-embedding-3-small")
 * into the hash, so a vector is only ever reused for the exact provider+model
 * that produced it -- a provider/model change now costs a handful of extra
 * embedding calls for previously-cached text, never a crash. The on-disk
 * format version was bumped (1 -> 2) so a cache file written before this fix
 * is discarded outright on load rather than partially matching under the new
 * key scheme.
 */
export class CachingEmbeddingProvider implements EmbeddingProvider {
  private cache: Map<string, number[]>;
  private dirty = false;
  readonly namespace: string;

  constructor(
    private inner: EmbeddingProvider,
    private cachePath: string
  ) {
    this.cache = loadCache(cachePath);
    this.namespace = inner.namespace;
  }

  async embed(texts: string[]): Promise<number[][]> {
    const hashes = texts.map((t) => hashText(this.inner.namespace, t));
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
    const file: CacheFile = { version: 2, entries: Object.fromEntries(this.cache) };
    writeFileSync(this.cachePath, JSON.stringify(file), "utf8");
    this.dirty = false;
  }
}

/**
 * A null byte can never appear in a provider namespace string (they're all
 * short literal identifiers built in this file) or matter to sha256's byte
 * stream, so it's a safe, simple separator that rules out two different
 * (namespace, text) pairs ever concatenating to the same hash input --
 * e.g. namespace "ab" + text "cd" vs namespace "a" + text "bcd".
 */
function hashText(namespace: string, text: string): string {
  return createHash("sha256").update(`${namespace}\0${text}`, "utf8").digest("hex");
}

function loadCache(cachePath: string): Map<string, number[]> {
  if (!existsSync(cachePath)) return new Map();
  try {
    const raw = JSON.parse(readFileSync(cachePath, "utf8")) as CacheFile;
    if (raw.version !== 2 || !raw.entries) return new Map();
    return new Map(Object.entries(raw.entries));
  } catch {
    // Corrupt or unreadable cache — treat as empty rather than failing the run.
    return new Map();
  }
}
