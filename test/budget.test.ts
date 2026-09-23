import { describe, it, expect } from "vitest";
import { countTokens, selectWithinBudget, type ScoredChunk } from "../src/budget.js";
import type { Chunk } from "../src/chunker.js";

function makeChunk(filePath: string, text: string): Chunk {
  return { filePath, startLine: 1, endLine: 1, text, isWholeFile: true };
}

describe("countTokens", () => {
  it("counts more tokens for longer text", () => {
    expect(countTokens("hello world")).toBeGreaterThan(0);
    expect(countTokens("hello world, this is a much longer sentence with many more words")).toBeGreaterThan(
      countTokens("hello world")
    );
  });
});

describe("selectWithinBudget", () => {
  it("never selects more tokens than the budget", () => {
    const chunks: ScoredChunk[] = [
      { chunk: makeChunk("a.ts", "a".repeat(2000)), score: 0.9 },
      { chunk: makeChunk("b.ts", "b".repeat(2000)), score: 0.8 },
      { chunk: makeChunk("c.ts", "c".repeat(2000)), score: 0.7 },
    ];
    const result = selectWithinBudget(chunks, 300);
    expect(result.totalTokens).toBeLessThanOrEqual(300);
  });

  it("prefers higher-scoring chunks first", () => {
    const chunks: ScoredChunk[] = [
      { chunk: makeChunk("low.ts", "x".repeat(100)), score: 0.1 },
      { chunk: makeChunk("high.ts", "y".repeat(100)), score: 0.9 },
    ];
    const result = selectWithinBudget(chunks, 1000);
    expect(result.selected[0].chunk.filePath).toBe("high.ts");
  });

  it("skips a chunk that doesn't fit but keeps checking smaller lower-ranked ones", () => {
    const chunks: ScoredChunk[] = [
      { chunk: makeChunk("big.ts", "z".repeat(4000)), score: 0.9 }, // won't fit
      { chunk: makeChunk("small.ts", "w".repeat(20)), score: 0.5 }, // should fit
    ];
    const result = selectWithinBudget(chunks, 50);
    const paths = result.selected.map((s) => s.chunk.filePath);
    expect(paths).toContain("small.ts");
    expect(paths).not.toContain("big.ts");
  });

  it("returns everything unselected when budget is zero or negative", () => {
    const chunks: ScoredChunk[] = [{ chunk: makeChunk("a.ts", "hello"), score: 1 }];
    const result = selectWithinBudget(chunks, 0);
    expect(result.selected).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });
});
