import type { BudgetSelection, ScoredChunk } from "./budget.js";
import type { Chunk } from "./chunker.js";

export interface BundleMeta {
  query: string;
  budgetTokens: number;
  root: string;
  /** Candidates the optional LLM reranker explicitly dropped, with its reason — shown for transparency. */
  excludedByRerank?: { chunk: Chunk; reason: string }[];
}

const LANGUAGE_BY_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".rb": "ruby",
  ".md": "markdown",
  ".json": "json",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".sh": "bash",
};

/**
 * Format a budget selection into a single markdown context bundle:
 * a summary of what was included (in relevance order), followed by the
 * actual file contents (grouped by file, in file order) ready to hand to a
 * coding agent.
 */
export function formatBundle(selection: BudgetSelection, meta: BundleMeta): string {
  const { selected, totalTokens, skipped } = selection;

  const lines: string[] = [];
  lines.push(`# Context Bundle`);
  lines.push("");
  lines.push(`- **Task:** ${meta.query}`);
  lines.push(`- **Repo:** ${meta.root}`);
  lines.push(`- **Token budget:** ${meta.budgetTokens}`);
  lines.push(`- **Tokens used:** ${totalTokens}`);
  const excluded = meta.excludedByRerank ?? [];
  const notes: string[] = [];
  if (skipped.length > 0) notes.push(`${skipped.length} skipped — didn't fit budget`);
  if (excluded.length > 0) notes.push(`${excluded.length} excluded by relevance check`);
  lines.push(`- **Chunks included:** ${selected.length}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`);
  lines.push("");

  if (selected.length === 0) {
    lines.push("_No chunks fit within the given token budget._");
    appendExcludedSection(lines, excluded);
    return lines.join("\n").trimEnd() + "\n";
  }

  lines.push("## Files included (by relevance)");
  lines.push("");
  const byRelevance = [...selected].sort((a, b) => b.score - a.score);
  for (const sc of byRelevance) {
    lines.push(
      `- \`${sc.chunk.filePath}\` (lines ${sc.chunk.startLine}-${sc.chunk.endLine}) — ${explainWhy(sc)}`
    );
  }
  lines.push("");

  lines.push("## Content");
  lines.push("");

  const byFile = groupByFile(selected.map((s) => s.chunk));
  for (const [filePath, chunks] of byFile) {
    const lang = languageFor(filePath);
    lines.push(`### ${filePath}`);
    lines.push("");
    for (const chunk of chunks) {
      if (!chunk.isWholeFile) {
        lines.push(`_lines ${chunk.startLine}-${chunk.endLine}_`);
        lines.push("");
      }
      lines.push("```" + lang);
      lines.push(chunk.text);
      lines.push("```");
      lines.push("");
    }
  }

  appendExcludedSection(lines, excluded);

  return lines.join("\n").trimEnd() + "\n";
}

function appendExcludedSection(lines: string[], excluded: { chunk: Chunk; reason: string }[]): void {
  if (excluded.length === 0) return;
  lines.push("## Excluded by relevance check");
  lines.push("");
  lines.push("_These looked relevant by semantic/structural score, but a second (cheap-model) pass judged them not needed for this task:_");
  lines.push("");
  for (const { chunk, reason } of excluded) {
    lines.push(`- \`${chunk.filePath}\` (lines ${chunk.startLine}-${chunk.endLine}) — ${reason}`);
  }
  lines.push("");
}

function groupByFile<T extends { filePath: string; startLine: number }>(chunks: T[]): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const chunk of chunks) {
    const list = map.get(chunk.filePath) ?? [];
    list.push(chunk);
    map.set(chunk.filePath, list);
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.startLine - b.startLine);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** Human-readable one-liner for why a chunk was included — the explainability feature. */
function explainWhy(sc: ScoredChunk): string {
  if (sc.pinned) return "pinned (always included)";
  if (!sc.explain) return `score ${sc.score.toFixed(3)}`;

  const { semanticScore, structuralBonus, connectedTo, llmReason } = sc.explain;
  const parts: string[] = [];
  if (structuralBonus > 0) {
    parts.push(`semantic ${semanticScore.toFixed(3)} + connected to ${connectedTo.map((f) => `\`${f}\``).join(", ")}`);
  } else {
    parts.push("semantic match");
  }
  if (llmReason) parts.push(`relevance check: ${llmReason}`);
  return `score ${sc.score.toFixed(3)} (${parts.join("; ")})`;
}

function languageFor(filePath: string): string {
  const idx = filePath.lastIndexOf(".");
  if (idx === -1) return "";
  const ext = filePath.slice(idx).toLowerCase();
  return LANGUAGE_BY_EXT[ext] ?? "";
}
