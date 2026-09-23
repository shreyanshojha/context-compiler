import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const CONFIG_FILENAME = ".context-compiler.json";

export interface ContextCompilerConfig {
  budgetTokens?: number;
  provider?: "openai" | "voyage" | "fake";
  pin?: string[];
  ignore?: string[];
  structuralBoost?: boolean;
  cache?: boolean;
  rerank?: boolean;
  rerankModel?: string;
  rerankProvider?: "openai" | "anthropic";
}

/**
 * Load `.context-compiler.json` from a repo root, if present.
 * Missing file is not an error — it just means "no saved defaults yet,"
 * which is the normal state before `context-compiler init` has been run.
 * A malformed file is reported clearly rather than silently ignored, since
 * a user editing it by hand deserves to know if they broke it.
 */
export function loadConfig(root: string): ContextCompilerConfig {
  const path = join(root, CONFIG_FILENAME);
  if (!existsSync(path)) return {};

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(`Could not read ${CONFIG_FILENAME}: ${(err as Error).message}`);
  }

  try {
    return JSON.parse(raw) as ContextCompilerConfig;
  } catch (err) {
    throw new Error(
      `${CONFIG_FILENAME} is not valid JSON: ${(err as Error).message}. Fix or delete it, or re-run \`context-compiler init\`.`
    );
  }
}

export const DEFAULT_CONFIG: Required<ContextCompilerConfig> = {
  budgetTokens: 8000,
  provider: "openai",
  pin: [],
  ignore: [],
  structuralBoost: true,
  cache: true,
  rerank: false, // opt-in: costs real (if cheap) API calls beyond embeddings
  rerankProvider: "openai",
  rerankModel: "gpt-4o-mini", // provider-appropriate default is resolved at call time if this is left untouched
};
