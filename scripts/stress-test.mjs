// Real-world stress test: walks and chunks an arbitrary on-disk repo with
// the tool's own (built) pipeline and checks for the failure modes that
// only show up at real scale -- crashes, gaps in line coverage, chunks over
// the window size, and content-free chunks -- rather than asserting any
// specific chunk shape. This is how two of the bugs in TESTING.md's
// stress-test rounds were actually found; run it against a large cloned
// repo whenever chunking logic changes.
//
// Usage: npm run build && node scripts/stress-test.mjs <repoRoot>
import { walkRepo } from "../dist/walker.js";
import { chunkFile, splitLines } from "../dist/chunker.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) { console.error("usage: node scripts/stress-test.mjs <repoRoot>"); process.exit(1); }

const opts = { wholeFileLineThreshold: 120, windowLines: 120, overlapLines: 20 };

const t0 = Date.now();
const files = walkRepo({ root });
const t1 = Date.now();
console.log(`walked ${files.length} files in ${t1 - t0}ms`);

const errors = [];
const gapFiles = [];
const overflowFiles = []; // any chunk exceeding windowLines
const emptyChunkFiles = []; // any chunk with blank/empty text entirely
let totalChunks = 0;
let maxChunksInOneFile = { file: null, count: 0 };
const topByChunkCount = [];

const chunkStart = Date.now();
for (const relPath of files) {
  let chunks;
  try {
    chunks = await chunkFile(root, relPath, opts);
  } catch (err) {
    errors.push({ file: relPath, error: err.message });
    continue;
  }

  totalChunks += chunks.length;
  topByChunkCount.push({ file: relPath, count: chunks.length });
  if (chunks.length > maxChunksInOneFile.count) maxChunksInOneFile = { file: relPath, count: chunks.length };

  // Validate ranges
  const text = readFileSync(join(root, relPath), "utf8");
  const totalLines = splitLines(text).length;
  let hasOverflow = false;
  for (const c of chunks) {
    if (c.startLine > c.endLine) errors.push({ file: relPath, error: `inverted range ${c.startLine}-${c.endLine}` });
    if (c.endLine - c.startLine + 1 > opts.windowLines) hasOverflow = true;
    if (c.text.trim().length === 0) emptyChunkFiles.push(relPath);
  }
  if (hasOverflow) overflowFiles.push(relPath);

  // Coverage check: sorted chunks should have no gap containing real content
  // (allowing overlap), and should span 1..totalLines modulo blank-only
  // stretches at either end (those are now intentionally droppable -- see
  // dropEmptyChunks in chunker.ts).
  const fileLines = text.split("\n");
  const hasContent = (from, to) => {
    for (let i = from; i <= to && i <= fileLines.length; i++) {
      if (fileLines[i - 1] !== undefined && fileLines[i - 1].trim().length > 0) return true;
    }
    return false;
  };
  const sorted = [...chunks].sort((a, b) => a.startLine - b.startLine);
  if (sorted.length > 0) {
    if (sorted[0].startLine !== 1 && hasContent(1, sorted[0].startLine - 1)) {
      gapFiles.push({ file: relPath, reason: `starts at ${sorted[0].startLine}` });
    }
    if (sorted[sorted.length - 1].endLine !== totalLines && hasContent(sorted[sorted.length - 1].endLine + 1, totalLines)) {
      gapFiles.push({ file: relPath, reason: `ends at ${sorted[sorted.length-1].endLine} vs ${totalLines}` });
    }
    for (let i = 1; i < sorted.length; i++) {
      if (sorted[i].startLine > sorted[i - 1].endLine + 1 && hasContent(sorted[i - 1].endLine + 1, sorted[i].startLine - 1)) {
        gapFiles.push({ file: relPath, reason: `gap between line ${sorted[i-1].endLine} and ${sorted[i].startLine}` });
      }
    }
  }
}
const chunkEnd = Date.now();

console.log(`chunked ${files.length} files (${totalChunks} chunks total) in ${chunkEnd - chunkStart}ms`);
console.log(`errors: ${errors.length}`);
errors.slice(0, 20).forEach((e) => console.log(`  ERROR ${e.file}: ${e.error}`));
console.log(`gap/coverage issues: ${gapFiles.length}`);
gapFiles.slice(0, 20).forEach((g) => console.log(`  GAP ${g.file}: ${g.reason}`));
console.log(`chunks exceeding windowLines: ${overflowFiles.length}`);
overflowFiles.slice(0, 20).forEach((f) => console.log(`  OVERFLOW ${f}`));
console.log(`chunks with empty/whitespace-only text: ${emptyChunkFiles.length}`);
console.log(`max chunks in one file: ${maxChunksInOneFile.count} (${maxChunksInOneFile.file})`);

topByChunkCount.sort((a, b) => b.count - a.count);
console.log("\ntop 10 files by chunk count:");
for (const t of topByChunkCount.slice(0, 10)) console.log(`  ${t.count}\t${t.file}`);

console.log(`\nSUMMARY: files=${files.length} chunks=${totalChunks} errors=${errors.length} gaps=${gapFiles.length} overflow=${overflowFiles.length} emptyChunks=${emptyChunkFiles.length} walkMs=${t1-t0} chunkMs=${chunkEnd-chunkStart}`);
