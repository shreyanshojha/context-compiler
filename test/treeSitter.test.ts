import { describe, it, expect } from "vitest";
import { loadLanguage, getQuery, GRAMMAR_BY_EXT } from "../src/treeSitter.js";

describe("getQuery", () => {
  it("REGRESSION: returns the same compiled Query instance for the same grammar+source instead of recompiling", async () => {
    // Found via profiling a 7,000+ file real-world repo: recompiling the
    // same static tree-sitter query from scratch for every file (instead of
    // once) accounted for the large majority of the import graph's build
    // time (34s of a 50s total run on that repo). A query source string
    // isn't like a regex literal -- compiling it is real, non-trivial work,
    // so it must be cached by (grammar, source), not re-run per call.
    const wasmFile = GRAMMAR_BY_EXT[".js"];
    const lang = await loadLanguage(wasmFile);
    const source = "(identifier) @id";

    const first = getQuery(lang, wasmFile, source);
    const second = getQuery(lang, wasmFile, source);
    expect(second).toBe(first); // same object reference, not just equal content
  });

  it("does not confuse queries with the same source text across different grammars", async () => {
    const jsWasm = GRAMMAR_BY_EXT[".js"];
    const pyWasm = GRAMMAR_BY_EXT[".py"];
    const jsLang = await loadLanguage(jsWasm);
    const pyLang = await loadLanguage(pyWasm);
    const source = "(identifier) @id";

    const jsQuery = getQuery(jsLang, jsWasm, source);
    const pyQuery = getQuery(pyLang, pyWasm, source);
    expect(jsQuery).not.toBe(pyQuery);
  });
});
