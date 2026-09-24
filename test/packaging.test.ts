import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

/**
 * Real bug found live, on a real machine, after publishing to npm: every
 * entry in package.json's "bin" map is a script npm makes directly
 * executable on install, and the OS needs a "#!/usr/bin/env node" shebang
 * line to know how to run a text file as a program. src/cli.ts had one;
 * src/mcpServer.ts never did. `context-compiler --version` (the cli.ts bin)
 * worked fine, which hid the bug -- but `context-compiler-mcp` (the
 * mcpServer.ts bin) failed to launch at all when Claude Code tried to spawn
 * it, surfacing only as an opaque "Failed to connect" with no error message,
 * nothing pointing at a missing shebang. Checked here at the source level
 * (not the compiled dist/ output) so this can never regress silently again,
 * regardless of what the build step does.
 */
describe("packaging: every bin entry is directly executable", () => {
  const binEntries: [name: string, srcPath: string][] = [
    ["context-compiler", "src/cli.ts"],
    ["context-compiler-mcp", "src/mcpServer.ts"],
  ];

  for (const [name, srcPath] of binEntries) {
    it(`${name} (${srcPath}) starts with a node shebang`, () => {
      const firstLine = readFileSync(join(ROOT, srcPath), "utf8").split("\n")[0];
      expect(firstLine).toBe("#!/usr/bin/env node");
    });
  }
});
