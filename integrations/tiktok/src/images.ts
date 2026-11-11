/**
 * Photo-carousel pipeline (plan §6.10, §6.13; verification log §4.1).
 *
 * - planBundle: pure labels and warnings for prepare_photo_post and the cards.
 * - convertForTikTok: after approval only. Copies the inputs into a private
 *   work dir as <index>.<ext>, runs ONE `sips -j` canvas pass (orient, fit
 *   1080p, flatten onto white, drop EXIF/GPS) and ONE `sips --matchTo sRGB
 *   -s formatOptions 85` pass, then checks every output.
 *
 * Tested on macOS 27.2 / sips-316:
 * - `sips -j` reads through symlinks, but `img.name` reports the symlink
 *   TARGET's basename, so two same-named inputs overwrite each other's output.
 *   Inputs are therefore copied (COPYFILE_FICLONE: an APFS clone, instant and
 *   copy-on-write, so the original can't be touched; a plain copy elsewhere).
 * - An input sips can't decode reaches the script as a 0×0 image and would
 *   come out as a blank white 1024×1024 JPEG with exit code 0. The script
 *   skips it, so its output is missing → IMAGE_UNREADABLE.
 * - sips prints canonical paths (/var → /private/var), so the root is realpath'd.
 * - Exit codes are 0 even for skipped inputs: outputs are what we check.
 */
import {
  closeSync,
  constants,
  copyFileSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { TikTokError, type TikTokErrorCode } from "./errors.ts";
import { log } from "./proc.ts";
import type { BundleImage, RunResult, Runner } from "./types.ts";

/**
 * The tested canvas script (verification log §4.1), plus one guard line that
 * skips undecodable (0×0) inputs. It's data: written to the work dir and run
 * by `sips -j`; this process never evaluates it.
 */
export const SIPS_ORIENT_JS: string = String.raw`// sips-orient.js: orient, fit 1080p, flatten onto white, drop EXIF/GPS (verification log §4.1).
for (const img of sips.images) {
  if (!img.size || !(img.size.width > 0 && img.size.height > 0)) continue;   // undecodable input: no output
  const o = Number((img.properties || {}).Orientation || 1);
  const w = img.size.width, h = img.size.height;
  const swap = o >= 5 && o <= 8;
  const ow = swap ? h : w, oh = swap ? w : h;
  const scale = Math.min(1, 1920 / Math.max(ow, oh), 1080 / Math.min(ow, oh));
  const tw = Math.round(ow * scale), th = Math.round(oh * scale);
  const c = new Canvas(tw, th);
  c.fillStyle = "white"; c.fillRect(0, 0, tw, th);
  c.save(); c.scale(scale, scale);
  switch (o) {
    case 2: c.translate(ow, 0); c.scale(-1, 1); break;
    case 3: c.translate(ow, oh); c.rotate(Math.PI); break;
    case 4: c.translate(0, oh); c.scale(1, -1); break;
    case 5: c.rotate(Math.PI / 2); c.scale(1, -1); break;
    case 6: c.translate(ow, 0); c.rotate(Math.PI / 2); break;
    case 7: c.translate(ow, oh); c.rotate(-Math.PI / 2); c.scale(1, -1); break;
    case 8: c.translate(0, oh); c.rotate(-Math.PI / 2); break;
  }
  c.drawImage(img, 0, 0, w, h);
  c.restore();
  new Output(c, img.name.replace(/\.[^.]+$/, "") + ".oriented.jpg").addToQueue();
}
`;

export const SIPS = "/usr/bin/sips";
export const SRGB_PROFILE = "/System/Library/ColorSync/Profiles/sRGB Profile.icc";
/** TikTok's (and the relay's) per-photo limit. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const MAX_PHOTOS = 35;
const SIPS_TIMEOUT_MS = 60_000;
const STALE_MS = 2 * 60 * 60 * 1000;
/** Our work dirs only (never e.g. `tiktok-thumbs` or another app's folder). */
const WORK_DIR = /^tiktok-[0-9a-f]{16}$/;
const ORDER_MAX = 120;
const IMAGE_EXT = /\.(jpe?g|png|heic|heif|webp|gif|tiff?|bmp|avif)$/i;

// ---------------------------------------------------------------------------
// planBundle (pure)
// ---------------------------------------------------------------------------

export interface PlannedBundle {
  count_label: string;
  order_label: string;
  warnings: string[];
  /** The ONE card line: warnings[0], or "". */
  warning: string;
  /** present = photos carrying any Content Credentials (AI ones included); ai = zero-based indexes whose credentials say AI. */
  credentials: { present: number; ai: number[] };
}

/** Display-safe name: no control or bidi-override characters, plain single spaces (macOS puts U+202F before AM/PM). */
function displayName(name: unknown): string {
  return String(name ?? "")
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, "")
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const stem = (name: unknown) => {
  const d = displayName(name);
  return d.replace(IMAGE_EXT, "") || d;
};

/** Cut to at most `max` UTF-16 units without splitting a surrogate pair. */
function cutChars(s: string, max: number): string {
  let out = "";
  for (const ch of s) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out.trimEnd();
}

/** "1 beach · 2 sunset · 3 dinner", ≤ 120 chars, cut at a whole name with " …" (or inside a too-long first name). */
function orderLabel(images: BundleImage[]): string {
  const parts = images.map((im, i) => `${i + 1} ${stem(im.name)}`);
  const whole = parts.join(" · ");
  if (whole.length <= ORDER_MAX) return whole;
  let kept = "";
  for (const part of parts) {
    const next = kept ? `${kept} · ${part}` : part;
    if (next.length + 2 > ORDER_MAX) break; // room for " …"
    kept = next;
  }
  return kept ? `${kept} …` : `${cutChars(parts[0], ORDER_MAX - 1)}…`;
}

const AI_TAIL = "TikTok can't label photos sent from here, so drafts are safer.";

/** Only what the credentials say, never "this is AI". Photo numbers are 1-based. */
function aiLine(ai: number[]): string {
  const ns = ai.map((i) => i + 1);
  if (ns.length === 1) return `Photo ${ns[0]}'s Content Credentials say it was made with AI. ${AI_TAIL}`;
  if (ns.length <= 4) {
    const list = `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`;
    return `Photos ${list}'s Content Credentials say they were made with AI. ${AI_TAIL}`;
  }
  return `${ns.length} photos' Content Credentials say they were made with AI. ${AI_TAIL}`;
}

const presentLine = (n: number) =>
  n === 1
    ? "1 photo carries Content Credentials, which are removed when it's converted."
    : `${n} photos carry Content Credentials, which are removed when they're converted.`;

const isScreenshot = (name: unknown) => /^(screenshot|screen shot)/i.test(displayName(name));
const isHeic = (im: BundleImage) => /^hei[cf]$/i.test(String(im.format ?? "").trim()) || /\.hei[cf]$/i.test(String(im.name ?? ""));
/** The 1080p rule (plan §6.13, S9): short side ≤ 1080 and long side ≤ 1920. Unknown sizes aren't flagged. */
const needsResize = (w: number, h: number) => w > 0 && h > 0 && (Math.min(w, h) > 1080 || Math.max(w, h) > 1920);

/**
 * Labels and warnings for a carousel in order. Warnings, most important first:
 * AI credentials, credentials removed, transparency, resizing, HEIC.
 */
export function planBundle(images: BundleImage[], cover_index: number): PlannedBundle {
  const n = Array.isArray(images) ? images.length : 0;
  if (n === 0) throw new TikTokError("NO_PHOTOS");
  if (n > MAX_PHOTOS) throw new TikTokError("TOO_MANY_PHOTOS", { n });
  if (!Number.isInteger(cover_index) || cover_index < 0 || cover_index >= n) {
    throw new TikTokError("INVALID_PARAM", { message: n === 1 ? "The cover has to be photo 1." : `Pick a cover from photo 1 to photo ${n}.` });
  }

  const ai = images.flatMap((im, i) => (im.credentials === "ai" ? [i] : []));
  const present = images.filter((im) => im.credentials === "ai" || im.credentials === "present").length;
  const warnings: string[] = [];
  if (ai.length) warnings.push(aiLine(ai));
  if (present) warnings.push(presentLine(present));

  const alpha = images.filter((im) => im.has_alpha);
  if (alpha.length) {
    const noun = alpha.every((im) => isScreenshot(im.name)) ? "screenshot" : "photo";
    warnings.push(
      alpha.length === 1
        ? `1 ${noun} has transparency; it will become white.`
        : `${alpha.length} ${noun}s have transparency; it will become white.`,
    );
  }

  const big = images.filter((im) => needsResize(im.width, im.height));
  if (big.length) {
    const sizes = [...new Set(big.map((im) => `${im.width}×${im.height}`))];
    warnings.push(
      big.length === 1
        ? `1 photo is ${sizes[0]} and will be resized.`
        : sizes.length === 1
          ? `${big.length} photos are ${sizes[0]} and will be resized.`
          : `${big.length} photos are larger than 1080p and will be resized.`,
    );
  }

  const heic = images.filter(isHeic).length;
  if (heic) warnings.push(heic === 1 ? "1 photo is HEIC and will be converted to JPEG." : `${heic} photos are HEIC and will be converted to JPEG.`);

  return {
    count_label: n === 1 ? "1 photo" : `${n} photos · cover: photo ${cover_index + 1}`,
    order_label: orderLabel(images),
    warnings,
    warning: warnings[0] ?? "",
    credentials: { present, ai },
  };
}

// ---------------------------------------------------------------------------
// convertForTikTok (after approval only)
// ---------------------------------------------------------------------------

export interface ConvertedImage {
  /** Inside the work dir; server-side only (never shown or logged). */
  path: string;
  bytes: number;
  width: number;
  height: number;
}

/** Every conversion failure happens before anything reaches the relay or TikTok. */
const fail = (code: TikTokErrorCode, name?: string, extra: Record<string, unknown> = {}) =>
  new TikTokError(code, { ...(name ? { name } : {}), ...extra, nothing_sent: true });

/** Output size of the canvas script for a stored w×h (orientation may swap the sides). */
function fitted(w: number, h: number): [number, number] {
  const scale = Math.min(1, 1920 / Math.max(w, h), 1080 / Math.min(w, h));
  return [Math.round(w * scale), Math.round(h * scale)];
}

function isJpegFile(path: string): boolean {
  let fd: number | undefined;
  try {
    if (!statSync(path).isFile()) return false;
    fd = openSync(path, "r");
    const head = Buffer.alloc(3);
    return readSync(fd, head, 0, 3, 0) === 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Delete stale outputs before every pass (sips can fail silently and leave an old file behind). */
function freshDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function makeWorkDir(root: string): string {
  for (let attempt = 0; attempt < 5; attempt++) {
    const dir = join(root, `tiktok-${randomBytes(8).toString("hex")}`);
    try {
      mkdirSync(dir, { mode: 0o700 });
      return dir;
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") break;
    }
  }
  throw fail("UNKNOWN", undefined, { message: "Couldn't make a temporary folder for the photos, so nothing was sent." });
}

/** A sips call that couldn't run (missing tool, kill timer) → UNKNOWN; other exit codes are judged by their outputs. */
function checkRun(r: RunResult, stage: string): void {
  if (r.timedOut) {
    log(`photos: sips ${stage} pass timed out`);
    throw fail("UNKNOWN", undefined, { message: "Converting the photos took more than a minute, so nothing was sent." });
  }
  if (r.code === 127) {
    log(`photos: sips ${stage} pass couldn't start`);
    throw fail("UNKNOWN", undefined, { message: "Couldn't start the image converter, so nothing was sent." });
  }
  if (r.code !== 0) log(`photos: sips ${stage} pass exited ${r.code}; checking its outputs`);
}

/** `sips -g pixelWidth -g pixelHeight` blocks → sizes keyed by the printed path and by basename (ours are unique). */
function parseDims(stdout: string): Map<string, { width: number; height: number }> {
  const map = new Map<string, { width: number; height: number }>();
  let path: string | undefined;
  let width = Number.NaN;
  let height = Number.NaN;
  const flush = () => {
    if (path !== undefined && width > 0 && height > 0) {
      map.set(path, { width, height });
      map.set(basename(path), { width, height });
    }
  };
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (!/^\s/.test(line)) {
      flush();
      path = line.trim();
      width = height = Number.NaN;
      continue;
    }
    const m = /^\s+(pixelWidth|pixelHeight):\s*(\d+)\s*$/.exec(line);
    if (m) {
      if (m[1] === "pixelWidth") width = Number(m[2]);
      else height = Number(m[2]);
    }
  }
  flush();
  return map;
}

/** Fits 1080p and, when the source size is known, is that photo scaled (either orientation, ±2 px). */
function plausible(d: { width: number; height: number }, im: BundleImage): boolean {
  if (Math.min(d.width, d.height) > 1080 || Math.max(d.width, d.height) > 1920) return false;
  if (!(im.width > 0 && im.height > 0)) return true;
  const [ew, eh] = fitted(im.width, im.height);
  const close = (a: number, b: number) => Math.abs(a - b) <= 2;
  return (close(d.width, ew) && close(d.height, eh)) || (close(d.width, eh) && close(d.height, ew));
}

/**
 * Convert the approved carousel for TikTok: upright, ≤ 1080p, white instead of
 * transparency, no EXIF/GPS/Content Credentials, sRGB JPEG ≤ 20 MB. Files come
 * back in carousel order. The work dir is removed on failure; on success the
 * caller calls cleanup() once the files are uploaded (or the 2-hour sweep does).
 */
export async function convertForTikTok(
  images: BundleImage[],
  runner: Runner,
  opts: { tmpRoot?: string } = {},
): Promise<{ files: ConvertedImage[]; dir: string; cleanup(): Promise<void> }> {
  const n = Array.isArray(images) ? images.length : 0;
  if (n === 0) throw fail("NO_PHOTOS");
  if (n > MAX_PHOTOS) throw fail("TOO_MANY_PHOTOS", undefined, { n });
  let root: string;
  try {
    root = realpathSync(opts.tmpRoot ?? tmpdir());
  } catch {
    throw fail("UNKNOWN", undefined, { message: "Couldn't find a temporary folder for the photos, so nothing was sent." });
  }
  sweepStaleWorkDirs(root);
  const dir = makeWorkDir(root);
  let removed = false;
  const cleanup = async () => {
    if (removed) return;
    removed = true;
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };
  const started = Date.now();
  try {
    const files = await convertIn(dir, images, runner);
    log(`photos: converted ${n} in ${Date.now() - started} ms`);
    return { files, dir, cleanup };
  } catch (e) {
    await cleanup();
    throw e;
  }
}

async function convertIn(dir: string, images: BundleImage[], runner: Runner): Promise<ConvertedImage[]> {
  const timeoutMs = SIPS_TIMEOUT_MS;
  const inDir = join(dir, "in");
  const orientedDir = join(dir, "oriented");
  const outDir = join(dir, "out");
  mkdirSync(inDir, { mode: 0o700 });

  // 1. Private copies named <index>.<ext>: same-named (or repeated) inputs can't collide.
  const inputs = images.map((im, i) => {
    const ext = extname(String(im.path ?? "")).slice(1).toLowerCase().replace(/[^a-z0-9]/g, "") || "img";
    const copy = join(inDir, `${i}.${ext}`);
    try {
      copyFileSync(im.path, copy, constants.COPYFILE_FICLONE);
    } catch (e) {
      throw fail((e as { code?: string }).code === "ENOENT" ? "FILE_NOT_FOUND" : "IMAGE_UNREADABLE", im.name);
    }
    return copy;
  });
  const script = join(dir, "sips-orient.js");
  writeFileSync(script, SIPS_ORIENT_JS, { mode: 0o600 });

  // 2. ONE canvas pass: orient, fit, flatten, strip.
  freshDir(orientedDir);
  checkRun(await runner([SIPS, "-j", script, ...inputs, "-o", orientedDir], { timeoutMs }), "orient");
  const oriented = images.map((im, i) => {
    const p = join(orientedDir, `${i}.oriented.jpg`);
    if (!isJpegFile(p)) throw fail("IMAGE_UNREADABLE", im.name);
    return p;
  });

  // 3. ONE sRGB + quality-85 pass (formatOptions has no effect on canvas output).
  freshDir(outDir);
  checkRun(await runner([SIPS, "--matchTo", SRGB_PROFILE, "-s", "formatOptions", "85", ...oriented, "--out", outDir], { timeoutMs }), "srgb");
  const finals = images.map((im, i) => {
    const p = join(outDir, `${i}.oriented.jpg`);
    if (!isJpegFile(p)) throw fail("IMAGE_UNREADABLE", im.name);
    return p;
  });

  // 4. Anything over 20 MB: once more at quality 75, then give up.
  const big = finals.flatMap((p, i) => (statSync(p).size > MAX_IMAGE_BYTES ? [i] : []));
  if (big.length) {
    const q75 = join(dir, "q75");
    freshDir(q75);
    log(`photos: re-encoding ${big.length} at quality 75`);
    checkRun(await runner([SIPS, "--matchTo", SRGB_PROFILE, "-s", "formatOptions", "75", ...big.map((i) => oriented[i]), "--out", q75], { timeoutMs }), "q75");
    for (const i of big) {
      const p = join(q75, `${i}.oriented.jpg`);
      if (!isJpegFile(p)) throw fail("IMAGE_UNREADABLE", images[i].name);
      if (statSync(p).size > MAX_IMAGE_BYTES) throw fail("IMAGE_TOO_LARGE", images[i].name);
      finals[i] = p;
    }
  }

  // 5. Final sizes in one call.
  const r = await runner([SIPS, "-g", "pixelWidth", "-g", "pixelHeight", ...finals], { timeoutMs });
  checkRun(r, "size");
  const dims = parseDims(r.stdout);
  return finals.map((p, i) => {
    const im = images[i];
    const d = dims.get(p) ?? dims.get(basename(p));
    if (!d || !plausible(d, im)) throw fail("IMAGE_UNREADABLE", im.name);
    return { path: p, bytes: statSync(p).size, width: d.width, height: d.height };
  });
}

/** Delete our tiktok-<hex> work dirs older than 2 h (best-effort; never follows symlinks). */
export function sweepStaleWorkDirs(tmpRoot: string = tmpdir(), maxAgeMs: number = STALE_MS): void {
  let names: string[];
  try {
    names = readdirSync(tmpRoot);
  } catch {
    return;
  }
  const now = Date.now();
  let removed = 0;
  for (const name of names) {
    if (!WORK_DIR.test(name)) continue;
    const p = join(tmpRoot, name);
    try {
      const st = lstatSync(p);
      if (!st.isDirectory() || now - st.mtimeMs < maxAgeMs) continue;
      rmSync(p, { recursive: true, force: true });
      removed++;
    } catch {
      /* best-effort */
    }
  }
  if (removed) log(`photos: removed ${removed} stale work folder(s)`);
}
