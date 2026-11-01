/**
 * Read a Composio MCP tool result exactly once, and believe only what it says.
 *
 * Observed live: Composio's session MCP returns the envelope as JSON text,
 * `{"successful": bool, "data": ..., "error": ...}`, with `isError: true` on
 * failure. Transport success alone proves nothing — a 200 that says
 * `successful: false`, or a body this code can't parse, is a failure.
 */

const CONTRACT_MESSAGE = "Composio returned a response this integration could not read.";
const MAX_TEXT_CHARS = 4_000_000;

export type Parsed =
  | { ok: true; data: unknown; logId?: string }
  | { ok: false; message: string; contract?: true };

const contractFailure = (): Parsed => ({ ok: false, message: CONTRACT_MESSAGE, contract: true });

function messageOf(env: Record<string, any>): string {
  const candidates = [env.error, env.data?.error, env.message, env.error?.message, env.data?.message];
  const found = candidates.find((c) => typeof c === "string" && c.trim());
  return found ? String(found).trim() : "The GitHub action failed.";
}

function success(env: Record<string, any>): Parsed {
  const logId = typeof env.log_id === "string" ? env.log_id : typeof env.logId === "string" ? env.logId : undefined;
  return logId ? { ok: true, data: env.data, logId } : { ok: true, data: env.data };
}

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

export function parseUpstream(result: unknown): Parsed {
  if (!isObject(result)) return contractFailure();
  const isError = result.isError === true;

  let env: unknown;
  let rawText: string | undefined;
  if (isObject(result.structuredContent)) {
    env = result.structuredContent;
  } else {
    const block = Array.isArray(result.content)
      ? result.content.find((c: any) => c && c.type === "text" && typeof c.text === "string")
      : undefined;
    rawText = block?.text;
    if (rawText !== undefined && rawText.length <= MAX_TEXT_CHARS) {
      try {
        env = JSON.parse(rawText);
      } catch {
        env = undefined;
      }
    }
  }

  if (!isObject(env)) {
    if (isError) return { ok: false, message: rawText?.trim() || "The GitHub action failed." };
    return contractFailure();
  }

  if (typeof env.successful === "boolean") {
    if (!env.successful || isError) return { ok: false, message: messageOf(env) };
    if (env.data === undefined || env.data === null) return contractFailure();
    return success(env);
  }
  if (isError) return { ok: false, message: messageOf(env) };
  if (env.data === undefined || env.data === null) return contractFailure();
  return success(env);
}
