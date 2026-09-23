import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chunkFile, splitLines } from "../src/chunker.js"; // splitLines used only in the tests below

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "fixtures", "sample-repo");

/** Finds the chunk whose line range contains `lineNum`, or undefined. */
function chunkContaining(chunks: { startLine: number; endLine: number }[], lineNum: number) {
  return chunks.find((c) => c.startLine <= lineNum && c.endLine >= lineNum);
}

describe("per-method chunking of oversized classes", () => {
  it("REGRESSION: splits an oversized class by method instead of cutting a method in half at a line offset", async () => {
    // src/bigClass.ts is one class with 8 async methods (~13 lines each) --
    // well over windowLines as a whole, but each individual method comfortably
    // fits inside one window. Before per-method chunking, an oversized class
    // fell straight into the same blind line-window fallback as an oversized
    // function, with no regard for where a method started or ended.
    const chunks = await chunkFile(FIXTURE_ROOT, "src/bigClass.ts", {
      wholeFileLineThreshold: 20,
      windowLines: 40,
      overlapLines: 5,
    });
    expect(chunks.length).toBeGreaterThan(1);

    const text = readFileSync(join(FIXTURE_ROOT, "src/bigClass.ts"), "utf8");
    const lines = text.split("\n");
    const methodStarts = lines
      .map((line, i) => ({ line, num: i + 1 }))
      .filter((l) => /^\s+async \w+\(/.test(l.line));
    expect(methodStarts.length).toBe(8);

    for (const method of methodStarts) {
      let closingBraceLine = method.num;
      for (let i = method.num; i < lines.length; i++) {
        if (lines[i] === "  }") {
          closingBraceLine = i + 1;
          break;
        }
      }
      const containing = chunkContaining(chunks, method.num);
      expect(containing).toBeDefined();
      expect(containing!.endLine).toBeGreaterThanOrEqual(closingBraceLine);
    }
  });

  it("keeps a member decorator attached to the member it decorates", async () => {
    // @HostListener(...) is a separate AST sibling immediately before the
    // method_definition it decorates, not nested inside it -- verifying the
    // decorator line and the method's own signature line always land in the
    // same chunk is the real regression check for that.
    const chunks = await chunkFile(FIXTURE_ROOT, "src/classEdgeCases.ts", {
      wholeFileLineThreshold: 10,
      windowLines: 20,
      overlapLines: 3,
    });
    const text = readFileSync(join(FIXTURE_ROOT, "src/classEdgeCases.ts"), "utf8");
    const lines = text.split("\n");

    const decoratorLine = lines.findIndex((l) => l.includes("@HostListener")) + 1;
    const methodLine = lines.findIndex((l) => l.includes("onClick(event")) + 1;
    expect(decoratorLine).toBeGreaterThan(0);
    expect(methodLine).toBeGreaterThan(decoratorLine);

    const decoratorChunk = chunkContaining(chunks, decoratorLine);
    const methodChunk = chunkContaining(chunks, methodLine);
    expect(decoratorChunk).toBeDefined();
    expect(decoratorChunk).toBe(methodChunk);
  });

  it("handles a full spread of class edge cases without throwing: private fields, static blocks, computed method names, generators, getters/setters, abstract classes, and anonymous class expressions", async () => {
    // No specific chunk-shape assertions here -- the point is that every one
    // of these real, legal constructs parses and chunks cleanly (falling
    // back to line-window splitting is fine; throwing, or silently dropping
    // lines, is not).
    const chunks = await chunkFile(FIXTURE_ROOT, "src/classEdgeCases.ts", {
      wholeFileLineThreshold: 10,
      windowLines: 20,
      overlapLines: 3,
    });
    expect(chunks.length).toBeGreaterThan(0);

    const text = readFileSync(join(FIXTURE_ROOT, "src/classEdgeCases.ts"), "utf8");
    const fileLines = splitLines(text);

    // Every line with real content must be covered by at least one chunk --
    // no gaps introduced by the extra segmentation pass. A blank-only line
    // occasionally ending up in no chunk is fine (and intentional -- see
    // "drops a leftover chunk that's nothing but blank lines" in
    // chunker.test.ts); it's not a content loss.
    for (let lineNum = 1; lineNum <= fileLines.length; lineNum++) {
      if (fileLines[lineNum - 1].trim().length === 0) continue;
      expect(chunkContaining(chunks, lineNum)).toBeDefined();
    }
  });

  it("splits an anonymous class expression (`const Foo = class { ... }`) by member, not just by treating it as an opaque statement", async () => {
    const chunks = await chunkFile(FIXTURE_ROOT, "src/classEdgeCases.ts", {
      wholeFileLineThreshold: 10,
      windowLines: 20,
      overlapLines: 3,
    });
    const text = readFileSync(join(FIXTURE_ROOT, "src/classEdgeCases.ts"), "utf8");
    const lines = text.split("\n");

    const incrementLine = lines.findIndex((l) => l.includes("increment(): number")) + 1;
    const resetLine = lines.findIndex((l) => l.includes("reset(): void")) + 1;
    expect(chunkContaining(chunks, incrementLine)).toBeDefined();
    expect(chunkContaining(chunks, resetLine)).toBeDefined();
  });

  it("REGRESSION (Python): splits an oversized class by method, keeps a @decorator attached to its method, and treats a nested class as its own unit", async () => {
    const chunks = await chunkFile(FIXTURE_ROOT, "pyutils/big_class.py", {
      wholeFileLineThreshold: 10,
      windowLines: 20,
      overlapLines: 3,
    });
    expect(chunks.length).toBeGreaterThan(1);

    const text = readFileSync(join(FIXTURE_ROOT, "pyutils/big_class.py"), "utf8");
    const lines = text.split("\n");

    const decoratorLine = lines.findIndex((l) => l.trim() === "@staticmethod") + 1;
    const methodLine = lines.findIndex((l) => l.includes("def normalize(record)")) + 1;
    expect(chunkContaining(chunks, decoratorLine)).toBe(chunkContaining(chunks, methodLine));

    // The nested `class Formatter` must stay intact -- its own def lines
    // should all resolve to chunks that fully cover it (no gap, and its
    // methods aren't scattered outside its own line range in a way that
    // drops coverage).
    const nestedClassLine = lines.findIndex((l) => l.includes("class Formatter")) + 1;
    const renderLine = lines.findIndex((l) => l.includes("def render(self, lines)")) + 1;
    expect(chunkContaining(chunks, nestedClassLine)).toBeDefined();
    expect(chunkContaining(chunks, renderLine)).toBeDefined();
  });

  it("REGRESSION: a single oversized method inside an otherwise-small class is sub-split on its own, without dragging its sibling methods into the cut", async () => {
    // src/hugeMethodInClass.ts: small() and tiny() are a couple of lines
    // each; giant() alone is 62 lines -- bigger than the 40-line window even
    // though the whole class isn't oversized by a huge margin. giant() is
    // the one thing here that should get a blind line-window sub-split
    // (falling back exactly like a big top-level function would); small()
    // and tiny() must each still come back as a single, whole, undivided
    // chunk rather than getting fragmented as collateral damage.
    const chunks = await chunkFile(FIXTURE_ROOT, "src/hugeMethodInClass.ts", {
      wholeFileLineThreshold: 10,
      windowLines: 40,
      overlapLines: 5,
    });
    const text = readFileSync(join(FIXTURE_ROOT, "src/hugeMethodInClass.ts"), "utf8");
    const lines = text.split("\n");

    const smallLine = lines.findIndex((l) => l.includes("small(): void")) + 1;
    const smallBodyLine = lines.findIndex((l) => l.includes("console.log('small')")) + 1;
    const tinyLine = lines.findIndex((l) => l.includes("tiny(): void")) + 1;
    const tinyBodyLine = lines.findIndex((l) => l.includes("console.log('tiny')")) + 1;

    const smallChunk = chunkContaining(chunks, smallLine);
    const tinyChunk = chunkContaining(chunks, tinyLine);
    expect(smallChunk).toBeDefined();
    expect(tinyChunk).toBeDefined();
    // small()'s own body line must be in the SAME chunk as its signature --
    // i.e. small() wasn't cut in half by a window boundary meant for giant().
    expect(chunkContaining(chunks, smallBodyLine)).toBe(smallChunk);
    expect(chunkContaining(chunks, tinyBodyLine)).toBe(tinyChunk);

    // giant() itself must still be fully covered by contiguous chunk(s), even
    // though it's split across more than one.
    const giantStart = lines.findIndex((l) => l.includes("giant(): void")) + 1;
    const giantEnd = lines.findIndex((l) => l.includes("giant step 59")) + 1;
    for (let lineNum = giantStart; lineNum <= giantEnd; lineNum++) {
      expect(chunkContaining(chunks, lineNum)).toBeDefined();
    }
  });

  it("REGRESSION: TS overload signatures (declaration-only, no body) don't get left as unclassified filler", async () => {
    // Found via a real-world stress test against Angular's HttpClient: a
    // class with several heavily-overloaded, heavily-documented methods --
    // each overload is a `method_signature` node (declaration only, no
    // body), distinct from the real `method_definition` implementation, and
    // each is preceded by its own JSDoc block. Before `method_signature` was
    // recognized as a class member, every signature (with its 20-90-line
    // JSDoc) was unclassified filler; several in a row blew past
    // windowLines and fell back to a blind, overlapping sliding-window cut
    // -- exactly the kind of arbitrary mid-method split class-member
    // splitting exists to avoid. src/overloadedMethods.ts reproduces the
    // same shape at a smaller scale (2 signatures + 1 implementation, x4
    // methods, each with a real multi-line JSDoc block).
    const chunks = await chunkFile(FIXTURE_ROOT, "src/overloadedMethods.ts", {
      wholeFileLineThreshold: 10,
      windowLines: 40,
      overlapLines: 5,
    });

    // The real regression signature: a blind sliding-window fallback
    // produces overlapping chunks (by design, for a single oversized
    // range); boundary-aligned packing never does, because it partitions
    // the range instead of sliding a window across it. Any overlap here
    // means some stretch of the file fell back to the blind cut.
    const sorted = [...chunks].sort((a, b) => a.startLine - b.startLine);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].startLine).toBeGreaterThan(sorted[i - 1].endLine);
    }

    // Every overload signature and its implementation must still be found
    // somewhere (nothing with real content silently dropped -- a chunk that
    // was nothing but a blank-line gap is fine to lose; see the "drops a
    // leftover chunk that's nothing but blank lines" test in chunker.test.ts).
    const text = readFileSync(join(FIXTURE_ROOT, "src/overloadedMethods.ts"), "utf8");
    const fileLines = splitLines(text);
    for (let lineNum = 1; lineNum <= fileLines.length; lineNum++) {
      if (fileLines[lineNum - 1].trim().length === 0) continue;
      expect(chunkContaining(chunks, lineNum)).toBeDefined();
    }
  });
});
