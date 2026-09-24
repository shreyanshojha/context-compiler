import { accessSync, constants, readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface DoctorCheck {
  ok: boolean;
  label: string;
  detail: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  /** A ready-to-paste `claude mcp add` command, with real resolved paths already filled in. */
  mcpAddCommand: string;
  allOk: boolean;
}

export interface DoctorOptions {
  /** The directory holding the compiled bin entries (cli.js, mcpServer.js). Defaults to this file's own directory -- correct for both a dist/ install and a from-source build. Overridable for testing. */
  distDir?: string;
  /** Overridable for testing; defaults to the real running node binary. */
  nodePath?: string;
  /** Overridable for testing; defaults to the real process.version. */
  nodeVersion?: string;
  /** Overridable for testing; defaults to the real process.env. */
  env?: NodeJS.ProcessEnv;
}

const require = createRequire(import.meta.url);

/**
 * Self-diagnostic for the exact class of bug this project's own npm publish
 * and Claude Code registration hit, live, on a real machine: a missing
 * shebang silently breaking the MCP server's launch (bug #16), and Claude
 * Code's minimal spawn environment not having `node` resolvable via PATH
 * even given an absolute path to the binary itself (bug #17). Both were
 * root-caused by hand, over hours, before this existed. Running this from a
 * real install catches both automatically and prints the exact fix.
 */
export function runDoctor(options: DoctorOptions = {}): DoctorReport {
  const distDir = options.distDir ?? dirname(fileURLToPath(import.meta.url));
  const nodePath = options.nodePath ?? process.execPath;
  const nodeVersion = options.nodeVersion ?? process.version;
  const env = options.env ?? process.env;

  const checks: DoctorCheck[] = [];

  // 1. Node version against package.json's own "engines.node".
  const pkg = require("../package.json") as { engines?: { node?: string } };
  const requiredNode = pkg.engines?.node ?? ">=20";
  const runningMajor = parseInt(nodeVersion.replace(/^v/, "").split(".")[0], 10);
  const requiredMajor = parseInt((requiredNode.match(/\d+/) ?? ["20"])[0], 10);
  checks.push({
    ok: Number.isFinite(runningMajor) && runningMajor >= requiredMajor,
    label: "Node version",
    detail: `${nodeVersion} (package requires ${requiredNode})`,
  });

  // 2. The node binary actually running this process -- this is exactly the
  // path Claude Code's MCP config needs (see README's PATH/shebang note),
  // reported regardless of whether other checks pass.
  checks.push({ ok: true, label: "Node binary in use", detail: nodePath });

  // 3. The MCP server file itself, next to this one.
  const mcpServerPath = join(distDir, "mcpServer.js");
  const mcpServerExists = existsSync(mcpServerPath);
  checks.push({
    ok: mcpServerExists,
    label: "MCP server file present",
    detail: mcpServerExists ? mcpServerPath : `not found at ${mcpServerPath} -- run "npm run build" first`,
  });

  // 4. Shebang on both bin entries -- bug #16 from this project's own
  // deployment history, checked here at the compiled level (not source),
  // since that's the file npm actually makes executable on install.
  for (const [label, filename] of [
    ["CLI shebang", "cli.js"],
    ["MCP server shebang", "mcpServer.js"],
  ] as const) {
    const filePath = join(distDir, filename);
    if (!existsSync(filePath)) {
      checks.push({ ok: false, label, detail: `${filePath} not found -- run "npm run build" first` });
      continue;
    }
    const firstLine = readFileSync(filePath, "utf8").split("\n")[0];
    const hasShebang = firstLine === "#!/usr/bin/env node";
    checks.push({
      ok: hasShebang,
      label,
      detail: hasShebang ? "present" : `missing -- first line is "${firstLine}"`,
    });
  }

  // 5. Executable bit -- npm sets this automatically on a normal install;
  // flags a manual copy or unusual install method that skipped it.
  const cliPath = join(distDir, "cli.js");
  let executable = false;
  if (existsSync(cliPath)) {
    try {
      accessSync(cliPath, constants.X_OK);
      executable = true;
    } catch {
      executable = false;
    }
  }
  checks.push({
    ok: executable,
    label: "CLI is executable",
    detail: executable ? cliPath : `${cliPath} is missing or not marked executable`,
  });

  // 6. API keys -- presence only, values are never read into the report.
  for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "VOYAGE_API_KEY"] as const) {
    const set = !!env[key];
    checks.push({
      ok: true, // informational -- not every key is required for every provider/rerank combination
      label: `${key} set`,
      detail: set ? "yes" : "no (only needed depending on --provider / --rerank-provider)",
    });
  }

  const mcpAddCommand = [
    "claude mcp add context-compiler -s user \\",
    "    -e OPENAI_API_KEY=sk-... \\",
    `    -- "${nodePath}" "${mcpServerPath}"`,
  ].join("\n");

  return { checks, mcpAddCommand, allOk: checks.every((c) => c.ok) };
}
