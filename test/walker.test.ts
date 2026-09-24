import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync, rmSync } from "node:fs";
import { walkRepo } from "../src/walker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "fixtures", "sample-repo");

describe("walkRepo", () => {
  it("returns only non-ignored, non-binary text files", () => {
    // .gitignore itself is a legitimate small text file and isn't excluded by
    // any rule (it doesn't ignore itself) — relevance filtering is the
    // ranker's job, not the walker's.
    const files = walkRepo({ root: FIXTURE_ROOT });
    expect(files).toEqual([
      ".gitignore",
      "README.md",
      "pyutils/__init__.py",
      "pyutils/big_class.py",
      "pyutils/helpers.py",
      "pyutils/main.py",
      "src/aliasConsumer.ts",
      "src/auth.ts",
      "src/barrel.ts",
      "src/barrelConsumer.ts",
      "src/big.ts",
      "src/bigClass.ts",
      "src/calculator.ts",
      "src/classEdgeCases.ts",
      "src/deepImpl.ts",
      "src/hugeMethodInClass.ts",
      "src/hugeSingleLine.ts",
      "src/index.ts",
      "src/large.rs",
      "src/manyFunctions.ts",
      "src/manySmallExports.ts",
      "src/mathUtils.ts",
      "src/nope.ts",
      "src/overloadedMethods.ts",
      "src/regexFalsePositive.ts",
      "tsconfig.json",
    ]);
  });

  it("excludes node_modules and build even without explicit .gitignore rule for node_modules name", () => {
    const files = walkRepo({ root: FIXTURE_ROOT });
    expect(files.some((f) => f.includes("node_modules"))).toBe(false);
    expect(files.some((f) => f.includes("build/"))).toBe(false);
  });

  it("excludes gitignored *.log files", () => {
    const files = walkRepo({ root: FIXTURE_ROOT });
    expect(files).not.toContain("debug.log");
  });

  it("excludes binary files by extension", () => {
    const files = walkRepo({ root: FIXTURE_ROOT });
    expect(files.some((f) => f.endsWith(".png"))).toBe(false);
  });

  it("REGRESSION: excludes binary content even on an extension not in the binary list", () => {
    // Found via a real-world test with real OpenAI embeddings: this
    // project's own bundled .wasm grammar files weren't on the extension
    // list, got walked as text, and the resulting UTF-8-decode garbage was
    // dense enough to blow past OpenAI's per-input token limit and hard-fail
    // the run. An extension list can never enumerate every binary format --
    // src/mystery.customfmt simulates exactly that: a NUL-prefixed binary
    // file on an extension nothing in BINARY_EXTENSIONS recognizes. Content
    // sniffing (a NUL byte in the first 8KB) is the actual fix.
    const files = walkRepo({ root: FIXTURE_ROOT });
    expect(files).not.toContain("src/mystery.customfmt");
  });

  it("always excludes its own embedding cache file, even if not gitignored", () => {
    // Regression test: without this, running the tool writes a cache file
    // into the repo, which the *next* run's walker then picks up as a new
    // candidate file — silently changing chunk counts between identical runs.
    const files = walkRepo({ root: FIXTURE_ROOT, extraIgnores: [] });
    expect(files).not.toContain(".context-compiler-cache.json");
  });

  it("always excludes its own local usage-metrics log, even if not gitignored", () => {
    // Same category of self-generated file as the cache above (see
    // metrics.ts). Written and removed within the test itself, rather than
    // committed as a permanent fixture, since other tests (cli.test.ts,
    // mcpServer.test.ts) copy/read this same shared fixture directory and
    // assume a repo with no metrics history yet.
    const metricsPath = join(FIXTURE_ROOT, ".context-compiler-metrics.jsonl");
    writeFileSync(metricsPath, '{"type":"run"}\n', "utf8");
    try {
      const files = walkRepo({ root: FIXTURE_ROOT, extraIgnores: [] });
      expect(files).not.toContain(".context-compiler-metrics.jsonl");
    } finally {
      rmSync(metricsPath);
    }
  });

  it("respects extraIgnores", () => {
    const files = walkRepo({ root: FIXTURE_ROOT, extraIgnores: ["README.md"] });
    expect(files).not.toContain("README.md");
  });
});
