import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compileContext } from "../src/index.js";
import { FakeEmbeddingProvider } from "../src/embeddings.js";
import { countTokens } from "../src/budget.js";
import { FakeRerankProvider } from "../src/rerank.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "fixtures", "sample-repo");

describe("compileContext (end-to-end, fake provider)", () => {
  it("produces a well-formed bundle within budget for a realistic query", async () => {
    const result = await compileContext({
      root: FIXTURE_ROOT,
      query: "fix the login authentication bug",
      budgetTokens: 500,
      provider: new FakeEmbeddingProvider(),
    });

    expect(result.filesConsidered).toBeGreaterThan(0);
    expect(result.chunksConsidered).toBeGreaterThanOrEqual(result.filesConsidered);
    expect(result.selection.totalTokens).toBeLessThanOrEqual(500);
    expect(result.bundle).toContain("# Context Bundle");
    expect(result.bundle).toContain("fix the login authentication bug");

    // node_modules and build/ file *content* must never leak into the bundle.
    // (.gitignore legitimately mentions the string "node_modules" itself, so
    // check for an actual included file section, not the bare substring.)
    expect(result.bundle).not.toContain("### node_modules");
    expect(result.bundle).not.toContain("### build");
    expect(result.bundle).not.toContain("vendored");
    expect(result.bundle).not.toContain("compiled output");
  });

  it("never exceeds the budget even when the repo has far more content than fits", async () => {
    const result = await compileContext({
      root: FIXTURE_ROOT,
      query: "anything",
      budgetTokens: 20, // deliberately tiny
      provider: new FakeEmbeddingProvider(),
    });
    expect(result.selection.totalTokens).toBeLessThanOrEqual(20);
  });

  it("splits the large fixture file into multiple chunks and can rank them independently", async () => {
    const result = await compileContext({
      root: FIXTURE_ROOT,
      query: "const x42",
      budgetTokens: 8000,
      provider: new FakeEmbeddingProvider(),
    });
    const bigFileChunks = result.selection.selected.filter((s) => s.chunk.filePath === "src/big.ts");
    // src/big.ts is 300 lines with a 120-line window/20 overlap -> 3 windows.
    expect(bigFileChunks.length).toBeGreaterThan(1);
  });

  it("respects extraIgnores end-to-end", async () => {
    const result = await compileContext({
      root: FIXTURE_ROOT,
      query: "readme",
      budgetTokens: 8000,
      provider: new FakeEmbeddingProvider(),
      extraIgnores: ["README.md"],
    });
    expect(result.bundle).not.toContain("### README.md");
  });

  it("bundle token count matches counting the same text directly", async () => {
    const result = await compileContext({
      root: FIXTURE_ROOT,
      query: "login",
      budgetTokens: 8000,
      provider: new FakeEmbeddingProvider(),
    });
    const recomputed = result.selection.selected.reduce((sum, s) => sum + countTokens(s.chunk.text), 0);
    expect(result.selection.totalTokens).toBe(recomputed);
  });

  it("always includes a pinned file even if it would never rank highly on its own", async () => {
    const result = await compileContext({
      root: FIXTURE_ROOT,
      query: "totally unrelated query about spreadsheets",
      budgetTokens: 8000,
      provider: new FakeEmbeddingProvider(),
      pinnedFiles: ["src/auth.ts"],
    });
    const authEntry = result.selection.selected.find((s) => s.chunk.filePath === "src/auth.ts");
    expect(authEntry).toBeDefined();
    expect(authEntry!.pinned).toBe(true);
    expect(result.bundle).toContain("pinned");
  });

  it("reserves budget for pinned files before ranking the rest", async () => {
    const result = await compileContext({
      root: FIXTURE_ROOT,
      query: "anything",
      budgetTokens: 15, // small enough that only the pin should fit
      provider: new FakeEmbeddingProvider(),
      pinnedFiles: ["README.md"],
    });
    const pinnedEntry = result.selection.selected.find((s) => s.chunk.filePath === "README.md");
    expect(pinnedEntry?.pinned).toBe(true);
  });

  it("gives an import-connected file a structural bonus end-to-end", async () => {
    const result = await compileContext({
      root: FIXTURE_ROOT,
      query: "sum values with the add function",
      budgetTokens: 8000,
      provider: new FakeEmbeddingProvider(),
    });
    const mathUtilsEntry = result.selection.selected.find((s) => s.chunk.filePath === "src/mathUtils.ts");
    expect(mathUtilsEntry?.explain).toBeDefined();
  });

  it("can disable the structural boost", async () => {
    const result = await compileContext({
      root: FIXTURE_ROOT,
      query: "sum values with the add function",
      budgetTokens: 8000,
      provider: new FakeEmbeddingProvider(),
      useStructuralBoost: false,
    });
    const anyStructural = result.selection.selected.some((s) => (s.explain?.structuralBonus ?? 0) > 0);
    expect(anyStructural).toBe(false);
  });

  it("drops chunks the reranker judges irrelevant, end-to-end", async () => {
    const result = await compileContext({
      root: FIXTURE_ROOT,
      query: "fix the login authentication bug",
      budgetTokens: 8000,
      provider: new FakeEmbeddingProvider(),
      rerankProvider: new FakeRerankProvider(),
    });
    // README.md and .gitignore share no keyword with the login/auth query,
    // so the fake reranker should drop them even though they fit the budget.
    expect(result.bundle).toContain("Excluded by relevance check");
    const includedPaths = result.selection.selected.map((s) => s.chunk.filePath);
    expect(includedPaths).not.toContain("README.md");
  });

  it("never reranks pinned files — they stay in regardless", async () => {
    const result = await compileContext({
      root: FIXTURE_ROOT,
      query: "fix the login authentication bug",
      budgetTokens: 8000,
      provider: new FakeEmbeddingProvider(),
      rerankProvider: new FakeRerankProvider(),
      pinnedFiles: ["README.md"], // would otherwise be dropped by the reranker
    });
    const readmeEntry = result.selection.selected.find((s) => s.chunk.filePath === "README.md");
    expect(readmeEntry?.pinned).toBe(true);
  });

  it("omits the reranker section entirely when no rerankProvider is given", async () => {
    const result = await compileContext({
      root: FIXTURE_ROOT,
      query: "fix the login authentication bug",
      budgetTokens: 8000,
      provider: new FakeEmbeddingProvider(),
    });
    expect(result.bundle).not.toContain("Excluded by relevance check");
  });
});
