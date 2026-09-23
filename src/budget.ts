import { encode } from "gpt-tokenizer";
import type { Chunk } from "./chunker.js";

/** Count tokens in a string using the same tokenizer family the target LLMs use. */
export function countTokens(text: string): number {
  return encode(text).length;
}

export interface ScoreExplanation {
  /** Raw cosine similarity between the query and this chunk, before any bonus. */
  semanticScore: number;
  /** Flat bonus added because this chunk's file is import-connected to a top semantic hit. */
  structuralBonus: number;
  /** Which top-ranked "seed" files this chunk's file is import-connected to, if any. */
  connectedTo: string[];
  /** Short reason from the optional LLM reranker, if that pass ran and evaluated this chunk. */
  llmReason?: string;
}

export interface ScoredChunk {
  chunk: Chunk;
  /** Final relevance score used for ranking/selection (semantic + structural bonus). */
  score: number;
  /** Present when ranked with rankChunks — explains how `score` was derived. */
  explain?: ScoreExplanation;
  /** True if this chunk was force-included via --pin rather than earning its place by ranking. */
  pinned?: boolean;
}

export interface BudgetSelection {
  selected: ScoredChunk[];
  totalTokens: number;
  /** Chunks that were skipped because they didn't fit within the remaining budget. */
  skipped: ScoredChunk[];
}

/**
 * Greedily select the highest-scoring chunks that fit within a token budget.
 * Chunks are considered in descending score order; a chunk that doesn't fit
 * in the remaining budget is skipped (not a hard stop) so smaller, lower-
 * ranked chunks later in the list still get a chance to fill leftover space.
 */
export function selectWithinBudget(scoredChunks: ScoredChunk[], budgetTokens: number): BudgetSelection {
  if (budgetTokens <= 0) {
    return { selected: [], totalTokens: 0, skipped: [...scoredChunks] };
  }

  const sorted = [...scoredChunks].sort((a, b) => b.score - a.score);
  const selected: ScoredChunk[] = [];
  const skipped: ScoredChunk[] = [];
  let totalTokens = 0;

  for (const sc of sorted) {
    const tokens = countTokens(sc.chunk.text);
    if (totalTokens + tokens <= budgetTokens) {
      selected.push(sc);
      totalTokens += tokens;
    } else {
      skipped.push(sc);
    }
  }

  return { selected, totalTokens, skipped };
}
