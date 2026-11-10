/**
 * The server's stdin must survive a write (found live 2026-11-06). On Bun 1.3.13, iterating a
 * `Bun.file().stream()` ends the process's stdin. VoiceOS launches `bun` from PATH (Homebrew, then ~/.bun/bin,
 * then its own 1.3.14), so a Mac with Bun 1.3.13 installed ran this server on it: the MD5 pass of every upload
 * ended stdin, the server exited once the write was done, VoiceOS put the integration in "error", and later turns
 * had no TikTok tools at all ("TikTok upload tools aren't available") until a Reload.
 *
 * This runs the real staging path (src/client.ts stageFile → MD5 → upload request → PUT, against the loopback
 * mock) in a child Bun whose stdin is a live pipe, and checks that stdin is still delivering afterwards. On a Bun
 * without the bug it passes trivially; on 1.3.13 (CI's or a dev's) it catches a return of `Bun.file().stream()`.
 */
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");

const CHILD = `
import { ComposioClient } from ${JSON.stringify(join(ROOT, "src/client.ts"))};
import { startMockComposio } from ${JSON.stringify(join(ROOT, "tests/mock-composio.ts"))};
import { realClock } from ${JSON.stringify(join(ROOT, "src/proc.ts"))};
let chunks = 0, ended = false;
process.stdin.on("data", () => { chunks++; });
process.stdin.on("end", () => { ended = true; });
const mock = startMockComposio();
const cfg = { apiKey: mock.apiKey, userId: mock.userId, connectedAccountId: mock.connectedAccountId, baseUrl: mock.baseUrl, relayBase: "", stateDir: "/nonexistent", home: "/nonexistent" };
const client = new ComposioClient(cfg as any, { clock: realClock });
await new Promise((r) => setTimeout(r, 200));
const staged = await client.stageFile(process.argv[2], "video/mp4", "TIKTOK_UPLOAD_VIDEO", Date.now() + 20_000);
const before = chunks;
await new Promise((r) => setTimeout(r, 700));
process.stdout.write(JSON.stringify({ staged: typeof staged.s3key === "string", ended, grew: chunks > before }) + "\\n");
mock.close?.();
process.exit(0);
`;

function runChild(video: string): Promise<{ staged: boolean; ended: boolean; grew: boolean }> {
  const dir = mkdtempSync(join(tmpdir(), "tiktok-stdin-"));
  const script = join(dir, "child.ts");
  writeFileSync(script, CHILD);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, video], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, BUN_JSC_useJIT: "false" } });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const ping = setInterval(() => child.stdin.writable && child.stdin.write("ping\n"), 50);
    const kill = setTimeout(() => child.kill("SIGKILL"), 25_000);
    child.on("exit", () => {
      clearInterval(ping);
      clearTimeout(kill);
      rmSync(dir, { recursive: true, force: true });
      try {
        resolve(JSON.parse(out.trim().split("\n").pop() ?? ""));
      } catch {
        reject(new Error(`child gave no result (${err.slice(-400)})`));
      }
    });
    child.stdin.on("error", () => {});
  });
}

describe("stdin survives an upload (Bun 1.3.13 file-stream bug)", () => {
  test("staging a video leaves stdin delivering", async () => {
    const video = join(ROOT, "tests/fixtures/media/ffmpeg-faststart.mp4");
    expect(statSync(video).size).toBeGreaterThan(0);
    const r = await runChild(video);
    expect(r).toEqual({ staged: true, ended: false, grew: true });
  }, 30_000);

  test("nothing under src/ iterates a Bun file stream", () => {
    const files = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? files(join(dir, n)) : n.endsWith(".ts") ? [join(dir, n)] : []));
    // Code lines only: the comment in src/client.ts that explains the bug names the call.
    const code = (f: string) => readFileSync(f, "utf8").split("\n").filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join("\n");
    const hits = files(join(ROOT, "src")).filter((f) => /Bun\.file\([^)]*\)\.stream\(|\bfile\.stream\(\)/.test(code(f)));
    expect(hits).toEqual([]);
  });
});
