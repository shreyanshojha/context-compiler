import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { chunkFile } from "../src/chunker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "fixtures", "sample-repo");

describe("chunkFile", () => {
  it("keeps a small file as a single whole-file chunk", () => {
    const chunks = chunkFile(FIXTURE_ROOT, "src/auth.ts");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].isWholeFile).toBe(true);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].text).toContain("validatePassword");
  });

  it("splits a large file into overlapping windows", () => {
    const chunks = chunkFile(FIXTURE_ROOT, "src/big.ts", {
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

  it("never produces a window larger than windowLines", () => {
    const chunks = chunkFile(FIXTURE_ROOT, "src/big.ts", {
      windowLines: 50,
      overlapLines: 10,
    });
    for (const c of chunks) {
      expect(c.endLine - c.startLine + 1).toBeLessThanOrEqual(50);
    }
  });
});
