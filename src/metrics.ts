import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const METRICS_FILENAME = ".context-compiler-metrics.jsonl";

export interface RunMetric {
  type: "run";
  timestamp: string;
  task: string;
  budgetTokens: number;
  tokensUsed: number;
  chunksIncluded: number;
  chunksSkipped: number;
}

export interface FeedbackMetric {
  type: "feedback";
  timestamp: string;
  outcome: "hit" | "miss";
  note?: string;
}

export type MetricEntry = RunMetric | FeedbackMetric;

/**
 * Append-only local log of real usage. This is the actual data the
 * project's own PRD defines as its v1 success metric -- tokens used per real
 * task, and whether the agent still had to ask for something it wasn't
 * given -- which the PRD's own status tracking had marked "not yet
 * measured" since day one. Never sent anywhere: a plain JSONL file inside
 * the repo, gitignored and walker-excluded the same way the embedding cache
 * already is (see walker.ts's ALWAYS_SKIP_FILES).
 *
 * Logging failures are swallowed everywhere here on purpose -- metrics are a
 * nice-to-have observing the tool, never a reason to fail the actual command
 * that's doing real work.
 */
export function recordRun(root: string, entry: Omit<RunMetric, "type" | "timestamp">): void {
  appendMetric(root, { type: "run", timestamp: new Date().toISOString(), ...entry });
}

/**
 * Records whether the agent needed something beyond the compiled bundle --
 * the "miss rate" half of the PRD's v1 success metric. There's no automatic
 * way for the tool itself to know this (it can't see what the agent did
 * afterward), so it's recorded manually via `context-compiler feedback`.
 */
export function recordFeedback(root: string, outcome: "hit" | "miss", note?: string): void {
  appendMetric(root, { type: "feedback", timestamp: new Date().toISOString(), outcome, ...(note ? { note } : {}) });
}

function appendMetric(root: string, entry: MetricEntry): void {
  try {
    appendFileSync(join(root, METRICS_FILENAME), JSON.stringify(entry) + "\n", "utf8");
  } catch {
    // Best-effort; see file header.
  }
}

/** Reads and parses every valid line; a corrupted line is skipped, not fatal. */
export function readMetrics(root: string): MetricEntry[] {
  const path = join(root, METRICS_FILENAME);
  if (!existsSync(path)) return [];

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }

  const entries: MetricEntry[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed) as MetricEntry);
    } catch {
      // Skip a corrupted line rather than failing the whole read.
    }
  }
  return entries;
}

export interface MetricsSummary {
  totalRuns: number;
  avgTokensUsed: number | null;
  avgBudgetTokens: number | null;
  feedbackHits: number;
  feedbackMisses: number;
  hitRate: number | null;
}

export function summarizeMetrics(root: string): MetricsSummary {
  const entries = readMetrics(root);
  const runs = entries.filter((e): e is RunMetric => e.type === "run");
  const feedback = entries.filter((e): e is FeedbackMetric => e.type === "feedback");
  const hits = feedback.filter((f) => f.outcome === "hit").length;
  const misses = feedback.filter((f) => f.outcome === "miss").length;

  return {
    totalRuns: runs.length,
    avgTokensUsed: runs.length ? average(runs.map((r) => r.tokensUsed)) : null,
    avgBudgetTokens: runs.length ? average(runs.map((r) => r.budgetTokens)) : null,
    feedbackHits: hits,
    feedbackMisses: misses,
    hitRate: hits + misses > 0 ? hits / (hits + misses) : null,
  };
}

function average(nums: number[]): number {
  return nums.reduce((sum, n) => sum + n, 0) / nums.length;
}
