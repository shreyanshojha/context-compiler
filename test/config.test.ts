import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, CONFIG_FILENAME } from "../src/config.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cc-config-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns an empty object when no config file exists", () => {
    expect(loadConfig(dir)).toEqual({});
  });

  it("parses a valid config file", () => {
    writeFileSync(join(dir, CONFIG_FILENAME), JSON.stringify({ budgetTokens: 4000, pin: ["README.md"] }));
    expect(loadConfig(dir)).toEqual({ budgetTokens: 4000, pin: ["README.md"] });
  });

  it("throws a clear, actionable error on malformed JSON", () => {
    writeFileSync(join(dir, CONFIG_FILENAME), "{not valid json");
    expect(() => loadConfig(dir)).toThrow(/not valid JSON/);
  });
});
