# Testing & Benchmarks

This is the full technical record from building and stress-testing context-compiler: what was tested, what broke, what got fixed, and real numbers for the token/cost savings the tool produces. Unit/integration test counts and coverage areas are summarized here; the tests themselves live in `test/`.

## Automated test suite

98 tests across 14 files, all offline (no API keys or network required) except where noted:

- `walker.test.ts`, `chunker.test.ts`, `budget.test.ts`, `output.test.ts`, `cache.test.ts`, `config.test.ts` — core pipeline stages.
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

## The AST-based import graph (tree-sitter)

The structural-boost import graph originally used a regex scan for import/require statements. That's a real limitation: a regex has no idea whether `require(...)`-shaped text is inside a comment, a string, or a function that merely happens to be named `require` — it will connect files based on any of those.

Replaced with real parsing via [`web-tree-sitter`](https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web) (WASM-based bindings, chosen specifically to avoid native compilation and the peer-dependency ABI conflicts that come with mixing native tree-sitter grammar packages) for JavaScript, TypeScript, TSX, and Python. Grammars are bundled directly (`wasm/`, ~5.8MB) rather than depending on the full multi-language `tree-sitter-wasms` package (51.8MB unpacked for languages this tool doesn't use).

Demonstrated correctness improvement, covered by a regression test: a file that only *mentions* `require('./nope')` inside a comment and a string literal is correctly ignored by the AST path, while the old regex-based fallback path gets it wrong on the identical fixture (asserted directly in the same test).

Python's relative imports got a hybrid treatment: `from x.y import z` resolves via a declarative tree-sitter query, but `from . import helpers` and `from ..pkg.sub import x` need the leading-dot count and "no explicit module name" shape handled by walking the parse tree directly — a plain query can't express "count the dots and go up that many directories." Both cases are covered by tests.

If `web-tree-sitter` fails to initialize in a given environment, the graph builder falls back to the original regex scan automatically (`buildImportGraphRegex`, still exported and tested) rather than failing the whole run.

## Function/class-boundary-aware chunking

Large files used to always be split into fixed-size, fixed-overlap line windows regardless of content — a function could easily land half in one chunk and half in another, weakening both halves' embeddings and giving a coding agent an incomplete function if only one chunk made the budget.

For JS/TS/TSX/Python, chunking now uses the same tree-sitter infrastructure as the import graph to find top-level function/class boundaries and align chunks to them: a function or class is kept whole in one chunk unless it's genuinely bigger than the window size, in which case it's deliberately sub-split (still better than an arbitrary cut, since the common case — most functions — stays intact). Small top-level statements between boundaries (imports, one-line exports, constants) are packed together up to the window size rather than each becoming its own chunk. Falls back to the original fixed-size line windows for unsupported languages or files with no real boundaries (verified to produce byte-identical output to the pre-chunking-change behavior in that case). See Round 5 above for the two real bugs (fragmentation, then a performance regression) found and fixed while building this.

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
- Runtime/quality comparisons (time saved from an agent skipping its own exploration, task pass/fail rate with vs. without the tool) are directional reasoning based on the above, not independently measured — that would need a controlled study across real coding tasks, which is future work.

## What's not yet built

- A hosted/team version, multi-repo context, or non-MCP agent integrations — see the roadmap in the README's "Status" section for the full backlog.
