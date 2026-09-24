import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Bundler/TS path-alias resolution for the import graph (e.g. "@/utils" ->
 * "src/utils"). Previously a documented known limitation: the import graph
 * only resolved genuinely relative specifiers ("./foo", "../bar"), so any
 * repo using tsconfig "paths" aliases lost the structural boost entirely for
 * every aliased import. Reads tsconfig.json/jsconfig.json's own
 * compilerOptions.baseUrl + paths -- the same config the TypeScript compiler
 * itself uses -- rather than inventing a separate config surface.
 */

export interface AliasPattern {
  /** Text before the pattern's "*", or the whole pattern if it has none. */
  prefix: string;
  /** Text after the pattern's "*", or "" if it has none. */
  suffix: string;
  /** Repo-root-relative (once joined with baseUrl) target templates, "*" preserved for substitution. */
  targets: string[];
}

export interface PathAliasMap {
  /** Repo-root-relative base directory paths are joined against. "." means the repo root itself. */
  baseUrl: string;
  patterns: AliasPattern[];
}

const CONFIG_CANDIDATES = ["tsconfig.json", "jsconfig.json"];

/**
 * Loads the first of tsconfig.json/jsconfig.json found at the repo root.
 * Returns null (not a throw) whenever there's nothing usable -- no config
 * file, no compilerOptions.paths, or a config this parser can't make sense
 * of -- since this is a ranking nudge, not a build tool: a repo with no
 * aliases, or an unparseable config, should just fall back to the existing
 * relative-only resolution rather than fail the run.
 */
export function loadPathAliases(root: string): PathAliasMap | null {
  for (const name of CONFIG_CANDIDATES) {
    const configPath = join(root, name);
    if (!existsSync(configPath)) continue;

    let raw: string;
    try {
      raw = readFileSync(configPath, "utf8");
    } catch {
      continue;
    }

    const parsed = parseJsonc(raw);
    const compilerOptions = parsed && typeof parsed === "object" ? (parsed as any).compilerOptions : undefined;
    if (!compilerOptions || typeof compilerOptions !== "object" || !compilerOptions.paths) continue;

    const baseUrl = typeof compilerOptions.baseUrl === "string" ? compilerOptions.baseUrl : ".";
    const patterns: AliasPattern[] = [];
    for (const [pattern, rawTargets] of Object.entries(compilerOptions.paths as Record<string, unknown>)) {
      if (!Array.isArray(rawTargets)) continue;
      const targets = rawTargets.filter((t): t is string => typeof t === "string");
      if (targets.length === 0) continue;

      const starIdx = pattern.indexOf("*");
      patterns.push(
        starIdx === -1
          ? { prefix: pattern, suffix: "", targets }
          : { prefix: pattern.slice(0, starIdx), suffix: pattern.slice(starIdx + 1), targets }
      );
    }

    if (patterns.length > 0) return { baseUrl, patterns };
  }
  return null;
}

/**
 * Repo-root-relative base paths (no extension yet -- the caller's own
 * CANDIDATE_EXTS loop appends those) that an aliased specifier could resolve
 * to. Empty array if there's no alias map, or the specifier matches no
 * configured pattern -- the caller's existing resolution still runs either way.
 */
export function aliasCandidates(specifier: string, aliasMap: PathAliasMap | null): string[] {
  if (!aliasMap) return [];
  const candidates: string[] = [];

  for (const { prefix, suffix, targets } of aliasMap.patterns) {
    if (!specifier.startsWith(prefix)) continue;
    const rest = specifier.slice(prefix.length);
    if (suffix) {
      if (!rest.endsWith(suffix)) continue;
    }
    const wildcardMatch = suffix ? rest.slice(0, rest.length - suffix.length) : rest;

    for (const target of targets) {
      const resolvedTarget = target.includes("*") ? target.replace("*", wildcardMatch) : target;
      candidates.push(aliasMap.baseUrl === "." ? resolvedTarget : `${aliasMap.baseUrl}/${resolvedTarget}`);
    }
  }

  return candidates;
}

/**
 * Real tsconfig.json files routinely have comments and trailing commas,
 * which JSON.parse rejects outright. Try strict JSON first (the common
 * case); only pay for the strip-and-retry when that fails.
 */
function parseJsonc(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    try {
      const stripped = raw
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1")
        .replace(/,(\s*[}\]])/g, "$1");
      return JSON.parse(stripped);
    } catch {
      return null;
    }
  }
}
