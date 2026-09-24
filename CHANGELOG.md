# Changelog

All notable changes to this project. Full technical detail, stress-test data, and every bug's root cause live in [`TESTING.md`](./TESTING.md) — this file is the short version.

## 0.7.0

**Added**
- `context-compiler doctor` — a self-diagnostic command that checks Node version, whether both bin entries (`cli.js`, `mcpServer.js`) still have their required `#!/usr/bin/env node` shebang, whether they're marked executable, and which `node` binary is actually running — then prints a ready-to-paste `claude mcp add` command with real, resolved paths already filled in. Every check corresponds to a real bug this project hit shipping v0.6.5–0.6.8 (see below); this replaces what used to be an hour of manual diagnosis with one command.
- Local usage-metrics logging: every run (CLI or MCP) now logs its token usage to `.context-compiler-metrics.jsonl` in the scanned repo (opt out with `--no-log` / `logMetrics: false`). New `context-compiler stats` summarizes logged runs; new `context-compiler feedback hit|miss ["note"]` records whether a bundle had everything an agent needed. This is the actual instrumentation for the project's own PRD-defined v1 success metric (token usage + "miss rate"), which had been tracked as "not yet measured" since day one.
- Import graph: resolves tsconfig/jsconfig `paths` aliases (e.g. `@/utils` → `src/utils`, read from the same `compilerOptions.baseUrl`/`paths` a real bundler uses) — previously only genuinely relative imports (`./foo`, `../bar`) could resolve at all.
- Import graph: follows barrel re-export chains transitively (`export * from './x'`, any number of files deep), so importing something *through* a barrel file gets the same structural ranking boost as importing it directly. Previously a consumer only connected to the barrel itself, one hop short of the real implementation.

**Removed**
- The dev-only `.mcp.json` checked into the repo root — it caused a confusing (if harmless) "conflicting scopes" warning whenever `claude` was run from inside this repo, since it collided with a real user-scope MCP registration. Use `context-compiler doctor` or `claude mcp add` instead.

**Changed**
- README overhaul: documents the `claude mcp add` CLI setup path end-to-end (not just a hand-edited JSON config), the nvm/PATH "Failed to connect" root cause and fix, the new `doctor`/`stats`/`feedback` commands, and a short comparison against Aider's built-in repo-map and Cursor's proprietary indexing.

## 0.6.8

Version bump only — 0.6.7 got stuck "staged" on npm after an unanswered two-factor prompt mid-publish, which permanently blocks republishing that exact version number. No code changes from 0.6.7.

## 0.6.7

**Fixed**
- Missing `#!/usr/bin/env node` shebang on `src/mcpServer.ts`'s compiled output — `context-compiler-mcp` silently failed to launch when spawned directly (surfacing only as an opaque "Failed to connect" in Claude Code), while `context-compiler` worked fine, since only `cli.ts` had the shebang. Added a permanent regression test (`test/packaging.test.ts`) that checks both bin entries at the source level so this can't silently regress again.

## 0.6.6

**Fixed**
- Untracked a generated test-fixture cache file (`test/fixtures/sample-repo/.context-compiler-cache.json`) that had been accidentally committed before `.gitignore` covered it — `.gitignore` only blocks *new* untracked files, not ones already tracked, so this caused a real merge conflict for anyone else running the test suite locally.

## 0.6.5

**Fixed**
- Cross-provider embedding cache poisoning: the cache key was a plain hash of chunk text with no regard for which embedding provider/model produced the vector, so switching providers (or dimensions) on a repo with an existing cache could silently hand back a vector of the wrong length, crashing with `Vector length mismatch`. Found live, on a real machine, during real usage — not by a planned test. Fixed by folding a provider/model namespace into the cache key; old (v1) cache files are now detected and discarded cleanly rather than misread.

## 0.6.0 and earlier

Per-method/field-level chunking for oversized classes, multi-provider embeddings (OpenAI, Voyage AI) and rerank (OpenAI, Anthropic), real npm-publish packaging fixes (missing `files` allowlist, a `prepare` script that broke on a fresh tarball install, a three-way `--version` drift), and the initial CLI + MCP server. See `TESTING.md` for the complete bug-by-bug history from this period.
