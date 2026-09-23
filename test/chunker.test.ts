import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chunkFile, splitLines } from "../src/chunker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "fixtures", "sample-repo");

describe("chunkFile", () => {
  it("keeps a small file as a single whole-file chunk", async () => {
    const chunks = await chunkFile(FIXTURE_ROOT, "src/auth.ts");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].isWholeFile).toBe(true);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].text).toContain("validatePassword");
  });

  it("splits a large file with no real function boundaries into overlapping windows (regex/line-window fallback)", async () => {
    // src/big.ts is 299 flat `const xN = N;` statements -- no functions or
    // classes at all, so AST-boundary chunking has nothing to align to and
    // must degrade to the exact same fixed-size window behavior as before.
    const chunks = await chunkFile(FIXTURE_ROOT, "src/big.ts", {
      wholeFileLineThreshold: 120,
      windowLines: 120,
      overlapLines: 20,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => !c.isWholeFile)).toBe(true);

    // Windows should be contiguous with overlap, and cover the whole file.
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[chunks.length - 1].endLine).toBe(300);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].startLine).toBeLessThanOrEqual(chunks[i - 1].endLine);
    }
  });

  it("never produces a window larger than windowLines", async () => {
    const chunks = await chunkFile(FIXTURE_ROOT, "src/big.ts", {
      windowLines: 50,
      overlapLines: 10,
    });
    for (const c of chunks) {
      expect(c.endLine - c.startLine + 1).toBeLessThanOrEqual(50);
    }
  });

  it("REGRESSION: keeps a function whole instead of cutting it in half at a fixed line offset", async () => {
    // src/manyFunctions.ts has several ~30-line top-level functions. With a
    // window size of 40 and no boundary awareness, a plain line-window split
    // would start new windows at fixed 40-line offsets and could easily land
    // mid-function. With AST-based chunking, every function's full body is
    // provably still contained within exactly one chunk's line range.
    const chunks = await chunkFile(FIXTURE_ROOT, "src/manyFunctions.ts", {
      wholeFileLineThreshold: 20,
      windowLines: 40,
      overlapLines: 5,
    });
    expect(chunks.length).toBeGreaterThan(1);

    const text = await import("node:fs").then((fs) =>
      fs.readFileSync(join(FIXTURE_ROOT, "src/manyFunctions.ts"), "utf8")
    );
    const lines = text.split("\n");

    // Every top-level "function NAME(" line must fall inside a chunk whose
    // range also extends at least to that function's own closing brace --
    // i.e. no chunk boundary falls strictly inside a function's body. (The
    // blank separator line after a function is allowed to land in the next
    // filler/boundary chunk instead; that's a real, harmless split point.)
    const functionStarts = lines
      .map((line, i) => ({ line, num: i + 1 }))
      .filter((l) => /^function \w+\(/.test(l.line));

    for (const fn of functionStarts) {
      let closingBraceLine = fn.num;
      for (let i = fn.num; i < lines.length; i++) {
        if (lines[i] === "}") {
          closingBraceLine = i + 1;
          break;
        }
      }
      const containingChunk = chunks.find((c) => c.startLine <= fn.num && c.endLine >= fn.num);
      expect(containingChunk).toBeDefined();
      expect(containingChunk!.endLine).toBeGreaterThanOrEqual(closingBraceLine);
    }
  });

  it("REGRESSION: packs many tiny top-level exports together instead of one chunk per statement", async () => {
    // Found on a real stress test against axios: every one-line
    // `export const X = ...` / one-line type declaration was becoming its
    // own chunk (247 chunks for a query that used to produce 16), because
    // each `export_statement` is a boundary in its own right regardless of
    // size. src/manySmallExports.ts is 50 one-line `export const` statements
    // -- packSegments must merge these back together up to windowLines
    // rather than emitting 50 near-empty chunks.
    const chunks = await chunkFile(FIXTURE_ROOT, "src/manySmallExports.ts", {
      wholeFileLineThreshold: 20,
      windowLines: 40,
      overlapLines: 5,
    });
    expect(chunks.length).toBeLessThan(10); // 50 lines packed into ~40-line windows, not 50 chunks
    for (const c of chunks) {
      expect(c.endLine - c.startLine + 1).toBeGreaterThan(1); // no lone one-line chunks
    }
  });

  it("REGRESSION: a file's own trailing newline never produces a phantom extra chunk", async () => {
    // Found via a real-world stress test against Angular's core/common/forms
    // packages: 43 chunks across the run were nothing but a single empty
    // line, one past the file's real content. Cause: `text.split("\n")` on a
    // file ending in "\n" (nearly all of them) always adds one synthetic
    // empty trailing element -- treated as a real extra line, it became its
    // own filler segment whenever the chunk before it in the packing pass
    // was already at windowLines capacity and couldn't absorb it.
    // src/manyFunctions.ts already ends in "\n" (as `Write` always leaves
    // files); windowLines=40 with several ~30-line functions reliably lands
    // a chunk at or near capacity right before EOF.
    const chunks = await chunkFile(FIXTURE_ROOT, "src/manyFunctions.ts", {
      wholeFileLineThreshold: 20,
      windowLines: 40,
      overlapLines: 5,
    });
    for (const c of chunks) {
      expect(c.text.trim().length).toBeGreaterThan(0);
    }
  });

  it("REGRESSION: never returns a chunk that's nothing but blank lines, across every fixture in the repo", async () => {
    // Found via a real-world stress test against Django's db/forms/core
    // packages: a handful of two-line chunks that were nothing but a blank
    // line gap between two class members, orphaned because the chunk before
    // them in the packing pass was already at windowLines capacity and
    // couldn't absorb the gap. A whitespace-only chunk is worse than no
    // chunk -- it still costs an embedding call for zero information.
    // Exercised here as a blanket property across every real fixture file
    // (several different window sizes, to vary where a packed segment lands
    // relative to capacity) rather than one hand-crafted repro, since the
    // original bug only showed up on real code at a scale these fixtures
    // don't individually reach.
    const files = [
      "src/auth.ts",
      "src/bigClass.ts",
      "src/classEdgeCases.ts",
      "src/hugeMethodInClass.ts",
      "src/manyFunctions.ts",
      "src/manySmallExports.ts",
      "src/overloadedMethods.ts",
      "pyutils/big_class.py",
      "pyutils/helpers.py",
      "pyutils/main.py",
    ];
    for (const windowLines of [15, 20, 40, 80]) {
      for (const file of files) {
        const chunks = await chunkFile(FIXTURE_ROOT, file, {
          wholeFileLineThreshold: 10,
          windowLines,
          overlapLines: Math.max(1, Math.floor(windowLines / 8)),
        });
        for (const c of chunks) {
          expect(c.text.trim().length, `${file} @ windowLines=${windowLines}: empty chunk at ${c.startLine}-${c.endLine}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("falls back to line-window splitting for a language with no tree-sitter grammar", async () => {
    // .rs (Rust) has no bundled grammar -- buildAstChunks returns null for
    // it, and chunkFile must fall back cleanly rather than throwing.
    const chunks = await chunkFile(FIXTURE_ROOT, "src/large.rs", {
      wholeFileLineThreshold: 20,
      windowLines: 40,
      overlapLines: 5,
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => !c.isWholeFile)).toBe(true);
  });
});

describe("splitLines", () => {
  it("drops the single synthetic trailing element a file-ending newline adds", () => {
    expect(splitLines("a\nb\n")).toEqual(["a", "b"]);
  });

  it("leaves line count unchanged when the file has no trailing newline", () => {
    expect(splitLines("a\nb")).toEqual(["a", "b"]);
  });

  it("preserves real blank lines the author left before EOF -- only the one synthetic entry is dropped", () => {
    expect(splitLines("a\nb\n\n")).toEqual(["a", "b", ""]);
  });

  it("handles an empty file", () => {
    expect(splitLines("")).toEqual([""]);
  });

  it("handles a file that is just one newline", () => {
    expect(splitLines("\n")).toEqual([""]);
  });
});
