export interface EmbeddingProvider {
  /** Embed a batch of texts, returning one vector per input in the same order. */
  embed(texts: string[]): Promise<number[][]>;
  /**
   * Identifies which provider+model produced this instance's vectors (e.g.
   * "openai:text-embedding-3-small", "voyage:voyage-code-3", "fake").
   * CachingEmbeddingProvider folds this into its cache keys so a vector
   * embedded by one provider/model can never be handed back as if it came
   * from another -- see cache.ts for the real bug this closes.
   */
  readonly namespace: string;
}

// Large enough that hash collisions between unrelated words are rare —
// a small dimension count (e.g. 64) causes spurious similarity between
// texts that share no real vocabulary, purely from hash collisions.
const FAKE_DIMENSIONS = 1024;

/**
 * Deterministic, offline embedding provider for tests and CI.
 * Uses a simple hashed bag-of-words scheme: no network calls, no API key,
 * fully reproducible — but still gives texts that share vocabulary a higher
 * cosine similarity than unrelated texts, which is what unit/integration
 * tests need to exercise ranking logic meaningfully.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly namespace = "fake";

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => embedOne(text));
  }
}

// Common words filtered out so shared function words (e.g. "the", "a",
// "with") don't create spurious similarity between otherwise unrelated
// texts — this is a bag-of-words stand-in, not a real semantic model, so it
// needs this to behave sensibly at all.
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are",
  "with", "this", "that", "it", "as", "by", "at", "be", "was", "were",
]);

function embedOne(text: string): number[] {
  const vector = new Array(FAKE_DIMENSIONS).fill(0);
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((w) => w && !STOPWORDS.has(w));

  for (const word of words) {
    const idx = hashString(word) % FAKE_DIMENSIONS;
    vector[idx] += 1;
  }

  return normalize(vector);
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

function normalize(vector: number[]): number[] {
  const magnitude = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  if (magnitude === 0) return vector;
  return vector.map((v) => v / magnitude);
}

/**
 * Real embedding provider backed by OpenAI's API.
 * Requires OPENAI_API_KEY in the environment; the API key is never read from
 * anywhere else and is not logged.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  private model: string;
  readonly namespace: string;

  constructor(model = "text-embedding-3-small") {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        "OPENAI_API_KEY is not set. Set it in your environment to use the OpenAI embedding provider, " +
          "e.g. `export OPENAI_API_KEY=sk-...`."
      );
    }
    this.model = model;
    this.namespace = `openai:${model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    // Imported lazily so the OpenAI SDK is never touched (and no API key is
    // required) for callers who only use the fake provider, e.g. in tests.
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI();
    const response = await client.embeddings.create({
      model: this.model,
      input: texts,
    });
    return response.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}

/**
 * Real embedding provider backed by Voyage AI's API. Voyage is Anthropic's
 * recommended embeddings partner (Anthropic has no first-party embeddings
 * API of its own), and its "voyage-code-3" model is trained specifically for
 * code retrieval -- a natural fit here since every chunk being embedded is
 * source code. No SDK dependency: Voyage's API is a single plain REST
 * endpoint, and Node's built-in fetch is enough.
 */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  private model: string;
  readonly namespace: string;

  constructor(model = "voyage-code-3") {
    if (!process.env.VOYAGE_API_KEY) {
      throw new Error(
        "VOYAGE_API_KEY is not set. Set it in your environment to use the Voyage AI embedding provider, " +
          "e.g. `export VOYAGE_API_KEY=pa-...`. Get a key at https://dashboard.voyageai.com/."
      );
    }
    this.model = model;
    this.namespace = `voyage:${model}`;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const response = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
        input_type: "document",
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`Voyage AI embeddings request failed: ${response.status} ${response.statusText} ${body}`);
    }

    const parsed = (await response.json()) as { data: { embedding: number[]; index: number }[] };
    return parsed.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
  }
}
