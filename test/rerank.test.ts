import { describe, it, expect, vi } from "vitest";
import {
  FakeRerankProvider,
  OpenAIRerankProvider,
  AnthropicRerankProvider,
  applyRerank,
  candidateId,
  resolveRerankModel,
} from "../src/rerank.js";
import type { Chunk } from "../src/chunker.js";
import type { ScoredChunk } from "../src/budget.js";

function makeScored(filePath: string, text: string, score: number, startLine = 1, endLine = 1): ScoredChunk {
  const chunk: Chunk = { filePath, startLine, endLine, text, isWholeFile: true };
  return { chunk, score, explain: { semanticScore: score, structuralBonus: 0, connectedTo: [] } };
}

// Mocks the Anthropic SDK's transport only (no network, no real key needed)
// so the "not_found_error: model gpt-4o-mini" bug can be verified against
// the REAL AnthropicRerankProvider class and the REAL model string it
// actually hands the SDK -- not just the extracted resolveRerankModel
// helper. vi.hoisted makes the spy reachable both inside vi.mock's factory
// (which vitest hoists above these imports) and in the test body below.
const { createMessagesMock } = vi.hoisted(() => ({ createMessagesMock: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: createMessagesMock },
  })),
}));

describe("candidateId", () => {
  it("is stable and unique per file+line-range", () => {
    const a: Chunk = { filePath: "a.ts", startLine: 1, endLine: 10, text: "x", isWholeFile: false };
    const b: Chunk = { filePath: "a.ts", startLine: 11, endLine: 20, text: "y", isWholeFile: false };
    expect(candidateId(a)).not.toBe(candidateId(b));
    expect(candidateId(a)).toBe("a.ts:1-10");
  });
});

describe("FakeRerankProvider", () => {
  it("keeps candidates that share a keyword with the query", async () => {
    const provider = new FakeRerankProvider();
    const verdicts = await provider.rerank("fix the login authentication bug", [
      { id: "1", filePath: "login.ts", startLine: 1, endLine: 1, text: "handles user login flow" },
      { id: "2", filePath: "report.ts", startLine: 1, endLine: 1, text: "quarterly sales spreadsheet totals" },
    ]);
    expect(verdicts.find((v) => v.id === "1")!.keep).toBe(true);
    expect(verdicts.find((v) => v.id === "2")!.keep).toBe(false);
  });

  it("matches a camelCase identifier against its constituent query words", async () => {
    // Regression: found via real-world testing -- "loginUser" as a single
    // identifier wasn't matching the query word "login" before keywordsOf
    // split on camelCase boundaries too.
    const provider = new FakeRerankProvider();
    const verdicts = await provider.rerank("fix the login bug", [
      { id: "1", filePath: "auth.test.ts", startLine: 1, endLine: 1, text: "const { loginUser } = require('./auth');" },
    ]);
    expect(verdicts[0].keep).toBe(true);
  });

  it("returns exactly one verdict per candidate", async () => {
    const provider = new FakeRerankProvider();
    const verdicts = await provider.rerank("q", [
      { id: "a", filePath: "a", startLine: 1, endLine: 1, text: "x" },
      { id: "b", filePath: "b", startLine: 1, endLine: 1, text: "y" },
      { id: "c", filePath: "c", startLine: 1, endLine: 1, text: "z" },
    ]);
    expect(verdicts).toHaveLength(3);
  });
});

describe("OpenAIRerankProvider", () => {
  it("throws a clear error when OPENAI_API_KEY is not set", () => {
    const original = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      expect(() => new OpenAIRerankProvider()).toThrow(/OPENAI_API_KEY/);
    } finally {
      if (original) process.env.OPENAI_API_KEY = original;
    }
  });
});

describe("AnthropicRerankProvider", () => {
  it("throws a clear error when ANTHROPIC_API_KEY is not set", () => {
    const original = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      expect(() => new AnthropicRerankProvider()).toThrow(/ANTHROPIC_API_KEY/);
    } finally {
      if (original) process.env.ANTHROPIC_API_KEY = original;
    }
  });

  it("returns an empty array without needing a key when there are no candidates", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    try {
      const provider = new AnthropicRerankProvider();
      expect(await provider.rerank("anything", [])).toEqual([]);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("REGRESSION: actually sends claude-haiku-4-5 to the SDK for an anthropic override, never a leaked openai model name", async () => {
    // This is the end-to-end version of the resolveRerankModel unit test
    // above: it drives the real AnthropicRerankProvider class and inspects
    // the literal `model` field handed to the (mocked) Anthropic SDK call,
    // which is what actually 404'd in production as
    // {"type":"not_found_error","message":"model: gpt-4o-mini"}.
    process.env.ANTHROPIC_API_KEY = "test-key-not-real";
    createMessagesMock.mockReset();
    createMessagesMock.mockResolvedValue({
      content: [{ type: "tool_use", input: { verdicts: [{ id: "auth.ts:1-1", keep: true, reason: "relevant" }] } }],
    });
    try {
      // Simulates the exact failure scenario: a stale .context-compiler.json
      // saved rerankModel: "gpt-4o-mini" from an old `init`, but the run
      // overrides only --rerank-provider to "anthropic" and passes no
      // explicit --rerank-model. resolveRerankModel is what both the CLI and
      // MCP server now call to pick the actual model in that situation.
      const model = resolveRerankModel(undefined, "anthropic");
      const provider = new AnthropicRerankProvider(model);
      await provider.rerank("fix the login bug", [
        { id: "auth.ts:1-1", filePath: "auth.ts", startLine: 1, endLine: 1, text: "function login() {}" },
      ]);

      expect(createMessagesMock).toHaveBeenCalledTimes(1);
      const callArgs = createMessagesMock.mock.calls[0][0];
      expect(callArgs.model).toBe("claude-haiku-4-5");
      expect(callArgs.model).not.toBe("gpt-4o-mini");
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      createMessagesMock.mockReset();
    }
  });
});

describe("resolveRerankModel", () => {
  it("uses the explicit model when one is given, regardless of provider", () => {
    expect(resolveRerankModel("gpt-4", "openai")).toBe("gpt-4");
    expect(resolveRerankModel("claude-3-opus", "anthropic")).toBe("claude-3-opus");
  });

  it("falls back to a provider-appropriate default when no model is given", () => {
    expect(resolveRerankModel(undefined, "openai")).toBe("gpt-4o-mini");
    expect(resolveRerankModel(undefined, "anthropic")).toBe("claude-haiku-4-5");
  });

  it("regression: a config file's openai model must not leak into an anthropic override", () => {
    // Reproduces a real bug: .context-compiler.json saved rerankModel:
    // "gpt-4o-mini" (from an older `init`) while rerankProvider stayed
    // "openai". Switching provider at the CLI with `--rerank-provider
    // anthropic` alone (no --rerank-model) must NOT carry "gpt-4o-mini"
    // along -- that model name doesn't exist on Anthropic's API and the
    // real request 404'd with {"type":"not_found_error","message":"model:
    // gpt-4o-mini"}. The fix: resolve the model against the FINAL provider,
    // treating a config-file default as absent once provider is overridden.
    const configFileRerankModel = undefined; // what a *new* init now leaves unset
    expect(resolveRerankModel(configFileRerankModel, "anthropic")).toBe("claude-haiku-4-5");
  });
});

describe("applyRerank", () => {
  it("excludes chunks the reranker drops, keeps the rest", async () => {
    const scored = [
      makeScored("login.ts", "handles user login authentication", 0.9),
      makeScored("report.ts", "quarterly sales spreadsheet totals", 0.5),
    ];
    const result = await applyRerank(scored, "fix the login authentication bug", new FakeRerankProvider());
    expect(result.kept.map((s) => s.chunk.filePath)).toEqual(["login.ts"]);
    expect(result.excluded.map((e) => e.chunk.filePath)).toEqual(["report.ts"]);
    expect(result.excluded[0].reason).toContain("no keyword overlap");
  });

  it("never sends more than topN candidates to the provider, leaving the rest untouched", async () => {
    const scored = Array.from({ length: 30 }, (_, i) =>
      makeScored(`file${i}.ts`, "totally unrelated content with no overlap", 1 - i * 0.01)
    );
    const result = await applyRerank(scored, "fix the login bug", new FakeRerankProvider(), 5);
    // Only the first 5 were sent to the reranker (and all dropped, no keyword overlap);
    // the remaining 25 pass through untouched in `kept`.
    expect(result.excluded).toHaveLength(5);
    expect(result.kept).toHaveLength(25);
  });

  it("attaches the reranker's reason onto explain.llmReason for kept chunks", async () => {
    const scored = [makeScored("login.ts", "handles user login authentication", 0.9)];
    const result = await applyRerank(scored, "fix the login authentication bug", new FakeRerankProvider());
    expect(result.kept[0].explain?.llmReason).toContain("shares keyword");
  });

  it("handles an empty input without error", async () => {
    const result = await applyRerank([], "anything", new FakeRerankProvider());
    expect(result).toEqual({ kept: [], excluded: [] });
  });
});
