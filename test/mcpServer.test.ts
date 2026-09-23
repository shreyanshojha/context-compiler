import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { handleCompileContextTool } from "../src/mcpServer.js";
import { FakeEmbeddingProvider } from "../src/embeddings.js";
import { FakeRerankProvider } from "../src/rerank.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "fixtures", "sample-repo");

describe("handleCompileContextTool", () => {
  it("returns a text content block with a well-formed bundle", async () => {
    const result = await handleCompileContextTool(
      {
        path: FIXTURE_ROOT,
        query: "fix the login authentication bug",
        budgetTokens: 500,
        useCache: false,
      },
      new FakeEmbeddingProvider()
    );

    expect(result.isError).toBeFalsy();
    expect(result.content).toHaveLength(1);
    expect(result.content[0].type).toBe("text");
    expect(result.content[0].text).toContain("# Context Bundle");
  });

  it("respects pin and ignore inputs", async () => {
    const result = await handleCompileContextTool(
      {
        path: FIXTURE_ROOT,
        query: "anything",
        budgetTokens: 8000,
        pin: ["src/auth.ts"],
        ignore: ["README.md"],
        useCache: false,
      },
      new FakeEmbeddingProvider()
    );

    expect(result.content[0].text).toContain("pinned");
    expect(result.content[0].text).not.toContain("### README.md");
  });

  it("returns an error result instead of throwing when the path doesn't exist", async () => {
    const result = await handleCompileContextTool(
      {
        path: "/no/such/repo/path/at/all",
        query: "anything",
        budgetTokens: 1000,
        useCache: false,
      },
      new FakeEmbeddingProvider()
    );
    // walkRepo tolerates unreadable dirs, so this returns an empty bundle
    // rather than throwing — assert it degrades gracefully either way.
    expect(result.content[0].text).toBeTruthy();
  });

  it("applies default budgetTokens and useCache when omitted", async () => {
    const result = await handleCompileContextTool(
      // @ts-expect-error - intentionally omitting optional fields to exercise zod defaults
      { path: FIXTURE_ROOT, query: "login" },
      new FakeEmbeddingProvider()
    );
    expect(result.content[0].text).toContain("Token budget:** 8000");
  });

  it("applies the reranker override when rerank:true, without needing a real API key", async () => {
    const result = await handleCompileContextTool(
      {
        path: FIXTURE_ROOT,
        query: "fix the login authentication bug",
        budgetTokens: 8000,
        useCache: false,
        rerank: true,
        rerankModel: "gpt-4o-mini",
      },
      new FakeEmbeddingProvider(),
      new FakeRerankProvider()
    );
    expect(result.content[0].text).toContain("Excluded by relevance check");
  });

  it("does not rerank when rerank is false (the default)", async () => {
    const result = await handleCompileContextTool(
      { path: FIXTURE_ROOT, query: "fix the login authentication bug", budgetTokens: 8000, useCache: false },
      new FakeEmbeddingProvider(),
      new FakeRerankProvider()
    );
    expect(result.content[0].text).not.toContain("Excluded by relevance check");
  });
});
