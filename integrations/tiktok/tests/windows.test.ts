import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { POWERSHELL_TIMEOUT_MS, removeJobDir, windowsOperation, windowsRunner } from "../src/windows.ts";
import { loadConfig } from "../src/config.ts";
import { createDeps } from "../src/mcpServer.ts";
import { run, realClock } from "../src/proc.ts";
import { convertForTikTok } from "../src/images.ts";
import { sipsMeta } from "../src/media.ts";
import { findRecentVideos } from "../src/files.ts";
import { parseDescribe } from "../src/finderParse.ts";
import { parseBmp, photoPreview, videoPreview } from "../src/preview.ts";
import { pngBytes, mp4 } from "./fixtures/media/fixtures.ts";
import type { BundleImage } from "../src/types.ts";

const dirs: string[] = [];
const fresh = () => { const p = mkdtempSync(join(tmpdir(), "tiktok-windows-test-")); dirs.push(p); return p; };
afterEach(() => { for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); });

test("Windows jobs pass Unicode and command-like text as JSON and remove temporary files", async () => {
  let script = "", data = "";
  const text = 'Café 🎉 $([IO.File]::Delete("anything"))';
  const r = await windowsOperation(async (cmd) => {
    expect(cmd[0]).toBe("powershell.exe");
    expect(cmd).toContain("-STA");
    script = cmd[cmd.indexOf("-File") + 1]; data = cmd[cmd.indexOf("-JobFile") + 1];
    expect(readFileSync(script, "utf8")).toStartWith("\ufeffparam(");
    expect(readFileSync(script, "utf8")).not.toContain(text);
    expect(JSON.parse(readFileSync(data, "utf8"))).toEqual({ operation: "clipboard", text });
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  }, { operation: "clipboard", text });
  expect(r.code).toBe(0); expect(existsSync(script)).toBe(false); expect(existsSync(data)).toBe(false);
});

test("File Explorer descriptions use the existing selection and reveal routes", () => {
  expect(parseDescribe("the video selected in File Explorer").finder).toBe(true);
  expect(parseDescribe("show it in File Explorer").reveal).toBe(true);
});

const native = windowsRunner(run);
const image = (p: string, width: number, height: number, alpha = false): BundleImage => ({ path: p, name: basename(p), size: statSync(p).size, mtimeMs: statSync(p).mtimeMs, width, height, format: "png", has_alpha: alpha, credentials: "none" });
// Minimal EXIF Orientation IFD, inserted before a valid JPEG's existing segments.
function oriented(jpg: Buffer, n: number): Buffer {
  const exif = Buffer.alloc(36); exif.set([0xff, 0xe1, 0, 34]); exif.write("Exif\0\0MM", 4, "latin1");
  exif.writeUInt16BE(42, 12); exif.writeUInt32BE(8, 14); exif.writeUInt16BE(1, 18);
  exif.writeUInt16BE(274, 20); exif.writeUInt16BE(3, 22); exif.writeUInt32BE(1, 24); exif.writeUInt16BE(n, 28);
  return Buffer.concat([jpg.subarray(0, 2), exif, jpg.subarray(2)]);
}

describe.skipIf(process.platform !== "win32")("native Windows media and desktop", () => {
  test("converts PNG/alpha and EXIF-rotated JPEG, fits 1080p and strips EXIF", async () => {
    const dir = fresh(), p = join(dir, 'Café 🎉 $(literal).png'), alpha = join(dir, "alpha.png");
    writeFileSync(p, pngBytes(2400, 1600)); writeFileSync(alpha, pngBytes(200, 100, true, [0, 0, 0]));
    const rotated = join(dir, "rotated.jpg");
    expect((await native(["sips", "-s", "format", "jpeg", p, "--out", rotated], { timeoutMs: 15000 })).code).toBe(0);
    writeFileSync(rotated, oriented(readFileSync(rotated), 6));
    const meta = await sipsMeta([p, alpha], native);
    expect(meta.get(p)).toMatchObject({ width: 2400, height: 1600 }); expect(meta.get(alpha)?.has_alpha).toBe(true);
    const out = await convertForTikTok([image(p, 2400, 1600), image(alpha, 200, 100, true), { ...image(rotated, 2400, 1600), format: "jpeg" }], native, { tmpRoot: dir });
    try {
      expect(out.files.map(x => [x.width, x.height])).toEqual([[1620, 1080], [200, 100], [1080, 1620]]);
      for (const f of out.files) expect(readFileSync(f.path).includes(Buffer.from("Exif\0\0"))).toBe(false);
      const bmp = join(dir, "alpha.bmp");
      expect((await native(["sips", "-s", "format", "bmp", out.files[1].path, "--out", bmp], { timeoutMs: 15000 })).code).toBe(0);
      const pixels = parseBmp(readFileSync(bmp))!;
      // Black at 50% alpha on white is gray, rather than black.
      for (const v of pixels.rgb.subarray(0, 3)) expect(v).toBeGreaterThan(110);
    } finally { await out.cleanup(); }
  }, 60000);

  test("creates photo thumbnails and a confirmation stack through native BMP/JPEG conversion", async () => {
    const dir = fresh(), p = join(dir, "photo.png"); writeFileSync(p, pngBytes(300, 400));
    const preview = await photoPreview([p], native, { budgetMs: 20000, tmpRoot: dir });
    expect(preview.thumbs?.[0]).toStartWith("data:image/jpeg;base64,"); expect(preview.stack).toStartWith("s2.");
  }, 30000);

  test("discovers a normal Videos file even when Windows reports no allocated blocks", async () => {
    const home = fresh(); mkdirSync(join(home, "Videos"));
    const path = join(home, "Videos", "Café 🎉.mp4"); writeFileSync(path, mp4({ seconds: 3, mdatBytes: 6000 }));
    const old = new Date(Date.now() - 60000); utimesSync(path, old, old);
    const result = await findRecentVideos({ home, folders: ["Videos"], runner: native, clock: realClock });
    expect(result.videos[0]?.name).toBe("Café 🎉.mp4"); expect(result.videos[0]?.duration_sec).toBe(3);
  }, 20000);

  test("copies Unicode captions literally using the native clipboard", async () => {
    const text = "Café 🎉 $literal #test";
    expect((await native(["pbcopy"], { stdin: text, timeoutMs: 15000 })).code).toBe(0);
    const r = await run(["powershell.exe", "-NoProfile", "-STA", "-Command", "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Console]::Write((Get-Clipboard -Raw))"], { timeoutMs: 15000 });
    expect(r.code).toBe(0); expect(r.stdout.trimEnd()).toBe(text);
  }, 30000);

  test("finds ffmpeg.exe on PATH and extracts a real video preview", async () => {
    const path = join(import.meta.dir, "fixtures/media/ffmpeg-faststart.mp4");
    const preview = await videoPreview(path, { duration_sec: 3, width: 160, height: 90, size: statSync(path).size, mtimeMs: statSync(path).mtimeMs }, native, { budgetMs: 15000 });
    expect(preview.poster).toStartWith("data:image/jpeg;base64,"); expect(preview.micro).toBeDefined();
  }, 20000);
});

// QA (PR 47): a PowerShell killed at its deadline can hold its job files a moment longer, and Windows then refuses the
// delete (EBUSY). Cleanup is best effort and retried: it never turns the job's result into a throw.
test("a job folder Windows won't delete yet (EBUSY) is retried in the background, never thrown", async () => {
  let calls = 0;
  const busy = () => {
    calls++;
    if (calls < 3) throw Object.assign(new Error("resource busy or locked"), { code: "EBUSY" });
  };
  expect(() => removeJobDir("C:\\Temp\\tiktok-windows-x", busy)).not.toThrow();
  expect(calls).toBe(1);
  await Bun.sleep(1_000); // retries after 250 ms, then 500 ms
  expect(calls).toBe(3);
});

test("a killed PowerShell's result comes back even when its folder can't be removed yet", async () => {
  const r = await windowsOperation(async () => ({ code: 124, stdout: "", stderr: "", timedOut: true }), { operation: "folders" });
  expect(r).toMatchObject({ code: 124, timedOut: true });
});

test("the clipboard copy gives PowerShell time for a cold start (15 s, not 5 s)", async () => {
  expect(POWERSHELL_TIMEOUT_MS).toBe(15_000);
  const asked: Array<{ cmd: string[]; timeoutMs?: number; stdin?: string }> = [];
  const deps = createDeps(loadConfig({}, [`--state-dir=${fresh()}`, `--home=${fresh()}`]), {
    runner: async (cmd, opts = {}) => {
      asked.push({ cmd: [...cmd], timeoutMs: opts.timeoutMs, stdin: opts.stdin });
      return { code: 0, stdout: "", stderr: "", timedOut: false };
    },
  });
  await deps.copyToClipboard("Café 🎉");
  expect(asked).toEqual([{ cmd: ["pbcopy"], timeoutMs: 15_000, stdin: "Café 🎉" }]);
});
