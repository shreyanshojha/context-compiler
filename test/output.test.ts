import { describe, it, expect } from "vitest";
import { formatBundle } from "../src/output.js";
import type { BudgetSelection } from "../src/budget.js";
import type { Chunk } from "../src/chunker.js";

function makeChunk(filePath: string, text: string, startLine = 1, endLine = 1, isWholeFile = true): Chunk {
  return { filePath, startLine, endLine, text, isWholeFile };
}

describe("formatBundle", () => {
  it("includes task, budget, and token usage in the header", () => {
    const selection: BudgetSelection = {
      selected: [{ chunk: makeChunk("a.ts", "const a = 1;"), score: 0.8 }],
      totalTokens: 5,
      skipped: [],
    };
    const out = formatBundle(selection, { query: "fix bug", budgetTokens: 100, root: "/repo" });
    expect(out).toContain("fix bug");
    expect(out).toContain("100");
    expect(out).toContain("Tokens used:** 5");
  });

  it("groups multiple chunks from the same file together", () => {
    const selection: BudgetSelection = {
      selected: [
        { chunk: makeChunk("big.ts", "chunk two", 121, 240, false), score: 0.5 },
        { chunk: makeChunk("big.ts", "chunk one", 1, 120, false), score: 0.9 },
        { chunk: makeChunk("other.ts", "other file", 1, 1, true), score: 0.7 },
      ],
      totalTokens: 30,
      skipped: [],
    };
    const out = formatBundle(selection, { query: "q", budgetTokens: 1000, root: "/repo" });

    const bigIdx = out.indexOf("### big.ts");
    const otherIdx = out.indexOf("### other.ts");
    const chunkOneIdx = out.indexOf("chunk one");
    const chunkTwoIdx = out.indexOf("chunk two");
    expect(bigIdx).toBeGreaterThanOrEqual(0);
    expect(otherIdx).toBeGreaterThan(bigIdx);
    // Within the file section, chunks appear in line order, not score order.
    expect(chunkOneIdx).toBeLessThan(chunkTwoIdx);
  });

  it("handles an empty selection gracefully", () => {
    const selection: BudgetSelection = { selected: [], totalTokens: 0, skipped: [] };
    const out = formatBundle(selection, { query: "q", budgetTokens: 100, root: "/repo" });
    expect(out).toContain("No chunks fit");
  });

  it("shows a structural connection reason when explain has a structural bonus", () => {
    const selection: BudgetSelection = {
      selected: [
        {
          chunk: makeChunk("helper.ts", "code"),
          score: 0.45,
          explain: { semanticScore: 0.4, structuralBonus: 0.05, connectedTo: ["login.ts"] },
        },
      ],
      totalTokens: 1,
      skipped: [],
    };
    const out = formatBundle(selection, { query: "q", budgetTokens: 10, root: "/repo" });
    expect(out).toContain("connected to");
    expect(out).toContain("login.ts");
  });

  it("marks a pinned chunk distinctly from a ranked one", () => {
    const selection: BudgetSelection = {
      selected: [{ chunk: makeChunk("config.ts", "code"), score: 0, pinned: true }],
      totalTokens: 1,
      skipped: [],
    };
    const out = formatBundle(selection, { query: "q", budgetTokens: 10, root: "/repo" });
    expect(out).toContain("pinned");
  });

  it("shows an llmReason alongside the semantic/structural explanation", () => {
    const selection: BudgetSelection = {
      selected: [
        {
          chunk: makeChunk("login.ts", "code"),
          score: 0.8,
          explain: { semanticScore: 0.8, structuralBonus: 0, connectedTo: [], llmReason: "directly handles login" },
        },
      ],
      totalTokens: 1,
      skipped: [],
    };
    const out = formatBundle(selection, { query: "q", budgetTokens: 10, root: "/repo" });
    expect(out).toContain("relevance check: directly handles login");
  });

  it("lists chunks excluded by the reranker in their own section, with reasons", () => {
    const selection: BudgetSelection = {
      selected: [{ chunk: makeChunk("login.ts", "code"), score: 0.8 }],
      totalTokens: 1,
      skipped: [],
    };
    const out = formatBundle(selection, {
      query: "q",
      budgetTokens: 10,
      root: "/repo",
      excludedByRerank: [{ chunk: makeChunk("report.ts", "unrelated"), reason: "not needed for this task" }],
    });
    expect(out).toContain("## Excluded by relevance check");
    expect(out).toContain("report.ts");
    expect(out).toContain("not needed for this task");
    expect(out).toContain("1 excluded by relevance check");
  });

  it("mentions skipped chunk count when some were skipped", () => {
    const selection: BudgetSelection = {
      selected: [{ chunk: makeChunk("a.ts", "x"), score: 0.5 }],
      totalTokens: 1,
      skipped: [{ chunk: makeChunk("b.ts", "y"), score: 0.4 }],
    };
    const out = formatBundle(selection, { query: "q", budgetTokens: 10, root: "/repo" });
    expect(out).toContain("1 skipped");
  });
});
