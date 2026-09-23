import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CachingEmbeddingProvider } from "../src/cache.js";
import type { EmbeddingProvider } from "../src/embeddings.js";

class CountingProvider implements EmbeddingProvider {
  calls = 0;
  readonly namespace = "counting-test-provider";
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    return texts.map((t) => [t.length, t.length * 2]);
  }
}

/** A minimal stand-in for a real provider whose vectors have a fixed size and a chosen namespace. */
class TaggedProvider implements EmbeddingProvider {
  calls = 0;
  constructor(
    readonly namespace: string,
    private dims: number
  ) {}
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    return texts.map(() => new Array(this.dims).fill(1));
  }
}

let dir: string;
let cachePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-cache-test-"));
  cachePath = join(dir, "cache.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("CachingEmbeddingProvider", () => {
  it("calls the inner provider on a cache miss and persists the result", async () => {
    const inner = new CountingProvider();
    const cache = new CachingEmbeddingProvider(inner, cachePath);

    const result = await cache.embed(["hello", "world"]);
    expect(inner.calls).toBe(1);
    expect(result).toEqual([[5, 10], [5, 10]]);
    expect(existsSync(cachePath)).toBe(true);
  });

  it("does not call the inner provider again for already-cached text", async () => {
    const inner = new CountingProvider();
    const cache = new CachingEmbeddingProvider(inner, cachePath);

    await cache.embed(["hello", "world"]);
    const secondResult = await cache.embed(["hello", "world"]);

    expect(inner.calls).toBe(1); // still 1, not 2
    expect(secondResult).toEqual([[5, 10], [5, 10]]);
  });

  it("only calls the inner provider for the new/changed subset on a partial hit", async () => {
    const inner = new CountingProvider();
    const cache = new CachingEmbeddingProvider(inner, cachePath);

    await cache.embed(["hello", "world"]);
    await cache.embed(["hello", "brand new text here"]);

    expect(inner.calls).toBe(2);
    // Second call should only have embedded the one new text.
  });

  it("persists across instances via the cache file on disk", async () => {
    const inner1 = new CountingProvider();
    const cache1 = new CachingEmbeddingProvider(inner1, cachePath);
    await cache1.embed(["persisted text"]);

    const inner2 = new CountingProvider();
    const cache2 = new CachingEmbeddingProvider(inner2, cachePath);
    await cache2.embed(["persisted text"]);

    expect(inner2.calls).toBe(0);
  });

  it("treats a corrupt cache file as empty rather than throwing", async () => {
    writeFileSync(cachePath, "{not valid json");
    const inner = new CountingProvider();
    const cache = new CachingEmbeddingProvider(inner, cachePath);
    const result = await cache.embed(["hello"]);
    expect(result).toEqual([[5, 10]]);
    expect(inner.calls).toBe(1);
  });

  it("returns results in the same order as the input, even with mixed hits/misses", async () => {
    const inner = new CountingProvider();
    const cache = new CachingEmbeddingProvider(inner, cachePath);
    await cache.embed(["aa", "bbb"]);
    const result = await cache.embed(["bbb", "new-one", "aa"]);
    expect(result).toEqual([[3, 6], [7, 14], [2, 4]]);
  });

  it("REGRESSION: never returns a cached vector embedded under a different provider/model", async () => {
    // Found via a real run on the user's own machine: a directory was first
    // used for a --provider fake demo (1024-dim vectors), which wrote
    // .context-compiler-cache.json there. The same directory was later
    // reused for a real run with a real OPENAI_API_KEY (1536-dim vectors) --
    // same files, same content hashes, same cache file on disk. Every
    // unchanged chunk's hash still matched its old entry, so the cache
    // handed back 1024-dim vectors alongside fresh 1536-dim ones in the same
    // ranking pass: a real "Vector length mismatch: 1536 vs 1024" crash.
    const openaiLike = new TaggedProvider("openai:text-embedding-3-small", 1536);
    const cacheA = new CachingEmbeddingProvider(openaiLike, cachePath);
    const firstRun = await cacheA.embed(["shared chunk text"]);
    expect(firstRun[0]).toHaveLength(1536);

    // Same cache FILE, but a different provider/model -- as if --provider
    // changed, or an old cache file survived from an earlier session.
    const fakeLike = new TaggedProvider("fake", 1024);
    const cacheB = new CachingEmbeddingProvider(fakeLike, cachePath);
    const secondRun = await cacheB.embed(["shared chunk text"]);

    // Must NOT reuse openaiLike's cached 1536-dim vector for the identical
    // text -- that would be exactly the cross-provider mismatch this closes.
    expect(secondRun[0]).toHaveLength(1024);
    expect(fakeLike.calls).toBe(1); // proves this was a real cache miss, not a stale hit
  });

  it("REGRESSION: discards a pre-fix (version 1) cache file instead of misinterpreting its keys", async () => {
    writeFileSync(cachePath, JSON.stringify({ version: 1, entries: { deadbeef: [1, 2, 3] } }));
    const inner = new CountingProvider();
    const cache = new CachingEmbeddingProvider(inner, cachePath);
    await cache.embed(["hello"]);
    expect(inner.calls).toBe(1); // treated as a fresh cache, not a hit against the old-format entry
  });
});
