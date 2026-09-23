import { describe, it, expect, vi, afterEach } from "vitest";
import { FakeEmbeddingProvider, OpenAIEmbeddingProvider, VoyageEmbeddingProvider } from "../src/embeddings.js";

function cosine(a: number[], b: number[]): number {
  const dot = a.reduce((sum, v, i) => sum + v * b[i], 0);
  const magA = Math.sqrt(a.reduce((s, v) => s + v * v, 0));
  const magB = Math.sqrt(b.reduce((s, v) => s + v * v, 0));
  return dot / (magA * magB);
}

describe("FakeEmbeddingProvider", () => {
  it("is deterministic for the same input", async () => {
    const provider = new FakeEmbeddingProvider();
    const [a] = await provider.embed(["login password validation"]);
    const [b] = await provider.embed(["login password validation"]);
    expect(a).toEqual(b);
  });

  it("gives higher similarity to texts sharing vocabulary", async () => {
    const provider = new FakeEmbeddingProvider();
    const [query, related, unrelated] = await provider.embed([
      "fix the login authentication bug",
      "function login authenticates a user with password",
      "the quarterly sales report spreadsheet totals",
    ]);
    const simRelated = cosine(query, related);
    const simUnrelated = cosine(query, unrelated);
    expect(simRelated).toBeGreaterThan(simUnrelated);
  });

  it("returns one vector per input, in order", async () => {
    const provider = new FakeEmbeddingProvider();
    const vectors = await provider.embed(["a", "b", "c"]);
    expect(vectors).toHaveLength(3);
  });
});

describe("OpenAIEmbeddingProvider", () => {
  it("throws a clear error when OPENAI_API_KEY is not set", () => {
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => new OpenAIEmbeddingProvider()).toThrow(/OPENAI_API_KEY/);
    } finally {
      if (original) process.env.OPENAI_API_KEY = original;
    }
  });
});

describe("VoyageEmbeddingProvider", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.VOYAGE_API_KEY;
  });

  it("throws a clear error when VOYAGE_API_KEY is not set", () => {
    delete process.env.VOYAGE_API_KEY;
    expect(() => new VoyageEmbeddingProvider()).toThrow(/VOYAGE_API_KEY/);
  });

  it("defaults to voyage-code-3 and sends texts+key to the real Voyage AI endpoint (network mocked, no real key needed)", async () => {
    process.env.VOYAGE_API_KEY = "test-key-not-real";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          { embedding: [0.1, 0.2], index: 1 },
          { embedding: [0.3, 0.4], index: 0 },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new VoyageEmbeddingProvider();
    const vectors = await provider.embed(["first chunk", "second chunk"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
    expect(init.headers.Authorization).toBe("Bearer test-key-not-real");
    const body = JSON.parse(init.body);
    expect(body.model).toBe("voyage-code-3");
    expect(body.input).toEqual(["first chunk", "second chunk"]);

    // Response came back out of order (index 1 before index 0) -- confirms
    // results are re-sorted to match input order, same contract as OpenAI's.
    expect(vectors).toEqual([
      [0.3, 0.4],
      [0.1, 0.2],
    ]);
  });

  it("surfaces a clear error when the Voyage AI API returns a non-OK response", async () => {
    process.env.VOYAGE_API_KEY = "test-key-not-real";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        statusText: "Unauthorized",
        text: async () => '{"error":"invalid API key"}',
      })
    );

    const provider = new VoyageEmbeddingProvider();
    await expect(provider.embed(["x"])).rejects.toThrow(/401/);
  });
});
