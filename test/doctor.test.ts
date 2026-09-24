import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "../src/doctor.js";

const tempDirs: string[] = [];
function makeTempDistDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "doctor-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("runDoctor", () => {
  it("reports every check green on a correctly built dist/ (shebang + executable + node OK)", () => {
    const distDir = makeTempDistDir();
    for (const name of ["cli.js", "mcpServer.js"]) {
      const filePath = join(distDir, name);
      writeFileSync(filePath, "#!/usr/bin/env node\nconsole.log('ok');\n", "utf8");
      chmodSync(filePath, 0o755);
    }

    const report = runDoctor({ distDir, nodePath: "/usr/local/bin/node", nodeVersion: "v22.0.0", env: {} });

    expect(report.allOk).toBe(true);
    expect(report.checks.find((c) => c.label === "MCP server shebang")?.ok).toBe(true);
    expect(report.checks.find((c) => c.label === "CLI is executable")?.ok).toBe(true);
  });

  it("REGRESSION: catches a missing shebang on the MCP server bin entry (the real bug this project shipped)", () => {
    const distDir = makeTempDistDir();
    writeFileSync(join(distDir, "cli.js"), "#!/usr/bin/env node\n", "utf8");
    chmodSync(join(distDir, "cli.js"), 0o755);
    // mcpServer.js deliberately has no shebang -- exactly bug #16.
    writeFileSync(join(distDir, "mcpServer.js"), "import { McpServer } from 'x';\n", "utf8");
    chmodSync(join(distDir, "mcpServer.js"), 0o755);

    const report = runDoctor({ distDir, nodePath: "/usr/local/bin/node", nodeVersion: "v22.0.0", env: {} });

    expect(report.allOk).toBe(false);
    const shebangCheck = report.checks.find((c) => c.label === "MCP server shebang");
    expect(shebangCheck?.ok).toBe(false);
    expect(shebangCheck?.detail).toContain("missing");
  });

  it("flags a node version older than package.json's engines requirement", () => {
    const distDir = makeTempDistDir();
    for (const name of ["cli.js", "mcpServer.js"]) {
      writeFileSync(join(distDir, name), "#!/usr/bin/env node\n", "utf8");
      chmodSync(join(distDir, name), 0o755);
    }

    const report = runDoctor({ distDir, nodePath: "/usr/local/bin/node", nodeVersion: "v14.0.0", env: {} });
    expect(report.checks.find((c) => c.label === "Node version")?.ok).toBe(false);
  });

  it("always reports the node binary in use and never fails the check over it", () => {
    const distDir = makeTempDistDir();
    const report = runDoctor({ distDir, nodePath: "/opt/custom/node", nodeVersion: "v22.0.0", env: {} });
    const nodeCheck = report.checks.find((c) => c.label === "Node binary in use");
    expect(nodeCheck?.ok).toBe(true);
    expect(nodeCheck?.detail).toBe("/opt/custom/node");
  });

  it("prints a ready-to-run claude mcp add command using the resolved node and mcpServer.js paths", () => {
    const distDir = makeTempDistDir();
    const report = runDoctor({ distDir, nodePath: "/opt/custom/node", nodeVersion: "v22.0.0", env: {} });
    expect(report.mcpAddCommand).toContain("/opt/custom/node");
    expect(report.mcpAddCommand).toContain(join(distDir, "mcpServer.js"));
    expect(report.mcpAddCommand).toContain("claude mcp add context-compiler");
  });

  it("reports API key presence without ever including the key's actual value", () => {
    const distDir = makeTempDistDir();
    const report = runDoctor({ distDir, nodePath: "/usr/local/bin/node", nodeVersion: "v22.0.0", env: { OPENAI_API_KEY: "sk-super-secret-value" } });
    const keyCheck = report.checks.find((c) => c.label === "OPENAI_API_KEY set");
    expect(keyCheck?.detail).toBe("yes");
    expect(JSON.stringify(report)).not.toContain("sk-super-secret-value");
  });

  it("does not throw, and reports the file as missing, when dist/ hasn't been built at all", () => {
    const distDir = makeTempDistDir(); // empty directory, nothing built
    const report = runDoctor({ distDir, nodePath: "/usr/local/bin/node", nodeVersion: "v22.0.0", env: {} });
    expect(report.allOk).toBe(false);
    expect(report.checks.find((c) => c.label === "MCP server file present")?.ok).toBe(false);
  });
});
