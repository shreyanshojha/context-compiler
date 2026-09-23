import { createRequire } from "node:module";

/**
 * Single source of truth for the tool's version, read from package.json at
 * runtime rather than hardcoded here (and again in the CLI's `--version`
 * and again in the MCP server's registration) -- three copies of the same
 * string drift the moment one of them is forgotten on a version bump, which
 * is exactly what happened while packaging 0.6.0 (the CLI briefly reported
 * "0.5.0" after the version had already been bumped everywhere else).
 * `createRequire` (rather than an ESM JSON import) needs no tsconfig flag
 * and no Node version-specific import-attribute syntax, and resolves
 * correctly relative to this compiled file in both the source-checkout
 * layout (dist/version.js -> ../package.json) and an installed/packaged
 * copy (package.json ships at the package root regardless of the "files"
 * allowlist).
 */
const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const VERSION: string = pkg.version;
