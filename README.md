# context-compiler

Automatically compiles the right slice of a repo into context for an AI coding agent — instead of hand-picking files or letting the agent explore blind.

## The 30-second version

**Option A — from npm:**

```bash
npm install -g @shreyanshojha/context-compiler
export OPENAI_API_KEY=sk-...
context-compiler init                       # writes .context-compiler.json + prints an MCP snippet, once
context-compiler "fix the login bug"        # that's it — no other flags needed
```

**Option B — from source:**

```bash
git clone https://github.com/shreyanshojha/context-compiler.git
cd context-compiler
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

Not sure your setup is right, or seeing "Failed to connect"? Run `context-compiler doctor` — it checks the exact things that break this (shebang, executable bit, node resolvable via PATH) and prints a ready-to-paste `claude mcp add` command with your real paths already filled in. See "Diagnosing a broken setup" below.

Any MCP-compatible client works the same way — Claude Desktop, Cursor, Windsurf, etc. all read a `command`/`args`/`env` block like the one above; only the config file's location differs per app.

### Claude Code (CLI setup)

Instead of hand-editing a config file, register it with the `claude mcp add` command. Run this from anywhere (it's self-resolving — no paths to fill in by hand):

```bash
claude mcp add context-compiler -s user \
  -e OPENAI_API_KEY=sk-... \
  -- "$(command -v node)" "$(npm root -g)/@shreyanshojha/context-compiler/dist/mcpServer.js"

claude mcp list   # should show context-compiler as ✓ Connected
```

`-s user` registers it globally for that machine (as opposed to `-s project`, which writes to a shared `.mcp.json` in the current repo). **This registration is per-machine** — it's stored in `~/.claude.json`, so if you use Claude Code from more than one computer, run this command on each one.

**If it shows "✗ Failed to connect," this is almost always a PATH issue, not a broken install** — especially if you manage Node with `nvm`. Both this CLI method and the JSON `command: "node"` config above rely on `node` being resolvable at launch time. Claude Code spawns MCP servers with a minimal environment that often doesn't include `nvm`'s directories on `PATH`, even if you pass an absolute path to the binary itself (the binary's own `#!/usr/bin/env node` shebang line still needs `PATH` to find `node`). The fix is to always give the **full, resolved path to the `node` binary itself** as the `command` — the `$(command -v node)` in the snippet above does exactly that. If you're editing a JSON config by hand instead of using `claude mcp add`, replace `"command": "node"` with the absolute path (run `which node` in the terminal you'd normally use, and paste that instead of the bare word `node`).

### Diagnosing a broken setup

```bash
context-compiler doctor
```

Checks the exact things that break an install or an MCP connection — Node version, whether `dist/cli.js` and `dist/mcpServer.js` still have their required shebang line, whether they're marked executable, and which `node` binary is actually running — then prints a `claude mcp add` command with your real, resolved paths already filled in. Every check it runs corresponds to a real bug this project hit shipping its own releases (see `TESTING.md`'s deployment rounds); running this first replaces what used to be an hour of manual diagnosis.

This exposes one tool, `compile_context` — the agent calls it itself, no manual CLI step. Inputs: `path`, `query`, `budgetTokens` (default 8000), `provider` (`openai` or `voyage`, default `openai`), `pin`, `ignore`, `useCache` (default true), `rerank` (default false), `rerankProvider` (`openai` or `anthropic`, default `openai`), `rerankModel` (defaults to `gpt-4o-mini` or `claude-haiku-4-5` depending on `rerankProvider`).

## Commands

| Command | What it does |
|---|---|
| `context-compiler "<task>"` | The default — compile a context bundle (see Options below) |
| `context-compiler init` | Write a starter config + print an MCP snippet |
| `context-compiler doctor` | Diagnose install/MCP-connection problems |
| `context-compiler stats` | Summarize this repo's logged runs |
| `context-compiler feedback hit\|miss ["note"]` | Record whether the last bundle had everything needed |

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
| `--no-log` | `logMetrics` | on | Skip logging this run to `.context-compiler-metrics.jsonl` |
| `--rerank` | `rerank` | **off** | Add the cheap-model triage pass (costs extra, small, API calls) |
| `--rerank-provider` | `rerankProvider` | `openai` | Which chat model provider runs the triage: `openai` or `anthropic` |
| `--rerank-model` | `rerankModel` | `gpt-4o-mini` (openai) / `claude-haiku-4-5` (anthropic) | Which chat model does the triage |

CLI flags always override `.context-compiler.json`.

## How ranking works

1. **Semantic score** — cosine similarity between your query's embedding and each chunk's embedding. Uses OpenAI's `text-embedding-3-small` by default, or Voyage AI's `voyage-code-3` (code-optimized) with `--provider voyage`.
2. **Structural bonus** — a real import graph, built with [tree-sitter](https://tree-sitter.github.io/) (via `web-tree-sitter`, WASM — no native build step) for JS/TS/TSX/Python, connects files; chunks import-connected to a top semantic hit get a small flat bonus. Catches files that matter but share no vocabulary with the query. Actually parsing the syntax (rather than pattern-matching it) means a `require(...)` mentioned in a comment or string doesn't create a false edge, and Python's relative imports (`from . import x`, `from ..pkg import y`) resolve correctly, dot-count included.
3. **Cheap-model triage** (opt-in) — the current top candidates go to a cheap chat model with the task description; it can drop ones that don't actually hold up on inspection, with a one-line reason. This is the "cheaper model finds it" half of the pipeline — the coding model you use afterward never sees this step or its cost.
4. **Explainability** — every entry in the output shows its score and why: semantic match, structural connection, cheap-model reasoning, or "pinned."

The import graph resolves tsconfig/jsconfig `paths` aliases (e.g. `@/utils` → `src/utils`, read from the same `compilerOptions.baseUrl`/`paths` your bundler already uses) and follows barrel re-export chains transitively (`export * from './x'`, even several files deep) — so importing something *through* a barrel file gets the same structural signal as importing it directly. Still a ranking nudge, not a full dependency-analysis tool: dynamic/computed import paths aren't resolved, and only JS/TS/TSX/Python get real parsing at all (other languages fall back to line-window chunking with no structural boost). If `web-tree-sitter` fails to initialize in a given environment, the structural boost falls back to the older regex-based scan automatically rather than failing the run. Real parsing has a real cost at very large scale (thousands of files) compared to the old regex — see `TESTING.md` for measured numbers.

## Incremental caching

Every run writes `.context-compiler-cache.json` into the scanned repo, keyed by the sha256 of each chunk's text — a second run only re-embeds what changed. The walker excludes this file from its own scans by default, so it can never pollute future runs; add it to your `.gitignore` anyway for cleanliness.

## Usage metrics (real numbers, not estimates)

Every run (CLI or MCP) logs its token usage to `.context-compiler-metrics.jsonl` in the scanned repo by default — a plain local file, never sent anywhere, excluded from the walker's own scans exactly like the cache file above.

```bash
context-compiler stats                          # summarize logged runs for this repo
context-compiler feedback hit                    # the bundle had everything the agent needed
context-compiler feedback miss "needed config.ts too"   # the agent had to ask for more
```

`--no-log` (CLI) or `logMetrics: false` (MCP tool input) skips logging for a single run. There's no automated way to know whether an agent needed more than it got, so `feedback` is manual — but logging it this way turns "does this actually help" from a one-off measurement into something you can track over real usage on your own repos.

## How this compares

| | context-compiler | Aider | Cursor |
|---|---|---|---|
| Approach | Standalone MCP tool + CLI | Built-in repo-map (tree-sitter + graph ranking) | Proprietary codebase indexing |
| Works with | Any MCP-compatible agent (Claude Code, etc.) | Aider only | Cursor only |
| Open source | Yes (MIT) | Yes | No |
| Configurable budget/pinning | Yes | Limited | No user control |
| Explainable output | Yes — every entry shows why it was picked | No | No |

Not a claim that either alternative is worse at what it does inside its own tool — the gap this fills is specifically "usable from *any* MCP-compatible agent, inspectable, and MIT-licensed," not a head-to-head ranking-quality benchmark (that would need identical repos and tasks run through all three, which hasn't been done).

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

v7 — published on npm, verified working as an MCP server in Claude Code (see the PATH/shebang note above), a `doctor` self-diagnostic command, local usage-metrics logging (`stats`/`feedback`), tsconfig path-alias and barrel re-export resolution in the import graph, zero-config CLI (positional query + `.context-compiler.json` + `init`), real (tree-sitter) structural ranking and chunking down to the method/field level, pinning, explainability, caching, an optional multi-provider cheap-model triage pass (OpenAI or Anthropic), and a code-optimized embedding option (Voyage AI).

See [`TESTING.md`](./TESTING.md) for the full test suite breakdown, real-world repo stress-test results, and measured token/cost savings.

## License

MIT
