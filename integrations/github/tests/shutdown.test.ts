/**
 * How the server ends. VoiceOS closes an integration the way the MCP SDK's
 * StdioClientTransport does: it ends stdin, waits 2 s, then calls
 * kill("SIGTERM"). On Windows that kill terminates the process at once and no
 * handler runs, so ending stdin is the only notice the server gets there.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRepo, startMockComposio } from "./mockComposio.ts";

const MAIN = join(import.meta.dir, "../src/main.ts");
const cleanup: Array<() => void> = [];
afterEach(() => {
  while (cleanup.length) cleanup.pop()!();
});

/** The server over a raw pipe, so nothing but what the test does reaches it (no signal). */
function launch(baseUrl: string, apiKey: string) {
  const state = mkdtempSync(join(tmpdir(), "gh-shutdown-"));
  const proc = Bun.spawn([process.execPath, MAIN, `--composio-base-url=${baseUrl}`, `--state-dir=${state}`], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    env: { PATH: process.env.PATH ?? "", SYSTEMROOT: process.env.SYSTEMROOT ?? "", COMPOSIO_PROJECT_API_KEY: apiKey },
  });
  cleanup.push(() => {
    proc.kill();
    rmSync(state, { recursive: true, force: true });
  });
  const replies = new Map<number, (msg: any) => void>();
  void (async () => {
    const decoder = new TextDecoder();
    let buffered = "";
    for await (const chunk of proc.stdout) {
      buffered += decoder.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (typeof msg.id === "number") replies.get(msg.id)?.(msg);
      }
    }
  })();
  let nextId = 1;
  const send = (msg: object) => {
    proc.stdin.write(`${JSON.stringify(msg)}\n`);
    proc.stdin.flush();
  };
  const request = (method: string, params: object) =>
    new Promise<any>((resolve) => {
      const id = nextId++;
      replies.set(id, resolve);
      send({ jsonrpc: "2.0", id, method, params });
    });
  return {
    proc,
    async handshake() {
      await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "shutdown-test", version: "1" } });
      send({ jsonrpc: "2.0", method: "notifications/initialized" });
    },
    call: (name: string, args: object) => request("tools/call", { name, arguments: args }),
  };
}

test("ending stdin alone shuts the server down and deletes the Composio session it opened", async () => {
  const mock = startMockComposio();
  cleanup.push(() => mock.stop());
  mock.addRepo(makeRepo("octocat", "Hello-World"));
  const server = launch(mock.baseUrl, mock.apiKey);
  await server.handshake();

  // Connect GitHub (the first call hands out the Connect card), then use it: the server now holds a live session.
  await server.call("search_repositories", { q: "hello" });
  mock.activate([...mock.accounts.keys()].at(-1)!);
  const found = await server.call("search_repositories", { q: "hello" });
  expect(JSON.parse(found.result.content[0].text).ok).toBe(true);
  expect(mock.sessions.size).toBe(1);

  const started = Date.now();
  server.proc.stdin.end();
  const exit = await Promise.race([server.proc.exited, Bun.sleep(5_000).then(() => "still running")]);
  expect(exit).toBe(0);
  // Inside the 2 s VoiceOS waits before it kills the process.
  expect(Date.now() - started).toBeLessThan(2_000);
  expect(mock.sessions.size).toBe(0);
}, 20_000);
