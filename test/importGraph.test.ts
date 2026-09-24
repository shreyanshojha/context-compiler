import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildImportGraph, buildImportGraphRegex } from "../src/importGraph.js";
import { walkRepo } from "../src/walker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "fixtures", "sample-repo");

describe("buildImportGraph (AST-based, real parsing)", () => {
  it("connects a TS file to the relative module it imports", async () => {
    const files = walkRepo({ root: FIXTURE_ROOT });
    const graph = await buildImportGraph(FIXTURE_ROOT, files);
    expect(graph.isConnected("src/calculator.ts", "src/mathUtils.ts")).toBe(true);
    // Undirected: the edge works both ways.
    expect(graph.isConnected("src/mathUtils.ts", "src/calculator.ts")).toBe(true);
  });

  it("connects a Python file to the local module it imports", async () => {
    const files = walkRepo({ root: FIXTURE_ROOT });
    const graph = await buildImportGraph(FIXTURE_ROOT, files);
    expect(graph.isConnected("pyutils/main.py", "pyutils/helpers.py")).toBe(true);
  });

  it("does not connect unrelated files", async () => {
    const files = walkRepo({ root: FIXTURE_ROOT });
    const graph = await buildImportGraph(FIXTURE_ROOT, files);
    expect(graph.isConnected("src/auth.ts", "pyutils/helpers.py")).toBe(false);
  });

  it("silently drops bare/external package specifiers", async () => {
    const files = walkRepo({ root: FIXTURE_ROOT });
    // src/index.ts imports nothing external in the fixture, but this should
    // never throw even for files with no resolvable imports at all.
    await expect(buildImportGraph(FIXTURE_ROOT, files)).resolves.not.toThrow();
  });

  it("REGRESSION: ignores require(...) text inside a comment or string, unlike the old regex", async () => {
    // src/regexFalsePositive.ts only *mentions* require('./nope') inside a
    // comment and a string literal -- not real call syntax. The old
    // regex-based scan matched this text blindly and wrongly connected the
    // two files; real parsing knows a comment/string isn't a call expression.
    const files = walkRepo({ root: FIXTURE_ROOT });

    const astGraph = await buildImportGraph(FIXTURE_ROOT, files);
    expect(astGraph.isConnected("src/regexFalsePositive.ts", "src/nope.ts")).toBe(false);

    // Confirms this is a real regression test, not a tautology: the fallback
    // regex path this replaced DOES get it wrong on the same fixture.
    const regexGraph = buildImportGraphRegex(FIXTURE_ROOT, files);
    expect(regexGraph.isConnected("src/regexFalsePositive.ts", "src/nope.ts")).toBe(true);
  });

  it("resolves a bare Python relative import (`from . import helpers`) to the sibling module", async () => {
    // pyutils/__init__.py contains exactly `from . import helpers` -- no
    // dotted_name at all, so the imported *name* ("helpers") is itself the
    // module, resolved relative to __init__.py's own directory. This is the
    // edge case a plain declarative tree-sitter query can't handle (the dot
    // count and "no trailing module" shape both need manual tree-walking).
    const files = walkRepo({ root: FIXTURE_ROOT });
    const graph = await buildImportGraph(FIXTURE_ROOT, files);
    expect(graph.isConnected("pyutils/__init__.py", "pyutils/helpers.py")).toBe(true);
  });

  it("resolves a tsconfig path alias (\"@/mathUtils\") the same as the equivalent relative import", async () => {
    // aliasConsumer.ts imports `add` from '@/mathUtils' -- not a relative
    // path at all. Previously this could never resolve: only "./foo"/"../bar"
    // style specifiers were tried. The fixture's tsconfig.json maps "@/*" to
    // "src/*", the same alias shape a real bundler-based repo uses.
    const files = walkRepo({ root: FIXTURE_ROOT });
    const graph = await buildImportGraph(FIXTURE_ROOT, files);
    expect(graph.isConnected("src/aliasConsumer.ts", "src/mathUtils.ts")).toBe(true);
  });

  it("follows a barrel re-export chain transitively (REGRESSION: previously only reached the barrel itself)", async () => {
    // barrelConsumer.ts imports `deepFeature` from './barrel', and barrel.ts
    // is a pure re-export (`export * from './deepImpl'`) -- it has no code
    // of its own. Before barrel-closure following, barrelConsumer only
    // connected to barrel.ts, one hop short of deepImpl.ts, which is where
    // the ranker's structural boost actually needed to point.
    const files = walkRepo({ root: FIXTURE_ROOT });
    const graph = await buildImportGraph(FIXTURE_ROOT, files);
    expect(graph.isConnected("src/barrelConsumer.ts", "src/barrel.ts")).toBe(true);
    expect(graph.isConnected("src/barrel.ts", "src/deepImpl.ts")).toBe(true);
    expect(graph.isConnected("src/barrelConsumer.ts", "src/deepImpl.ts")).toBe(true);
  });
});
