# context-compiler

Automatically compiles the right slice of a repo into context for an AI coding agent — instead of hand-picking files or letting the agent explore blind.

## The 30-second version

```bash
npm install          # also builds, via the prepare script
export OPENAI_API_KEY=sk-...
node dist/cli.js init                       # writes .context-compiler.json + prints an MCP snippet, once
node dist/cli.js "fix the login bug"        # that's it — no other flags needed
```

Everything else below is what you can configure once you outgrow the defaults.

## What it does

1. Walks your repo, respecting `.gitignore` (skips `node_modules`, build output, binaries, oversized files, and its own cache file).
2. Splits files into chunks — small files stay whole; large JS/TS/TSX/Python files split at function/class boundaries (via tree-sitter) so a function isn't cut in half; an oversized class gets the same treatment one level down, split by its own methods so a giant class doesn't get blindly cut either. Plain overlapping line windows are the fallback for other languages, and for any single function or method still bigger than the window on its own.
3. Ranks every chunk against your task using embeddings, boosted by a real import-graph signal (tree-sitter, not regex — see "How ranking works") — a file with low text similarity but a direct import relationship to a top hit still gets pulled in.
4. **Optional cheap-model triage** (`--rerank`): a second pass, using a cheap chat model — `gpt-4o-mini` or Claude Haiku (`--rerank-provider openai|anthropic`) — not the model you'll actually code with — reviews the top candidates and drops ones that only looked relevant on paper. The point: a small, inexpensive model does the *finding*, so your real coding session (Claude Code, Cursor, whatever you're paying more per token for) only spends its tokens and context window on the *doing*.
5. Greedily selects the highest-relevance chunks that fit inside a token budget. Files you `--pin` are always included first, in full.
6. Outputs a single markdown bundle with a one-line "why this was picked" for every entry — via CLI, or fetched directly by your agent through the MCP server.

## Setup (once per repo)

```bash
node dist/cli.js init
```

This writes `.context-compiler.json` with sane defaults, and prints a ready-to-paste MCP config block with the absolute path to the server already filled in. Edit the config file directly to change defaults (budget, pins, ignores, whether reranking is on) — the CLI reads it automatically from then on.

## Everyday use (CLI)

```bash
context-compiler "fix the login authentication bug"
```

Positional argument, no flags required beyond what your config already set. `--out context.md` writes to a file instead of stdout. Any flag you pass overrides the config file for that one run.

## Everyday use (MCP — plug into Claude Code or another MCP-compatible agent)

Paste the snippet `init` printed into your agent's MCP config, e.g.:

```json
{
  "mcpServers": {
    "context-compiler": {
      "command": "node",
      "args": ["/absolute/path/to/context-compiler/dist/mcpServer.js"],
      "env": {
        "OPENAI_API_KEY": "sk-...",
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

`OPENAI_API_KEY` is required for embeddings unless you use `--provider voyage` (and for `--rerank` if `rerankProvider` is `openai`, the default). `ANTHROPIC_API_KEY` is only needed if you set `rerankProvider` to `anthropic` — that only affects the rerank/triage step. `VOYAGE_API_KEY` is only needed if you set `provider` to `voyage`.

This exposes one tool, `compile_context` — the agent calls it itself, no manual CLI step. Inputs: `path`, `query`, `budgetTokens` (default 8000), `provider` (`openai` or `voyage`, default `openai`), `pin`, `ignore`, `useCache` (default true), `rerank` (default false), `rerankProvider` (`openai` or `anthropic`, default `openai`), `rerankModel` (defaults to `gpt-4o-mini` or `claude-haiku-4-5` depending on `rerankProvider`).

## Options

| Flag | Config key | Default | Meaning |
|---|---|---|---|
| *(positional)* / `-q, --query` | — | *(required)* | The task you're about to do |
| `-p, --path` | — | cwd | Repo root to scan |
| `-b, --budget` | `budgetTokens` | `8000` | Max tokens in the output bundle |
| `-o, --out` | — | stdout | Write bundle to a file |
| `--provider` | `provider` | `openai` | `openai`, `voyage` (Voyage AI's `voyage-code-3`, trained for code retrieval — needs `VOYAGE_API_KEY`), or `fake` (offline, no API key, for trying the pipeline free) |
| `--ignore` | `ignore` | `[]` | Extra `.gitignore`-style patterns to exclude |
| `--pin` | `pin` | `[]` | Repo-relative file(s) always included in full, before ranking |
| `--no-structural-boost` | `structuralBoost` | on | Disable the import-graph relevance boost |
| `--no-cache` | `cache` | on | Disable the on-disk embedding cache |
| `--rerank` | `rerank` | **off** | Add the cheap-model triage pass (costs extra, small, API calls) |
| `--rerank-provider` | `rerankProvider` | `openai` | Which chat model provider runs the triage: `openai` or `anthropic` |
| `--rerank-model` | `rerankModel` | `gpt-4o-mini` (openai) / `claude-haiku-4-5` (anthropic) | Which chat model does the triage |

CLI flags always override `.context-compiler.json`.

## How ranking works

1. **Semantic score** — cosine similarity between your query's embedding and each chunk's embedding. Uses OpenAI's `text-embedding-3-small` by default, or Voyage AI's `voyage-code-3` (code-optimized) with `--provider voyage`.
2. **Structural bonus** — a real import graph, built with [tree-sitter](https://tree-sitter.github.io/) (via `web-tree-sitter`, WASM — no native build step) for JS/TS/TSX/Python, connects files; chunks import-connected to a top semantic hit get a small flat bonus. Catches files that matter but share no vocabulary with the query. Actually parsing the syntax (rather than pattern-matching it) means a `require(...)` mentioned in a comment or string doesn't create a false edge, and Python's relative imports (`from . import x`, `from ..pkg import y`) resolve correctly, dot-count included.
3. **Cheap-model triage** (opt-in) — the current top candidates go to a cheap chat model with the task description; it can drop ones that don't actually hold up on inspection, with a one-line reason. This is the "cheaper model finds it" half of the pipeline — the coding model you use afterward never sees this step or its cost.
4. **Explainability** — every entry in the output shows its score and why: semantic match, structural connection, cheap-model reasoning, or "pinned."

Known limitations: the import graph still misses bundler path aliases (e.g. `@/utils`) and barrel re-export chains; it's a ranking nudge, not a full dependency-analysis tool. If `web-tree-sitter` fails to initialize in a given environment, the structural boost falls back to the older regex-based scan automatically rather than failing the run. Real parsing has a real cost at very large scale (thousands of files) compared to the old regex — see `TESTING.md` for measured numbers.

## Incremental caching

Every run writes `.context-compiler-cache.json` into the scanned repo, keyed by the sha256 of each chunk's text — a second run only re-embeds what changed. The walker excludes this file from its own scans by default, so it can never pollute future runs; add it to your `.gitignore` anyway for cleanliness.

## Try it without an API key

```bash
node dist/cli.js "fix the login bug" --provider fake
```

Deterministic offline stand-in for both embeddings and reranking (add `--rerank` too) — good for seeing the full pipeline run end-to-end at zero cost, not for real ranking quality.

## Development

```bash
npm test        # unit + integration + CLI end-to-end tests, all offline
npm run dev -- "..." --provider fake   # run from source without building
```

## Status

v6 — zero-config CLI (positional query + `.context-compiler.json` + `init`), MCP-ready, real (tree-sitter) structural ranking and chunking down to the method/field level, pinning, explainability, caching, an optional multi-provider cheap-model triage pass (OpenAI or Anthropic), and a code-optimized embedding option (Voyage AI).

See [`TESTING.md`](./TESTING.md) for the full test suite breakdown, real-world repo stress-test results, and measured token/cost savings.

## License

MIT
