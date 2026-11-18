/**
 * Photo pipeline (src/images.ts): planBundle labels and warnings, the sips
 * canvas script, convertForTikTok against a FAKE sips runner (CI is ubuntu),
 * the stale work-dir sweep, and a darwin-only suite that runs the real
 * pipeline on images generated with sips itself.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { TikTokError } from "../src/errors.ts";
import { SIPS_ORIENT_JS, convertForTikTok, planBundle, sweepStaleWorkDirs } from "../src/images.ts";
import { run } from "../src/proc.ts";
import type { BundleImage, RunOptions, RunResult, Runner } from "../src/types.ts";

const SRGB = "/System/Library/ColorSync/Profiles/sRGB Profile.icc";
const MAX_BYTES = 20 * 1024 * 1024;
const WORK_RE = /^tiktok-[0-9a-f]{16}$/;

const img = (name: string, o: Partial<BundleImage> = {}): BundleImage => ({
  path: `/Users/someone/Downloads/${name}`,
  name,
  size: 1000,
  mtimeMs: 1,
  width: 1080,
  height: 1350,
  format: "jpeg",
  has_alpha: false,
  credentials: "none",
  ...o,
});

function caughtSync(fn: () => unknown): TikTokError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TikTokError);
    return e as TikTokError;
  }
  throw new Error("expected a throw");
}

async function caught(p: Promise<unknown>): Promise<TikTokError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(TikTokError);
    return e as TikTokError;
  }
  throw new Error("expected a rejection");
}

const roots: string[] = [];
function tempRoot(): string {
  const r = mkdtempSync(join(tmpdir(), "images-test-"));
  roots.push(r);
  return r;
}
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const workDirs = (root: string) => (existsSync(root) ? readdirSync(root).filter((n) => WORK_RE.test(n)) : []);

// ---------------------------------------------------------------------------
// planBundle
// ---------------------------------------------------------------------------

describe("planBundle: labels", () => {
  test("count_label names the count and the cover (1-based); a single photo is just '1 photo'", () => {
    const eight = Array.from({ length: 8 }, (_, i) => img(`p${i}.jpg`));
    expect(planBundle(eight, 1).count_label).toBe("8 photos · cover: photo 2");
    expect(planBundle(eight.slice(0, 2), 0).count_label).toBe("2 photos · cover: photo 1");
    expect(planBundle([img("beach.jpg")], 0).count_label).toBe("1 photo");
  });

  test("order_label lists basenames without extensions, numbered in carousel order", () => {
    const p = planBundle([img("beach.jpg"), img("sunset.HEIC"), img("dinner.png")], 0);
    expect(p.order_label).toBe("1 beach · 2 sunset · 3 dinner");
    expect(planBundle([img("my.trip.photo.jpeg")], 0).order_label).toBe("1 my.trip.photo");
  });

  test("order_label normalises macOS's narrow no-break space and drops control/bidi characters", () => {
    const p = planBundle([img("Screenshot 2026-11-03 at 9.07.32 PM.png"), img("we‮ird\u0007  name.jpg")], 0);
    expect(p.order_label).toBe("1 Screenshot 2026-11-03 at 9.07.32 PM · 2 weird name");
  });

  test("a long order_label is cut at a whole name, ≤ 120 chars, ending with '…'", () => {
    const names = Array.from({ length: 12 }, (_, i) => `vacation-photo-${String(i + 1).padStart(2, "0")}.jpg`);
    const label = planBundle(names.map((n) => img(n)), 0).order_label;
    expect(label.length).toBeLessThanOrEqual(120);
    expect(label.endsWith(" …")).toBe(true);
    const kept = label.slice(0, -2).split(" · ");
    expect(kept.length).toBeGreaterThan(1);
    kept.forEach((part, i) => expect(part).toBe(`${i + 1} vacation-photo-${String(i + 1).padStart(2, "0")}`));
    // Adding the next whole name would have broken the limit.
    expect(`${label.slice(0, -2)} · ${kept.length + 1} vacation-photo-${String(kept.length + 1).padStart(2, "0")} …`.length).toBeGreaterThan(120);
  });

  test("exactly 120 chars is kept whole; one char more is cut", () => {
    // "1 " + 57 chars + " · " + "2 " + 56 chars = 120
    const a = "a".repeat(57);
    const b = "b".repeat(56);
    const whole = planBundle([img(`${a}.jpg`), img(`${b}.jpg`)], 0).order_label;
    expect(whole.length).toBe(120);
    expect(whole.endsWith("…")).toBe(false);
    const cut = planBundle([img(`${a}.jpg`), img(`${b}b.jpg`)], 0).order_label;
    expect(cut).toBe(`1 ${a} …`);
  });

  test("a single name longer than the limit is cut inside, without splitting an emoji", () => {
    const long = planBundle([img(`${"x".repeat(300)}.jpg`), img("b.jpg")], 0).order_label;
    expect(long.length).toBeLessThanOrEqual(120);
    expect(long.startsWith("1 xxx")).toBe(true);
    expect(long.endsWith("…")).toBe(true);
    const emoji = planBundle([img(`${"😀".repeat(100)}.png`)], 0).order_label;
    expect(emoji.length).toBeLessThanOrEqual(120);
    expect(emoji.endsWith("…")).toBe(true);
    expect(emoji.isWellFormed()).toBe(true);
  });
});

describe("planBundle: warnings", () => {
  test("HEIC photos (singular and plural)", () => {
    const one = planBundle([img("a.heic", { format: "heic" }), img("b.jpg")], 0);
    expect(one.warnings).toContain("1 photo is HEIC and will be converted to JPEG.");
    const three = planBundle(
      [img("a.heic", { format: "heic" }), img("b.HEIC", { format: "heic" }), img("c.heif", { format: "heif" }), img("d.jpg")],
      0,
    );
    expect(three.warnings).toContain("3 photos are HEIC and will be converted to JPEG.");
  });

  test("transparency: screenshots by name, otherwise photos", () => {
    const shots = planBundle(
      [img("Screenshot 2026-11-03 at 9.07.32 PM.png", { format: "png", has_alpha: true }), img("Screen Shot 2020-01-01.png", { format: "png", has_alpha: true })],
      0,
    );
    expect(shots.warnings).toContain("2 screenshots have transparency; it will become white.");
    const oneShot = planBundle([img("Screenshot 1.png", { format: "png", has_alpha: true })], 0);
    expect(oneShot.warnings).toContain("1 screenshot has transparency; it will become white.");
    const onePhoto = planBundle([img("logo.png", { format: "png", has_alpha: true })], 0);
    expect(onePhoto.warnings).toContain("1 photo has transparency; it will become white.");
    const mixed = planBundle([img("logo.png", { has_alpha: true }), img("Screenshot 2.png", { has_alpha: true })], 0);
    expect(mixed.warnings).toContain("2 photos have transparency; it will become white.");
  });

  test("resizing uses the 1080p rule: short side ≤ 1080 and long side ≤ 1920", () => {
    const one = planBundle([img("big.jpg", { width: 4032, height: 3024 })], 0);
    expect(one.warnings).toEqual(["1 photo is 4032×3024 and will be resized."]);
    const same = planBundle([0, 1, 2].map((i) => img(`${i}.jpg`, { width: 4032, height: 3024 })), 0);
    expect(same.warnings).toEqual(["3 photos are 4032×3024 and will be resized."]);
    const mixed = planBundle([img("a.jpg", { width: 4032, height: 3024 }), img("b.jpg", { width: 2000, height: 1000 })], 0);
    expect(mixed.warnings).toEqual(["2 photos are larger than 1080p and will be resized."]);
    for (const [width, height] of [[1080, 1920], [1920, 1080], [1080, 1080], [1440, 1080], [720, 1280], [0, 0]]) {
      expect(planBundle([img("ok.jpg", { width, height })], 0).warnings).toEqual([]);
    }
    for (const [width, height] of [[1081, 1081], [2000, 1000], [1000, 2000], [1200, 1600]]) {
      expect(planBundle([img("big.jpg", { width, height })], 0).warnings).toHaveLength(1);
    }
  });

  test("no warnings → empty list and an empty card line", () => {
    const p = planBundle([img("a.jpg"), img("b.jpg")], 1);
    expect(p.warnings).toEqual([]);
    expect(p.warning).toBe("");
    expect(p.credentials).toEqual({ present: 0, ai: [] });
  });

  test("without credentials the card line is the most important other warning: transparency > resize > HEIC", () => {
    const heic = img("a.heic", { format: "heic" });
    const big = img("b.jpg", { width: 4032, height: 3024 });
    const alpha = img("c.png", { format: "png", has_alpha: true });
    expect(planBundle([heic], 0).warning).toBe("1 photo is HEIC and will be converted to JPEG.");
    expect(planBundle([heic, big], 0).warning).toBe("1 photo is 4032×3024 and will be resized.");
    expect(planBundle([heic, big, alpha], 0).warning).toBe("1 photo has transparency; it will become white.");
    const all = planBundle([heic, big, alpha], 0);
    expect(all.warnings).toEqual([
      "1 photo has transparency; it will become white.",
      "1 photo is 4032×3024 and will be resized.",
      "1 photo is HEIC and will be converted to JPEG.",
    ]);
  });
});

describe("planBundle: Content Credentials", () => {
  const AI_TAIL = "TikTok can't label photos sent from here, so drafts are safer.";

  test("credentials counts every photo that carries them; ai lists zero-based indexes", () => {
    const p = planBundle(
      [img("a.jpg"), img("b.jpg", { credentials: "ai" }), img("c.jpg"), img("d.jpg", { credentials: "present" }), img("e.jpg", { credentials: "ai" })],
      0,
    );
    expect(p.credentials).toEqual({ present: 3, ai: [1, 4] });
  });

  test("one AI photo → 'Photo 3's …' (1-based) and drafts advice", () => {
    const p = planBundle([img("a.jpg"), img("b.jpg"), img("c.jpg", { credentials: "ai" })], 0);
    expect(p.warning).toBe(`Photo 3's Content Credentials say it was made with AI. ${AI_TAIL}`);
    expect(p.warnings[0]).toBe(p.warning);
  });

  test("several AI photos → 'Photos 2 and 5's …', 'Photos 1, 2 and 3's …', or a count when there are many", () => {
    const two = planBundle(
      [img("a.jpg"), img("b.jpg", { credentials: "ai" }), img("c.jpg"), img("d.jpg"), img("e.jpg", { credentials: "ai" })],
      0,
    );
    expect(two.warning).toBe(`Photos 2 and 5's Content Credentials say they were made with AI. ${AI_TAIL}`);
    const three = planBundle([0, 1, 2].map((i) => img(`${i}.jpg`, { credentials: "ai" })), 0);
    expect(three.warning).toBe(`Photos 1, 2 and 3's Content Credentials say they were made with AI. ${AI_TAIL}`);
    const six = planBundle([0, 1, 2, 3, 4, 5].map((i) => img(`${i}.jpg`, { credentials: "ai" })), 0);
    expect(six.warning).toBe(`6 photos' Content Credentials say they were made with AI. ${AI_TAIL}`);
  });

  test("AI beats plain credentials and every other warning; the removal note stays in warnings[]", () => {
    const p = planBundle(
      [
        img("a.png", { credentials: "present", has_alpha: true, format: "png" }),
        img("b.heic", { credentials: "ai", format: "heic", width: 4032, height: 3024 }),
      ],
      0,
    );
    expect(p.warning).toBe(`Photo 2's Content Credentials say it was made with AI. ${AI_TAIL}`);
    expect(p.warnings[0]).toBe(p.warning);
    expect(p.warnings).toContain("2 photos carry Content Credentials, which are removed when they're converted.");
    expect(p.warnings).toContain("1 photo has transparency; it will become white.");
  });

  test("plain credentials (singular and plural) beat the format/size warnings", () => {
    const two = planBundle(
      [img("a.heic", { credentials: "present", format: "heic" }), img("b.jpg", { credentials: "present" }), img("c.jpg")],
      0,
    );
    expect(two.warning).toBe("2 photos carry Content Credentials, which are removed when they're converted.");
    const one = planBundle([img("a.png", { credentials: "present", has_alpha: true })], 0);
    expect(one.warning).toBe("1 photo carries Content Credentials, which are removed when it's converted.");
    expect(one.credentials).toEqual({ present: 1, ai: [] });
  });

  test("the wording only reports what the credentials say", () => {
    const p = planBundle([img("a.jpg", { credentials: "ai" }), img("b.jpg", { credentials: "present" })], 0);
    for (const w of p.warnings) {
      expect(w).not.toMatch(/this is AI|is AI-generated|are AI-generated/i);
    }
  });
});

describe("planBundle: purity and guards", () => {
  test("same input → same output; the input isn't mutated", () => {
    const input = [img("a.heic", { format: "heic", credentials: "ai" }), img("b.png", { has_alpha: true })];
    const before = structuredClone(input);
    expect(planBundle(input, 1)).toEqual(planBundle(input, 1));
    expect(input).toEqual(before);
  });

  test("empty, more than 35, or an out-of-range cover are refused", () => {
    expect(caughtSync(() => planBundle([], 0)).code).toBe("NO_PHOTOS");
    const many = caughtSync(() => planBundle(Array.from({ length: 36 }, (_, i) => img(`${i}.jpg`)), 0));
    expect(many.code).toBe("TOO_MANY_PHOTOS");
    expect(many.detail.n).toBe(36);
    for (const cover of [-1, 3, 1.5, Number.NaN]) {
      expect(caughtSync(() => planBundle([img("a.jpg"), img("b.jpg"), img("c.jpg")], cover)).code).toBe("INVALID_PARAM");
    }
    expect(planBundle(Array.from({ length: 35 }, (_, i) => img(`${i}.jpg`)), 34).count_label).toBe("35 photos · cover: photo 35");
  });
});

// ---------------------------------------------------------------------------
// The sips canvas script (data, never evaluated by our process)
// ---------------------------------------------------------------------------

describe("SIPS_ORIENT_JS", () => {
  test("carries the tested transform table from verification log §4.1, line for line", () => {
    const lines = [
      "const o = Number((img.properties || {}).Orientation || 1);",
      "const swap = o >= 5 && o <= 8;",
      "const ow = swap ? h : w, oh = swap ? w : h;",
      "const scale = Math.min(1, 1920 / Math.max(ow, oh), 1080 / Math.min(ow, oh));",
      "const tw = Math.round(ow * scale), th = Math.round(oh * scale);",
      'c.fillStyle = "white"; c.fillRect(0, 0, tw, th);',
      "c.save(); c.scale(scale, scale);",
      "case 2: c.translate(ow, 0); c.scale(-1, 1); break;",
      "case 3: c.translate(ow, oh); c.rotate(Math.PI); break;",
      "case 4: c.translate(0, oh); c.scale(1, -1); break;",
      "case 5: c.rotate(Math.PI / 2); c.scale(1, -1); break;",
      "case 6: c.translate(ow, 0); c.rotate(Math.PI / 2); break;",
      "case 7: c.translate(ow, oh); c.rotate(-Math.PI / 2); c.scale(1, -1); break;",
      "case 8: c.translate(0, oh); c.rotate(-Math.PI / 2); break;",
      "c.drawImage(img, 0, 0, w, h);",
      'new Output(c, img.name.replace(/\\.[^.]+$/, "") + ".oriented.jpg").addToQueue();',
    ];
    for (const line of lines) expect(SIPS_ORIENT_JS).toContain(line);
    expect(SIPS_ORIENT_JS).toContain("for (const img of sips.images)");
  });

  test("skips images sips couldn't decode (they arrive as 0×0), so their output is missing", () => {
    expect(SIPS_ORIENT_JS).toMatch(/if \(!img\.size \|\| !\(img\.size\.width > 0 && img\.size\.height > 0\)\) continue;/);
  });
});

// ---------------------------------------------------------------------------
// convertForTikTok with a fake sips
// ---------------------------------------------------------------------------

/** Output size the canvas script produces (either orientation is acceptable). */
const fit = (w: number, h: number): [number, number] => {
  const scale = Math.min(1, 1920 / Math.max(w, h), 1080 / Math.min(w, h));
  return [Math.round(w * scale), Math.round(h * scale)];
};
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0xff, 0xd9]);

interface FakeCall {
  cmd: string[];
  opts?: RunOptions;
  script?: string;
  inputs?: Array<{ name: string; symlink: boolean; content: string }>;
}
interface FakeOpts {
  skipPass1?: number[];
  skipPass2?: number[];
  notJpeg?: number[];
  huge?: number[];
  hugeAt75?: number[];
  dims?: Record<number, [number, number] | "nil">;
  /** Print -g paths under a different directory (sips prints canonical paths). */
  otherPrefix?: boolean;
  result?: Partial<RunResult>;
}

function fakeSips(images: BundleImage[], o: FakeOpts = {}) {
  const calls: FakeCall[] = [];
  const indexOf = (p: string) => Number(basename(p).split(".")[0]);
  const runner: Runner = async (cmd: string[], opts?: RunOptions): Promise<RunResult> => {
    const call: FakeCall = { cmd: [...cmd], opts };
    calls.push(call);
    if (o.result) return { code: 0, stdout: "", stderr: "", timedOut: false, ...o.result };
    let stdout = "";
    if (cmd[1] === "-j") {
      call.script = readFileSync(cmd[2], "utf8");
      const oi = cmd.indexOf("-o");
      const inputs = cmd.slice(3, oi);
      call.inputs = inputs.map((p) => ({ name: basename(p), symlink: lstatSync(p).isSymbolicLink(), content: readFileSync(p, "utf8") }));
      for (const p of inputs) {
        const stem = basename(p).replace(/\.[^.]+$/, "");
        if (o.skipPass1?.includes(Number(stem))) continue;
        writeFileSync(join(cmd[oi + 1], `${stem}.oriented.jpg`), JPEG);
      }
    } else if (cmd[1] === "--matchTo") {
      const q = Number(cmd[cmd.indexOf("formatOptions") + 1]);
      const oi = cmd.indexOf("--out");
      for (const p of cmd.slice(6, oi)) {
        const i = indexOf(p);
        if (q === 85 && o.skipPass2?.includes(i)) continue;
        const dst = join(cmd[oi + 1], basename(p));
        writeFileSync(dst, o.notJpeg?.includes(i) ? Buffer.from("\x89PNG\r\n") : JPEG);
        if ((q === 85 && o.huge?.includes(i)) || (q === 75 && o.hugeAt75?.includes(i))) truncateSync(dst, MAX_BYTES + 1);
      }
    } else if (cmd[1] === "-g") {
      stdout = cmd
        .slice(5)
        .map((p) => {
          const i = indexOf(p);
          const d = o.dims?.[i] ?? fit(images[i].width, images[i].height);
          const shown = o.otherPrefix ? `/elsewhere/${basename(dirname(p))}/${basename(p)}` : p;
          return d === "nil"
            ? `${shown}\n  pixelWidth: <nil>\n  pixelHeight: <nil>\n`
            : `${shown}\n  pixelWidth: ${d[0]}\n  pixelHeight: ${d[1]}\n`;
        })
        .join("");
    }
    return { code: 0, stdout, stderr: "", timedOut: false };
  };
  return { runner, calls };
}

/** Three real source files: two different photos with the SAME name in different folders, and a PNG. */
function sources(root: string): BundleImage[] {
  const src = join(root, "src");
  for (const d of ["a", "b", "c"]) mkdirSync(join(src, d), { recursive: true });
  writeFileSync(join(src, "a", "IMG_0001.HEIC"), "photo-from-a");
  writeFileSync(join(src, "b", "IMG_0001.HEIC"), "photo-from-b");
  writeFileSync(join(src, "c", "shot.png"), "png-shot");
  return [
    img("IMG_0001.HEIC", { path: join(src, "a", "IMG_0001.HEIC"), width: 4032, height: 3024, format: "heic" }),
    img("IMG_0001.HEIC", { path: join(src, "b", "IMG_0001.HEIC"), width: 3024, height: 4032, format: "heic" }),
    img("shot.png", { path: join(src, "c", "shot.png"), width: 1170, height: 2532, format: "png", has_alpha: true }),
  ];
}

describe("convertForTikTok (fake sips)", () => {
  test("one orient pass, one sRGB pass, one size read; inputs are copies named <index>.<ext>", async () => {
    const root = tempRoot();
    const images = sources(root);
    const { runner, calls } = fakeSips(images);
    const out = await convertForTikTok(images, runner, { tmpRoot: root });

    const dir = out.dir;
    expect(basename(dir)).toMatch(WORK_RE);
    expect(dirname(dir)).toBe(realpathSync(root));
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.cmd[0]).toBe("/usr/bin/sips");
      expect(c.opts?.timeoutMs).toBe(60_000);
    }

    const [orient, srgb, dims] = calls;
    expect(orient.cmd).toEqual([
      "/usr/bin/sips",
      "-j",
      join(dir, "sips-orient.js"),
      join(dir, "in", "0.heic"),
      join(dir, "in", "1.heic"),
      join(dir, "in", "2.png"),
      "-o",
      join(dir, "oriented"),
    ]);
    expect(orient.script).toBe(SIPS_ORIENT_JS);
    expect(orient.inputs).toEqual([
      { name: "0.heic", symlink: false, content: "photo-from-a" },
      { name: "1.heic", symlink: false, content: "photo-from-b" },
      { name: "2.png", symlink: false, content: "png-shot" },
    ]);
    expect(srgb.cmd).toEqual([
      "/usr/bin/sips",
      "--matchTo",
      SRGB,
      "-s",
      "formatOptions",
      "85",
      join(dir, "oriented", "0.oriented.jpg"),
      join(dir, "oriented", "1.oriented.jpg"),
      join(dir, "oriented", "2.oriented.jpg"),
      "--out",
      join(dir, "out"),
    ]);
    const finals = [0, 1, 2].map((i) => join(dir, "out", `${i}.oriented.jpg`));
    expect(dims.cmd).toEqual(["/usr/bin/sips", "-g", "pixelWidth", "-g", "pixelHeight", ...finals]);

    expect(out.files).toEqual([
      { path: finals[0], bytes: JPEG.length, width: 1440, height: 1080 },
      { path: finals[1], bytes: JPEG.length, width: 1080, height: 1440 },
      { path: finals[2], bytes: JPEG.length, width: 887, height: 1920 },
    ]);

    await out.cleanup();
    expect(existsSync(dir)).toBe(false);
    await out.cleanup(); // idempotent
  });

  test("the same file twice still gets two separate inputs and outputs", async () => {
    const root = tempRoot();
    const [a] = sources(root);
    const { runner, calls } = fakeSips([a, a]);
    const out = await convertForTikTok([a, a], runner, { tmpRoot: root });
    expect(calls[0].inputs!.map((x) => x.name)).toEqual(["0.heic", "1.heic"]);
    expect(out.files.map((f) => basename(f.path))).toEqual(["0.oriented.jpg", "1.oriented.jpg"]);
    await out.cleanup();
  });

  test("an image sips couldn't decode (no pass-1 output) → IMAGE_UNREADABLE {name}; nothing else runs; work dir removed", async () => {
    const root = tempRoot();
    const images = sources(root);
    const { runner, calls } = fakeSips(images, { skipPass1: [2] });
    const e = await caught(convertForTikTok(images, runner, { tmpRoot: root }));
    expect(e.code).toBe("IMAGE_UNREADABLE");
    expect(e.detail.name).toBe("shot.png");
    expect(e.detail.nothing_sent).toBe(true);
    expect(calls).toHaveLength(1);
    expect(workDirs(root)).toEqual([]);
  });

  test("a missing pass-2 output → IMAGE_UNREADABLE {name}", async () => {
    const root = tempRoot();
    const images = sources(root);
    const { runner, calls } = fakeSips(images, { skipPass2: [1] });
    const e = await caught(convertForTikTok(images, runner, { tmpRoot: root }));
    expect(e.code).toBe("IMAGE_UNREADABLE");
    expect(e.detail.name).toBe("IMG_0001.HEIC");
    expect(calls).toHaveLength(2);
    expect(workDirs(root)).toEqual([]);
  });

  test("an output that doesn't start with FF D8 FF → IMAGE_UNREADABLE", async () => {
    const root = tempRoot();
    const images = sources(root);
    const e = await caught(convertForTikTok(images, fakeSips(images, { notJpeg: [0] }).runner, { tmpRoot: root }));
    expect(e.code).toBe("IMAGE_UNREADABLE");
    expect(e.detail.name).toBe("IMG_0001.HEIC");
  });

  test("an output over 20 MB is re-encoded once at quality 75, for that photo only", async () => {
    const root = tempRoot();
    const images = sources(root);
    const { runner, calls } = fakeSips(images, { huge: [1] });
    const out = await convertForTikTok(images, runner, { tmpRoot: root });
    const dir = out.dir;
    expect(calls).toHaveLength(4);
    expect(calls[2].cmd).toEqual([
      "/usr/bin/sips",
      "--matchTo",
      SRGB,
      "-s",
      "formatOptions",
      "75",
      join(dir, "oriented", "1.oriented.jpg"),
      "--out",
      join(dir, "q75"),
    ]);
    expect(out.files[1].path).toBe(join(dir, "q75", "1.oriented.jpg"));
    expect(out.files[1].bytes).toBeLessThanOrEqual(MAX_BYTES);
    expect(calls[3].cmd.slice(5)).toEqual([join(dir, "out", "0.oriented.jpg"), join(dir, "q75", "1.oriented.jpg"), join(dir, "out", "2.oriented.jpg")]);
    await out.cleanup();
  });

  test("still over 20 MB at quality 75 → IMAGE_TOO_LARGE {name}", async () => {
    const root = tempRoot();
    const images = sources(root);
    const e = await caught(convertForTikTok(images, fakeSips(images, { huge: [2], hugeAt75: [2] }).runner, { tmpRoot: root }));
    expect(e.code).toBe("IMAGE_TOO_LARGE");
    expect(e.detail.name).toBe("shot.png");
    expect(e.detail.nothing_sent).toBe(true);
    expect(workDirs(root)).toEqual([]);
  });

  test("sizes are read from sips's canonical paths too, and rotated outputs are accepted", async () => {
    const root = tempRoot();
    const images = sources(root);
    // photo 0 is 4032×3024 but came out upright 1080×1440 (EXIF orientation 6)
    const out = await convertForTikTok(images, fakeSips(images, { otherPrefix: true, dims: { 0: [1080, 1440] } }).runner, { tmpRoot: root });
    expect(out.files.map((f) => [f.width, f.height])).toEqual([[1080, 1440], [1080, 1440], [887, 1920]]);
    await out.cleanup();
  });

  test("a size that doesn't fit the photo, exceeds 1080p, or is unreadable → IMAGE_UNREADABLE", async () => {
    for (const dims of [{ 0: [1024, 1024] }, { 1: [3024, 4032] }, { 2: "nil" }] as FakeOpts["dims"][]) {
      const root = tempRoot();
      const images = sources(root);
      const e = await caught(convertForTikTok(images, fakeSips(images, { dims }).runner, { tmpRoot: root }));
      expect(e.code).toBe("IMAGE_UNREADABLE");
      expect(e.detail.name).toBe(images[Number(Object.keys(dims!)[0])].name);
      expect(workDirs(root)).toEqual([]);
    }
  });

  test("unknown source dimensions skip the size match but not the 1080p check", async () => {
    const root = tempRoot();
    const images = sources(root).map((i) => ({ ...i, width: 0, height: 0 }));
    const ok = await convertForTikTok(images, fakeSips(images, { dims: { 0: [800, 600], 1: [600, 800], 2: [10, 10] } }).runner, { tmpRoot: root });
    expect(ok.files.map((f) => f.width)).toEqual([800, 600, 10]);
    await ok.cleanup();
  });

  test("sips missing or timing out → UNKNOWN that says nothing was sent", async () => {
    for (const result of [{ code: 127, stderr: "ENOENT" }, { code: 124, timedOut: true }]) {
      const root = tempRoot();
      const images = sources(root);
      const { runner, calls } = fakeSips(images, { result });
      const e = await caught(convertForTikTok(images, runner, { tmpRoot: root }));
      expect(e.code).toBe("UNKNOWN");
      expect(e.detail.nothing_sent).toBe(true);
      expect(String(e.detail.message)).toMatch(/nothing was sent/);
      expect(calls).toHaveLength(1);
      expect(workDirs(root)).toEqual([]);
    }
  });

  test("a photo that disappeared → FILE_NOT_FOUND {name} before sips runs", async () => {
    const root = tempRoot();
    const images = sources(root);
    rmSync(images[1].path);
    const { runner, calls } = fakeSips(images);
    const e = await caught(convertForTikTok(images, runner, { tmpRoot: root }));
    expect(e.code).toBe("FILE_NOT_FOUND");
    expect(e.detail.name).toBe("IMG_0001.HEIC");
    expect(calls).toHaveLength(0);
    expect(workDirs(root)).toEqual([]);
  });

  test("count guards refuse before any work", async () => {
    const root = tempRoot();
    const { runner, calls } = fakeSips([]);
    expect((await caught(convertForTikTok([], runner, { tmpRoot: root }))).code).toBe("NO_PHOTOS");
    const many = Array.from({ length: 36 }, (_, i) => img(`${i}.jpg`));
    expect((await caught(convertForTikTok(many, runner, { tmpRoot: root }))).code).toBe("TOO_MANY_PHOTOS");
    expect(calls).toHaveLength(0);
    expect(workDirs(root)).toEqual([]);
  });

  test("a conversion sweeps stale work dirs in the same temp root first", async () => {
    const root = tempRoot();
    const stale = join(root, "tiktok-00000000000000aa");
    mkdirSync(stale);
    const old = (Date.now() - 3 * 3600_000) / 1000;
    utimesSync(stale, old, old);
    const images = sources(root);
    const out = await convertForTikTok(images, fakeSips(images).runner, { tmpRoot: root });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(out.dir)).toBe(true);
    await out.cleanup();
  });
});

// ---------------------------------------------------------------------------
// sweepStaleWorkDirs
// ---------------------------------------------------------------------------

describe("sweepStaleWorkDirs", () => {
  test("removes only our tiktok-<hex> work dirs older than 2 h", () => {
    const root = tempRoot();
    const age = (p: string, ms: number) => {
      const t = (Date.now() - ms) / 1000;
      utimesSync(p, t, t);
    };
    const mk = (name: string, ms: number) => {
      const p = join(root, name);
      mkdirSync(p);
      writeFileSync(join(p, "x.jpg"), "x");
      age(p, ms);
      return p;
    };
    const oldWork = mk("tiktok-0123456789abcdef", 3 * 3600_000);
    const freshWork = mk("tiktok-fedcba9876543210", 10 * 60_000);
    const thumbs = mk("tiktok-thumbs", 3 * 3600_000);
    const shortName = mk("tiktok-abc123", 3 * 3600_000);
    const other = mk("something-else", 3 * 3600_000);
    const file = join(root, "tiktok-aaaaaaaaaaaaaaaa");
    writeFileSync(file, "not a dir");
    age(file, 3 * 3600_000);
    const target = mk("target", 3 * 3600_000);
    const link = join(root, "tiktok-bbbbbbbbbbbbbbbb");
    symlinkSync(target, link);

    sweepStaleWorkDirs(root);
    expect(existsSync(oldWork)).toBe(false);
    for (const kept of [freshWork, thumbs, shortName, other, file, target, join(target, "x.jpg")]) expect(existsSync(kept)).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);

    sweepStaleWorkDirs(root, 5 * 60_000);
    expect(existsSync(freshWork)).toBe(false);
  });

  test("a missing temp root is fine", () => {
    expect(() => sweepStaleWorkDirs(join(tmpdir(), "does-not-exist-tiktok-test"))).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Darwin only: the REAL pipeline on images generated with sips itself
// ---------------------------------------------------------------------------

const onMac = process.platform === "darwin";

/** A minimal big-endian EXIF APP1: IFD0 {Orientation, GPSInfo → GPS IFD (N 38°43'20.28", W 9°8'30")}. */
function exifApp1(orientation: number): Buffer {
  const t = Buffer.alloc(152);
  t.write("MM", 0, "latin1");
  t.writeUInt16BE(42, 2);
  t.writeUInt32BE(8, 4);
  let p = 8;
  const entry = (tag: number, type: number, count: number, fill: (o: number) => void) => {
    t.writeUInt16BE(tag, p);
    t.writeUInt16BE(type, p + 2);
    t.writeUInt32BE(count, p + 4);
    fill(p + 8);
    p += 12;
  };
  t.writeUInt16BE(2, p);
  p += 2;
  entry(0x0112, 3, 1, (o) => t.writeUInt16BE(orientation, o));
  entry(0x8825, 4, 1, (o) => t.writeUInt32BE(38, o));
  t.writeUInt32BE(0, p);
  p += 4;
  t.writeUInt16BE(5, p); // GPS IFD at offset 38
  p += 2;
  entry(0x0000, 1, 4, (o) => {
    t[o] = 2;
    t[o + 1] = 2;
  });
  entry(0x0001, 2, 2, (o) => t.write("N\0", o, "latin1"));
  entry(0x0002, 5, 3, (o) => t.writeUInt32BE(104, o));
  entry(0x0003, 2, 2, (o) => t.write("W\0", o, "latin1"));
  entry(0x0004, 5, 3, (o) => t.writeUInt32BE(128, o));
  t.writeUInt32BE(0, p);
  const rationals = (o: number, v: number[][]) =>
    v.forEach(([n, d], i) => {
      t.writeUInt32BE(n, o + i * 8);
      t.writeUInt32BE(d, o + i * 8 + 4);
    });
  rationals(104, [[38, 1], [43, 1], [2028, 100]]);
  rationals(128, [[9, 1], [8, 1], [30, 1]]);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), t]);
  const head = Buffer.from([0xff, 0xe1, 0, 0]);
  head.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([head, payload]);
}

/** Replace a JPEG's APP0/APP1 segments with our EXIF block. */
function withExif(jpeg: Buffer, orientation: number): Buffer {
  const parts: Buffer[] = [jpeg.subarray(0, 2), exifApp1(orientation)];
  let i = 2;
  while (jpeg[i] === 0xff && jpeg[i + 1] !== 0xda) {
    const len = jpeg.readUInt16BE(i + 2);
    if (jpeg[i + 1] !== 0xe0 && jpeg[i + 1] !== 0xe1) parts.push(jpeg.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  parts.push(jpeg.subarray(i));
  return Buffer.concat(parts);
}

/** IFD0 tag ids of every APP1 Exif segment in a JPEG. */
function exifTags(jpeg: Buffer): number[] {
  const tags: number[] = [];
  let i = 2;
  while (i + 4 <= jpeg.length && jpeg[i] === 0xff && jpeg[i + 1] !== 0xda) {
    const len = jpeg.readUInt16BE(i + 2);
    if (jpeg[i + 1] === 0xe1 && jpeg.subarray(i + 4, i + 10).toString("latin1") === "Exif\0\0") {
      const t = jpeg.subarray(i + 10, i + 2 + len);
      const le = t.toString("latin1", 0, 2) === "II";
      const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
      const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
      const ifd = u32(4);
      for (let k = 0; k < u16(ifd); k++) tags.push(u16(ifd + 2 + k * 12));
    }
    i += 2 + len;
  }
  return tags;
}

/** RGB of one pixel of a 24/32-bit uncompressed BMP (what `sips -s format bmp` writes). */
function bmpPixel(buf: Buffer, x: number, y: number): [number, number, number] {
  const off = buf.readUInt32LE(10);
  const w = buf.readInt32LE(18);
  const hRaw = buf.readInt32LE(22);
  const bpp = buf.readUInt16LE(28);
  const stride = Math.ceil((w * bpp) / 32) * 4;
  const row = hRaw > 0 ? Math.abs(hRaw) - 1 - y : y;
  const at = off + row * stride + x * (bpp / 8);
  return [buf[at + 2], buf[at + 1], buf[at]];
}

const near = (px: number[], want: number[], tol = 48) => px.every((v, i) => Math.abs(v - want[i]) <= tol);

async function sips(args: string[]): Promise<RunResult> {
  const r = await run(["/usr/bin/sips", ...args], { timeoutMs: 60_000 });
  if (r.code !== 0) throw new Error(`sips ${args[0]} failed: ${r.stderr}`);
  return r;
}

const MAKE_JS = String.raw`
const q = new Canvas(400, 300);
q.fillStyle = "red"; q.fillRect(0, 0, 200, 150);
q.fillStyle = "lime"; q.fillRect(200, 0, 200, 150);
q.fillStyle = "blue"; q.fillRect(0, 150, 200, 150);
q.fillStyle = "yellow"; q.fillRect(200, 150, 200, 150);
new Output(q, "quad.jpg").addToQueue();
const b = new Canvas(4032, 3024);
b.fillStyle = "rgb(40,120,200)"; b.fillRect(0, 0, 4032, 3024);
b.fillStyle = "rgb(250,200,40)"; b.fillRect(1000, 800, 2000, 1400);
new Output(b, "big.jpg").addToQueue();
const a = new Canvas(200, 100);
a.fillStyle = "rgb(51,102,255)"; a.fillRect(0, 0, 100, 100);
new Output(a, "alpha.png").addToQueue();
`;

let fx: Promise<Record<string, string>> | undefined;
let macRoot = "";
/** Fixtures, generated once with sips (darwin only). */
function macFixtures(): Promise<Record<string, string>> {
  fx ??= (async () => {
    macRoot = tempRoot();
    const gen = join(macRoot, "gen");
    mkdirSync(gen);
    writeFileSync(join(macRoot, "make.js"), MAKE_JS);
    await sips(["-j", join(macRoot, "make.js"), "-o", gen]);
    const o6 = join(gen, "o6.jpg");
    writeFileSync(o6, withExif(readFileSync(join(gen, "quad.jpg")), 6));
    await sips(["-s", "format", "heic", join(gen, "quad.jpg"), "--out", join(gen, "quad.heic")]);
    const garbage = join(gen, "garbage.jpg");
    writeFileSync(garbage, "this is not an image\n");
    const files = { quad: join(gen, "quad.jpg"), big: join(gen, "big.jpg"), alpha: join(gen, "alpha.png"), o6, heic: join(gen, "quad.heic"), garbage };
    for (const [k, p] of Object.entries(files)) if (!existsSync(p)) throw new Error(`fixture ${k} wasn't created`);
    return files;
  })();
  return fx;
}

const real = (path: string, o: Partial<BundleImage>): BundleImage => img(basename(path), { path, ...o });

describe("convertForTikTok on this Mac (real sips)", () => {
  beforeAll(() => {
    if (onMac) return macFixtures().then(() => undefined);
  });

  test.skipIf(!onMac)(
    "JPEG out, fits 1080p, upright, white where transparent, no Orientation or GPS left",
    async () => {
      const f = await macFixtures();
      // Sanity: the O6 fixture really carries Orientation and GPS.
      expect(exifTags(readFileSync(f.o6))).toEqual([0x0112, 0x8825]);

      const images = [
        real(f.o6, { width: 400, height: 300 }),
        real(f.big, { width: 4032, height: 3024 }),
        real(f.alpha, { width: 200, height: 100, format: "png", has_alpha: true }),
        real(f.heic, { width: 400, height: 300, format: "heic" }),
      ];
      const tmpRoot = tempRoot();
      const out = await convertForTikTok(images, run, { tmpRoot });
      expect(out.files.map((x) => [x.width, x.height])).toEqual([[300, 400], [1440, 1080], [200, 100], [400, 300]]);

      const fmt = await sips(["-g", "format", ...out.files.map((x) => x.path)]);
      expect(fmt.stdout.match(/format: \w+/g)).toEqual(["format: jpeg", "format: jpeg", "format: jpeg", "format: jpeg"]);
      for (const file of out.files) {
        const bytes = readFileSync(file.path);
        expect([...bytes.subarray(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
        expect(file.bytes).toBe(bytes.length);
        expect(file.bytes).toBeLessThanOrEqual(MAX_BYTES);
        expect(Math.min(file.width, file.height)).toBeLessThanOrEqual(1080);
        expect(Math.max(file.width, file.height)).toBeLessThanOrEqual(1920);
        const tags = exifTags(bytes);
        expect(tags).not.toContain(0x0112); // Orientation
        expect(tags).not.toContain(0x8825); // GPS IFD
      }

      // Orientation 6 applied: the stored image's bottom-left (blue) is now top-left (verification log L8: "BRYG").
      const bmp = join(tmpRoot, "o6.bmp");
      await sips(["-s", "format", "bmp", out.files[0].path, "--out", bmp]);
      const px = readFileSync(bmp);
      expect(near(bmpPixel(px, 75, 100), [0, 0, 255])).toBe(true);
      expect(near(bmpPixel(px, 225, 100), [255, 0, 0])).toBe(true);
      expect(near(bmpPixel(px, 75, 300), [255, 255, 0])).toBe(true);
      expect(near(bmpPixel(px, 225, 300), [0, 255, 0])).toBe(true);

      // Transparent pixels came out white; the opaque half didn't.
      const abmp = join(tmpRoot, "alpha.bmp");
      await sips(["-s", "format", "bmp", out.files[2].path, "--out", abmp]);
      const apx = readFileSync(abmp);
      expect(bmpPixel(apx, 150, 50).every((v) => v >= 250)).toBe(true);
      const opaque = bmpPixel(apx, 50, 50);
      expect(opaque[2]).toBeGreaterThan(200);
      expect(opaque[0]).toBeLessThan(120);

      await out.cleanup();
      expect(existsSync(out.dir)).toBe(false);
    },
    30_000,
  );

  test.skipIf(!onMac)(
    "same-named photos from different folders stay separate",
    async () => {
      const f = await macFixtures();
      const root = tempRoot();
      for (const d of ["a", "b"]) mkdirSync(join(root, d));
      writeFileSync(join(root, "a", "IMG_0001.jpg"), readFileSync(f.quad));
      writeFileSync(join(root, "b", "IMG_0001.jpg"), readFileSync(f.big));
      const images = [
        real(join(root, "a", "IMG_0001.jpg"), { width: 400, height: 300 }),
        real(join(root, "b", "IMG_0001.jpg"), { width: 4032, height: 3024 }),
      ];
      const out = await convertForTikTok(images, run, { tmpRoot: root });
      expect(out.files.map((x) => [x.width, x.height])).toEqual([[400, 300], [1440, 1080]]);
      await out.cleanup();
    },
    30_000,
  );

  test.skipIf(!onMac)(
    "a file sips can't decode → IMAGE_UNREADABLE {name}, and the work dir is gone",
    async () => {
      const f = await macFixtures();
      const root = tempRoot();
      const images = [real(f.quad, { width: 400, height: 300 }), real(f.garbage, { width: 0, height: 0 })];
      const e = await caught(convertForTikTok(images, run, { tmpRoot: root }));
      expect(e.code).toBe("IMAGE_UNREADABLE");
      expect(e.detail.name).toBe("garbage.jpg");
      expect(workDirs(root)).toEqual([]);
    },
    30_000,
  );
});
