import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, cpSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = join(__dirname, "..", "src", "cli.ts");
const FIXTURE_SOURCE = join(__dirname, "fixtures", "sample-repo");

function runCli(args: string[], cwd: string): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("npx", ["tsx", CLI_ENTRY, ...args], { cwd, encoding: "utf8" });
  return { stdout: result.stdout ?? "", stderr: result.stderr ?? "", status: result.status ?? 1 };
}

let repoDir: string;

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "cc-cli-e2e-"));
  cpSync(FIXTURE_SOURCE, repoDir, { recursive: true });
});

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true });
});

describe("CLI (end-to-end via tsx, fake provider)", () => {
  it("accepts the task as a bare positional argument with no flags", () => {
    const { stdout, status } = runCli(["fix the login bug", "--provider", "fake", "--budget", "300"], repoDir);
    expect(status).toBe(0);
    expect(stdout).toContain("# Context Bundle");
    expect(stdout).toContain("fix the login bug");
  }, 20000);

  it("errors clearly when no task is given at all", () => {
    const { stderr, status } = runCli(["--provider", "fake"], repoDir);
    expect(status).not.toBe(0);
    expect(stderr).toContain("Missing task");
  }, 20000);

  it("picks up defaults from .context-compiler.json in the repo root", () => {
    writeFileSync(join(repoDir, ".context-compiler.json"), JSON.stringify({ budgetTokens: 50 }));
    const { stdout } = runCli(["anything", "--provider", "fake"], repoDir);
    expect(stdout).toContain("Token budget:** 50");
  }, 20000);

  it("lets a CLI flag override the config file", () => {
    writeFileSync(join(repoDir, ".context-compiler.json"), JSON.stringify({ budgetTokens: 50 }));
    const { stdout } = runCli(["anything", "--provider", "fake", "--budget", "8000"], repoDir);
    expect(stdout).toContain("Token budget:** 8000");
  }, 20000);

  it("init writes a starter config and doesn't clobber an existing one", () => {
    const { stderr: first } = runCli(["init"], repoDir);
    expect(first).toContain("Wrote");
    const configPath = join(repoDir, ".context-compiler.json");
    expect(existsSync(configPath)).toBe(true);
    const written = JSON.parse(readFileSync(configPath, "utf8"));
    expect(written.budgetTokens).toBe(8000);

    writeFileSync(configPath, JSON.stringify({ budgetTokens: 999 }));
    const { stderr: second } = runCli(["init"], repoDir);
    expect(second).toContain("already exists");
    const stillThere = JSON.parse(readFileSync(configPath, "utf8"));
    expect(stillThere.budgetTokens).toBe(999); // untouched
  }, 20000);

  it("init prints a ready-to-paste MCP config snippet", () => {
    const { stderr } = runCli(["init"], repoDir);
    expect(stderr).toContain("mcpServers");
    expect(stderr).toContain("context-compiler");
    expect(stderr).toContain("mcpServer.js");
    expect(stderr).toContain("ANTHROPIC_API_KEY");
    expect(stderr).toContain("VOYAGE_API_KEY");
  }, 20000);

  it("reports a clear error on --provider voyage without VOYAGE_API_KEY set", () => {
    const original = process.env.VOYAGE_API_KEY;
    delete process.env.VOYAGE_API_KEY;
    const { stderr, status } = runCli(["anything", "--provider", "voyage"], repoDir);
    if (original) process.env.VOYAGE_API_KEY = original;
    expect(status).not.toBe(0);
    expect(stderr).toContain("VOYAGE_API_KEY is not set");
  }, 20000);

  it("errors clearly on an unknown --rerank-provider instead of silently ignoring it", () => {
    const { stderr, status } = runCli(
      ["anything", "--provider", "fake", "--rerank", "--rerank-provider", "bogus"],
      repoDir
    );
    expect(status).not.toBe(0);
    expect(stderr).toContain('Unknown --rerank-provider "bogus"');
  }, 20000);

  it("reports a clear error when --rerank-provider anthropic is used without ANTHROPIC_API_KEY set", () => {
    // Deliberately --provider openai (not fake) here: fake-embeddings mode
    // always short-circuits to the fake reranker regardless of
    // --rerank-provider, so this needs a non-fake embedding provider to
    // actually exercise the AnthropicRerankProvider construction path.
    // Rerank-provider construction happens before embedding-provider
    // resolution, so this fails on the Anthropic key, not the OpenAI one.
    const originalAnthropic = process.env.ANTHROPIC_API_KEY;
    const originalOpenAI = process.env.OPENAI_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    const { stderr, status } = runCli(
      ["anything", "--provider", "openai", "--rerank", "--rerank-provider", "anthropic"],
      repoDir
    );
    if (originalAnthropic) process.env.ANTHROPIC_API_KEY = originalAnthropic;
    if (originalOpenAI) process.env.OPENAI_API_KEY = originalOpenAI;
    expect(status).not.toBe(0);
    expect(stderr).toContain("ANTHROPIC_API_KEY is not set");
  }, 20000);
});
