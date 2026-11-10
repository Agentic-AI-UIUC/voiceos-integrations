/**
 * Child processes with a hard kill timer. Users' Macs have no `timeout`
 * command, and `qlmanage` can hang for minutes (plan §6.13), so every spawn
 * carries its own deadline. Output is captured, never inherited: stdout is
 * the MCP wire.
 */
import type { Clock, RunOptions, RunResult, Runner } from "./types.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 8 * 1024 * 1024;
const UTF8 = /utf-?8/i;

/**
 * VoiceOS starts integrations with no LANG or LC_* at all (12 variables, checked on 0.1.40), and macOS tools
 * then read and print text as MacRoman: pbcopy turned "Café 🎉" into "Caf√© …", and osascript and `defaults`
 * garble non-ASCII names the same way. Every child gets a UTF-8 locale; a UTF-8 one the user has is kept.
 * Passed explicitly, because Bun.spawn's default is the environment as it was at startup.
 */
function childEnv(base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (typeof v === "string") env[k] = v;
  if (!UTF8.test(env.LANG ?? "")) env.LANG = "en_US.UTF-8";
  if (!UTF8.test(env.LC_CTYPE ?? "")) env.LC_CTYPE = env.LANG;
  if (env.LC_ALL !== undefined && !UTF8.test(env.LC_ALL)) delete env.LC_ALL;
  return env;
}

export const run: Runner = async (cmd: string[], opts: RunOptions = {}): Promise<RunResult> => {
  let timedOut = false;
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      env: childEnv(process.env),
      stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (error) {
    // ENOENT and friends: the tool doesn't exist on this machine.
    return { code: 127, stdout: "", stderr: (error as Error).message, timedOut: false };
  }
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      proc.kill(9);
    } catch {
      /* already gone */
    }
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream).text(),
      new Response(proc.stderr as ReadableStream).text(),
      proc.exited,
    ]);
    return {
      code: timedOut ? 124 : code,
      stdout: stdout.length > MAX_OUTPUT ? stdout.slice(0, MAX_OUTPUT) : stdout,
      stderr: stderr.slice(0, 64 * 1024),
      timedOut,
    };
  } finally {
    clearTimeout(timer);
  }
};

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const t = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, Math.max(0, ms));
      const onAbort = () => {
        clearTimeout(t);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

/** stderr-only logging. Callers pass slugs, durations, our codes and log_ids — never keys, ids, paths, captions or URLs. */
export const log = (line: string) => {
  try {
    console.error(`[tiktok] ${line}`);
  } catch {
    /* stderr closed */
  }
};
