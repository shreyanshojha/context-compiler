# Testing & Benchmarks

This is the full technical record from building and stress-testing context-compiler: what was tested, what broke, what got fixed, and real numbers for the token/cost savings the tool produces. Unit/integration test counts and coverage areas are summarized here; the tests themselves live in `test/`.

## Automated test suite

116 tests across 15 files, all offline (no API keys or network required) except where noted (Round 7 below additionally validates the pipeline against real OpenAI and Anthropic API keys, outside the automated suite):

- `walker.test.ts`, `chunker.test.ts`, `astChunker.test.ts`, `budget.test.ts`, `output.test.ts`, `cache.test.ts`, `config.test.ts` — core pipeline stages. `astChunker.test.ts` covers per-method/per-field chunking of oversized classes specifically: decorators staying attached to the member they decorate, private fields, static init blocks, computed method names, generators, getters/setters, abstract classes, anonymous class expressions, TS overload groups, and Python nested classes.
- `embeddings.test.ts` — fake provider determinism/similarity behavior; `OpenAIEmbeddingProvider`/`VoyageEmbeddingProvider` clear-error-without-key checks; a mocked-network test that verifies the *actual* HTTP request `VoyageEmbeddingProvider` sends (endpoint, auth header, model, response re-ordering) without needing a real key.
- `rerank.test.ts` — `FakeRerankProvider` keyword-overlap logic (including a camelCase-splitting regression, see below); `OpenAIRerankProvider`/`AnthropicRerankProvider` clear-error-without-key checks; a mocked-network test that verifies the actual model string `AnthropicRerankProvider` sends to the Anthropic SDK (see the model-selection bug below); `applyRerank`'s topN bounding and explain-attaching behavior.
- `importGraph.test.ts` — the AST-based import graph (see below): real cross-file connections in TS and Python, a real regression test proving the AST path ignores a `require(...)` mentioned only in a comment/string (where the old regex fallback gets it wrong on the same fixture), and Python's bare relative-import edge case (`from . import helpers`).
- `ranker.test.ts`, `mcpServer.test.ts`, `cli.test.ts` (end-to-end via the actual CLI binary) — integration coverage, including config-file/CLI-flag precedence and clear-error paths for every provider combination.

Run with `npm test`.

## Real-world repo stress testing

Three rounds against public, unauthenticated `git clone --depth 1` checkouts (no credentials needed) plus a disposable scratch repo created and deleted via a real GitHub account, to validate against known ground truth.

### Round 1 — Flask (Python, 223 files) and Express (JS/CommonJS, 211 files)
No crashes, sub-2s runtime, deterministic output, correct pinning on a 1,629-line file, real import-graph edges built on both languages (134 edge-endpoints/27 files on Flask, 306/137 on Express), structural boost firing on Express, correct handling of Unicode filenames and the size-cutoff for oversized files.

### Round 2 — scratch repo with known-correct ground truth
A public scratch repo was created with a deliberately known structure (two files with a real import link, one unrelated file, one test file), tested, then deleted.

**Real bug found and fixed:** `FakeRerankProvider`'s keyword tokenizer split only on non-alphanumeric characters, so an identifier like `loginUser` never matched the query word "login" — a directly relevant file was wrongly dropped under `--rerank`. Fixed by also splitting on camelCase/PascalCase boundaries; regression test added (`test/rerank.test.ts`). This only affected the offline fake stand-in used for testing, not the real `OpenAIRerankProvider`.

Validated against ground truth: correct files ranked highest, structural boost correctly pulled in the import-linked file despite zero semantic score, and after the fix `--rerank` kept exactly the relevant files and dropped the irrelevant ones.

### Round 3 — five diverse repos (different languages and scales)
Picked to stress different things: **axios** (TS, 458 files — supported), **ripgrep** (Rust, 234 files — unsupported), **sinatra** (Ruby, 288 files — unsupported), **gin** (Go, 130 files — unsupported), **react** (JS/TS monorepo, 7,146 files — scale test).

| Repo | Files | Runtime | Deterministic | Import-graph edges | Pin works |
|---|---|---|---|---|---|
| axios | 458 | 0.8s | yes | 616 edges / 167 files | yes |
| ripgrep | 234 | 0.6s | yes | 0 (Rust unsupported — expected) | — |
| sinatra | 288 | 0.3s | yes | 0 (Ruby unsupported — expected) | — |
| gin | 130 | 0.4s | yes | 0 (Go unsupported — expected) | — |
| react | 7,146 | 4.3s | yes | 7,464 edges / 1,951 files | yes |

No crashes on any of the five, including React at roughly 14,200 chunks and a 75MB working tree — the largest repo tested.

### Round 4 — AST-based import parsing against real repos
After replacing the regex-based import graph with real parsing (tree-sitter, see below), Flask and axios were re-run through the CLI end-to-end (offline `--rerank` mode) with no crashes across real Python and JS/TS syntax at repo scale.

### Round 5 — AST-based chunking at scale (two real bugs found and fixed)
After adding function/class-boundary-aware chunking (see below), re-running against axios surfaced a real over-fragmentation bug: one-line `export const X = ...` statements and similar trivial top-level declarations were each becoming their own chunk (247 chunks for a query that previously produced 16, most of them one line long). Root cause: every `export_statement` was treated as its own chunk boundary regardless of size. Fixed by restructuring the chunker into two passes — split into boundary-aligned segments, then greedily pack consecutive small segments back together up to the window size — which never merges *across* a large function but does stop treating every tiny statement as its own chunk. Chunk count for the same axios query dropped back to 18, in line with the pre-AST baseline. Covered by a regression test with 50 synthetic one-line exports, asserting they pack into a handful of chunks rather than 50.

Re-running the full pipeline against React (7,146 files, the largest repo in the stress-test set) then surfaced a second, more serious real bug: a **12x runtime regression** (4.3s baseline → 50s). Profiling isolated it to the import-graph step (34s of the 50s): the tree-sitter query objects were being recompiled from their S-expression source on every single file, instead of once per grammar. Query compilation is real work, not free like a regex literal. Fixed by caching compiled queries by (grammar, query source); import-graph time on the same repo dropped from 34s to 9.3s (3.6x). A second pass (reusing one Parser instance per grammar instead of constructing one per file) made no measurable difference, confirming query compilation was the actual bottleneck rather than parser construction. End-to-end React runtime is now 22.6s — still slower than the pre-AST-parsing 4.3s baseline (real parsing has a real cost at this scale, a tradeoff documented in the README's known limitations), but a 2.2x improvement over the regression, and this was the largest and most demanding repo in the entire test set. Both fixes are covered by regression tests (a query-instance-identity test in `treeSitter.test.ts`, not a timing-based test, since timing assertions are flaky).

### Round 6 — per-method chunking against Angular and Django (three real bugs found and fixed) + a clean-room packaging test

After extending chunking to split an oversized *class* by its own members (see below) instead of falling back to a blind line-window cut, two large, real production codebases were cloned and run through the full chunking pipeline directly (`scripts/stress-test.mjs`, checking for crashes, gaps in line coverage, chunks over the window size, and content-free chunks — not asserting any specific chunk shape):

| Repo (sparse clone) | Files | Chunks | Runtime | Errors | Gaps | Oversized chunks | Empty chunks |
|---|---|---|---|---|---|---|---|
| Angular `packages/{core,common,forms}` | 1,702 | 5,453 | 2.4s | 0 | 0 | 0 | 0 |
| Django `django/{db,forms,core}` | 349 | 1,147 | 0.6s | 0 | 0 | 0 | 0 |

Getting to a clean run surfaced three real bugs, none caught by the unit test suite (all three are now covered by regression tests, two of them at the fixture level and one as a blanket property across every fixture):

1. **Unclassified TS overload groups.** Angular's `HttpClient` has several heavily-overloaded, heavily-documented methods — each overload is a `method_signature` node (declaration only, no body), distinct from the real `method_definition` implementation, each preceded by its own 20-90-line JSDoc block. `method_signature` wasn't a recognized class-member type, so every signature (with its JSDoc) was unclassified filler; several in a row blew past `windowLines` and fell back to a blind, overlapping sliding-window cut on that stretch of the class — the exact kind of arbitrary mid-method split this feature exists to avoid. Fixed by adding `method_signature` alongside `abstract_method_signature` in the recognized member set. `client.ts` (2,667 lines) went from 36 chunks with several overlapping ranges to 25 chunks with none.
2. **A file's own trailing newline creating a phantom extra chunk.** `text.split("\n")` on a file ending in `"\n"` (nearly every real source file) adds one synthetic empty element past the real end of the file. Treated as a real line, it became its own filler segment whenever the chunk before it in the packing pass was already at `windowLines` capacity and couldn't absorb it — 43 chunks across the Angular run were nothing but that one phantom blank line, and every reported `endLine` for an affected file was off by one. Fixed with a shared `splitLines()` helper that strips exactly the one synthetic trailing element when the text ends in `"\n"` (never a real blank line the author left before EOF, however many of those precede it).
3. **An orphaned blank-line-only filler chunk.** Even after (2), a small filler segment consisting only of a blank-line gap between two class members could still end up on its own — five two-line, whitespace-only chunks on the Django run, again because the chunk before them in the pack was already at capacity. Fixed by dropping any resulting chunk that's nothing but whitespace (with a one-chunk-minimum safety net so a genuinely all-blank file never ends up with zero chunks) — a content-free chunk is worse than none, since it still costs an embedding call for zero information.

**Packaging.** Running `npm pack` and installing the resulting tarball into a fresh, empty directory (rather than just running the source tree in place, which every prior test round did) surfaced two more real issues:

4. A stale `dist/` in `.gitignore` meant the compiled output the `bin` entries point to was never part of what `npm pack`/`npm publish` would actually ship. Fixed with an explicit `"files": ["dist", "wasm"]` in `package.json`.
5. Once `dist/` was included, the existing `prepare: "npm run build"` script broke a fresh install *from the packed tarball*, because that tarball (correctly) doesn't ship `tsconfig.json` or `src/` — there's nothing to rebuild from. Fixed by making `prepare` a no-op when `tsconfig.json` isn't present (a normal git-clone-and-`npm install` still builds from source exactly as before; an install from a packaged tarball uses the prebuilt `dist/` as-is).

Caught in the same pass: the CLI's `--version`, printed via a hardcoded string, had drifted out of sync with `package.json`'s version (three separate copies of the same string across `cli.ts`, `mcpServer.ts`, and `package.json`, one of which was missed on this version bump). Replaced all three with a single `src/version.ts` that reads `package.json` at runtime via `createRequire`, so this specific class of drift can't recur.

Verified end-to-end after all five fixes: `npm pack` → extract into an empty directory → `npm install --omit=dev` (succeeds, builds nothing, uses the shipped `dist/`) → `node dist/cli.js --version` (reports the correct version) → a real `--provider fake --rerank` run against the cloned Angular checkout (produces a correct bundle) → `node dist/mcpServer.js` starts without error.

Reproduce the stress test yourself: `npm run stress -- <path to any large cloned repo>`.

### Round 7 — real provider validation with live API keys (one more real bug found and fixed)

Every prior round ran offline (`--provider fake`) or against mocked network transports — enough to prove request *shapes* and *chunk* correctness, but never an actual round-trip against a real embedding/chat model. With real `OPENAI_API_KEY` and `ANTHROPIC_API_KEY` keys, the full pipeline was run end-to-end against this project's own repo (self-referential: asking it to find its own per-method-chunking code):

- Real OpenAI embeddings (`text-embedding-3-small`), no rerank.
- Real OpenAI embeddings + real OpenAI rerank (`gpt-4o-mini`).
- Real OpenAI embeddings + real **Anthropic** rerank (`claude-haiku-4-5`) — the exact provider combination that produced the original `404 model: gpt-4o-mini` error at the very start of this project's testing (see the multi-provider bug below). With a real key this time, it completed cleanly and returned real, specific reasoning for excluded candidates (e.g. *"Tests output formatting of chunks, not the chunking algorithm itself"*) — not a mocked string.
- The MCP tool handler itself (`handleCompileContextTool`, not just the CLI) called directly with real keys and `rerankProvider: "anthropic"`, confirming the MCP-specific code path — a client would invoke this function, not the CLI — works identically.

**Real bug found and fixed:** the very first real OpenAI run failed outright: `400 Invalid 'input[123]': maximum input length is 8192 tokens`. Root cause: this project's own bundled `wasm/*.wasm` tree-sitter grammar files were being walked as candidate *text* files — `BINARY_EXTENSIONS` was an extension allowlist-to-exclude, and `.wasm` simply wasn't on it. Read as UTF-8 (which never throws on invalid bytes, it just produces replacement-character garbage), the file chunked "successfully," and that garbage tokenized at up to ~1 token per byte under BPE — dense enough that several chunks blew past OpenAI's 8,192-token embedding limit and hard-failed the *entire* run on one bad file. An extension list can never be complete (this is direct proof), so the walker now backs it with real content sniffing: any file that survives the extension/size checks gets its first 8KB read and checked for a NUL byte — the same heuristic `git` and `grep -I` use, and a reliable one (a WASM module's magic header is literally `\0asm`, a leading NUL). Verified: `wasm/tree-sitter-python.wasm` is now excluded, all three real-provider runs above complete successfully, and the full offline suite (113 tests) and both large-repo stress tests (Angular, Django) still pass with identical results otherwise. Regression test added with a synthetic NUL-prefixed file on an extension (`.customfmt`) deliberately *not* on the extension list, so the content-sniffing fallback specifically (not the extension fast path) is what's under test.

This is also the reason the whole-file/line-window size thresholds (`wholeFileLineThreshold`, `windowLines`) are line-count-based, not token-based -- a real sharp edge, closed in Round 8 below rather than just flagged.

### Round 8 -- two more large real repos (NestJS, FastAPI), plus a deliberate repro closing the line-count/token-count gap flagged after Round 7

Two more structurally different real codebases were stress-tested to widen coverage beyond what Round 6 exercised: **NestJS** (`packages/common` + `packages/core`, 596 files, 1,016 chunks, heavy TypeScript decorator and dependency-injection usage) and **FastAPI** (`fastapi` + `tests`, 564 files, 1,308 chunks, Python route handlers decorated at the *top level*, e.g. `@app.get("/")`, rather than inside a class -- a decorator pattern Round 6's Angular/Django coverage didn't exercise). Both ran clean: 0 errors, 0 gaps, 0 oversized chunks, 0 empty chunks. Angular and Django were also re-cloned at current HEAD and re-run to confirm no regression from this round's fix (1,672 files / 5,410 chunks and 329 files / 1,113 chunks respectively -- file counts differ slightly from Round 6's numbers because these are live repos that have changed since, not the same fixed snapshot; both still 0 errors/gaps/overflow/empty).

**Real bug found and fixed**, this time via a deliberate repro rather than an incidental real-repo find: Round 7's Known Limitations flagged, but never actually demonstrated, that `wholeFileLineThreshold` and `windowLines` measure size in *lines*, so a file with one pathologically long line -- a minified bundle, a huge generated single-line JSON blob -- would sail through every size check as "small" and come out as one giant chunk. Built a concrete repro: a 140KB file consisting of two lines (one of them enormous). It produced exactly one chunk containing **over 100,000 tokens** -- more than 12x past OpenAI's 8,192-token embedding limit -- confirming the gap was real, not theoretical, and would have hard-failed any real run against a repo containing so much as one minified vendor bundle or generated data file, an extremely common thing to find in a real codebase. Fixed with a `maxChunkTokens` safety net (default 8000) applied as a final pass over every chunk regardless of which strategy produced it (whole-file, AST-boundary, class-member, or line-window fallback): a cheap character-length pre-check skips tokenizing the overwhelming majority of chunks, and only a chunk that's actually oversized gets tokenized and sliced via `decode(encode(text).slice(...))` into token-exact pieces. Verified: the repro now produces 13 chunks, each at or under the 8000-token cap; the full 114-test suite (one new regression test added) and all four real-repo stress runs above stayed clean.

### Round 9 -- real-machine bug: cache poisoning across embedding providers

Found live, on the user's own Mac, during real end-to-end usage (not a synthetic repro): the same project directory was used first for a `--provider fake` demo run (`FakeEmbeddingProvider`, 1024-dimension vectors) and later for a real run with a real `OPENAI_API_KEY` (`OpenAIEmbeddingProvider`, 1536-dimension vectors) -- same files, same content hashes, same leftover `.context-compiler-cache.json` on disk from the earlier demo. The on-disk cache keyed entries by content hash alone, with no notion of which provider or model had produced a given vector. Every unchanged chunk's hash still matched its old fake-provider entry, so the real run's ranking pass ended up mixing 1024-dim cached vectors with fresh 1536-dim OpenAI vectors and crashed outright: `context-compiler failed: Vector length mismatch: 1536 vs 1024`. This isn't specific to the fake provider -- switching `--provider openai` to `--provider voyage` against the same repo, or a future embedding-model bump for the same provider, would hit the identical crash.

Fixed by giving every `EmbeddingProvider` a `namespace` identifying its provider+model (`"openai:text-embedding-3-small"`, `"voyage:voyage-code-3"`, `"fake"`), and folding that into the cache's hash key alongside the content hash, so a vector is only ever reused for the exact provider+model that produced it. A provider/model change now costs a handful of extra embedding calls for previously-cached text -- never a crash. The on-disk cache format version was bumped (1 -> 2) so a cache file written before this fix is discarded cleanly on load rather than partially matching under the new key scheme. Two regression tests added: one proving a shared cache file never hands a text's vector from one provider/model to a different one, and one proving an old version-1 cache file is treated as empty rather than misread.

## The AST-based import graph (tree-sitter)

The structural-boost import graph originally used a regex scan for import/require statements. That's a real limitation: a regex has no idea whether `require(...)`-shaped text is inside a comment, a string, or a function that merely happens to be named `require` — it will connect files based on any of those.

Replaced with real parsing via [`web-tree-sitter`](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web) (WASM-based bindings, chosen specifically to avoid native compilation and the peer-dependency ABI conflicts that come with mixing native tree-sitter grammar packages) for JavaScript, TypeScript, TSX, and Python. Grammars are bundled directly (`wasm/`, ~5.8MB) rather than depending on the full multi-language `tree-sitter-wasms` package (51.8MB unpacked for languages this tool doesn't use).

Demonstrated correctness improvement, covered by a regression test: a file that only *mentions* `require('./nope')` inside a comment and a string literal is correctly ignored by the AST path, while the old regex-based fallback path gets it wrong on the identical fixture (asserted directly in the same test).

Python's relative imports got a hybrid treatment: `from x.y import z` resolves via a declarative tree-sitter query, but `from . import helpers` and `from ..pkg.sub import x` need the leading-dot count and "no explicit module name" shape handled by walking the parse tree directly — a plain query can't express "count the dots and go up that many directories." Both cases are covered by tests.

If `web-tree-sitter` fails to initialize in a given environment, the graph builder falls back to the original regex scan automatically (`buildImportGraphRegex`, still exported and tested) rather than failing the whole run.

## Function/class-boundary-aware chunking

Large files used to always be split into fixed-size, fixed-overlap line windows regardless of content — a function could easily land half in one chunk and half in another, weakening both halves' embeddings and giving a coding agent an incomplete function if only one chunk made the budget.

For JS/TS/TSX/Python, chunking now uses the same tree-sitter infrastructure as the import graph to find top-level function/class boundaries and align chunks to them: a function or class is kept whole in one chunk unless it's genuinely bigger than the window size, in which case it's deliberately sub-split (still better than an arbitrary cut, since the common case — most functions — stays intact). Small top-level statements between boundaries (imports, one-line exports, constants) are packed together up to the window size rather than each becoming its own chunk. Falls back to the original fixed-size line windows for unsupported languages or files with no real boundaries (verified to produce byte-identical output to the pre-chunking-change behavior in that case). See Round 5 above for the two real bugs (fragmentation, then a performance regression) found and fixed while building this.

**Per-method chunking.** An oversized class used to fall straight into the same blind line-window cut as an oversized function, with no regard for where one method ended and the next began. It now gets the identical segment-then-pack treatment recursively, one level down, over its own members — methods, fields, static blocks, getters/setters, TS overload groups, nested classes — so a method stays whole in its own chunk wherever possible, and a member-level decorator (`@Input()`, `@HostListener(...)`, Python's `@staticmethod`) always lands in the same chunk as the member it decorates, since it's a separate preceding AST sibling rather than nested inside it. Only a single member still bigger than the window on its own (a genuinely huge method) falls back to a blind line-window cut, exactly like an oversized top-level function always has. The recursion handles a nested class (or `class Foo { ... }` written as an expression) the same way, one level deeper. See Round 6 below for the real bugs found stress-testing this at scale.

## Multi-provider support

**Rerank/triage step** — a second, cheap-model pass that reviews top candidates and drops ones that don't hold up on inspection — now supports both OpenAI (`gpt-4o-mini` by default) and Anthropic (`claude-haiku-4-5` by default, via a forced tool-call since Anthropic's API has no JSON response mode). Embeddings stay OpenAI (or Voyage AI, see below) only, since Anthropic has no public embeddings API.

**Embeddings** — added Voyage AI (`voyage-code-3`, a model trained specifically for code retrieval) as a second embedding provider alongside OpenAI's `text-embedding-3-small`, via `--provider voyage` / `VOYAGE_API_KEY`. No SDK dependency; it's a single REST call.

**A real bug found and fixed in this work:** the CLI resolved a provider-appropriate default rerank model (`gpt-4o-mini` vs. `claude-haiku-4-5`) using the *config file's* saved provider setting, computed once before command-line flags were parsed. If a saved config had `rerankModel` pinned to `"gpt-4o-mini"` (as an earlier version of `init` wrote by default) and a run then overrode only `--rerank-provider anthropic` on the command line without also passing `--rerank-model`, the stale OpenAI model name silently reached Anthropic's API and was rejected (`404 not_found_error: model: gpt-4o-mini`). Fixed by resolving the model against the *final* provider choice at the point of use (`resolveRerankModel`, shared by the CLI and MCP server) and by having `init` stop writing an explicit default model at all, so a provider override always gets the right default. Covered by two tests: a unit test of `resolveRerankModel`'s fallback logic, and an end-to-end test that mocks only the Anthropic SDK's transport and asserts the *actual* model string sent by the real `AnthropicRerankProvider` class is `claude-haiku-4-5`, never a leaked OpenAI model name.

## Quantified token/cost savings

Computed directly with the tool's own tokenizer (`gpt-tokenizer`): "dump the whole repo" vs. the compiled bundle at the default 8,000-token budget, across the seven real repos tested.

| Repo | Files | Full-repo tokens | Compiled bundle | Reduction | Est. cost saved per query* |
|---|---|---|---|---|---|
| Flask | 223 | 267,258 | 7,998 | 97.0% | ~$0.78 |
| Express | 211 | 190,499 | 8,000 | 95.8% | ~$0.55 |
| axios | 458 | 915,149 | 7,996 | 99.1% | ~$2.72 |
| ripgrep | 234 | 913,688 | 7,997 | 99.1% | ~$2.72 |
| sinatra | 288 | 241,623 | 7,999 | 96.7% | ~$0.70 |
| gin | 130 | 250,337 | 7,994 | 96.8% | ~$0.73 |
| react | 7,146 | 7,260,195 | 8,000 | 99.9% | ~$21.76 |

\* at roughly $3/M input tokens (a frontier-model ballpark — check current pricing, it moves). This is input-token savings only, and it recurs every time an agent is invoked on that repo without a pre-compiled slice — a monorepo the size of React saves upwards of $20 in input tokens on a single query.

The compiled-bundle cost stays flat near the configured budget regardless of repo size; the whole-repo-dump cost it's being compared against scales linearly with repo size, which is why the percentage reduction grows with scale.

## Known limitations

- The import graph still misses bundler path aliases (e.g. `@/utils`) and barrel re-export chains, and only covers JS/TS/TSX/Python — it's a ranking nudge, not a full dependency-analysis tool.
- Rerank is opt-in and costs real API calls beyond embeddings — deliberately not defaulted on.
- Chunk-size thresholds (`wholeFileLineThreshold`, `windowLines`) are still line-count-based, not token-based -- but a token-aware safety net now backs them (see Round 8: `maxChunkTokens`, 8000 by default), so a pathologically long line no longer slips through as a giant chunk.
- A chunk sub-split purely by token count (the `maxChunkTokens` safety net) doesn't track exact character offsets within its parent line the way ordinary line-based splitting does -- every such sub-chunk reports the same `startLine`/`endLine` as its parent. Accepted tradeoff for what's a rare-input safety net, not the common path.
- Runtime/quality comparisons (time saved from an agent skipping its own exploration, task pass/fail rate with vs. without the tool) are directional reasoning based on the above, not independently measured — that would need a controlled study across real coding tasks, which is future work.

## What's not yet built

- A hosted/team version, multi-repo context, or non-MCP agent integrations — see the roadmap in the README's "Status" section for the full backlog.
