import type { Chunk } from "./chunker.js";
import type { ScoredChunk } from "./budget.js";

export interface RerankCandidate {
  /** Stable identifier so verdicts can be matched back to their chunk: `filePath:startLine-endLine`. */
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  text: string;
}

export interface RerankVerdict {
  id: string;
  keep: boolean;
  reason: string;
}

export interface RerankProvider {
  rerank(query: string, candidates: RerankCandidate[]): Promise<RerankVerdict[]>;
}

export function candidateId(chunk: Chunk): string {
  return `${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`;
}

/**
 * Pick the chat model for the rerank/triage step: an explicit model always
 * wins, otherwise fall back to a provider-appropriate default.
 *
 * This has to be resolved against the FINAL provider choice (after any CLI
 * flag or MCP input has overridden a config file), not a value baked in
 * earlier -- resolving it too early was a real bug: a saved config with
 * `rerankProvider: "openai", rerankModel: "gpt-4o-mini"` survived a later
 * `--rerank-provider anthropic` override and sent "gpt-4o-mini" straight to
 * Anthropic's API, which rejected it (404 not_found_error).
 */
export function resolveRerankModel(explicitModel: string | undefined, provider: "openai" | "anthropic"): string {
  return explicitModel ?? (provider === "anthropic" ? "claude-haiku-4-5" : "gpt-4o-mini");
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "is", "are",
  "with", "this", "that", "it", "as", "by", "at", "be", "was", "were", "fix",
  "bug", "add", "update", "the",
]);

function keywordsOf(text: string): Set<string> {
  // Split on non-alphanumerics first, then also split each token on
  // camelCase/PascalCase boundaries (e.g. "loginUser" -> "login", "user")
  // so identifier-heavy code still overlaps with plain-English task words.
  const words = new Set<string>();
  for (const raw of text.split(/[^a-zA-Z0-9_]+/)) {
    if (!raw) continue;
    words.add(raw.toLowerCase());
    for (const part of raw.split(/(?<=[a-z0-9])(?=[A-Z])/)) {
      const w = part.toLowerCase();
      if (w) words.add(w);
    }
  }
  for (const w of [...words]) {
    if (STOPWORDS.has(w)) words.delete(w);
  }
  return words;
}

/**
 * Deterministic, offline stand-in for a real LLM reranker: keeps a candidate
 * if its text shares at least one meaningful (non-stopword) keyword with the
 * query, drops it otherwise. Crude compared to an actual model's judgment,
 * but gives tests (and cost-free trial runs) a real, inspectable signal
 * rather than a no-op passthrough.
 */
export class FakeRerankProvider implements RerankProvider {
  async rerank(query: string, candidates: RerankCandidate[]): Promise<RerankVerdict[]> {
    const queryWords = keywordsOf(query);
    return candidates.map((c) => {
      const candidateWords = keywordsOf(c.text);
      const overlap = [...queryWords].filter((w) => candidateWords.has(w));
      const keep = overlap.length > 0;
      return {
        id: c.id,
        keep,
        reason: keep ? `shares keyword(s): ${overlap.join(", ")}` : "no keyword overlap with the task",
      };
    });
  }
}

const RERANK_SYSTEM_PROMPT = `You triage candidate code snippets for relevance to a coding task.
Given a task description and a numbered list of code snippets (each with an id), decide which snippets
a coding agent would actually need to see to do that task. Keep snippets that are directly relevant,
that are called by or call into relevant code, or that provide necessary context. Drop snippets that are
clearly unrelated. When unsure, keep it — a false drop is worse than a false keep.

Respond with ONLY a JSON object of the form:
{"verdicts": [{"id": "<id>", "keep": true|false, "reason": "<one short sentence>"}, ...]}
Include exactly one verdict per candidate id given, in any order.`;

/**
 * Real reranker backed by a cheap chat model (not the embedding model) —
 * this is the "cheap model does the finding, your real coding model does
 * the coding" step: a small, inexpensive model reviews the embedding+
 * structural candidates and catches what pure similarity scoring misses
 * (e.g. two files being related in a way that doesn't share vocabulary,
 * or a candidate that only looks relevant on the surface).
 */
export class OpenAIRerankProvider implements RerankProvider {
  constructor(private model = "gpt-4o-mini") {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error(
        "OPENAI_API_KEY is not set. Set it in your environment to use the OpenAI reranker, " +
          "e.g. `export OPENAI_API_KEY=sk-...`."
      );
    }
  }

  async rerank(query: string, candidates: RerankCandidate[]): Promise<RerankVerdict[]> {
    if (candidates.length === 0) return [];

    const { default: OpenAI } = await import("openai");
    const client = new OpenAI();

    const candidateList = candidates
      .map((c, i) => `${i + 1}. id="${c.id}" (${c.filePath} lines ${c.startLine}-${c.endLine})\n${c.text}`)
      .join("\n\n");

    const response = await client.chat.completions.create({
      model: this.model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: RERANK_SYSTEM_PROMPT },
        { role: "user", content: `Task: ${query}\n\nCandidates:\n\n${candidateList}` },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    let parsed: { verdicts?: RerankVerdict[] };
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Model returned unparseable output — fail safe by keeping everything
      // rather than silently dropping content the user would want to see.
      return candidates.map((c) => ({ id: c.id, keep: true, reason: "reranker response unparseable; kept by default" }));
    }

    const verdictById = new Map((parsed.verdicts ?? []).map((v) => [v.id, v]));
    return candidates.map((c) => {
      const v = verdictById.get(c.id);
      return v ?? { id: c.id, keep: true, reason: "not evaluated by reranker; kept by default" };
    });
  }
}

/**
 * Same triage step as OpenAIRerankProvider, backed by a cheap Claude model
 * instead. Anthropic has no public embeddings API (Voyage AI is Anthropic's
 * recommended partner for that), so this only covers the rerank/triage half
 * of the pipeline -- embeddings still need `--provider openai` today. Uses
 * a forced tool call instead of prompted JSON so the response is always
 * well-formed, since Anthropic's API has no dedicated "JSON mode".
 */
export class AnthropicRerankProvider implements RerankProvider {
  constructor(private model = "claude-haiku-4-5") {
    if (!process.env.ANTHROPIC_API_KEY) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Set it in your environment to use the Anthropic reranker, " +
          "e.g. `export ANTHROPIC_API_KEY=sk-ant-...`."
      );
    }
  }

  async rerank(query: string, candidates: RerankCandidate[]): Promise<RerankVerdict[]> {
    if (candidates.length === 0) return [];

    const { default: Anthropic } = await import("@anthropic-ai/sdk");
    const client = new Anthropic();

    const candidateList = candidates
      .map((c, i) => `${i + 1}. id="${c.id}" (${c.filePath} lines ${c.startLine}-${c.endLine})\n${c.text}`)
      .join("\n\n");

    const response = await client.messages.create({
      model: this.model,
      max_tokens: 4096,
      system: RERANK_SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Task: ${query}\n\nCandidates:\n\n${candidateList}` }],
      tools: [
        {
          name: "report_verdicts",
          description: "Report a keep/drop verdict with a one-sentence reason for every candidate snippet given.",
          input_schema: {
            type: "object",
            properties: {
              verdicts: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    keep: { type: "boolean" },
                    reason: { type: "string" },
                  },
                  required: ["id", "keep", "reason"],
                },
              },
            },
            required: ["verdicts"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "report_verdicts" },
    });

    const toolUse = response.content.find(
      (block): block is Extract<typeof block, { type: "tool_use" }> => block.type === "tool_use"
    );
    const verdicts = ((toolUse?.input as { verdicts?: RerankVerdict[] } | undefined)?.verdicts ?? []) as RerankVerdict[];
    const verdictById = new Map(verdicts.map((v) => [v.id, v]));
    return candidates.map((c) => verdictById.get(c.id) ?? { id: c.id, keep: true, reason: "not evaluated by reranker; kept by default" });
  }
}

export interface RerankResult {
  kept: ScoredChunk[];
  excluded: { chunk: Chunk; reason: string }[];
}

/**
 * Apply a reranker to the top `topN` scored chunks (bounded to control cost
 * on the paid path). Chunks beyond `topN` are untouched — reranking every
 * chunk in a large repo would defeat the point of it being the "cheap" step.
 */
export async function applyRerank(
  scoredChunks: ScoredChunk[],
  query: string,
  provider: RerankProvider,
  topN = 20
): Promise<RerankResult> {
  const candidates = scoredChunks.slice(0, topN);
  const rest = scoredChunks.slice(topN);

  if (candidates.length === 0) {
    return { kept: rest, excluded: [] };
  }

  const rerankCandidates: RerankCandidate[] = candidates.map((sc) => ({
    id: candidateId(sc.chunk),
    filePath: sc.chunk.filePath,
    startLine: sc.chunk.startLine,
    endLine: sc.chunk.endLine,
    text: sc.chunk.text,
  }));

  const verdicts = await provider.rerank(query, rerankCandidates);
  const verdictById = new Map(verdicts.map((v) => [v.id, v]));

  const kept: ScoredChunk[] = [];
  const excluded: { chunk: Chunk; reason: string }[] = [];

  for (const sc of candidates) {
    const verdict = verdictById.get(candidateId(sc.chunk));
    if (verdict && !verdict.keep) {
      excluded.push({ chunk: sc.chunk, reason: verdict.reason });
    } else {
      kept.push({
        ...sc,
        explain: sc.explain ? { ...sc.explain, llmReason: verdict?.reason } : sc.explain,
      });
    }
  }

  return { kept: [...kept, ...rest], excluded };
}
