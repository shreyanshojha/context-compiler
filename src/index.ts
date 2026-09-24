import { walkRepo } from "./walker.js";
import { chunkFiles, chunkFile, type Chunk, type ChunkOptions } from "./chunker.js";
import { rankChunks, type RankOptions } from "./ranker.js";
import { selectWithinBudget, countTokens, type BudgetSelection, type ScoredChunk } from "./budget.js";
import { formatBundle } from "./output.js";
import { buildImportGraph } from "./importGraph.js";
import { applyRerank, type RerankProvider } from "./rerank.js";
import type { EmbeddingProvider } from "./embeddings.js";

export interface CompileOptions {
  root: string;
  query: string;
  budgetTokens: number;
  provider: EmbeddingProvider;
  extraIgnores?: string[];
  chunkOptions?: ChunkOptions;
  /** Repo-relative paths to always include, in full, before ranking anything else. */
  pinnedFiles?: string[];
  /** Boost chunks import-connected to a top semantic hit. Default true. */
  useStructuralBoost?: boolean;
  structuralWeight?: number;
  seedCount?: number;
  /**
   * Optional second pass: a cheap chat model reviews the top-ranked
   * candidates and can drop ones that only look relevant on paper. This is
   * the "cheap model finds it, your real coding model uses it" step — it
   * never touches pinned files, and it costs real (if inexpensive) API
   * calls, so it's opt-in.
   */
  rerankProvider?: RerankProvider;
  rerankTopN?: number;
}

export interface CompileResult {
  bundle: string;
  selection: BudgetSelection;
  filesConsidered: number;
  chunksConsidered: number;
}

/**
 * Run the full pipeline: walk the repo, pin any always-include files, chunk
 * and rank the rest against the query (with an optional import-graph
 * structural boost), select the best-fitting chunks within the remaining
 * budget, and format the result as a context bundle.
 */
export async function compileContext(options: CompileOptions): Promise<CompileResult> {
  const files = walkRepo({ root: options.root, extraIgnores: options.extraIgnores });
  const pinnedSet = new Set(options.pinnedFiles ?? []);

  const pinnedChunks = await chunkPinnedFiles(options.root, options.pinnedFiles ?? []);
  const pinnedScored: ScoredChunk[] = pinnedChunks.map((chunk) => ({
    chunk,
    score: Number.POSITIVE_INFINITY,
    pinned: true,
  }));
  const pinnedTokens = pinnedChunks.reduce((sum, c) => sum + countTokens(c.text), 0);

  const rankableFiles = files.filter((f) => !pinnedSet.has(f));
  const chunks = await chunkFiles(options.root, rankableFiles, options.chunkOptions);

  const rankOptions: RankOptions = {};
  if (options.useStructuralBoost ?? true) {
    rankOptions.importGraph = await buildImportGraph(options.root, files);
    if (options.structuralWeight !== undefined) rankOptions.structuralWeight = options.structuralWeight;
    if (options.seedCount !== undefined) rankOptions.seedCount = options.seedCount;
  }

  let ranked = await rankChunks(chunks, options.query, options.provider, rankOptions);

  let excludedByRerank: { chunk: Chunk; reason: string }[] = [];
  if (options.rerankProvider) {
    const rerankResult = await applyRerank(ranked, options.query, options.rerankProvider, options.rerankTopN);
    ranked = rerankResult.kept;
    excludedByRerank = rerankResult.excluded;
  }

  const remainingBudget = Math.max(0, options.budgetTokens - pinnedTokens);
  const rankedSelection = selectWithinBudget(ranked, remainingBudget);

  const selection: BudgetSelection = {
    selected: [...pinnedScored, ...rankedSelection.selected],
    totalTokens: pinnedTokens + rankedSelection.totalTokens,
    skipped: rankedSelection.skipped,
  };

  const bundle = formatBundle(selection, {
    query: options.query,
    budgetTokens: options.budgetTokens,
    root: options.root,
    excludedByRerank,
  });

  return {
    bundle,
    selection,
    filesConsidered: files.length,
    chunksConsidered: chunks.length + pinnedChunks.length,
  };
}

async function chunkPinnedFiles(root: string, pinnedFiles: string[]): Promise<Chunk[]> {
  // Pinned files are included whole, regardless of size — the point of
  // pinning is "always give the agent this entire file," not a ranked slice.
  const perFile = await Promise.all(
    pinnedFiles.map((relPath) => chunkFile(root, relPath, { wholeFileLineThreshold: Number.MAX_SAFE_INTEGER }))
  );
  return perFile.flat();
}

export { walkRepo } from "./walker.js";
export { chunkFile, chunkFiles, type Chunk, type ChunkOptions } from "./chunker.js";
export { rankChunks, cosineSimilarity, type RankOptions } from "./ranker.js";
export {
  selectWithinBudget,
  countTokens,
  type ScoredChunk,
  type BudgetSelection,
  type ScoreExplanation,
} from "./budget.js";
export { formatBundle, type BundleMeta } from "./output.js";
export { FakeEmbeddingProvider, OpenAIEmbeddingProvider, type EmbeddingProvider } from "./embeddings.js";
export { buildImportGraph, buildImportGraphRegex, ImportGraph } from "./importGraph.js";
export { buildAstImportGraph } from "./astImportGraph.js";
export { loadPathAliases, aliasCandidates, type PathAliasMap } from "./pathAliases.js";
export { runDoctor, type DoctorReport, type DoctorCheck } from "./doctor.js";
export {
  recordRun,
  recordFeedback,
  readMetrics,
  summarizeMetrics,
  type MetricEntry,
  type MetricsSummary,
} from "./metrics.js";
export {
  FakeRerankProvider,
  OpenAIRerankProvider,
  applyRerank,
  candidateId,
  type RerankProvider,
  type RerankCandidate,
  type RerankVerdict,
} from "./rerank.js";
