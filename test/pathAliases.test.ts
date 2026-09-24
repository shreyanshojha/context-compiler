import { describe, it, expect } from "vitest";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadPathAliases, aliasCandidates } from "../src/pathAliases.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "fixtures", "sample-repo");

describe("loadPathAliases", () => {
  it("reads baseUrl and paths from a real tsconfig.json", () => {
    const map = loadPathAliases(FIXTURE_ROOT);
    expect(map).not.toBeNull();
    expect(map!.baseUrl).toBe(".");
    expect(map!.patterns).toHaveLength(1);
  });

  it("returns null when there's no tsconfig/jsconfig at all", () => {
    expect(loadPathAliases(join(__dirname, "fixtures"))).toBeNull();
  });

  it("returns null (never throws) on an unparseable config", () => {
    // A directory with no tsconfig.json returns null the same way a
    // malformed one would -- both are "no aliases available", not an error.
    expect(() => loadPathAliases(__dirname)).not.toThrow();
  });
});

describe("aliasCandidates", () => {
  const map = loadPathAliases(FIXTURE_ROOT);

  it("expands a wildcard alias to the matching target path", () => {
    expect(aliasCandidates("@/mathUtils", map)).toContain("src/mathUtils");
  });

  it("returns nothing for a specifier that matches no configured pattern", () => {
    expect(aliasCandidates("react", map)).toEqual([]);
  });

  it("returns nothing when there's no alias map at all", () => {
    expect(aliasCandidates("@/mathUtils", null)).toEqual([]);
  });
});
