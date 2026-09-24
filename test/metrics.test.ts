import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordRun, recordFeedback, readMetrics, summarizeMetrics, METRICS_FILENAME } from "../src/metrics.js";

const tempDirs: string[] = [];
function makeTempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "metrics-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("metrics", () => {
  it("appends one JSON line per recorded run", () => {
    const root = makeTempRoot();
    recordRun(root, { task: "a", budgetTokens: 8000, tokensUsed: 100, chunksIncluded: 2, chunksSkipped: 0 });
    recordRun(root, { task: "b", budgetTokens: 8000, tokensUsed: 200, chunksIncluded: 3, chunksSkipped: 1 });

    const raw = readFileSync(join(root, METRICS_FILENAME), "utf8");
    expect(raw.trim().split("\n")).toHaveLength(2);

    const entries = readMetrics(root);
    expect(entries).toHaveLength(2);
    expect(entries[0].type).toBe("run");
  });

  it("summarizes total runs and average token usage", () => {
    const root = makeTempRoot();
    recordRun(root, { task: "a", budgetTokens: 8000, tokensUsed: 100, chunksIncluded: 2, chunksSkipped: 0 });
    recordRun(root, { task: "b", budgetTokens: 8000, tokensUsed: 300, chunksIncluded: 3, chunksSkipped: 1 });

    const summary = summarizeMetrics(root);
    expect(summary.totalRuns).toBe(2);
    expect(summary.avgTokensUsed).toBe(200);
  });

  it("computes hit rate from recorded feedback", () => {
    const root = makeTempRoot();
    recordFeedback(root, "hit");
    recordFeedback(root, "hit");
    recordFeedback(root, "miss", "needed the config file too");

    const summary = summarizeMetrics(root);
    expect(summary.feedbackHits).toBe(2);
    expect(summary.feedbackMisses).toBe(1);
    expect(summary.hitRate).toBeCloseTo(2 / 3);
  });

  it("returns an empty, non-throwing summary when nothing has been logged yet", () => {
    const root = makeTempRoot();
    expect(readMetrics(root)).toEqual([]);
    const summary = summarizeMetrics(root);
    expect(summary.totalRuns).toBe(0);
    expect(summary.avgTokensUsed).toBeNull();
    expect(summary.hitRate).toBeNull();
  });

  it("skips a corrupted line instead of failing the whole read", () => {
    const root = makeTempRoot();
    recordRun(root, { task: "a", budgetTokens: 8000, tokensUsed: 100, chunksIncluded: 1, chunksSkipped: 0 });
    // Append a line that isn't valid JSON at all.
    appendFileSync(join(root, METRICS_FILENAME), "not valid json\n");
    recordRun(root, { task: "b", budgetTokens: 8000, tokensUsed: 200, chunksIncluded: 1, chunksSkipped: 0 });

    const entries = readMetrics(root);
    expect(entries).toHaveLength(2);
  });

  it("never throws when appending fails (e.g. an unwritable root)", () => {
    expect(() => recordRun("/no/such/directory/at/all", { task: "a", budgetTokens: 1, tokensUsed: 1, chunksIncluded: 0, chunksSkipped: 0 })).not.toThrow();
  });
});
