/** Runtime configuration for the TypeScript BrowseCraft backend. */

import { config as loadDotEnv } from "dotenv";

loadDotEnv();

export type BackendConfig = {
  port: number;
  anthropicApiKey: string | null;
  anthropicChatModel: string;
  convexUrl: string | null;
  convexAccessKey: string | null;
  buildApplyTimeoutMs: number;
};

/** Load backend configuration from the current process environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): BackendConfig {
  return {
    port: parseInteger(env.PORT, 8080),
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? null,
    anthropicChatModel: env.ANTHROPIC_CHAT_MODEL ?? "claude-sonnet-4-5",
    convexUrl: env.CONVEX_URL ?? null,
    convexAccessKey: env.CONVEX_ACCESS_KEY ?? null,
    buildApplyTimeoutMs: parseInteger(env.BUILD_APPLY_TIMEOUT_MS, 15_000),
  };
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Expected integer environment value, got: ${value}`);
  }

  return parsed;
}
