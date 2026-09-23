import type { Chunk } from "./chunker.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { ScoredChunk } from "./budget.js";
import type { ImportGraph } from "./importGraph.js";

/** Cosine similarity between two equal-length vectors. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

export interface RankOptions {
  /** When given, chunks import-connected to a top semantic hit get a flat score bonus. */
  importGraph?: ImportGraph;
  /** Size of the flat bonus. Kept small and additive so it nudges ties, never overrides a strong semantic mismatch. */
  structuralWeight?: number;
  /** How many top-scoring files (by their best chunk) count as "seeds" for the structural bonus. */
  seedCount?: number;
}

const DEFAULT_STRUCTURAL_WEIGHT = 0.05;
const DEFAULT_SEED_COUNT = 3;

/**
 * Rank chunks by relevance to a query string.
 *
 * Base signal is cosine similarity between the query's embedding and each
 * chunk's embedding (semantic relevance). When an import graph is supplied,
 * a second pass identifies the top `seedCount` files by their best semantic
 * score and gives a flat bonus to any chunk whose file is import-connected
 * to one of those seeds — catching files that matter to the task but don't
 * share vocabulary with the query or the seed file (e.g. a helper with
 * generic naming that's nonetheless the one thing the top hit calls).
 *
 * Every returned chunk carries `explain` so a caller can show why it was
 * picked, not just that it was.
 */
export async function rankChunks(
  chunks: Chunk[],
  query: string,
  provider: EmbeddingProvider,
  options: RankOptions = {}
): Promise<ScoredChunk[]> {
  if (chunks.length === 0) return [];

  const structuralWeight = options.structuralWeight ?? DEFAULT_STRUCTURAL_WEIGHT;
  const seedCount = options.seedCount ?? DEFAULT_SEED_COUNT;

  const [queryVector, ...chunkVectors] = await provider.embed([
    query,
    ...chunks.map((c) => c.text),
  ]);

  const semanticScores = chunks.map((chunk, i) => ({
    chunk,
    semanticScore: cosineSimilarity(queryVector, chunkVectors[i]),
  }));

  const seedFiles = options.importGraph ? topSeedFiles(semanticScores, seedCount) : [];

  const scored: ScoredChunk[] = semanticScores.map(({ chunk, semanticScore }) => {
    const connectedTo = options.importGraph
      ? seedFiles.filter(
          (seed) => seed !== chunk.filePath && options.importGraph!.isConnected(chunk.filePath, seed)
        )
      : [];
    const structuralBonus = connectedTo.length > 0 ? structuralWeight : 0;

    return {
      chunk,
      score: semanticScore + structuralBonus,
      explain: { semanticScore, structuralBonus, connectedTo },
    };
  });

  return scored.sort((a, b) => b.score - a.score);
}

function topSeedFiles(
  semanticScores: { chunk: Chunk; semanticScore: number }[],
  seedCount: number
): string[] {
  const bestPerFile = new Map<string, number>();
  for (const { chunk, semanticScore } of semanticScores) {
    const best = bestPerFile.get(chunk.filePath);
    if (best === undefined || semanticScore > best) {
      bestPerFile.set(chunk.filePath, semanticScore);
    }
  }
  return [...bestPerFile.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, seedCount)
    .map(([filePath]) => filePath);
}
