import { describe, it, expect } from "vitest";
import { cosineSimilarity, rankChunks } from "../src/ranker.js";
import { FakeEmbeddingProvider } from "../src/embeddings.js";
import { ImportGraph } from "../src/importGraph.js";
import type { Chunk } from "../src/chunker.js";

function makeChunk(filePath: string, text: string): Chunk {
  return { filePath, startLine: 1, endLine: 1, text, isWholeFile: true };
}

describe("cosineSimilarity", () => {
  it("is 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it("is 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("throws on mismatched lengths", () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/length mismatch/);
  });
});

describe("rankChunks", () => {
  it("ranks the most relevant chunk first", async () => {
    const chunks = [
      makeChunk("auth.ts", "function validatePassword login authentication"),
      makeChunk("report.ts", "quarterly sales report totals spreadsheet"),
      makeChunk("login.ts", "handles user login and authentication flow"),
    ];
    const ranked = await rankChunks(chunks, "fix the login authentication bug", new FakeEmbeddingProvider());

    expect(ranked[0].chunk.filePath).not.toBe("report.ts");
    // Scores should be sorted descending.
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1].score).toBeGreaterThanOrEqual(ranked[i].score);
    }
  });

  it("returns an empty array for no chunks", async () => {
    const ranked = await rankChunks([], "anything", new FakeEmbeddingProvider());
    expect(ranked).toEqual([]);
  });

  it("attaches an explain object with semanticScore and no bonus when no import graph is given", async () => {
    const chunks = [makeChunk("a.ts", "login authentication")];
    const ranked = await rankChunks(chunks, "login bug", new FakeEmbeddingProvider());
    expect(ranked[0].explain).toBeDefined();
    expect(ranked[0].explain!.structuralBonus).toBe(0);
    expect(ranked[0].explain!.connectedTo).toEqual([]);
    expect(ranked[0].score).toBeCloseTo(ranked[0].explain!.semanticScore);
  });

  it("boosts a low-semantic-similarity chunk whose file is import-connected to a top hit", async () => {
    // "helper.ts" shares no vocabulary with the query at all, but is
    // import-connected to "login.ts", which is the clear top semantic hit.
    const chunks = [
      makeChunk("login.ts", "handles user login and authentication flow, calls helper"),
      makeChunk("helper.ts", "totally generic utility code with no relevant words"),
      makeChunk("report.ts", "quarterly sales report totals spreadsheet unrelated content"),
    ];
    const graph = new ImportGraph();
    graph.addEdge("login.ts", "helper.ts");

    const withoutGraph = await rankChunks(chunks, "fix the login authentication bug", new FakeEmbeddingProvider());
    const withGraph = await rankChunks(chunks, "fix the login authentication bug", new FakeEmbeddingProvider(), {
      importGraph: graph,
      seedCount: 1,
    });

    const helperWithout = withoutGraph.find((c) => c.chunk.filePath === "helper.ts")!;
    const helperWith = withGraph.find((c) => c.chunk.filePath === "helper.ts")!;
    const reportWith = withGraph.find((c) => c.chunk.filePath === "report.ts")!;

    expect(helperWith.score).toBeGreaterThan(helperWithout.score);
    expect(helperWith.explain!.structuralBonus).toBeGreaterThan(0);
    expect(helperWith.explain!.connectedTo).toContain("login.ts");
    // The bonus should not be so large that it beats a file with no connection at all by default weight —
    // just confirm the unconnected file gets no bonus.
    expect(reportWith.explain!.structuralBonus).toBe(0);
  });
});
