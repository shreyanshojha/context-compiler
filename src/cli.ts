#!/usr/bin/env node
import { Command } from "commander";
import { writeFileSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { compileContext } from "./index.js";
import {
  FakeEmbeddingProvider,
  OpenAIEmbeddingProvider,
  VoyageEmbeddingProvider,
  type EmbeddingProvider,
} from "./embeddings.js";
import { CachingEmbeddingProvider } from "./cache.js";
import { loadConfig, DEFAULT_CONFIG, CONFIG_FILENAME, type ContextCompilerConfig } from "./config.js";
import {
  FakeRerankProvider,
  OpenAIRerankProvider,
  AnthropicRerankProvider,
  resolveRerankModel,
  type RerankProvider,
} from "./rerank.js";
import { VERSION } from "./version.js";
import { runDoctor } from "./doctor.js";
import { recordRun, recordFeedback, summarizeMetrics } from "./metrics.js";

/**
 * Find a --path/-p value in raw argv before commander parses anything.
 * Needed because the repo root has to be known *before* we can load its
 * config file and use that to set option defaults — chicken-and-egg
 * otherwise.
 */
function preScanPath(argv: string[]): string {
  for (let i = 0; i < argv.length; i++) {
    if ((argv[i] === "--path" || argv[i] === "-p") && argv[i + 1]) return argv[i + 1];
    const eq = argv[i].match(/^(?:--path|-p)=(.+)$/);
    if (eq) return eq[1];
  }
  return process.cwd();
}

const guessedRoot = resolve(preScanPath(process.argv));
let fileConfig: ContextCompilerConfig = {};
try {
  fileConfig = loadConfig(guessedRoot);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
const cfg = { ...DEFAULT_CONFIG, ...fileConfig };

// Deliberately NOT cfg.rerankModel here: cfg is merged with DEFAULT_CONFIG,
// so it's always at least "gpt-4o-mini" even when the file never set it,
// which makes "did the user actually choose this model" unanswerable later.
// Using the raw, unmerged file value means "undefined" still means
// "unset" by the time the action handler picks a provider-appropriate
// default -- see the comment there for why that distinction matters.
const rerankModelFileDefault = fileConfig.rerankModel;

const program = new Command();

program
  .name("context-compiler")
  .description("Compile the right slice of a repo into context for an AI coding agent.")
  .version(VERSION);

program
  .command("run", { isDefault: true })
  .description("Rank a repo against a task and output a context bundle within a token budget.")
  .argument("[task]", 'the task you\'re about to do, e.g. "fix the login bug" (or use -q/--query)')
  .option("-q, --query <text>", "the task you're about to do (alternative to the positional argument)")
  .option("-p, --path <dir>", "repo root to scan", guessedRoot)
  .option("-b, --budget <tokens>", "token budget for the output bundle", String(cfg.budgetTokens))
  .option("-o, --out <file>", "write the bundle to a file instead of stdout")
  .option("--provider <name>", "embedding provider: openai | voyage | fake", cfg.provider)
  .option("--ignore <pattern...>", "extra gitignore-style patterns to exclude", cfg.ignore)
  .option("--pin <path...>", "repo-relative file(s) to always include in full, before ranking", cfg.pin)
  .option("--structural-boost", "enable the import-graph relevance boost", cfg.structuralBoost)
  .option("--no-structural-boost", "disable the import-graph relevance boost")
  .option("--cache", "enable the on-disk embedding cache", cfg.cache)
  .option("--no-cache", "disable the on-disk embedding cache (always re-embed everything)")
  .option("--log", "log this run's token usage locally, for `context-compiler stats`", cfg.logMetrics)
  .option("--no-log", "don't log this run's token usage")
  .option(
    "--rerank",
    "add a cheap-model second pass that reviews top candidates and drops what doesn't hold up (costs extra API calls beyond embeddings)",
    cfg.rerank
  )
  .option("--no-rerank", "disable the reranker pass")
  .option("--rerank-provider <name>", "chat model provider for --rerank: openai | anthropic", cfg.rerankProvider)
  .option(
    "--rerank-model <name>",
    "chat model used for --rerank (default: gpt-4o-mini for openai, claude-haiku-4-5 for anthropic)",
    rerankModelFileDefault
  )
  .action(async (task, opts) => {
    const query = task ?? opts.query;
    if (!query) {
      console.error('Missing task. Usage: context-compiler "fix the login bug"  (or --query "...")');
      process.exitCode = 1;
      return;
    }

    const root = resolve(opts.path);
    const budgetTokens = parseInt(opts.budget, 10);
    if (!Number.isFinite(budgetTokens) || budgetTokens <= 0) {
      console.error(`Invalid --budget: ${opts.budget}`);
      process.exitCode = 1;
      return;
    }

    // Resolve and construct the reranker (if requested) before touching the
    // embedding provider, so a bad --rerank-provider value or a missing key
    // for it fails fast rather than being masked by an unrelated embedding
    // provider error (or vice versa) -- these two providers are independent.
    let rerankProvider: RerankProvider | undefined;
    if (opts.rerank) {
      if (opts.rerankProvider !== "openai" && opts.rerankProvider !== "anthropic") {
        console.error(`Unknown --rerank-provider "${opts.rerankProvider}". Expected "openai" or "anthropic".`);
        process.exitCode = 1;
        return;
      }
      // Resolved here, not at option-declaration time: opts.rerankProvider
      // already reflects a CLI --rerank-provider override beating the config
      // file's value (that's normal commander precedence). The model default
      // has to be resolved at the same point, using that SAME final
      // provider -- otherwise (the bug this replaced) a config file that
      // pins rerankModel to "gpt-4o-mini" while the CLI switches provider to
      // anthropic silently sends an OpenAI model name to Anthropic's API.
      const rerankModel = resolveRerankModel(opts.rerankModel, opts.rerankProvider);
      try {
        if (opts.provider === "fake") {
          // Full offline mode: fake embeddings pair with the fake reranker
          // regardless of --rerank-provider, so the whole pipeline can be
          // trialed for free with no real API key of any kind.
          rerankProvider = new FakeRerankProvider();
        } else if (opts.rerankProvider === "anthropic") {
          rerankProvider = new AnthropicRerankProvider(rerankModel);
        } else {
          rerankProvider = new OpenAIRerankProvider(rerankModel);
        }
      } catch (err) {
        console.error((err as Error).message);
        process.exitCode = 1;
        return;
      }
    }

    let provider: EmbeddingProvider;
    try {
      provider = resolveProvider(opts.provider);
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
      return;
    }

    if (opts.cache) {
      provider = new CachingEmbeddingProvider(provider, join(root, ".context-compiler-cache.json"));
    }

    try {
      const result = await compileContext({
        root,
        query,
        budgetTokens,
        provider,
        extraIgnores: opts.ignore,
        pinnedFiles: opts.pin,
        useStructuralBoost: opts.structuralBoost,
        rerankProvider,
      });

      if (opts.out) {
        writeFileSync(opts.out, result.bundle, "utf8");
        console.error(
          `Wrote ${result.selection.totalTokens} tokens (${result.selection.selected.length} chunks) to ${opts.out}`
        );
      } else {
        process.stdout.write(result.bundle);
      }

      if (opts.log) {
        recordRun(root, {
          task: query,
          budgetTokens,
          tokensUsed: result.selection.totalTokens,
          chunksIncluded: result.selection.selected.length,
          chunksSkipped: result.selection.skipped.length,
        });
      }
    } catch (err) {
      console.error(`context-compiler failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  });

program
  .command("init")
  .description("Write a starter .context-compiler.json in the repo and print an MCP config snippet.")
  .option("-p, --path <dir>", "repo root to set up", guessedRoot)
  .action((opts) => {
    const root = resolve(opts.path);
    const configPath = join(root, CONFIG_FILENAME);

    if (existsSync(configPath)) {
      console.error(`${CONFIG_FILENAME} already exists at ${configPath} — leaving it as is.`);
    } else {
      const starter: ContextCompilerConfig = {
        budgetTokens: DEFAULT_CONFIG.budgetTokens,
        provider: DEFAULT_CONFIG.provider,
        pin: [],
        ignore: [],
        structuralBoost: true,
        cache: true,
        rerank: false,
        rerankProvider: DEFAULT_CONFIG.rerankProvider,
        logMetrics: true,
        // Deliberately omitted: rerankModel. Leaving it unset lets the CLI
        // pick a provider-appropriate default (gpt-4o-mini / claude-haiku-4-5)
        // at run time even if --rerank-provider is overridden on the command
        // line later. Baking a model name in here caused a real bug: a saved
        // "gpt-4o-mini" survived a later `--rerank-provider anthropic` and
        // was sent straight to Anthropic's API, which rejected it (404).
      };
      writeFileSync(configPath, JSON.stringify(starter, null, 2) + "\n", "utf8");
      console.error(`Wrote ${configPath}`);
      console.error(`From now on, just run:  context-compiler "your task here"`);
    }

    const mcpServerPath = resolve(new URL("./mcpServer.js", import.meta.url).pathname);
    console.error("");
    console.error("To use this from Claude Code or another MCP-compatible agent instead of the CLI,");
    console.error("add this to your MCP config (e.g. Claude Code's mcp settings):");
    console.error("");
    console.error(
      JSON.stringify(
        {
          mcpServers: {
            "context-compiler": {
              command: "node",
              args: [mcpServerPath],
              env: {
                OPENAI_API_KEY: "sk-...", // required for embeddings (unless provider is voyage); also used for --rerank if rerankProvider is openai
                ANTHROPIC_API_KEY: "sk-ant-...", // only needed if rerankProvider is anthropic (rerank/triage step only -- Anthropic has no embeddings API)
                VOYAGE_API_KEY: "pa-...", // only needed if provider is voyage (code-optimized embeddings; replaces OPENAI_API_KEY for that step)
              },
            },
          },
        },
        null,
        2
      )
    );
  });

program
  .command("stats")
  .description("Summarize this repo's locally logged runs -- real token usage and any recorded hit/miss feedback.")
  .option("-p, --path <dir>", "repo root to read logs from", guessedRoot)
  .action((opts) => {
    const root = resolve(opts.path);
    const summary = summarizeMetrics(root);

    if (summary.totalRuns === 0) {
      console.error("No logged runs yet in this repo. Runs are logged automatically unless you pass --no-log.");
      return;
    }

    console.error(`Runs logged:        ${summary.totalRuns}`);
    console.error(`Avg tokens used:    ${Math.round(summary.avgTokensUsed!)}`);
    console.error(`Avg budget:         ${Math.round(summary.avgBudgetTokens!)}`);
    console.error("");
    if (summary.hitRate === null) {
      console.error('No feedback recorded yet. After a task, run: context-compiler feedback hit|miss ["note"]');
    } else {
      console.error(
        `Feedback: ${summary.feedbackHits} hit / ${summary.feedbackMisses} miss  (hit rate: ${(summary.hitRate * 100).toFixed(0)}%)`
      );
    }
  });

program
  .command("feedback")
  .description('Record whether the agent needed something beyond the last compiled bundle -- e.g. "context-compiler feedback miss \\"needed the config file too\\""')
  .argument("<outcome>", '"hit" (the bundle had everything needed) or "miss" (the agent had to ask for more)')
  .argument("[note]", "optional free-text note")
  .option("-p, --path <dir>", "repo root to log against", guessedRoot)
  .action((outcome, note, opts) => {
    if (outcome !== "hit" && outcome !== "miss") {
      console.error(`Expected "hit" or "miss", got "${outcome}".`);
      process.exitCode = 1;
      return;
    }
    recordFeedback(resolve(opts.path), outcome, note);
    console.error(`Logged: ${outcome}${note ? ` (${note})` : ""}`);
  });

program
  .command("doctor")
  .description("Diagnose common install/MCP-connection problems and print a ready-to-run Claude Code registration command.")
  .action(() => {
    const report = runDoctor();
    for (const check of report.checks) {
      console.error(`${check.ok ? "✓" : "✗"} ${check.label}: ${check.detail}`);
    }
    console.error("");
    console.error(
      report.allOk
        ? "All checks passed. To register this as an MCP server in Claude Code, run:"
        : "One or more checks failed above — fix those first if possible. Either way, here's the registration command with your real paths already filled in:"
    );
    console.error("");
    console.error(report.mcpAddCommand);
    if (!report.allOk) process.exitCode = 1;
  });

function resolveProvider(name: string): EmbeddingProvider {
  switch (name) {
    case "openai":
      return new OpenAIEmbeddingProvider();
    case "voyage":
      return new VoyageEmbeddingProvider();
    case "fake":
      return new FakeEmbeddingProvider();
    default:
      throw new Error(`Unknown --provider "${name}". Expected "openai", "voyage", or "fake".`);
  }
}

program.parseAsync(process.argv);
