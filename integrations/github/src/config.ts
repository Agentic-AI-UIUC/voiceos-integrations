/**
 * Configuration as VoiceOS provides it: setup fields injected as environment
 * variables (strings, booleans as "true"/"false").
 *
 * Test seams arrive as command-line arguments, never as environment variables
 * (VoiceOS launches run.sh without arguments, and every env var the server
 * reads is a declared setup field): --composio-base-url (loopback servers
 * only) and --state-dir.
 */
import { join } from "node:path";
import { resolveBaseUrl } from "./composio.ts";
import type { GatewayConfig } from "./gateway.ts";

function argument(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : undefined;
}

export function loadConfig(env: Record<string, string | undefined>, folder: string, argv: string[] = []): GatewayConfig {
  const text = (name: string) => {
    const v = env[name]?.trim();
    return v ? v : undefined;
  };
  return {
    apiKey: text("COMPOSIO_PROJECT_API_KEY"),
    baseUrl: resolveBaseUrl(argument(argv, "composio-base-url")),
    connectionEnabled: env.GITHUB_CONNECTION !== "false",
    authConfigPin: text("COMPOSIO_GITHUB_AUTH_CONFIG_ID"),
    stateDir: argument(argv, "state-dir") ?? join(folder, ".state"),
  };
}
