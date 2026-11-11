import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentCredentials, mp4Info, mp4InfoFromBuffer, sipsMeta } from "../src/media.ts";
import { run } from "../src/proc.ts";
import { box, box64, boxToEof, concat, fakeRunner, ftyp, mdat, mehd, moov, mp4, mvhd, pngBytes, tkhd, trak } from "./fixtures/media/fixtures.ts";

const FIXTURES = join(import.meta.dir, "fixtures", "media");
const darwin = process.platform === "darwin";
let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tiktok-media-test-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("mp4InfoFromBuffer", () => {
  test("moov first: mvhd v0 duration, brand, mime and the video track's size (audio track ignored)", () => {
    const buf = concat(ftyp("isom"), moov(mvhd(0, 600, 3600), trak(tkhd({ width: 1920, height: 1080 })), trak(tkhd({ width: 0, height: 0, trackId: 2 }), "soun")), mdat(64));
    expect(mp4InfoFromBuffer(buf)).toEqual({ size: buf.length, duration_sec: 6, brand: "isom", mime: "video/mp4", width: 1920, height: 1080 });
  });

  test("moov last, after a large mdat", () => {
    const buf = mp4({ moovLast: true, mdatBytes: 2 * 1024 * 1024, seconds: 23, width: 1080, height: 1920 });
    expect(mp4InfoFromBuffer(buf)).toMatchObject({ size: buf.length, duration_sec: 23, width: 1080, height: 1920, mime: "video/mp4" });
  });

  test("mvhd version 1 (64-bit duration) and tkhd version 1", () => {
    const buf = concat(ftyp("mp42"), moov(mvhd(1, 90_000, 90_000n * 125n + 45_000n), trak(tkhd({ version: 1, width: 720, height: 1280 }))));
    expect(mp4InfoFromBuffer(buf)).toMatchObject({ duration_sec: 125.5, brand: "mp42", mime: "video/mp4", width: 720, height: 1280 });
  });

  test("64-bit box sizes (size = 1 + largesize) for mdat and moov", () => {
    const m = moov(mvhd(0, 1000, 4_000), trak(tkhd({ width: 640, height: 360 })));
    const buf = concat(ftyp(), box64("mdat", new Uint8Array(1000)), box64("moov", m.subarray(8)));
    expect(mp4InfoFromBuffer(buf)).toMatchObject({ duration_sec: 4, width: 640, height: 360 });
  });

  test("size-0 boxes extend to the end of the file (as the last mdat, or as moov itself)", () => {
    const m = moov(mvhd(0, 1000, 2_500), trak(tkhd({ width: 320, height: 240 })));
    expect(mp4InfoFromBuffer(concat(ftyp(), m, boxToEof("mdat", new Uint8Array(500))))).toMatchObject({ duration_sec: 2.5, width: 320 });
    expect(mp4InfoFromBuffer(concat(ftyp(), box("free"), boxToEof("moov", m.subarray(8))))).toMatchObject({ duration_sec: 2.5, width: 320 });
  });

  test("90° and 270° display matrices swap width and height; 180° doesn't", () => {
    expect(mp4InfoFromBuffer(mp4({ width: 1920, height: 1080, rotation: 90 }))).toMatchObject({ width: 1080, height: 1920 });
    expect(mp4InfoFromBuffer(mp4({ width: 1920, height: 1080, rotation: 270 }))).toMatchObject({ width: 1080, height: 1920 });
    expect(mp4InfoFromBuffer(mp4({ width: 1920, height: 1080, rotation: 180 }))).toMatchObject({ width: 1920, height: 1080 });
  });

  test('ftyp "qt  " → video/quicktime; other brands → video/mp4; no ftyp → no mime', () => {
    expect(mp4InfoFromBuffer(mp4({ brand: "qt  " }))).toMatchObject({ brand: "qt  ", mime: "video/quicktime" });
    expect(mp4InfoFromBuffer(mp4({ brand: "M4V " }))).toMatchObject({ brand: "M4V ", mime: "video/mp4" });
    const classic = mp4InfoFromBuffer(mp4({ brand: null, seconds: 3 }));
    expect(classic.duration_sec).toBe(3);
    expect(classic.mime).toBeUndefined();
    expect(classic.brand).toBeUndefined();
  });

  test("the largest video track wins; handler 'vide' beats a bigger non-video track", () => {
    const buf = concat(ftyp(), moov(mvhd(0, 600, 600), trak(tkhd({ width: 320, height: 180 })), trak(tkhd({ width: 1920, height: 1080, trackId: 2 })), trak(tkhd({ width: 3840, height: 200, trackId: 3 }), "sbtl")));
    expect(mp4InfoFromBuffer(buf)).toMatchObject({ width: 1920, height: 1080 });
  });

  test("fragmented MP4: mvhd duration 0 falls back to mvex/mehd", () => {
    const buf = concat(ftyp("iso6"), moov(mvhd(0, 1000, 0), box("mvex", mehd(0, 12_345)), trak(tkhd({ width: 1080, height: 1920 }))));
    expect(mp4InfoFromBuffer(buf).duration_sec).toBe(12.345);
  });

  test("corrupt or non-MP4 bytes → size only; truncated moov → what parsed, no throw", () => {
    let seed = 7;
    const noise = Uint8Array.from({ length: 4096 }, () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 0xff);
    expect(mp4InfoFromBuffer(noise)).toEqual({ size: 4096 });
    expect(mp4InfoFromBuffer(new Uint8Array(100).fill(0xff))).toEqual({ size: 100 });
    expect(mp4InfoFromBuffer(new Uint8Array(3))).toEqual({ size: 3 });
    const m = moov(mvhd(0, 600, 1200), trak(tkhd({ width: 640, height: 480 })));
    const truncated = concat(ftyp(), m).subarray(0, ftyp().length + 8 + 108 + 20); // mvhd complete, trak cut short
    const info = mp4InfoFromBuffer(truncated);
    expect(info).toMatchObject({ size: truncated.length, duration_sec: 2, brand: "isom" });
    expect(info.width).toBeUndefined();
  });

  test("a flood of tiny boxes is bounded (returns quickly, no hang)", () => {
    const free = box("free");
    const buf = new Uint8Array(free.length * 200_000);
    for (let i = 0; i < 200_000; i++) buf.set(free, i * free.length);
    const t = performance.now();
    expect(mp4InfoFromBuffer(buf)).toEqual({ size: buf.length });
    expect(performance.now() - t).toBeLessThan(1000);
  });
});

describe("mp4Info (files, seek-based)", () => {
  // Expected values are what ffprobe 9.0.1 reported for these ffmpeg-generated files.
  test.each([
    ["ffmpeg-faststart.mp4", 2, 32, 18, "isom", "video/mp4"],
    ["ffmpeg-moov-last.mp4", 2, 32, 18, "isom", "video/mp4"], // + an AAC track, moov at the end
    ["ffmpeg-qt.mov", 1.5, 32, 18, "qt  ", "video/quicktime"],
    ["ffmpeg-rotated90.mov", 1.5, 18, 32, "qt  ", "video/quicktime"], // display_rotation 90
  ] as const)("real ffmpeg output %s", (name, seconds, width, height, brand, mime) => {
    const info = mp4Info(join(FIXTURES, name));
    expect(info.duration_sec).toBeCloseTo(seconds, 1);
    expect(info).toMatchObject({ width, height, brand, mime });
  });

  test("synthetic files match the buffer reader (moov first and moov last)", () => {
    for (const [i, buf] of [mp4({ seconds: 9 }), mp4({ moovLast: true, brand: "qt  ", seconds: 9, rotation: 90 })].entries()) {
      const p = join(dir, `synthetic-${i}.mp4`);
      writeFileSync(p, buf);
      expect(mp4Info(p)).toEqual(mp4InfoFromBuffer(buf));
    }
  });

  test.skipIf(process.platform === "win32")("moov after a 5 GB mdat (sparse file): found with a few small reads", () => {
    const p = join(dir, "huge.mp4");
    const head = ftyp();
    const fiveGB = 5 * 1024 ** 3;
    const m = moov(mvhd(0, 600, 600 * 61), trak(tkhd({ width: 1080, height: 1920 })));
    const fd = openSync(p, "w");
    try {
      writeSync(fd, head, 0, head.length, 0);
      const mdatHead = box64("mdat", new Uint8Array(0), fiveGB);
      writeSync(fd, mdatHead, 0, mdatHead.length, head.length);
      writeSync(fd, m, 0, m.length, head.length + fiveGB);
    } finally {
      closeSync(fd);
    }
    const t = performance.now();
    const info = mp4Info(p);
    expect(performance.now() - t).toBeLessThan(500);
    expect(info).toMatchObject({ size: head.length + fiveGB + m.length, duration_sec: 61, width: 1080, height: 1920 });
  });

  test("corrupt file → size only; missing file throws", () => {
    const p = join(dir, "corrupt.mov");
    const text = "this is not a movie at all, just text that happens to be long enough";
    writeFileSync(p, text);
    expect(mp4Info(p)).toEqual({ size: Buffer.byteLength(text) });
    expect(() => mp4Info(join(dir, "nope.mp4"))).toThrow();
  });
});

describe("sipsMeta (fake runner)", () => {
  test.skipIf(process.platform === "win32")("ONE sips call; per-file blocks parsed; realpath-printed paths, odd names, <nil> dims and skipped files mapped back", async () => {
    const real = join(dir, "real");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(dir, "link"));
    const odd = join(dir, "link", 'Screenshot 2026-11-03 at 9.07.32 PM "q" 🎉.png');
    const plain = join(dir, "link", "a b.jpg");
    const notImage = join(dir, "link", "notes.png");
    const missing = join(dir, "link", "missing.heic");
    for (const p of [odd, plain, notImage]) writeFileSync(p, "x");
    const meta: Record<string, { width: number; height: number; format: string; has_alpha: boolean } | null> = {
      [odd]: { width: 2940, height: 1912, format: "png", has_alpha: true },
      [plain]: { width: 4032, height: 3024, format: "jpeg", has_alpha: false },
      [notImage]: null,
    };
    const runner = fakeRunner({ sips: (p) => meta[p], sipsPrintPath: (p) => realpathSync(p) });
    const out = await sipsMeta([odd, plain, notImage, missing, plain], runner);
    expect(runner.count("sips")).toBe(1);
    const cmd = runner.calls[0].cmd;
    expect(cmd.slice(0, 9)).toEqual(["/usr/bin/sips", "-g", "pixelWidth", "-g", "pixelHeight", "-g", "format", "-g", "hasAlpha"]);
    expect(cmd.slice(9)).toEqual([odd, plain, notImage, missing]); // deduplicated, verbatim (no shell, no escaping)
    expect(out.get(odd)).toEqual({ width: 2940, height: 1912, format: "png", has_alpha: true });
    expect(out.get(plain)).toEqual({ width: 4032, height: 3024, format: "jpeg", has_alpha: false });
    expect(out.get(notImage)).toBeNull();
    expect(out.get(missing)).toBeNull();
    expect(out.size).toBe(4);
  });

  test("canned real-world output: two-space indented keys, warnings ignored", async () => {
    const a = join(dir, "x1.png");
    const b = join(dir, "x2.heic");
    const stdout = `${a}\n  pixelWidth: 3\n  pixelHeight: 2\n  format: png\n  hasAlpha: yes\n${b}\n  pixelWidth: 4\n  pixelHeight: 5\n  format: heic\n  hasAlpha: no\n`;
    const out = await sipsMeta([a, b], fakeRunner({ sipsResult: { stdout, stderr: "Warning: something - skipping\n" } }));
    expect(out.get(a)).toEqual({ width: 3, height: 2, format: "png", has_alpha: true });
    expect(out.get(b)).toEqual({ width: 4, height: 5, format: "heic", has_alpha: false });
  });

  test("unmatched block paths pair up in order when the counts agree", async () => {
    const a = join(dir, "pair-a.png");
    const out = await sipsMeta([a], fakeRunner({ sipsResult: { stdout: "/elsewhere/pair-a.png\n  pixelWidth: 10\n  pixelHeight: 20\n  format: png\n  hasAlpha: no\n" } }));
    expect(out.get(a)).toEqual({ width: 10, height: 20, format: "png", has_alpha: false });
  });

  test("sips missing or failing → every path null; empty input → no call", async () => {
    const out = await sipsMeta(["/a.png", "/b.png"], fakeRunner({ sipsResult: { code: 127, stderr: "not found" } }));
    expect([...out.values()]).toEqual([null, null]);
    const runner = fakeRunner();
    expect((await sipsMeta([], runner)).size).toBe(0);
    expect(runner.calls.length).toBe(0);
  });
});

describe("contentCredentials", () => {
  const UUID = Buffer.from("6332706100110010800000aa00389b71", "hex");
  const AI = Buffer.from("http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia", "latin1");
  const COMPOSITE = Buffer.from("http://cv.iptc.org/newscodes/digitalsourcetype/compositeWithTrainedAlgorithmicMedia", "latin1");
  const jpegish = (...parts: Uint8Array[]) => concat(Uint8Array.from([0xff, 0xd8, 0xff, 0xeb]), new Uint8Array(300).fill(7), ...parts, new Uint8Array(200), Uint8Array.from([0xff, 0xd9]));
  const write = (name: string, bytes: Uint8Array) => {
    const p = join(dir, name);
    writeFileSync(p, bytes);
    return p;
  };

  test("none / present / ai", async () => {
    expect(await contentCredentials(write("plain.jpg", jpegish()))).toBe("none");
    expect(await contentCredentials(write("signed.jpg", jpegish(Buffer.from("jumb"), UUID, Buffer.from("c2pa\0"))))).toBe("present");
    expect(await contentCredentials(write("ai.jpg", jpegish(UUID, new Uint8Array(50), AI)))).toBe("ai");
    expect(await contentCredentials(write("composite.jpg", jpegish(UUID, COMPOSITE)))).toBe("ai");
  });

  test("an AI source string without a C2PA manifest store is 'none' (XMP alone isn't Content Credentials)", async () => {
    expect(await contentCredentials(write("xmp-only.jpg", jpegish(AI)))).toBe("none");
  });

  test("patterns straddling the 8 MB read boundary are still found", async () => {
    const big = new Uint8Array(9 * 1024 * 1024);
    big.set(UUID, 8 * 1024 * 1024 - 7);
    expect(await contentCredentials(write("straddle-uuid.webp", big))).toBe("present");
    big.set(AI, 8 * 1024 * 1024 - 30);
    big.set(UUID, 100);
    expect(await contentCredentials(write("straddle-ai.webp", big))).toBe("ai");
  });

  test("missing file rejects", async () => {
    await expect(contentCredentials(join(dir, "gone.jpg"))).rejects.toThrow();
  });
});

describe.skipIf(!darwin)("darwin: real sips -g", () => {
  test("PNG/JPEG/HEIC made with sips, a fake .png and a missing file, through the /var → /private/var symlink", async () => {
    const rgba = join(dir, "real alpha.png");
    const rgb = join(dir, "real rgb.png");
    writeFileSync(rgba, pngBytes(3, 2, true));
    writeFileSync(rgb, pngBytes(4, 5, false));
    const jpg = join(dir, "real.jpg");
    const heic = join(dir, "real.heic");
    expect((await run(["/usr/bin/sips", "-s", "format", "jpeg", rgb, "--out", jpg])).code).toBe(0);
    expect((await run(["/usr/bin/sips", "-s", "format", "heic", rgb, "--out", heic])).code).toBe(0);
    const fake = join(dir, "fake.png");
    writeFileSync(fake, "not an image");
    const missing = join(dir, "missing.png");
    const out = await sipsMeta([rgba, rgb, jpg, heic, fake, missing], run);
    expect(out.get(rgba)).toEqual({ width: 3, height: 2, format: "png", has_alpha: true });
    expect(out.get(rgb)).toEqual({ width: 4, height: 5, format: "png", has_alpha: false });
    expect(out.get(jpg)).toEqual({ width: 4, height: 5, format: "jpeg", has_alpha: false });
    expect(out.get(heic)).toMatchObject({ width: 4, height: 5, format: "heic" });
    expect(out.get(fake)).toBeNull();
    expect(out.get(missing)).toBeNull();
  });
});
