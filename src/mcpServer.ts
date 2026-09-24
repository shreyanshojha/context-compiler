#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolve } from "node:path";
import { compileContext } from "./index.js";
import { OpenAIEmbeddingProvider, VoyageEmbeddingProvider, type EmbeddingProvider } from "./embeddings.js";
import { CachingEmbeddingProvider } from "./cache.js";
import { OpenAIRerankProvider, AnthropicRerankProvider, resolveRerankModel, type RerankProvider } from "./rerank.js";
import { VERSION } from "./version.js";

export const compileContextInputShape = {
  path: z.string().describe("Absolute or relative path to the repo root to scan."),
  query: z.string().describe("The coding task about to be done, e.g. \"fix the login bug\"."),
  budgetTokens: z.number().int().positive().default(8000).describe("Max tokens in the returned context bundle."),
  pin: z.array(z.string()).optional().describe("Repo-relative file paths to always include in full."),
  ignore: z.array(z.string()).optional().describe("Extra gitignore-style patterns to exclude."),
  provider: z
    .enum(["openai", "voyage"])
    .default("openai")
    .describe(
      "Embedding provider. \"voyage\" uses Voyage AI's voyage-code-3 model (trained for code retrieval; " +
        "requires VOYAGE_API_KEY) instead of OpenAI's text-embedding-3-small (requires OPENAI_API_KEY)."
    ),
  useCache: z.boolean().default(true).describe("Reuse cached embeddings for unchanged content."),
  rerank: z
    .boolean()
    .default(false)
    .describe(
      "Add a cheap chat-model second pass that reviews top candidates and drops what doesn't hold up. " +
        "Costs extra (small) API calls beyond embeddings; the coding model you use afterward is unaffected."
    ),
  rerankProvider: z
    .enum(["openai", "anthropic"])
    .default("openai")
    .describe(
      "Which chat model provider runs the rerank/triage step when rerank is true. " +
        "Embeddings are OpenAI-only regardless (Anthropic has no public embeddings API)."
    ),
  rerankModel: z
    .string()
    .optional()
    .describe(
      "Chat model used when rerank is true. Defaults to gpt-4o-mini for rerankProvider \"openai\" " +
        "or claude-haiku-4-5 for \"anthropic\" if left unset."
    ),
};

const CompileContextInput = z.object(compileContextInputShape);
export type CompileContextInput = z.infer<typeof CompileContextInput>;

export interface ToolTextResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
  // MCP's CallToolResult is an open record (carries _meta, etc.) — this
  // keeps our return type structurally assignable without importing and
  // re-declaring the SDK's full result type.
  [key: string]: unknown;
}

/**
 * The actual tool logic, factored out from MCP registration so it can be
 * unit tested directly — no MCP client or transport needed to exercise it.
 */
export async function handleCompileContextTool(
  rawInput: CompileContextInput,
  embeddingProvider?: EmbeddingProvider,
  rerankProviderOverride?: RerankProvider
): Promise<ToolTextResult> {
  const input = CompileContextInput.parse(rawInput);
  const root = resolve(input.path);

  let provider = embeddingProvider ?? (input.provider === "voyage" ? new VoyageEmbeddingProvider() : new OpenAIEmbeddingProvider());
  if (input.useCache) {
    provider = new CachingEmbeddingProvider(provider, resolve(root, ".context-compiler-cache.json"));
  }

  try {
    let rerankProvider: RerankProvider | undefined;
    if (input.rerank) {
      if (rerankProviderOverride) {
        rerankProvider = rerankProviderOverride;
      } else if (input.rerankProvider === "anthropic") {
        rerankProvider = new AnthropicRerankProvider(resolveRerankModel(input.rerankModel, "anthropic"));
      } else {
        rerankProvider = new OpenAIRerankProvider(resolveRerankModel(input.rerankModel, "openai"));
      }
    }

    const result = await compileContext({
      root,
      query: input.query,
      budgetTokens: input.budgetTokens,
      provider,
      extraIgnores: input.ignore,
      pinnedFiles: input.pin,
      rerankProvider,
    });
    return { content: [{ type: "text", text: result.bundle }] };
  } catch (err) {
    return {
      content: [{ type: "text", text: `context-compiler failed: ${(err as Error).message}` }],
      isError: true,
    };
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "context-compiler", version: VERSION });

  server.registerTool(
    "compile_context",
    {
      title: "Compile Context",
      description:
        "Compile the most relevant slice of a repo into a token-budgeted context bundle for a given coding task. " +
        "Use this before starting a coding task on a large repo instead of guessing which files to read.",
      inputSchema: compileContextInputShape,
    },
    (args) => handleCompileContextTool(args)
  );

  return server;
}

async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only start the stdio server when this file is run directly (as the MCP
// entrypoint) — not when it's imported for testing.
const isMainModule = process.argv[1] && import.meta.url === new URL(process.argv[1], "file:").href;
if (isMainModule) {
  main().catch((err) => {
    console.error("context-compiler MCP server failed to start:", err);
    process.exit(1);
  });
}
