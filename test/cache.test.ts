import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CachingEmbeddingProvider } from "../src/cache.js";
import type { EmbeddingProvider } from "../src/embeddings.js";

class CountingProvider implements EmbeddingProvider {
  calls = 0;
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    return texts.map((t) => [t.length, t.length * 2]);
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
});
