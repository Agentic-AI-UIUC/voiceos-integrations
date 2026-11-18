/**
 * Result cards for the notch, built on the Widget Kit (renderCustom).
 *
 * "Media first, notch-native": any card about a video leads with that video's
 * frame (a rounded 9:16 tile, or 16:9 for landscape sources, with a bottom
 * scrim, a 1px inner highlight and a duration pill), numbers are the heroes
 * (tabular, tight tracking) and labels whisper. With no frame the tile is a
 * dark gradient with a play glyph, never a broken image.
 *
 * The header row is the integration mark, a small "TIKTOK" label and
 * right-aligned context; then the focal content; then facts; then at most one
 * quiet footnote, with the single link a card may carry on its right.
 *
 * Colour carries state only: good = posted / in the inbox, bad = failed, and
 * TikTok red (the kit's accent) marks progress and the top item. Motion is
 * light (a slow drift on hero frames, a check that draws in, a shimmer while
 * TikTok processes) and opt-in under `prefers-reduced-motion: no-preference`,
 * so a renderer that never runs animations still paints the finished card.
 *
 * Every string is cleaned, clipped before rendering and escaped; links are
 * https on tiktok.com only; images are `data:` URIs that pass CARD_IMAGE_RE
 * and a per-card budget, or they're left out (the sandbox has no network).
 * Declared heights come from a small layout model of the CSS below, so a card
 * arrives at its final size (tests/cards.test.ts keeps every card within 60–420 px).
 */
import { esc, markHtml, renderCustom, textEms } from "../widgetKit.ts";
import { cleanText, clipText, firstLine, hashtags } from "./captions.ts";
import { ACCENT } from "./config.ts";
import { TikTokError, privacyLabel } from "./errors.ts";
import { ago, agoShort, aspect as aspectOf, compact, duration, exact, percent, plural, postedLabel, times } from "./format.ts";
import type { MediaKind, VideoDetails, VideoSummary, Widget, WriteMode } from "./types.ts";

// ---------------------------------------------------------------------------
// Images: data URIs only, validated, and budgeted per card
// ---------------------------------------------------------------------------

/**
 * The only images a card draws: base64 JPEG, PNG, WebP or AVIF data URIs (animated WebP and AVIF: the moving loops;
 * WebP stills: covers on Windows). Anything else is ignored.
 */
export const CARD_IMAGE_RE = /^data:image\/(jpeg|png|webp|avif);base64,[A-Za-z0-9+/=]+$/;
/** A moving loop: one animated AVIF or WebP, or a JPEG filmstrip. */
const MOTION_RE = /^data:image\/(jpeg|webp|avif);base64,[A-Za-z0-9+/=]+$/;
/** A loop as data-URI characters (src/preview.ts makes them this size at most: ~94 KB of AVIF). */
export const MAX_MOTION_CHARS = 125_000;

/**
 * A video's moving loop (src/preview.ts VideoMotion), validated: an animated AVIF or WebP, or a JPEG filmstrip of
 * 2-30 frames. A filmstrip's `edge` is the smeared border each frame carries on both sides, as a fraction of the
 * frame's width: the card shows only the frame inside it, so a step never shows a sliver of the next frame.
 */
export interface CardMotion {
  src: string;
  frames?: number;
  fps?: number;
  edge?: number;
}
export function cardMotion(m: unknown): CardMotion | undefined {
  if (!m || typeof m !== "object") return undefined;
  const { src, frames, fps, edge } = m as { src?: unknown; frames?: unknown; fps?: unknown; edge?: unknown };
  if (typeof src !== "string" || src.length > MAX_MOTION_CHARS || !MOTION_RE.test(src)) return undefined;
  if (frames === undefined) return src.startsWith("data:image/webp") || src.startsWith("data:image/avif") ? { src } : undefined;
  if (!src.startsWith("data:image/jpeg")) return undefined;
  if (typeof frames !== "number" || !Number.isInteger(frames) || frames < 2 || frames > 30) return undefined;
  const rate = typeof fps === "number" && Number.isFinite(fps) && fps >= 1 && fps <= 30 ? fps : 8;
  const bleed = typeof edge === "number" && Number.isFinite(edge) && edge > 0 && edge <= 0.1 ? edge : 0;
  return { src, frames, fps: rate, ...(bleed ? { edge: bleed } : {}) };
}
/** One still, as data-URI characters (src/preview.ts keeps posters ≤ 58,000). */
const MAX_IMAGE_CHARS = 64_000;
/** All the images on one card, so a card stays near 200 KB and far under the kit's 300,000-character cap. Earlier (higher) images win. */
const CARD_IMAGE_BUDGET = 200_000;

/** The image if it's a data URI a card may draw (at most `max` characters), else undefined. */
export function cardImage(src: unknown, max = MAX_IMAGE_CHARS): string | undefined {
  if (typeof src !== "string" || src.length > Math.min(max, MAX_MOTION_CHARS)) return undefined;
  return CARD_IMAGE_RE.test(src) ? src : undefined;
}

type Images = ((src: unknown, max?: number) => string | undefined) & {
  /** Characters still free. */
  left?: () => number;
  /** Give back what an image no longer needs (a poster a loop replaced). */
  refund?: (chars: number) => void;
};

function imageBudget(total = CARD_IMAGE_BUDGET): Images {
  let left = total;
  const take = ((src: unknown, max?: number) => {
    const ok = cardImage(src, max);
    if (!ok || ok.length > left) return undefined;
    left -= ok.length;
    return ok;
  }) as Images;
  take.left = () => left;
  take.refund = (chars) => void (left += Math.max(0, chars));
  return take;
}

/**
 * Pixel size from a PNG's IHDR, a JPEG's SOF marker, a WebP's VP8/VP8L/VP8X header or an AVIF's `ispe` property
 * (the first ~18 KB is enough), so a tile can take the frame's own shape.
 */
export function imageSize(uri: string | undefined): { w: number; h: number } | undefined {
  if (!uri) return undefined;
  const comma = uri.indexOf(",");
  if (comma < 0) return undefined;
  let b64 = uri.slice(comma + 1, comma + 1 + 24_000);
  b64 = b64.slice(0, b64.length - (b64.length % 4));
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  } catch {
    return undefined;
  }
  const u16 = (i: number) => (bytes[i] << 8) | bytes[i + 1];
  const u32 = (i: number) => ((bytes[i] << 24) | (bytes[i + 1] << 16) | (bytes[i + 2] << 8) | bytes[i + 3]) >>> 0;
  const tag = (i: number) => String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
  const sized = (w: number, h: number) => (w > 0 && h > 0 ? { w, h } : undefined);
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes.length >= 24) {
    const w = (bytes[16] << 24) | (bytes[17] << 16) | u16(18);
    const h = (bytes[20] << 24) | (bytes[21] << 16) | u16(22);
    return w > 0 && h > 0 ? { w, h } : undefined;
  }
  if (bytes.length >= 30 && tag(0) === "RIFF" && tag(8) === "WEBP") {
    const le24 = (i: number) => bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16);
    const chunk = tag(12);
    if (chunk === "VP8X") return sized(le24(24) + 1, le24(27) + 1);
    if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return sized((bytes[26] | (bytes[27] << 8)) & 0x3fff, (bytes[28] | (bytes[29] << 8)) & 0x3fff);
    }
    if (chunk === "VP8L" && bytes[20] === 0x2f) {
      const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0;
      return sized((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    }
    return undefined;
  }
  if (bytes.length >= 16 && tag(4) === "ftyp" && /^avi[fs]$/.test(tag(8))) {
    // The image spatial extents property (ispe): 4 bytes of version and flags, then width and height.
    for (let i = 8; i + 16 <= bytes.length; i++) {
      if (bytes[i] === 0x69 && tag(i) === "ispe") return sized(u32(i + 8), u32(i + 12));
    }
    return undefined;
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return undefined;
    const marker = bytes[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const h = u16(i + 5);
      const w = u16(i + 7);
      return w > 0 && h > 0 ? { w, h } : undefined;
    }
    i += 2 + u16(i + 2);
  }
  return undefined;
}

/** Landscape when the frame (or, failing that, the reported size) is wider than tall. */
function isWide(src: string | undefined, w?: number, h?: number): boolean {
  const size = imageSize(src);
  if (size) return size.w > size.h * 1.08;
  return isNum(w) && isNum(h) && w > h * 1.08;
}

// ---------------------------------------------------------------------------
// Styles (on top of the kit's variables: --ink-1..4, --line, --fill-1/2, --track, --good, --bad, --accent)
// ---------------------------------------------------------------------------

type TileSize = "xs" | "s" | "m" | "l" | "xl" | "h" | "f";
/** Portrait sizes (9:16); `.is-w` swaps them for a 16:9 source. */
const TILE: Record<TileSize, { w: number; h: number; r: number }> = {
  xs: { w: 27, h: 48, r: 7 },
  s: { w: 34, h: 60, r: 8 },
  m: { w: 60, h: 106, r: 10 },
  l: { w: 72, h: 128, r: 12 },
  xl: { w: 88, h: 156, r: 12 },
  /** The hero: a video playing on the find, posting-as and completion cards. */
  h: { w: 108, h: 192, r: 14 },
  /** A landscape video across the posting-as card (used lying down only: 358 × 201). */
  f: { w: 201, h: 358, r: 16 },
};
/**
 * The biggest tiles a loop plays in, in CSS px (src/preview.ts makes loops and posters twice this size: the notch is
 * a 2× display): the hero (find, posting-as and completion cards) for a portrait video, and the posting-as card's
 * across-the-card tile for a landscape one. Smaller tiles (the status card's) show the same loop scaled down.
 */
export const LOOP_TILES = {
  hero: { w: TILE.h.w, h: TILE.h.h },
  across: { w: TILE.f.h, h: TILE.f.w },
} as const;
const TILE_CSS = (Object.entries(TILE) as Array<[TileSize, { w: number; h: number; r: number }]>)
  .map(([k, t]) => `.tt-m.z-${k}{width:${t.w}px;height:${t.h}px;border-radius:${t.r}px}.tt-m.z-${k}.is-w{width:${t.h}px;height:${t.w}px}`)
  .join("");

const CSS = `
html[data-k-theme=light]{--good:#248a3d;--bad:#d70015}
.tt{padding:13px 15px 14px;display:flex;flex-direction:column;gap:10px;min-width:0}
.tt .k-hd-l{flex:none}
.tt .k-hd-tr{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.tt-n{font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
.tt-1{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tt-c2,.tt-c3,.tt-c4,.tt-c5,.tt-c6{display:-webkit-box;-webkit-box-orient:vertical;overflow:hidden}
.tt-c2{-webkit-line-clamp:2}.tt-c3{-webkit-line-clamp:3}.tt-c4{-webkit-line-clamp:4}.tt-c5{-webkit-line-clamp:5}.tt-c6{-webkit-line-clamp:6}
.tt-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}
.tt-h{font-size:14.5px;font-weight:620;letter-spacing:-.012em;line-height:1.3;color:var(--ink-1);overflow-wrap:anywhere;min-width:0}
.tt-h.tt-sm{font-size:14px;line-height:1.32}
.tt-dim{color:var(--ink-3);font-weight:500}
.tt-pre{white-space:pre-line}
.tt-p{font-size:12.5px;line-height:1.45;color:var(--ink-2);overflow-wrap:anywhere;min-width:0}
.tt-meta{display:flex;font-size:12px;line-height:16px;color:var(--ink-3);min-width:0;overflow:hidden;white-space:nowrap;font-variant-numeric:tabular-nums}
.tt-meta>span{min-width:0;overflow:hidden;text-overflow:ellipsis;flex:0 1000 auto}
.tt-meta>span+span{flex:none;white-space:pre}
.tt-eb{font-size:10.5px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;line-height:1.3;color:var(--ink-3)}
.tt-eb.q{color:var(--ink-3)}
.tt-g{width:12px;height:12px;flex:none;display:block;fill:currentColor}
/* media tiles */
.tt-m{position:relative;display:block;flex:none;overflow:hidden;isolation:isolate;background:linear-gradient(158deg,#3b3b45 0%,#202027 52%,#121215 100%)}
html[data-k-theme=light] .tt-m{background:linear-gradient(158deg,#dedee4 0%,#c9c9d1 100%)}
${TILE_CSS}
.tt-m-g{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,.6)}
html[data-k-theme=light] .tt-m-g{color:rgba(0,0,0,.42)}
.tt-m-g svg{width:42%;max-width:26px;min-width:12px;height:auto;display:block}
.tt-m-i{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.tt-m.has-i::before{content:"";position:absolute;left:0;right:0;bottom:0;height:46%;z-index:1;pointer-events:none;background:linear-gradient(to top,rgba(0,0,0,.52),rgba(0,0,0,0))}
.tt-m::after{content:"";position:absolute;inset:0;z-index:4;border-radius:inherit;pointer-events:none;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
html[data-k-theme=light] .tt-m::after{box-shadow:inset 0 0 0 1px rgba(0,0,0,.08)}
.tt-m.is-dim .tt-m-i{filter:grayscale(.85) brightness(.55)}
.tt-m-d{position:absolute;left:5px;bottom:5px;z-index:2;height:16px;padding:0 5px;border-radius:5px;display:flex;align-items:center;font-size:10px;font-weight:650;letter-spacing:.01em;color:#fff;background:rgba(0,0,0,.42);font-variant-numeric:tabular-nums;white-space:nowrap}
.tt-m.z-s .tt-m-d{left:3px;bottom:3px;height:13px;padding:0 3px;border-radius:4px;font-size:8.5px}
.tt-m.is-top{outline:1.5px solid var(--accent);outline-offset:2px}
.tt-m-b{position:absolute;right:6px;bottom:6px;z-index:3;width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;background:#56565e;box-shadow:0 2px 8px rgba(0,0,0,.35)}
.tt-m-b svg{width:13px;height:13px}
.tt-m-b.is-good{background:var(--good)}
.tt-m-b.is-bad{background:var(--bad)}
.tt-m-b.is-live{background:var(--accent)}
.tt-m.z-h{box-shadow:0 10px 26px rgba(0,0,0,.4),0 1px 3px rgba(0,0,0,.35)}
html[data-k-theme=light] .tt-m.z-h{box-shadow:0 8px 20px rgba(0,0,0,.14),0 1px 2px rgba(0,0,0,.12)}
.tt-m-fs{position:absolute;inset:0;overflow:hidden;border-radius:inherit}
.tt-m-fsi{position:absolute;top:0;left:0;height:100%;max-width:none;display:block}
@media(prefers-reduced-motion:no-preference){.tt-m-fsi{animation-name:tt-fs;animation-iteration-count:infinite}}
@keyframes tt-fs{to{transform:translateX(-100%)}}
@media(prefers-reduced-motion:reduce){.tt-m.is-mo:has(>.tt-m-i:not(.tt-m-mo)) .tt-m-mo{display:none}}
.tt-m.is-named .tt-m-g{flex-direction:column;gap:9px;padding:0 9px}
.tt-m-n{max-width:100%;font-size:11px;font-weight:600;line-height:14px;letter-spacing:-.005em;text-align:center;color:rgba(255,255,255,.7);overflow:hidden;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow-wrap:anywhere}
html[data-k-theme=light] .tt-m-n{color:rgba(0,0,0,.55)}
.tt-m-sh{position:absolute;inset:0;z-index:2;pointer-events:none;background:linear-gradient(100deg,rgba(255,255,255,0) 35%,rgba(255,255,255,.2) 50%,rgba(255,255,255,0) 65%);background-size:260% 100%;background-position:50% 0}
/* text beside a tile */
.tt-mb{display:flex;gap:14px;min-width:0}
.tt-mb-c{flex:1;min-width:0;display:flex;flex-direction:column}
.tt-mb-c.is-mid{justify-content:center}
.tt-mb-c.is-split{justify-content:space-between}
/* identity */
.tt-who{display:flex;align-items:center;gap:13px;min-width:0}
.tt-av{position:relative;width:56px;height:56px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;overflow:hidden;font-size:19px;font-weight:660;letter-spacing:.02em;color:var(--ink-1);background:linear-gradient(150deg,rgba(255,255,255,.17),rgba(255,255,255,.05))}
html[data-k-theme=light] .tt-av{background:linear-gradient(150deg,rgba(0,0,0,.1),rgba(0,0,0,.03))}
.tt-av::after{content:"";position:absolute;inset:0;border-radius:50%;box-shadow:inset 0 0 0 1px rgba(255,255,255,.1);pointer-events:none}
html[data-k-theme=light] .tt-av::after{box-shadow:inset 0 0 0 1px rgba(0,0,0,.08)}
.tt-av.z-sm{width:40px;height:40px;font-size:14.5px}
.tt-av svg{width:42%;height:42%;color:var(--ink-2)}
.tt-av-i{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block}
.tt-who-m{flex:1;min-width:0}
.tt-name{display:flex;align-items:center;gap:6px;min-width:0}
.tt-who-n{font-size:17px;font-weight:660;letter-spacing:-.018em;line-height:1.25}
.tt-av.z-sm+.tt-who-m .tt-who-n{font-size:15px}
.tt-who-s{font-size:12.5px;line-height:1.35;color:var(--ink-3);margin-top:1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tt-vf{width:15px;height:15px;flex:none;display:block}
/* hero numbers */
.tt-sts{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));column-gap:14px}
.tt-st{min-width:0}
.tt-st-v{font-size:28px;font-weight:700;letter-spacing:-.025em;line-height:1.1;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tt-st-l{font-size:11.5px;line-height:1.4;color:var(--ink-3);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tt-big{display:flex;align-items:baseline;gap:6px;min-width:0;white-space:nowrap}
.tt-big-v{font-size:30px;font-weight:720;letter-spacing:-.03em;line-height:1;font-variant-numeric:tabular-nums}
.tt-big-l{font-size:12px;color:var(--ink-3)}
.tt-vs{display:flex;align-items:center;gap:4px;font-size:12px;font-weight:600;line-height:16px;margin-top:4px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.tt-vs.is-up{color:var(--good)}
.tt-vs svg{width:10px;height:10px;flex:none}
.tt-ms{display:flex;justify-content:space-between;gap:8px;min-width:0}
.tt-ms.is-few{justify-content:flex-start;gap:28px}
.tt-ms.is-row{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}
.tt-ms-c{min-width:0;flex:0 1 auto}
.tt-ms-v{display:flex;align-items:center;gap:4px;font-size:15px;font-weight:680;letter-spacing:-.015em;line-height:19px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden}
.tt-ms-v .tt-g{width:11px;height:11px;color:var(--ink-3)}
.tt-ms-l{font-size:10.5px;line-height:14px;color:var(--ink-3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* totals strip */
.tt-tot{display:flex;align-items:baseline;gap:14px;min-width:0;white-space:nowrap;overflow:hidden;line-height:22px}
.tt-tot span{font-size:11.5px;color:var(--ink-3);min-width:0}
.tt-tot b{font-size:17px;font-weight:700;letter-spacing:-.02em;color:var(--ink-1);margin-right:4px;font-variant-numeric:tabular-nums}
/* facts */
.tt-kvs{display:flex;flex-direction:column;min-width:0}
.tt-kvs.tt-rule{border-top:1px solid var(--line);padding-top:7px}
.tt-kv{display:flex;align-items:baseline;justify-content:space-between;gap:16px;padding:3px 0;min-width:0;line-height:1.45}
.tt-k{font-size:12px;color:var(--ink-3);white-space:nowrap;flex:none}
.tt-v{font-size:12.5px;color:var(--ink-1);text-align:right;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.tt-mb-c .tt-kv{padding:2px 0}
/* per-post rows: a <details> each, tap for the breakdown */
.tt-pl{display:flex;flex-direction:column;min-width:0}
.tt-pr{display:block;min-width:0}
.tt-pr+.tt-pr{border-top:1px solid var(--line)}
.tt-row{display:flex;align-items:center;gap:12px;padding:6px 0;min-width:0;list-style:none;cursor:pointer;color:inherit;text-decoration:none;-webkit-tap-highlight-color:transparent}
.tt-row::-webkit-details-marker{display:none}
.tt-row::marker{content:""}
.tt-pr:first-child>.tt-row{padding-top:0}
.tt-pr:last-child>.tt-row{padding-bottom:0}
.tt-row-m{flex:1;min-width:0;display:block}
.tt-row-t{display:block;font-size:13.5px;font-weight:600;letter-spacing:-.01em;line-height:17px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tt-row-s{display:block;font-size:11.5px;color:var(--ink-3);line-height:15px;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}
.tt-gl{display:flex;align-items:center;gap:11px;font-size:11.5px;line-height:15px;margin-top:3px;color:var(--ink-2);white-space:nowrap;overflow:hidden;font-variant-numeric:tabular-nums}
.tt-gl>span{display:flex;align-items:center;gap:4px;flex:none}
.tt-gl .tt-g{width:11px;height:11px;color:var(--ink-3)}
.tt-row-tr{flex:none;max-width:38%;display:flex;flex-direction:column;align-items:flex-end;font-size:12px;line-height:1.3;color:var(--ink-2);font-variant-numeric:tabular-nums}
.tt-row-tr>span{max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tt-row-tr .tt-row-trs{font-size:10.5px;color:var(--ink-4)}
.tt-row-n{display:flex;align-items:baseline;gap:3px}
.tt-row-tr .tt-row-v{font-size:15px;font-weight:700;letter-spacing:-.02em;color:var(--ink-1)}
.tt-row-tr .tt-row-u{font-size:10.5px;color:var(--ink-3)}
.tt-meter{display:block;width:56px;height:3px;margin-top:6px;border-radius:2px;background:var(--track);overflow:hidden}
.tt-meter i{display:block;height:100%;border-radius:2px;background:var(--ink-3)}
.tt-meter.is-top i{background:var(--accent)}
.tt-chev{width:10px;height:10px;flex:none;margin-left:-4px;color:var(--ink-4)}
.tt-row:hover .tt-chev{color:var(--ink-2)}
.tt-row:hover .tt-row-t{color:var(--ink-1)}
details[open]>.tt-row .tt-chev{transform:rotate(90deg);color:var(--ink-2)}
.tt-row:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:8px}
.tt-xp{display:flex;align-items:center;gap:8px;margin:4px 0 6px 46px;padding:7px 7px 7px 10px;border-radius:10px;background:var(--fill-1);box-shadow:inset 0 0 0 1px var(--line);min-width:0}
.tt-xp-g{flex:1;min-width:0;display:flex;justify-content:space-between;gap:8px;overflow:hidden}
.tt-xp-c{min-width:0;display:flex;flex-direction:column}
.tt-xp-c b{font-size:13px;font-weight:660;letter-spacing:-.01em;line-height:16px;font-variant-numeric:tabular-nums;white-space:nowrap}
.tt-xp-c span{font-size:10px;letter-spacing:-.005em;line-height:13px;color:var(--ink-3);white-space:nowrap}
.tt-xo{width:24px;height:24px;flex:none;border-radius:50%;display:flex;align-items:center;justify-content:center;color:var(--ink-1);background:var(--fill-2);text-decoration:none}
.tt-xo:hover{background:var(--track)}
.tt-xo svg{width:12px;height:12px}
.tt.is-x .tt-ft,.tt:has(details.tt-pr[open]) .tt-ft{display:none}
/* plain rows (files, photos) */
.tt-list{display:flex;flex-direction:column;min-width:0}
.tt-list>.tt-row{cursor:default;border-top:1px solid var(--line);padding:6px 0}
.tt-list>.tt-row:first-child{border-top:0;padding-top:0}
.tt-list>.tt-row:last-child{padding-bottom:0}
.tt-list.tt-rule>.tt-row:first-child{border-top:1px solid var(--line);padding-top:6px}
.tt-slot{width:48px;height:48px;flex:none;display:flex;align-items:center;justify-content:center}
/* footnote and link */
.tt-ft{display:flex;align-items:center;justify-content:space-between;gap:12px;font-size:11.5px;line-height:1.4;color:var(--ink-3);min-width:0}
.tt-ft-n{min-width:0;overflow-wrap:anywhere}
.tt-a{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 9px 0 10px;border-radius:999px;background:var(--fill-1);box-shadow:inset 0 0 0 1px var(--line);color:var(--ink-1);font-size:11.5px;font-weight:600;text-decoration:none;white-space:nowrap;flex:none;margin-left:auto}
.tt-a:hover{background:var(--fill-2)}
.tt-ai{width:11px;height:11px;flex:none;opacity:.7}
.tt-a:focus-visible,.tt-xo:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
/* state */
.tt-pill{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 11px 0 9px;border-radius:999px;font-size:12.5px;font-weight:620;white-space:nowrap;width:max-content;max-width:100%;color:var(--ink-1);background:var(--fill-2)}
.tt-pill svg{width:12px;height:12px;flex:none}
.tt-pill i{width:7px;height:7px;border-radius:50%;background:var(--accent);flex:none}
.tt-pill.is-good{color:var(--good);background:rgba(48,209,88,.16);background:color-mix(in srgb,var(--good) 16%,transparent)}
.tt-pill.is-bad{color:var(--bad);background:rgba(255,69,58,.16);background:color-mix(in srgb,var(--bad) 16%,transparent)}
.tt-pill.is-neutral{color:var(--ink-2)}
.tt-rail{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));column-gap:4px}
.tt-step{min-width:0}
.tt-step i{position:relative;display:block;height:4px;border-radius:2px;background:var(--track);overflow:hidden}
.tt-step span{display:block;font-size:11px;line-height:1.4;color:var(--ink-4);margin-top:5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tt-step.is-done i{background:var(--accent)}
.tt-step.is-done span{color:var(--ink-3)}
.tt-step.is-now i{background:rgba(254,44,85,.35);background:color-mix(in srgb,var(--accent) 38%,transparent)}
.tt-step.is-now span{color:var(--ink-1);font-weight:600}
.tt-step.is-ok i{background:var(--good)}
.tt-step.is-ok span{color:var(--ink-3)}
.tt-ot{font-size:15.5px;font-weight:650;letter-spacing:-.015em;line-height:20px;min-width:0;overflow-wrap:anywhere}
.tt-oh{display:flex;align-items:flex-start;gap:11px;min-width:0}
.tt-oi{width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;flex:none;color:var(--ink-2);background:var(--fill-2)}
.tt-oi svg{width:15px;height:15px}
.tt-oh.is-good .tt-oi{color:var(--good);background:rgba(48,209,88,.16);background:color-mix(in srgb,var(--good) 16%,transparent)}
.tt-oh.is-bad .tt-oi{color:var(--bad);background:rgba(255,69,58,.16);background:color-mix(in srgb,var(--bad) 16%,transparent)}
.tt-oh-m{flex:1;min-width:0;padding-top:5px}
.tt-oh-m .tt-p{margin-top:4px}
.tt-info{display:flex;gap:7px;align-items:flex-start;font-size:12px;line-height:17px;color:var(--ink-2);min-width:0}
.tt-info svg{width:14px;height:14px;flex:none;margin-top:1.5px;color:var(--ink-3)}
.tt-info span{min-width:0;overflow-wrap:anywhere}
.tt-warn{display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:1.45;color:var(--ink-2);min-width:0}
.tt-warn svg{width:14px;height:14px;flex:none;margin-top:1px;color:var(--ink-1)}
.tt-warn span{min-width:0;overflow-wrap:anywhere}
.tt-chips{display:flex;flex-wrap:wrap;gap:5px;justify-content:flex-end;min-width:0}
.tt-chip{font-size:11px;font-weight:600;line-height:20px;height:20px;padding:0 8px;border-radius:999px;color:var(--ink-2);background:var(--fill-1);box-shadow:inset 0 0 0 1px var(--line);white-space:nowrap}
.tt-m.z-ph{width:36px;height:48px;border-radius:8px}
.tt-m.z-ph.has-i::before{display:none}
@keyframes tt-kb{from{transform:scale(1.03) translate(0,0)}to{transform:scale(1.13) translate(-3%,-2.5%)}}
@keyframes tt-draw{from{stroke-dashoffset:15}to{stroke-dashoffset:0}}
@keyframes tt-pop{0%{transform:scale(.4);opacity:0}70%{transform:scale(1.08);opacity:1}100%{transform:scale(1)}}
@keyframes tt-shim{from{background-position:130% 0}to{background-position:-30% 0}}
@keyframes tt-flow{from{transform:translateX(-100%)}to{transform:translateX(250%)}}
@media(prefers-reduced-motion:no-preference){
.tt-m.kb .tt-m-i{animation:tt-kb 16s ease-in-out infinite alternate;transform-origin:50% 40%}
.tt-m-b{animation:tt-pop .42s cubic-bezier(.2,.9,.3,1.2) .12s both}
.tt-m-b .tt-ck path{stroke-dasharray:15;animation:tt-draw .42s ease-out .4s both}
.tt-m-sh{animation:tt-shim 1.8s linear infinite}
.tt-chev{transition:transform .18s ease,color .18s ease}
.tt-step.is-now i::after{content:"";position:absolute;top:0;bottom:0;left:0;width:40%;border-radius:2px;background:var(--accent);animation:tt-flow 1.6s ease-in-out infinite}
}
`;

// ---------------------------------------------------------------------------
// Text, links and the layout model
// ---------------------------------------------------------------------------

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
/** Clean, then clip (grapheme-safe). Escape at the point of interpolation. */
const fit = (v: unknown, max: number): string => clipText(cleanText(v), max);
const captionOf = (v: { caption?: string; video_description?: string; title?: string }) => v.caption || v.video_description || v.title || "";

/** Card text with its line breaks kept (each line cleaned, blank runs collapsed), clipped to `max`. */
function multiline(v: unknown, max: number): string {
  const lines = String(v ?? "").split(/\r\n|[\r\n]/).map(cleanText);
  const kept: string[] = [];
  for (const line of lines) if (line || (kept.length && kept[kept.length - 1])) kept.push(line);
  while (kept.length && !kept[kept.length - 1]) kept.pop();
  return clipText(kept.join("\n"), max);
}

/** https on tiktok.com (and its subdomains) only; anything else renders as text. */
function tiktokHref(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  const raw = url.trim();
  if (!/^https:\/\/[^\s"'<>\\]+$/i.test(raw)) return undefined;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" || u.username || u.password) return undefined;
    if (!/(^|\.)tiktok\.com$/i.test(u.hostname)) return undefined;
    return u.href;
  } catch {
    return undefined;
  }
}

/** Content column: 388 px card minus 15 px padding each side. */
const COL = 358;
const PAD = 27;
const GAP = 10;
const HEADER = 16;
/** Space between a tile and the text beside it. */
const BESIDE = 14;

/** Wrapped line count, from the kit's per-script width model (CJK and emoji are wide; vNote's 28.6 em per 358 px line). */
function lines(text: string, px: number, width = COL, max = 99): number {
  if (!text) return 0;
  return Math.min(max, Math.max(1, Math.ceil((textEms(text) * px) / width)));
}
/** Lines for text that keeps its own line breaks. */
function brokenLines(text: string, px: number, width: number, max: number): number {
  return Math.min(max, text.split("\n").reduce((sum, line) => sum + Math.max(1, lines(line, px, width)), 0));
}

interface Part {
  html: string;
  h: number;
  /** CSS this part needs on top of the shared sheet (a photo stack's), added once per card. */
  css?: string;
  /** Script this part needs (the photo stack's driver, ES5), added once per card. */
  js?: string;
}
type Maybe<T> = T | null | undefined | false | "";

/**
 * Rows open one at a time (the `name` attribute does it natively; this covers engines without it),
 * and the card's footnote steps aside while one is open so the card stays inside the notch.
 * ES5, no strings compiled to code.
 */
const ACCORDION_JS =
  "(function(){var r=document.querySelector('.tt');document.addEventListener('toggle',function(e){var d=e.target;if(!d||d.tagName!=='DETAILS')return;" +
  "if(d.open){var o=document.querySelectorAll('details.tt-pr[open]');for(var i=0;i<o.length;i++){if(o[i]!==d)o[i].open=false}}" +
  "if(r)r.className=document.querySelector('details.tt-pr[open]')?'tt is-x':'tt'},true)})()";

function render(o: { trailing?: string; parts: Array<Maybe<Part>>; label: string; script?: string }): Widget {
  const scripts = [...new Set([o.script, ...o.parts.map((p) => (p && p.js) || "")].filter((x): x is string => Boolean(x)))];
  const parts = o.parts.filter((p): p is Part => Boolean(p && p.html));
  const trailing = fit(o.trailing, 28);
  const header = `<div class="k-hd"><div class="k-hd-l">${markHtml()}<span class="k-hd-t">TikTok</span></div>${
    trailing ? `<span class="k-hd-tr">${esc(trailing)}</span>` : ""
  }</div>`;
  const height = Math.round(PAD + HEADER + parts.reduce((sum, p) => sum + GAP + p.h, 0));
  const label = fit(o.label, 60) || "TikTok";
  const script = scripts.length ? `<script>${scripts.join(";\n")}</script>` : "";
  const extra = [...new Set(parts.map((p) => p.css).filter((c): c is string => Boolean(c)))].join("");
  const card = renderCustom({ accent: ACCENT, css: CSS + extra, body: `<div class="tt">${header}${parts.map((p) => p.html).join("")}</div>${script}`, height, label });
  return { type: "widget", html: card.html, height: card.height, label: card.label ?? label };
}

// ---------------------------------------------------------------------------
// Glyphs
// ---------------------------------------------------------------------------

const ICONS = {
  check: '<path d="M3.8 8.3 6.6 11 12.2 5"/>',
  cross: '<path d="M5 5l6 6M11 5l-6 6"/>',
  clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5.2V8l1.9 1.3"/>',
  ext: '<path d="M6.5 4.5h5v5M11.5 4.5 5 11"/>',
  warn: '<path d="M8 2.8 14.2 13.2H1.8Z"/><path d="M8 6.8v2.6M8 11.3v.01"/>',
  film: '<rect x="2.25" y="3.25" width="11.5" height="9.5" rx="2.2"/><path d="M6.9 6.1v3.8L10 8Z" fill="currentColor" stroke-width="1.2"/>',
  photo: '<rect x="2.25" y="3" width="11.5" height="10" rx="2.2"/><circle cx="6" cy="6.6" r="1.05" fill="currentColor" stroke="none"/><path d="m2.8 11.6 3.1-2.9 2.3 2 1.7-1.4 3.3 2.9"/>',
  person: '<circle cx="8" cy="5.9" r="2.6"/><path d="M3.4 13.2c.8-2.4 2.6-3.6 4.6-3.6s3.8 1.2 4.6 3.6"/>',
  chev: '<path d="M6 3.5 10.5 8 6 12.5"/>',
  up: '<path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2"/>',
  search: '<circle cx="7.2" cy="7.2" r="4.2"/><path d="m10.4 10.4 3.1 3.1"/>',
  down: '<path d="M8 3v9.5M3.8 8.5 8 12.7l4.2-4.2"/>',
} as const;
type IconName = keyof typeof ICONS;
const icon = (name: IconName, cls = "") =>
  `<svg${cls ? ` class="${cls}"` : ""} viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

/** Filled metric glyphs, the way TikTok draws them beside a number. */
const METRIC = {
  views: '<path d="M4.6 2.7v10.6c0 .6.6.9 1.1.6l8.3-5.3c.5-.3.5-.9 0-1.2L5.7 2.1c-.5-.3-1.1 0-1.1.6Z"/>',
  likes: '<path d="M8 14.2S1.8 10.6 1.8 6.2a3.25 3.25 0 0 1 6.2-1.6 3.25 3.25 0 0 1 6.2 1.6c0 4.4-6.2 8-6.2 8Z"/>',
  comments: '<path d="M8 2.2c3.4 0 6.2 2.3 6.2 5.2S11.4 12.6 8 12.6c-.7 0-1.3-.1-1.9-.2l-3.3 1.4.9-2.7C2.6 10.1 1.8 8.8 1.8 7.4c0-2.9 2.8-5.2 6.2-5.2Z"/>',
  shares: '<path d="M9.2 2.4 14.8 7.6 9.2 12.8V9.9c-3.6 0-5.7 1-7.4 3.6.4-4.2 2.6-7.1 7.4-7.6Z"/>',
} as const;
type Metric = keyof typeof METRIC;
const glyph = (m: Metric) => `<svg class="tt-g" viewBox="0 0 16 16" aria-hidden="true">${METRIC[m]}</svg>`;

const PLAY_G = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11.5" fill="currentColor" opacity=".16"/><path d="M9.7 7.3v9.4l7.3-4.7Z" fill="currentColor"/></svg>';
const PHOTO_G = icon("photo");

/** TikTok's verified mark: a cyan disc with a check. The word rides along for screen readers. */
const VERIFIED = `<svg class="tt-vf" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#20d5ec"/><path d="M4.9 8.2 7.1 10.3 11.2 5.9" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="tt-sr">Verified</span>`;

const clampClass = (n: number) => (n <= 1 ? "tt-1" : `tt-c${Math.min(6, n)}`);

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

type Tone = "good" | "bad" | "live" | "neutral";

interface TileOpts {
  size: TileSize;
  wide?: boolean;
  /** Already validated (cardImage / imageBudget). */
  src?: string;
  kind?: "video" | "photo";
  /** Duration or count, bottom-left. */
  pill?: string;
  /** The slow Ken Burns drift (hero frames only). */
  drift?: boolean;
  badge?: { tone: Tone; icon: IconName };
  busy?: boolean;
  dim?: boolean;
  top?: boolean;
  /** The video playing: an animated WebP or a filmstrip (cardMotion), over the poster. */
  motion?: CardMotion;
  /** With no picture at all, the big tiles show this (the file name) under the glyph instead of an empty box. */
  label?: string;
}

/**
 * A media tile. The glyph is drawn first and the frame over it, so a frame the kit strips
 * (over the document cap) or one that fails to decode leaves the tasteful fallback, never a hole.
 */
function tile(o: TileOpts): { html: string; w: number; h: number } {
  const t = TILE[o.size];
  const [w, h] = o.wide ? [t.h, t.w] : [t.w, t.h];
  const mo = o.motion;
  const pic = Boolean(o.src || mo);
  const named = !pic && (o.size === "l" || o.size === "xl" || o.size === "h" || o.size === "f") ? fit(o.label, 48) : "";
  const cls = [
    "tt-m", `z-${o.size}`, o.wide && "is-w", pic && "has-i", o.src && o.drift && !mo && "kb", mo && "is-mo", o.dim && "is-dim", o.top && "is-top", named && "is-named",
  ].filter(Boolean).join(" ");
  const pill = fit(o.pill, 10);
  const badge = o.badge
    ? `<span class="tt-m-b is-${o.badge.tone}">${o.badge.icon === "check" ? icon("check", "tt-ck") : icon(o.badge.icon)}</span>`
    : "";
  // The loop sits over the poster; with reduced motion the poster shows instead (a filmstrip simply holds its first frame).
  // A filmstrip's frames each carry a smeared border (`edge`): the strip is that much wider per frame and starts that far
  // left, so every step lands inside a frame and scaling never blends in a sliver of its neighbour.
  const edge = mo?.frames ? mo.edge ?? 0 : 0;
  const stripBox = edge && mo?.frames ? `width:${+(mo.frames * (1 + 2 * edge) * 100).toFixed(4)}%;left:${+(-edge * 100).toFixed(4)}%` : `width:${(mo?.frames ?? 0) * 100}%`;
  const moving = !mo
    ? ""
    : mo.frames
      ? `<span class="tt-m-fs"><img class="tt-m-fsi" src="${esc(mo.src)}" alt="" style="${stripBox};animation-duration:${(mo.frames / (mo.fps ?? 8)).toFixed(3)}s;animation-timing-function:steps(${mo.frames})"></span>`
      : `<img class="tt-m-i tt-m-mo" src="${esc(mo.src)}" alt="">`;
  const glyph = `<span class="tt-m-g">${o.kind === "photo" ? PHOTO_G : PLAY_G}${named ? `<span class="tt-m-n">${esc(named)}</span>` : ""}</span>`;
  const html = `<span class="${cls}" aria-hidden="true">${glyph}${o.src ? `<img class="tt-m-i" src="${esc(o.src)}" alt="">` : ""}${moving}${
    o.busy ? '<span class="tt-m-sh"></span>' : ""
  }${pill ? `<span class="tt-m-d">${esc(pill)}</span>` : ""}${badge}</span>`;
  return { html, w, h };
}

/** A tile (or a photo stack) with a column of text beside it; the block is as tall as the taller of the two. */
function besideTile(t: { html: string; w: number; h: number; css?: string; js?: string }, inner: string, innerH: number, align: "top" | "mid" | "split" = "top"): Part {
  const cls = align === "mid" ? " is-mid" : align === "split" ? " is-split" : "";
  return {
    html: `<div class="tt-mb">${t.html}<div class="tt-mb-c${cls}">${inner}</div></div>`,
    h: Math.max(t.h, innerH),
    ...(t.css ? { css: t.css } : {}),
    ...(t.js ? { js: t.js } : {}),
  };
}
const besideWidth = (t: { w: number }) => COL - t.w - BESIDE;

// ---------------------------------------------------------------------------
// The photo stack: the whole carousel as 3:4 cards fanned behind each other, the way iMessage stacks a batch of
// photos. A small ES5 driver (STACK_JS) flicks the top card aside and tucks it in at the back every few seconds,
// through every photo; a click, a swipe (pointer or trackpad), Return, Space or the arrow keys move it by hand,
// and hovering pauses it. With reduced motion the photos cross-fade in place over a still fan. Without scripts
// the fan still reads, photo 1 on top. The confirmation cards draw the same stack (confirm-card/card.css) from
// the tiny frames; these cards get real thumbnails of every photo.
// ---------------------------------------------------------------------------

type StackSize = "m" | "l" | "xl";
/** Card (cw × ch, 3:4, radius r) and the box the fan needs around it (w × h, dots row included). */
const STACK: Record<StackSize, { cw: number; ch: number; r: number; w: number; h: number; top: number; dots: boolean }> = {
  m: { cw: 62, ch: 83, r: 10, w: 92, h: 96, top: 9, dots: false },
  l: { cw: 88, ch: 117, r: 13, w: 130, h: 150, top: 14, dots: true },
  xl: { cw: 108, ch: 144, r: 15, w: 156, h: 180, top: 17, dots: true },
};
/** The same stacks for tall photos (slides, phone screenshots): 9:16 cards, so nothing is cropped away. */
const STACK_TALL: Record<StackSize, { cw: number; ch: number; r: number; w: number; h: number; top: number; dots: boolean }> = {
  m: { cw: 54, ch: 96, r: 10, w: 92, h: 108, top: 9, dots: false },
  l: { cw: 74, ch: 132, r: 12, w: 128, h: 165, top: 14, dots: true },
  xl: { cw: 96, ch: 171, r: 14, w: 156, h: 207, top: 17, dots: true },
};
/** Every photo of a carousel (TikTok's 35). */
const STACK_MAX = 35;
/** All of one stack's thumbnails together, so the card stays well under VoiceOS's 300,000-character cap. */
const STACK_BUDGET = 215_000;
/** Dots up to this many photos; past it the position pill alone says where you are. */
const STACK_DOTS_MAX = 12;

interface Slot {
  t: string;
  o: number;
  b: number;
  z: number;
}
/** Where each depth sits: the top card square, the next two peeking out right and left, the rest hidden behind. */
const SLOTS: Slot[] = [
  { t: "translate(0,0) rotate(0deg) scale(1)", o: 1, b: 1, z: 6 },
  { t: "translate(15%,-2%) rotate(8deg) scale(.94)", o: 1, b: 0.9, z: 5 },
  { t: "translate(-15%,-4%) rotate(-8deg) scale(.89)", o: 1, b: 0.8, z: 4 },
  { t: "translate(0,-6%) rotate(0deg) scale(.82)", o: 0, b: 0.72, z: 3 },
  { t: "translate(0,-6%) rotate(0deg) scale(.82)", o: 0, b: 0.72, z: 2 },
];
/** The flick: up and away to the left, still on top; then it drops behind and tucks in at the back. */
const FLICK = "translate(-44%,-9%) rotate(-14deg) scale(.97)";

const slotCss = (s: Slot) => `transform:${s.t};opacity:${s.o};filter:brightness(${s.b});z-index:${s.z}`;

/**
 * The stack's driver (ES5, no strings compiled to code). Each `.tt-ps.is-live` box's cards move through the
 * depth classes s0-s4; `out` is the flick, `back` the tuck-in, `fade` the reduced-motion cross-fade.
 */
export const STACK_JS =
  "(function(){var still=!!(window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches);" +
  "var boxes=document.querySelectorAll('.tt-ps.is-live');for(var b=0;b<boxes.length;b++)init(boxes[b]);" +
  "function init(box){var cards=box.querySelectorAll('.tt-ps-c'),n=cards.length,order=[],busy=false,hover=false,timer=0,x0=null,swiped=false,wheel=0,i;" +
  "if(n<2)return;for(i=0;i<n;i++)order.push(i);var dots=box.querySelectorAll('.tt-ps-d i');" +
  "function cls(c,k,extra){c.className='tt-ps-c s'+Math.min(k,4)+(extra?' '+extra:'')}" +
  "function mark(){for(var d=0;d<dots.length;d++)dots[d].className=d===order[0]?'on':''}" +
  "function place(){for(var k=0;k<n;k++)cls(cards[order[k]],k);mark()}" +
  "function step(dir){if(busy)return;busy=true;var k,m;" +
  "if(still){if(dir>0){m=cards[order[0]];m.className+=' fade';setTimeout(function(){order.push(order.shift());place();busy=false},480)}else{order.unshift(order.pop());place();busy=false}mark();return}" +
  "if(dir>0){m=cards[order[0]];order.push(order.shift());for(k=0;k<n-1;k++)cls(cards[order[k]],k);m.className='tt-ps-c out';" +
  "setTimeout(function(){cls(m,n-1,'back')},340)}else{m=cards[order[n-1]];order.unshift(order.pop());for(k=1;k<n;k++)cls(cards[order[k]],k);m.className='tt-ps-c out under';" +
  "setTimeout(function(){cls(m,0)},360)}mark();setTimeout(function(){place();busy=false},900)}" +
  "function loop(){clearTimeout(timer);timer=setTimeout(function(){if(!hover&&!document.hidden)step(1);loop()},2800)}" +
  "box.addEventListener('mouseenter',function(){hover=true});box.addEventListener('mouseleave',function(){hover=false});" +
  "box.addEventListener('pointerdown',function(e){x0=e.clientX});" +
  "box.addEventListener('pointerup',function(e){if(x0===null)return;var dx=e.clientX-x0;x0=null;if(Math.abs(dx)>24){swiped=true;step(dx<0?1:-1);loop()}});" +
  "box.addEventListener('click',function(){if(swiped){swiped=false;return}step(1);loop()});" +
  "box.addEventListener('wheel',function(e){if(Math.abs(e.deltaX)<=Math.abs(e.deltaY))return;e.preventDefault();wheel+=e.deltaX;if(Math.abs(wheel)>40){step(wheel>0?1:-1);wheel=0;loop()}},{passive:false});" +
  "box.addEventListener('keydown',function(e){var k=e.key;if(k==='ArrowRight'||k==='Enter'||k===' '){e.preventDefault();step(1);loop()}else if(k==='ArrowLeft'){e.preventDefault();step(-1);loop()}});" +
  "place();loop()}})()";

/** The stack's own sheet (sizes and depths come from STACK and SLOTS), shared by every stack on a card. */
function stackBaseCss(): string {
  const sizeCss = (table: typeof STACK, tall: boolean) =>
    (Object.entries(table) as Array<[StackSize, (typeof STACK)[StackSize]]>)
      .map(([k, z]) => {
        const sel = `.tt-ps.z-${k}${tall ? ".is-tall" : ""}`;
        return `${sel}{width:${z.w}px;height:${z.h}px}${sel} .tt-ps-k{width:${z.cw}px;height:${z.ch}px}${sel} .tt-ps-c,${sel} .tt-ps-k::before,${sel} .tt-ps-k::after{border-radius:${z.r}px}`;
      })
      .join("");
  const sizes = sizeCss(STACK, false) + sizeCss(STACK_TALL, true);
  const slots = SLOTS.map((sl, i) => `.tt-ps-c.s${i}{${slotCss(sl)}}`).join("");
  return (
    `.tt-ps{position:relative;display:block;flex:none;isolation:isolate;outline:none;-webkit-tap-highlight-color:transparent;--tt-dot:rgba(255,255,255,.2);--tt-dot-on:rgba(255,255,255,.88)}` +
    `.tt-ps.is-live{cursor:pointer;touch-action:pan-y}` +
    `html[data-k-theme=light] .tt-ps{--tt-dot:rgba(0,0,0,.14);--tt-dot-on:rgba(0,0,0,.7)}` +
    `.tt-ps-k{position:absolute;display:block}` +
    `.tt-ps-c,.tt-ps.is-deep .tt-ps-k::before,.tt-ps.is-deep .tt-ps-k::after{position:absolute;inset:0;display:block;transform-origin:50% 85%}` +
    `.tt-ps-c{overflow:hidden;isolation:isolate;background:linear-gradient(158deg,#3b3b45 0%,#202027 52%,#121215 100%);box-shadow:0 8px 20px rgba(0,0,0,.45),0 1px 3px rgba(0,0,0,.35)}` +
    `.tt-ps-c::after{content:"";position:absolute;inset:0;z-index:4;border-radius:inherit;pointer-events:none;box-shadow:inset 0 0 0 1px rgba(255,255,255,.1)}` +
    `.tt-ps.is-deep .tt-ps-k::before,.tt-ps.is-deep .tt-ps-k::after{content:"";z-index:0;background:linear-gradient(158deg,#34343c,#1b1b20);box-shadow:0 6px 14px rgba(0,0,0,.3)}` +
    `.tt-ps.is-deep .tt-ps-k::before{transform:${SLOTS[1].t};filter:brightness(${SLOTS[1].b})}.tt-ps.is-deep .tt-ps-k::after{transform:${SLOTS[2].t};filter:brightness(${SLOTS[2].b})}` +
    `html[data-k-theme=light] .tt-ps-c{background:linear-gradient(158deg,#e4e4e9 0%,#cfcfd6 100%);box-shadow:0 6px 16px rgba(0,0,0,.16),0 1px 2px rgba(0,0,0,.12)}` +
    `html[data-k-theme=light] .tt-ps-c::after{box-shadow:inset 0 0 0 1px rgba(0,0,0,.08)}` +
    `html[data-k-theme=light] .tt-ps.is-deep .tt-ps-k::before,html[data-k-theme=light] .tt-ps.is-deep .tt-ps-k::after{background:linear-gradient(158deg,#d6d6dc,#c2c2ca);box-shadow:0 4px 10px rgba(0,0,0,.08)}` +
    `.tt-ps-i{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;display:block;-webkit-user-drag:none;user-select:none}` +
    `.tt-ps.is-dim .tt-ps-i{filter:grayscale(.85) brightness(.6)}` +
    `.tt-ps-p{position:absolute;left:5px;bottom:5px;z-index:3;height:15px;padding:0 5px;border-radius:5px;display:flex;align-items:center;font-size:9.5px;font-weight:650;letter-spacing:.01em;color:#fff;background:rgba(0,0,0,.45);font-variant-numeric:tabular-nums;white-space:nowrap}` +
    `.tt-ps.z-l .tt-ps-p,.tt-ps.z-xl .tt-ps-p{left:6px;bottom:6px;height:17px;padding:0 6px;border-radius:6px;font-size:10.5px}` +
    `.tt-ps-c:not(.s0) .tt-ps-p{opacity:0}` +
    `.tt-ps-cv{position:absolute;left:6px;top:6px;z-index:3;display:flex;align-items:center;gap:4px;height:16px;padding:0 6px 0 5px;border-radius:5px;font-size:9.5px;font-weight:650;letter-spacing:.01em;color:#fff;background:rgba(0,0,0,.45)}` +
    `.tt-ps-cv::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--accent)}` +
    `.tt-ps-nm{position:absolute;left:8px;right:8px;bottom:26px;z-index:3;font-size:10.5px;font-weight:600;line-height:13px;text-align:center;color:rgba(255,255,255,.72);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}` +
    `html[data-k-theme=light] .tt-ps-nm{color:rgba(0,0,0,.55)}` +
    `.tt-ps-d{position:absolute;left:0;right:0;bottom:0;height:5px;display:flex;justify-content:center;gap:4px}` +
    `.tt-ps-d i{display:block;width:5px;height:5px;border-radius:3px;background:var(--tt-dot)}.tt-ps-d i.on{width:12px;background:var(--tt-dot-on)}` +
    `.tt-ps .tt-m-b{z-index:10;right:auto;bottom:auto}` +
    `.tt-ps.is-live:focus-visible .tt-ps-c.s0{outline:2px solid var(--accent);outline-offset:3px}` +
    `.tt-ps-c.out{transform:${FLICK};opacity:1;filter:none;z-index:9}.tt-ps-c.out.under{z-index:1}.tt-ps-c.back{z-index:1}` +
    `@media(prefers-reduced-motion:no-preference){.tt-ps-c{transition:transform .55s cubic-bezier(.2,.75,.25,1),filter .55s ease,opacity .45s ease}` +
    `.tt-ps-c.out{transition:transform .34s cubic-bezier(.5,0,.75,.4),filter .34s ease,opacity .2s ease}.tt-ps-p{transition:opacity .25s ease}.tt-ps-d i{transition:width .3s ease,background-color .3s ease}}` +
    `@media(prefers-reduced-motion:reduce){.tt-ps.is-live .tt-ps-c{transform:${SLOTS[0].t};filter:none;opacity:1;transition:opacity .48s ease}.tt-ps.is-live .tt-ps-c.fade{opacity:0}}` +
    sizes +
    slots
  );
}

interface StackOpts {
  size: StackSize;
  /** Every photo's thumbnail (validated here), in carousel order. */
  thumbs?: unknown[];
  /** How many photos the post has. */
  count?: number;
  /** The cover's index in the post, from 0. */
  cover?: number;
  /** Run the loop (off for failures and refusals: the fan stays still). */
  animate?: boolean;
  badge?: { tone: Tone; icon: IconName };
  busy?: boolean;
  dim?: boolean;
  /** With no thumbnails: a word for the plain stack ("11 photos"). */
  label?: string;
}

/**
 * The stack. Each card is the photo glyph under its thumbnail (a stripped or broken image leaves the glyph,
 * never a hole) with its place in the post ("2/11"); the cover says so. Without thumbnails: three designed
 * cards, still, with the glyph, the count and a word.
 */
function photoStack(o: StackOpts, images?: Images): { html: string; w: number; h: number; css: string; js?: string } {
  const budget = images ?? imageBudget(STACK_BUDGET);
  const srcs = (Array.isArray(o.thumbs) ? o.thumbs : []).slice(0, STACK_MAX).map((t) => budget(t)).filter((t): t is string => Boolean(t));
  // Tall thumbnails (9:16 slides) get tall cards.
  const first = srcs.length ? imageSize(srcs[0]) : undefined;
  const tall = Boolean(first && first.h >= first.w * 1.6);
  const z = (tall ? STACK_TALL : STACK)[o.size];
  const count = Math.max(isNum(o.count) && o.count > 0 ? Math.min(99, Math.round(o.count)) : 0, srcs.length);
  const real = srcs.length > 0;
  const n = real ? srcs.length : Math.max(1, Math.min(3, count || 3));
  const live = real && n > 1 && o.animate !== false;
  const cover = isNum(o.cover) ? Math.round(o.cover) : -1;
  const word = fit(o.label, 40);
  const cards = Array.from({ length: n }, (_, i) => {
    const img = real ? `<img class="tt-ps-i" src="${esc(srcs[i])}" alt="" draggable="false">` : "";
    const cv = real && i === cover && o.size !== "m" && count > 1 ? '<span class="tt-ps-cv">Cover</span>' : "";
    const glyph = real || i === 0 ? `<span class="tt-m-g">${PHOTO_G}</span>` : "";
    const pos = count > 1 && (real || i === 0) ? `<span class="tt-ps-p">${real ? `${i + 1}/${count}` : `${count}`}</span>` : "";
    const nm = !real && i === 0 && word && o.size !== "m" ? `<span class="tt-ps-nm">${esc(word)}</span>` : "";
    return `<span class="tt-ps-c s${Math.min(i, 4)}">${glyph}${img}${o.busy ? '<span class="tt-m-sh"></span>' : ""}${nm}${pos}${cv}</span>`;
  }).join("");
  const dots = z.dots && real && n > 1 && n <= STACK_DOTS_MAX ? `<span class="tt-ps-d">${Array.from({ length: n }, (_, i) => (i ? "<i></i>" : '<i class="on"></i>')).join("")}</span>` : "";
  const left = (z.w - z.cw) / 2;
  const badge = o.badge
    ? `<span class="tt-m-b is-${o.badge.tone}" style="left:${Math.round(left + z.cw - 17)}px;top:${Math.round(z.top + z.ch - 17)}px">${
        o.badge.icon === "check" ? icon("check", "tt-ck") : icon(o.badge.icon)
      }</span>`
    : "";
  const cls = ["tt-ps", `z-${o.size}`, tall && "is-tall", `n${n}`, live && "is-live", n > 1 && "is-deep", o.dim && "is-dim", real && "has-i"].filter(Boolean).join(" ");
  const a11y = live ? ` role="group" tabindex="0" aria-roledescription="photo stack" aria-label="${esc(`${count} photos. Click or swipe to see the next one.`)}"` : ' aria-hidden="true"';
  const html = `<span class="${cls}"${a11y}><span class="tt-ps-k" style="left:${left}px;top:${z.top}px">${cards}</span>${dots}${badge}</span>`;
  return { html, w: z.w, h: z.h, css: stackBaseCss(), ...(live ? { js: STACK_JS } : {}) };
}

function headline(text: string, clamp = 2, dim = false): Part {
  return { html: `<div class="tt-h ${clampClass(clamp)}${dim ? " tt-dim" : ""}">${esc(text)}</div>`, h: lines(text, 14.5, COL, clamp) * 19 };
}

function para(text: string, clamp = 4, width = COL): Maybe<Part> {
  if (!text) return null;
  return { html: `<p class="tt-p ${clampClass(clamp)}">${esc(text)}</p>`, h: lines(text, 12.5, width, clamp) * 18 };
}

/** Up to three big numbers in a row. A number is compacted (12.4K); a string (a percentage) is shown as is; missing is a dash, never 0. */
function stats(items: Array<[string, number | string | undefined]>): Part {
  const cells = items
    .map(([label, v]) => {
      const shown = typeof v === "string" && v ? v : isNum(v) ? compact(v) : "—";
      return `<div class="tt-st"><div class="tt-st-v">${esc(shown)}</div><div class="tt-st-l">${esc(label)}</div></div>`;
    })
    .join("");
  return { html: `<div class="tt-sts">${cells}</div>`, h: 50 };
}

function facts(rows: Array<Maybe<[string, string]>>, rule = false): Maybe<Part> {
  const list = rows
    .filter((r): r is [string, string] => Array.isArray(r))
    .map(([k, v]) => [fit(k, 32), fit(v, 64)] as const)
    .filter(([k, v]) => k && v);
  if (!list.length) return null;
  const html = list.map(([k, v]) => `<div class="tt-kv"><span class="tt-k">${esc(k)}</span><span class="tt-v">${esc(v)}</span></div>`).join("");
  return { html: `<div class="tt-kvs${rule ? " tt-rule" : ""}">${html}</div>`, h: list.length * 24 + (rule ? 8 : 0) };
}

/** Up to two initials for a monogram ("Tiny AI Lab" → "TA"); one for scripts without word spaces. */
function initials(name: string): string {
  const words = cleanText(name).replace(/^@+/, "").split(/[\s._-]+/).filter(Boolean);
  const firsts = words.map((w) => Array.from(w).find((ch) => /[\p{L}\p{N}]/u.test(ch)) ?? "").filter(Boolean);
  return firsts.slice(0, 2).join("").toLocaleUpperCase();
}

/**
 * The account's picture (round, hairline ring), name with the verified mark, and a quiet second line.
 * With no picture, or one the kit strips, the monogram underneath shows.
 */
function identity(name: string, o: { sub?: string; verified?: boolean; avatar?: string; small?: boolean; eyebrow?: string } = {}): Part {
  const mono = initials(name);
  const pic = o.avatar ? `<img class="tt-av-i" src="${esc(o.avatar)}" alt="">` : "";
  const av = `<span class="tt-av${o.small ? " z-sm" : ""}${pic ? " has-i" : ""}" aria-hidden="true">${mono ? esc(mono) : icon("person")}${pic}</span>`;
  const second = fit(o.sub, 64);
  const eyebrow = fit(o.eyebrow, 24);
  return {
    html: `<div class="tt-who">${av}<div class="tt-who-m">${eyebrow ? `<div class="tt-who-s">${esc(eyebrow)}</div>` : ""}<div class="tt-name"><span class="tt-who-n tt-1">${esc(name)}</span>${
      o.verified ? VERIFIED : ""
    }</div>${second ? `<div class="tt-who-s">${esc(second)}</div>` : ""}</div></div>`,
    h: o.small ? 40 : 56,
  };
}

function foot(note: string, link?: { href?: string; text: string }): Maybe<Part> {
  const href = link ? tiktokHref(link.href) : undefined;
  const text = fit(note, 200);
  if (!text && !href) return null;
  const a = href && link ? `<a class="tt-a" href="${esc(href)}">${esc(link.text)}${icon("ext", "tt-ai")}</a>` : "";
  const n = lines(text, 11.5, COL - (href ? 120 : 0), 3);
  return { html: `<div class="tt-ft">${text ? `<span class="tt-ft-n">${esc(text)}</span>` : ""}${a}</div>`, h: Math.max(href ? 24 : 16, n * 16) };
}

function pillHtml(text: string, tone: Tone): string {
  const mark = tone === "good" ? icon("check") : tone === "bad" ? icon("cross") : tone === "live" ? "<i></i>" : "";
  return `<div><span class="tt-pill is-${tone}">${mark}${esc(fit(text, 24))}</span></div>`;
}

/** Upload → Processing → In inbox / Posted. `at` is the current step (0 or 1); "done" fills it green. */
function railHtml(at: 0 | 1 | "done", last: string): string {
  const labels = ["Upload", "Processing", last];
  const cells = labels
    .map((label, i) => {
      const cls = at === "done" ? "is-ok" : i < at ? "is-done" : i === at ? "is-now" : "";
      return `<div class="tt-step${cls ? ` ${cls}` : ""}"><i></i><span>${esc(label)}</span></div>`;
    })
    .join("");
  const said = at === "done" ? `Done: ${last}` : `Step ${at + 1} of 3: ${labels[at]}, then ${at === 0 ? `processing and ${last.toLowerCase()}` : last.toLowerCase()}`;
  return `<div class="tt-rail" role="img" aria-label="${esc(said)}">${cells}</div>`;
}
const RAIL_H = 25;

/** A title with a tinted state disc: the errors' and refusals' focal line. */
function alert(title: string, body: string, tone: Tone, name: IconName, clamp = 6): Part {
  const t = fit(title, 60);
  const width = COL - 41;
  const titleH = lines(t, 15.5, width, 2) * 20;
  // Word wrap leaves a little of each line empty: measure the body with 8 % to spare.
  const bodyH = body ? 4 + lines(body, 12.5 * 1.08, width, clamp) * 18 : 0;
  return {
    html: `<div class="tt-oh is-${tone}"><span class="tt-oi">${icon(name)}</span><div class="tt-oh-m"><div class="tt-ot">${esc(t)}</div>${
      body ? `<p class="tt-p ${clampClass(clamp)}">${esc(body)}</p>` : ""
    }</div></div>`,
    h: Math.max(30, 5 + titleH + bodyH),
  };
}

/** A quiet line that explains the result (where a file was found), with a search glyph. */
function info(text: string): Maybe<Part> {
  if (!text) return null;
  return { html: `<div class="tt-info">${icon("search")}<span class="tt-c2">${esc(text)}</span></div>`, h: lines(text, 12, COL - 21, 2) * 17 };
}

function warning(text: string): Maybe<Part> {
  const t = fit(text, 240);
  if (!t) return null;
  return { html: `<div class="tt-warn">${icon("warn")}<span class="tt-c3">${esc(t)}</span></div>`, h: lines(t, 12, COL - 22, 3) * 17.5 };
}

const lengthLabel = (v: { duration?: number }) => (v.duration === 0 ? "Photos" : isNum(v.duration) && v.duration > 0 ? duration(v.duration) : "");

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export function statsCard(u: {
  username?: string;
  display_name?: string;
  follower_count?: number;
  following_count?: number;
  likes_count?: number;
  video_count?: number;
  bio_description?: string;
  is_verified?: boolean;
  profile_deep_link?: string;
  include_profile?: boolean;
  /** The profile picture as a small data URI (the pipeline fetches and downscales it). */
  avatar_data?: string;
}): Widget {
  const handle = fit(u.username, 40).replace(/^@+/, "");
  const at = handle ? `@${handle}` : "";
  const name = fit(u.display_name, 60) || at || "Your TikTok";
  const counts: Array<[string, number | undefined]> = [
    ["Followers", u.follower_count],
    ["Likes", u.likes_count],
    ["Public videos", u.video_count],
  ];
  const bio = fit(u.bio_description, 100);
  // One derived number a creator actually asks about; only when it means something.
  const avg = isNum(u.likes_count) && isNum(u.video_count) && u.video_count > 0 ? u.likes_count / u.video_count : undefined;
  const note = [
    isNum(u.following_count) ? `${compact(u.following_count)} following` : "",
    avg !== undefined && avg >= 1 ? `${compact(Math.round(avg))} avg likes/video` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  return render({
    trailing: "Profile",
    label: at ? `TikTok stats for ${at}` : "TikTok stats",
    parts: [
      identity(name, { sub: name === at ? "" : at, verified: u.is_verified === true, avatar: cardImage(u.avatar_data) }),
      counts.some(([, v]) => isNum(v)) ? stats(counts) : para("TikTok didn't return the counts."),
      para(bio, 2),
      foot(note, { href: u.profile_deep_link, text: "Open profile" }),
    ],
  });
}

const NOT_LISTED = "Only me posts and drafts aren't listed here. Find them in the TikTok app.";
/** Rows on a list card. Four 60 px covers, the totals strip and a footnote fill the notch; an open row's breakdown takes the footnote's place. */
const LIST_ROWS = 4;
const ROW_TILE = TILE.s.h;
const ROW_PAD = 6;

interface Totals {
  views?: number;
  likes?: number;
  comments?: number;
  /** (likes + comments + shares) / views over the posts that report all four; only from 100 views, like a single post's rate. */
  rate?: number;
}

function totals(posts: VideoSummary[]): Totals {
  const sum = (pick: (p: VideoSummary) => number | undefined) => {
    const known = posts.map(pick).filter(isNum);
    return known.length ? known.reduce((a, b) => a + b, 0) : undefined;
  };
  const full = posts.filter((p) => isNum(p.view_count) && isNum(p.like_count) && isNum(p.comment_count) && isNum(p.share_count));
  const fullViews = full.reduce((a, p) => a + (p.view_count as number), 0);
  const acts = full.reduce((a, p) => a + (p.like_count as number) + (p.comment_count as number) + (p.share_count as number), 0);
  return {
    views: sum((p) => p.view_count),
    likes: sum((p) => p.like_count),
    comments: sum((p) => p.comment_count),
    rate: fullViews >= 100 ? acts / fullViews : undefined,
  };
}

/** One post's rate: TikTok's own when given, else (likes + comments + shares) / views from 100 views. */
function rateOf(p: VideoSummary & { engagement_rate?: number }): number | undefined {
  if (isNum(p.engagement_rate)) return p.engagement_rate;
  if (!isNum(p.view_count) || p.view_count < 100 || !isNum(p.like_count) || !isNum(p.comment_count) || !isNum(p.share_count)) return undefined;
  return (p.like_count + p.comment_count + p.share_count) / p.view_count;
}

/** Totals across the posts on the card, as one quiet line: views, likes, and engagement (comments when there isn't enough reach for a rate). */
function overview(posts: VideoSummary[]): Part {
  const t = totals(posts);
  const cell = (v: string, label: string) => `<span><b>${esc(v)}</b>${esc(label)}</span>`;
  const views = isNum(t.views) ? compact(t.views) : "—";
  const likes = isNum(t.likes) ? compact(t.likes) : "—";
  const third = t.rate !== undefined ? cell(percent(t.rate), "engagement") : cell(isNum(t.comments) ? compact(t.comments) : "—", t.comments === 1 ? "comment" : "comments");
  return {
    html: `<div class="tt-tot">${cell(views, t.views === 1 ? "view" : "views")}${cell(likes, t.likes === 1 ? "like" : "likes")}${third}</div>`,
    h: 22,
  };
}

/** A caption's trailing run of #hashtags and @mentions (shown as their own fact), or "" if that's all there is. */
function withoutTrailingTags(text: string): string {
  return text.replace(/(?:\s*[#＃@][^\s#＃@]+)+\s*$/u, "").trim();
}

function rowTitle(p: VideoSummary): string {
  const line = firstLine(captionOf(p), 90);
  return clipText(withoutTrailingTags(line) || line, 60);
}

/** Likes · comments · shares, each with its glyph; a count TikTok didn't send is left out. */
function glyphLine(p: VideoSummary): string {
  const cells = (
    [
      ["likes", p.like_count, "like"],
      ["comments", p.comment_count, "comment"],
      ["shares", p.share_count, "share"],
    ] as Array<[Metric, number | undefined, string]>
  )
    .filter(([, n]) => isNum(n))
    .map(([m, n, one]) => `<span>${glyph(m)}${esc(compact(n as number))}<span class="tt-sr"> ${esc(n === 1 ? one : `${one}s`)}</span></span>`);
  return cells.length ? `<span class="tt-gl">${cells.join("")}</span>` : "";
}

function meterHtml(share: unknown, top = false): string {
  if (!isNum(share) || share < 0) return "";
  const pct = share <= 0 ? 0 : Math.max(5, Math.min(100, Math.round(share * 100)));
  return `<span class="tt-meter${top ? " is-top" : ""}" aria-hidden="true"><i style="width:${pct}%"></i></span>`;
}

/** The breakdown an open row reveals: every count exactly, the rate, and the link to the post. */
function breakdown(p: VideoSummary): string {
  const rate = rateOf(p);
  // Exact while it fits the cell; from 100K the compact form ("123K") keeps five cells on one line.
  const fine = (n: number | undefined) => (isNum(n) && Math.abs(n) >= 100_000 ? compact(n) : exact(n as number));
  const cells: Array<[string, string]> = [
    ["Views", fine(p.view_count)],
    ["Likes", fine(p.like_count)],
    ["Comments", fine(p.comment_count)],
  ];
  if (isNum(p.share_count)) cells.push(["Shares", fine(p.share_count)]);
  if (rate !== undefined) cells.push(["Engagement", percent(rate)]);
  const href = tiktokHref(p.share_url);
  const grid = cells.map(([l, v]) => `<span class="tt-xp-c"><b>${esc(v)}</b><span>${esc(l)}</span></span>`).join("");
  return `<div class="tt-xp"><div class="tt-xp-g">${grid}</div>${
    href ? `<a class="tt-xo" href="${esc(href)}" title="Open in TikTok" aria-label="Open in TikTok">${icon("ext")}</a>` : ""
  }</div>`;
}

/**
 * One <details> per post: cover, caption, likes · comments · shares, when and how long, and views on the right
 * with a bar against the best post on the card. Tapping it reveals the exact breakdown in place.
 */
function postRows(all: VideoSummary[], now: number, max: number, covers: Record<string, string> | undefined, images: Images): Part {
  // Bars compare the rows on the card, so the best one in view always carries the accent.
  const posts = all.slice(0, max);
  const views = posts.map((p) => (isNum(p.view_count) ? p.view_count : -1));
  const best = Math.max(...views);
  const compare = posts.length > 1 && best > 0;
  const top = compare ? views.indexOf(best) : -1;
  const html = posts
    .map((p, i) => {
      const title = rowTitle(p);
      const when = isNum(p.create_time) ? agoShort(p.create_time * 1000, now) : "";
      const photo = p.duration === 0;
      const src = images(covers && typeof p.id === "string" ? covers[p.id] : undefined);
      const t = tile({ size: "s", wide: isWide(src, p.width, p.height), src, kind: photo ? "photo" : "video", top: i === top });
      const meta = [when, lengthLabel(p)].filter(Boolean).join(" · ");
      const value = isNum(p.view_count) ? compact(p.view_count) : "—";
      const right = `<span class="tt-row-tr"><span class="tt-row-n"><span class="tt-row-v">${esc(value)}</span><span class="tt-row-u">${
        p.view_count === 1 ? "view" : "views"
      }</span></span>${compare && isNum(p.view_count) ? meterHtml(p.view_count / best, i === top) : ""}</span>`;
      const tileSlot = t.w > TILE.s.w ? `<span class="tt-slot" style="width:${t.w}px;height:${ROW_TILE}px">${t.html}</span>` : t.html;
      return `<details class="tt-pr" name="tt-post"><summary class="tt-row">${tileSlot}<span class="tt-row-m"><span class="tt-row-t${title ? "" : " tt-dim"}">${esc(
        title || "No caption",
      )}</span>${glyphLine(p)}${meta ? `<span class="tt-row-s">${esc(meta)}</span>` : ""}</span>${right}${icon("chev", "tt-chev")}</summary>${breakdown(p)}</details>`;
    })
    .join("");
  const n = posts.length;
  const h = n * ROW_TILE + Math.max(0, n - 1) * (2 * ROW_PAD + 1);
  return { html: `<div class="tt-pl">${html}</div>`, h };
}

interface PostHeroOpts {
  cover?: string;
  avgViews?: number;
}

/** How a post's views compare with the channel's average, in words; only when both are known. */
function versus(views: unknown, avg: unknown): { text: string; up: boolean; down: boolean } | undefined {
  if (!isNum(views) || !isNum(avg) || avg <= 0 || views < 0) return undefined;
  const r = views / avg;
  if (r >= 1.95) return { text: `${times(r)} your average`, up: true, down: false };
  if (r >= 1.1) return { text: `${Math.round((r - 1) * 100)}% above your average`, up: true, down: false };
  if (r > 0.9) return { text: "About your average", up: false, down: false };
  return { text: `${Math.round((1 - r) * 100)}% below your average`, up: false, down: true };
}

/** One post, picture first: the cover on the left; caption, big views, vs average and the breakdown on the right. */
function postHero(d: VideoSummary & Partial<VideoDetails>, o: PostHeroOpts, captionText: string, clamp = 3): Part {
  const photo = d.duration === 0;
  const t = tile({
    size: "xl",
    wide: isWide(o.cover, d.width, d.height),
    src: o.cover,
    kind: photo ? "photo" : "video",
    pill: photo ? "Photos" : lengthLabel(d),
    drift: true,
  });
  const width = besideWidth(t);
  const rate = rateOf(d);
  const cells: Array<[string, Metric | null, string]> = [
    ["Likes", "likes", isNum(d.like_count) ? compact(d.like_count) : "—"],
    ["Comments", "comments", isNum(d.comment_count) ? compact(d.comment_count) : "—"],
  ];
  if (isNum(d.share_count)) cells.push(["Shares", "shares", compact(d.share_count)]);
  if (rate !== undefined) cells.push(["Engagement", null, percent(rate)]);
  const vs = versus(d.view_count, o.avgViews);
  const cap = captionText
    ? `<div class="tt-h tt-sm tt-pre ${clampClass(clamp)}">${esc(captionText)}</div>`
    : `<div class="tt-h tt-sm tt-1 tt-dim">No caption</div>`;
  const capH = (captionText ? brokenLines(captionText, 14, width, clamp) : 1) * 18.5;
  const views = isNum(d.view_count) ? compact(d.view_count) : "—";
  const big = `<div><div class="tt-big"><span class="tt-big-v">${esc(views)}</span><span class="tt-big-l">${d.view_count === 1 ? "view" : "views"}</span></div>${
    vs ? `<div class="tt-vs${vs.up ? " is-up" : ""}">${vs.up ? icon("up") : vs.down ? icon("down") : ""}${esc(vs.text)}</div>` : ""
  }</div>`;
  const wide = t.w > t.h;
  const ms = `<div class="tt-ms${wide ? " is-row" : cells.length < 3 ? " is-few" : ""}">${cells
    .map(([l, m, v]) => `<div class="tt-ms-c"><div class="tt-ms-v">${m ? glyph(m) : ""}${esc(v)}</div><div class="tt-ms-l">${esc(l)}</div></div>`)
    .join("")}</div>`;
  const bigH = 30 + (vs ? 20 : 0);
  if (wide) {
    // A landscape cover leaves a short, narrow column: caption and views beside it, the breakdown across the card below.
    const top = besideTile(t, `${cap}<div style="margin-top:8px">${big}</div>`, capH + 8 + bigH, "mid");
    return { html: `<div style="display:flex;flex-direction:column;gap:12px;min-width:0">${top.html}${ms}</div>`, h: top.h + 12 + 33 };
  }
  const innerH = capH + 10 + bigH + 10 + 33;
  return besideTile(t, `${cap}<div style="display:flex;flex-direction:column;gap:10px">${big}${ms}</div>`, innerH, "split");
}

function postsCard(posts: VideoSummary[], now: number, covers: Record<string, string> | undefined, o: { trailing: string; label: string; more?: boolean }): Widget {
  const images = imageBudget();
  const max = LIST_ROWS;
  const over = posts.length > max;
  const note = [over ? `Showing ${max} of ${posts.length}` : "", o.more ? `${over ? "o" : "O"}lder posts available` : ""].filter(Boolean).join(" · ");
  return render({
    trailing: o.trailing,
    label: o.label,
    parts: [overview(posts), postRows(posts, now, max, covers, images), foot(note)],
    script: ACCORDION_JS,
  });
}

export function videoListCard(
  v: { videos: VideoSummary[]; has_more: boolean },
  now: number = Date.now(),
  media?: { covers?: Record<string, string>; sends?: SendRow[] },
): Widget {
  const videos = Array.isArray(v?.videos) ? v.videos : [];
  // status: what VoiceOS sent (Only me, drafts) as a second section (listWithSends, at the end of this file).
  if (Array.isArray(media?.sends) && media.sends.length) {
    return listWithSends(videos, v?.has_more === true, media.sends, now, media.covers && typeof media.covers === "object" ? media.covers : undefined);
  }
  if (!videos.length) {
    return render({
      trailing: "Public posts",
      label: "Your recent TikTok posts",
      parts: [headline("No public posts yet", 1), para(NOT_LISTED, 2)],
    });
  }
  const covers = media?.covers && typeof media.covers === "object" ? media.covers : undefined;
  if (videos.length === 1) {
    // A lone post reads best as itself: its cover and its numbers, not a one-row list.
    const p = videos[0];
    const body = multiline(captionOf(p), 150);
    const head = withoutTrailingTags(body) || body;
    const posted = isNum(p.create_time) ? postedLabel(p.create_time, now) : "";
    return render({
      trailing: "1 public post",
      label: "Your recent TikTok posts",
      parts: [
        postHero(p, { cover: cardImage(covers?.[p.id]) }, head),
        foot(posted ? `Posted ${posted}${v.has_more === true ? " · older posts available" : ""}` : v.has_more === true ? "Older posts available" : "", { href: p.share_url, text: "Open in TikTok" }),
      ],
    });
  }
  return postsCard(videos, now, covers, {
    trailing: `Last ${videos.length} public posts`,
    label: "Your recent TikTok posts",
    more: v.has_more === true,
  });
}

export function postDetailsCard(d: VideoDetails, now: number = Date.now(), media?: { cover?: string; channelAvgViews?: number }): Widget {
  const full = captionOf(d);
  const body = multiline(full, 150);
  const lead = withoutTrailingTags(body) || body;
  const head = lead ? `${lead}${d.caption_truncated ? "…" : ""}` : "";
  const posted = fit(d.posted_label, 64) || (isNum(d.create_time) ? postedLabel(d.create_time, now) : "");
  const photo = d.duration === 0;
  const shape = d.aspect || aspectOf(d.width, d.height) || "";
  const length = [isNum(d.duration) && d.duration > 0 ? duration(d.duration) : "", shape].filter(Boolean).join(" · ");
  const tags = (Array.isArray(d.hashtags) && d.hashtags.length ? d.hashtags : hashtags(full)).join(" ");
  return render({
    trailing: "Post details",
    label: "TikTok post details",
    parts: [
      postHero(d, { cover: cardImage(media?.cover), avgViews: media?.channelAvgViews }, head),
      facts(
        [
          posted && ["Posted", posted],
          photo ? ["Type", "Photos"] : length && ["Length", length],
          tags && ["Hashtags", tags],
          d.is_aigc === true && ["Label", "AI-generated"],
        ],
        true,
      ),
      foot(d.caption_truncated ? "TikTok shows up to 150 characters" : "", { href: d.share_url, text: "Open in TikTok" }),
    ],
  });
}

export function postsDetailsCard(list: VideoDetails[], now: number = Date.now(), media?: { covers?: Record<string, string> }): Widget {
  const posts = Array.isArray(list) ? list : [];
  const covers = media?.covers && typeof media.covers === "object" ? media.covers : undefined;
  if (posts.length === 1) return postDetailsCard(posts[0], now, { cover: covers?.[posts[0].id] });
  if (!posts.length) {
    return render({ trailing: "Post details", label: "TikTok post details", parts: [headline("No post details", 1), para(NOT_LISTED, 3)] });
  }
  return postsCard(posts, now, covers, { trailing: `${posts.length} posts`, label: "TikTok post details" });
}

// ---------------------------------------------------------------------------
// Status ("did it go up?")
// ---------------------------------------------------------------------------

export interface StatusCardInput {
  state: "staging" | "uploading" | "processing" | "inbox" | "posted" | "failed" | "unknown" | "none";
  kind?: MediaKind;
  mode?: WriteMode;
  count?: number;
  name?: string;
  /** ISO time the write started (ledger created_at), shown as "2 min ago". Anything that doesn't parse is left out. */
  started_at?: string;
  privacy_label?: string;
  /** Plain-words reason for a failure (e.g. the TikTokError's card text). */
  reason?: string;
  /** Not shown: ids aren't for people. */
  publish_id?: string;
  /** Clock for "2 min ago"; defaults to now. */
  now?: number;
  /** The video's frame as a small data URI, when the pipeline has one. */
  poster?: string;
  /** A photo post's photos (small JPEG data URIs, carousel order) and its cover's index. */
  thumbs?: string[];
  cover_index?: number;
  /** The video's moving loop (src/preview.ts), when the pipeline has one. */
  motion?: CardMotion;
}

const STATES: Record<StatusCardInput["state"], { label: string; tone: Tone; at?: 0 | 1 | "done"; badge?: IconName }> = {
  staging: { label: "Uploading", tone: "live", at: 0, badge: "up" },
  uploading: { label: "Uploading", tone: "live", at: 0, badge: "up" },
  processing: { label: "Processing", tone: "live", at: 1, badge: "clock" },
  inbox: { label: "In your inbox", tone: "good", at: "done", badge: "check" },
  posted: { label: "Posted", tone: "good", at: "done", badge: "check" },
  failed: { label: "Failed", tone: "bad", badge: "cross" },
  unknown: { label: "Not confirmed", tone: "neutral", badge: "clock" },
  none: { label: "Not found", tone: "neutral" },
};

const FINISH = "Tap the TikTok notification to finish.";

/**
 * One quiet line of facts ("ep01-strawberry-tokens.mp4 · 2 min ago · Only me"). The first item (a file name) gives
 * way first, so the time and privacy after it stay readable.
 */
function metaLine(items: string[]): Maybe<Part> {
  const list = items.map((x) => cleanText(x)).filter(Boolean);
  if (!list.length) return null;
  const [first, ...rest] = list;
  return {
    html: `<div class="tt-meta"><span>${esc(first)}</span>${rest.length ? `<span> · ${esc(rest.join(" · "))}</span>` : ""}</div>`,
    h: 16,
  };
}

export function statusCard(s: StatusCardInput): Widget {
  const st = STATES[s.state] ?? STATES.unknown;
  const now = isNum(s.now) ? s.now : Date.now();
  const t = Date.parse(String(s.started_at ?? ""));
  const started = Number.isFinite(t) ? ago(t, now) : "";
  // "Not found" means there is no post: no picture, type, file, time or mode to describe.
  const found = s.state !== "none";
  const last = s.state === "posted" || (s.state !== "inbox" && s.mode === "direct") ? "Posted" : s.mode === "drafts" || s.state === "inbox" ? "In inbox" : "Done";
  // A note only when it says what to do, or what the user would otherwise miss.
  const note =
    st.tone === "live"
      ? "Can take a few minutes."
      : s.state === "inbox"
        ? FINISH
        : s.state === "posted" && s.mode === "direct"
          ? SHOWS_SOON
          : s.state === "unknown"
            ? new TikTokError("OUTCOME_UNKNOWN").card
            : s.state === "none"
              ? "No recent post from VoiceOS to check."
              : s.state === "failed"
                ? fit(s.reason, 240)
                : "";
  const trailing = !found ? "" : s.mode === "drafts" ? "Drafts" : s.mode === "direct" ? "Direct post" : "";
  const label = `TikTok post status: ${st.label}`;
  if (!found) return render({ trailing, label, parts: [{ html: pillHtml(st.label, st.tone), h: 24 }, para(note, 3)] });

  const photos = s.kind === "photos";
  const n = isNum(s.count) && s.count > 0 ? Math.round(s.count) : 0;
  const src = photos ? undefined : cardImage(s.poster);
  const badge = st.badge ? { tone: st.tone, icon: st.badge } : undefined;
  const mo = photos ? undefined : cardMotion(s.motion);
  const tl = photos
    ? photoStack({
        size: "l", thumbs: s.thumbs, count: s.count, cover: s.cover_index, animate: st.tone !== "bad" && s.state !== "unknown", badge, busy: st.tone === "live", dim: s.state === "failed",
        label: n ? plural(n, "photo") : "Photos",
      })
    : tile({ size: "m", wide: isWide(src), src, kind: "video", badge, busy: st.tone === "live", dim: s.state === "failed", drift: st.tone === "good", ...(mo && s.state !== "failed" ? { motion: mo } : {}) });
  const width = besideWidth(tl);
  // The rail shows progress while it's moving; once done or failed, the badge and the pill say it.
  const rail = st.tone === "live" && st.at !== undefined ? railHtml(st.at, last) : "";
  const meta = metaLine([
    photos ? (n ? plural(n, "photo") : "Photos") : fit(s.name, 64),
    started,
    s.privacy_label ? fit(privacyLabel(cleanText(s.privacy_label)), 24) : "",
  ]);
  const noteP = para(note, 3, width);
  const inner = [pillHtml(st.label, st.tone), rail, meta ? meta.html : "", noteP ? noteP.html : ""].filter(Boolean);
  const innerH = 24 + (rail ? 8 + RAIL_H : 0) + (meta ? 8 + meta.h : 0) + (noteP ? 8 + noteP.h : 0);
  return render({
    trailing,
    label,
    parts: [besideTile(tl, `<div style="display:flex;flex-direction:column;gap:8px;min-width:0">${inner.join("")}</div>`, innerH, "mid")],
  });
}

// ---------------------------------------------------------------------------
// Writes: the completion card of a background write (what the ticket calls a toast)
// ---------------------------------------------------------------------------

export interface WriteResultInput {
  outcome: "inbox" | "posted" | "processing" | "failed" | "unknown" | "refused";
  kind: MediaKind;
  mode: WriteMode;
  /** File basename (video). */
  name?: string;
  /** Photo count. */
  count?: number;
  privacy_label?: string;
  /** The text that was sent (or, for video drafts, handed off): caption, or a photo post's title/description. */
  caption?: string;
  caption_copied?: boolean;
  /** "@maya.makes" or the nickname, for the header. */
  account_label?: string;
  error?: TikTokError;
  /** The video's frame as a small data URI, when the pipeline has one. */
  poster?: string;
  /** A photo post's photos (small JPEG data URIs, carousel order) and its cover's index. */
  thumbs?: string[];
  cover_index?: number;
  /** The video's moving loop (src/preview.ts), when the pipeline has one. */
  motion?: CardMotion;
}

const NOTHING_SENT = "Nothing was sent to TikTok.";

/** The error's card text, plus "Nothing was sent to TikTok." when the detail says so and the card doesn't already. */
function errorBody(e: TikTokError): string {
  const card = e.card;
  return e.detail?.nothing_sent === true && !/nothing was (sent|posted)|nothing reached/i.test(card) ? `${card} ${NOTHING_SENT}` : card;
}

/** A card's one line under its title: the body, minus a "Nothing was sent" the title ("Not sent") already says. */
function lineUnder(title: string, body: string): string {
  if (!/^not sent\b/i.test(title)) return body;
  return body.replace(/\s*Nothing was sent to TikTok\.$/, "").trim() || body;
}

const asError = (e: unknown, fallback: TikTokError): TikTokError => (e instanceof TikTokError ? e : fallback);

/** TikTok asks apps to say a direct post can take a few minutes to process and show on the profile. */
const SHOWS_SOON = "May take a few minutes to show on your profile.";

/**
 * Title, one short line and one spoken sentence (≤ 15 words, facts only) for a finished write (plan §6.5, §6.6,
 * §6.11, §6.12, §8.5). The line is what to do next, or what the user would otherwise miss; the result's JSON
 * carries the rest (caption_copied, privacy, file, count). It's also the result's `message` and, for a failure,
 * the words VoiceOS's task panel prints, so it stays plain sentences.
 */
export function writeOutcomeCopy(r: WriteResultInput): { title: string; body: string; spoken: string } {
  const photos = r.kind === "photos";
  const n = isNum(r.count) && r.count > 0 ? Math.round(r.count) : 0;
  const nPhotos = n === 1 ? "1 photo" : n > 1 ? `${n} photos` : "";
  const privacy = r.privacy_label ? fit(privacyLabel(cleanText(r.privacy_label)), 24) : "";
  const as = privacy ? ` as ${privacy}` : "";
  const subject = photos ? (n === 1 ? "Your photo is" : n > 1 ? `Your ${n} photos are` : "Your photos are") : "Your video is";
  switch (r.outcome) {
    case "inbox":
      return photos
        ? {
            title: `${nPhotos || "Photos"} sent to TikTok drafts`,
            body: FINISH,
            spoken: `${subject} in your TikTok inbox; tap the notification to finish.`,
          }
        : {
            title: "Sent to TikTok drafts",
            body: `${FINISH}${r.caption_copied ? " Your caption is copied." : ""}`,
            spoken: r.caption_copied ? "Your video is in your TikTok inbox, and your caption is copied." : "Your video is in your TikTok inbox; tap the notification to finish.",
          };
    case "posted":
      if (r.mode === "drafts") {
        return { title: photos && nPhotos ? `Posted ${nPhotos} on TikTok` : "Posted on TikTok", body: "Finished in the TikTok app.", spoken: `${subject} up on TikTok.` };
      }
      return {
        title: photos ? `Posted ${nPhotos || "photos"} to TikTok${as}` : `Posted to TikTok${as}`,
        body: SHOWS_SOON,
        spoken: `${subject} posted to TikTok${as}.`,
      };
    case "processing":
      return { title: "TikTok is still processing it", body: "Ask 'did it go up?' in a few minutes.", spoken: "TikTok is still processing it; ask me any time if it went up." };
    case "failed": {
      const e = asError(r.error, new TikTokError("UNKNOWN", {}));
      return { title: e.title, body: errorBody(e), spoken: e.spoken };
    }
    case "unknown": {
      const e = asError(r.error, new TikTokError("OUTCOME_UNKNOWN", {}));
      return { title: e.title, body: errorBody(e), spoken: e.spoken };
    }
    default: {
      const e = asError(r.error, new TikTokError("CONFIRMATION_REQUIRED", { nothing_sent: true }));
      return { title: e.title, body: errorBody(e), spoken: e.spoken };
    }
  }
}

const OUTCOME_LOOK: Record<WriteResultInput["outcome"], { tone: Tone; icon: IconName }> = {
  inbox: { tone: "good", icon: "check" },
  posted: { tone: "good", icon: "check" },
  processing: { tone: "live", icon: "clock" },
  failed: { tone: "bad", icon: "cross" },
  unknown: { tone: "neutral", icon: "clock" },
  refused: { tone: "neutral", icon: "cross" },
};

/**
 * The completion card ("toast"): what went up on the left (the frame, playing, or the photo stack) with the outcome
 * badged on it; on the right one title and one short line. Processing adds the progress rail. The caption, the
 * file name and the privacy stay in the result's JSON: the user just approved them on the confirmation card.
 */
export function writeResultCard(r: WriteResultInput): Widget {
  const copy = writeOutcomeCopy(r);
  const look = OUTCOME_LOOK[r.outcome] ?? OUTCOME_LOOK.unknown;
  const photos = r.kind === "photos";
  const n = isNum(r.count) && r.count > 0 ? Math.round(r.count) : 0;
  const last = r.mode === "direct" ? "Posted" : "In inbox";
  const src = photos ? undefined : cardImage(r.poster);
  const failed = r.outcome === "failed" || r.outcome === "refused";
  const mo = photos || failed ? undefined : cardMotion(r.motion);
  const badge = { tone: look.tone, icon: look.icon };
  // The video plays big once it's in (or on its way): the moment the user sees what went up.
  const tl = photos
    ? photoStack({
        size: "l", thumbs: r.thumbs, count: n, cover: r.cover_index, animate: !failed && r.outcome !== "unknown", badge, busy: r.outcome === "processing", dim: failed,
        label: n ? plural(n, "photo") : "Photos",
      })
    : tile({
        // A landscape frame stays toast-sized beside the words (a lying-down hero would squeeze them).
        size: mo || src ? (isWide(src) ? "l" : "h") : "m", wide: isWide(src), src, kind: "video", badge, busy: r.outcome === "processing", dim: failed, drift: look.tone === "good",
        ...(mo ? { motion: mo } : {}),
      });
  const width = besideWidth(tl);
  const title = fit(copy.title, 60);
  const titleH = lines(title, 15.5, width, 2) * 20;
  // No frame to show which video it was: its name, quietly, instead.
  const named = !photos && !src && !mo ? metaLine([fit(r.name, 64)]) : null;
  const line = para(lineUnder(copy.title, copy.body), 4, width);
  const rail = r.outcome === "processing" ? railHtml(1, last) : "";
  const inner = `<div class="tt-ot tt-c2">${esc(title)}</div>${named ? `<div style="margin-top:2px">${named.html}</div>` : ""}${
    line ? `<div style="margin-top:4px">${line.html}</div>` : ""
  }${rail ? `<div style="margin-top:12px">${rail}</div>` : ""}`;
  const innerH = titleH + (named ? 2 + named.h : 0) + (line ? 4 + line.h : 0) + (rail ? 12 + RAIL_H : 0);
  return render({
    trailing: r.account_label,
    label: copy.title,
    parts: [besideTile(tl, inner, innerH, "mid")],
  });
}

export function errorCard(e: TikTokError): Widget {
  const err = asError(e, new TikTokError("UNKNOWN", { message: cleanText((e as { message?: unknown })?.message) }));
  // Colour carries state: an unknown outcome or a refusal (nothing happened) isn't a failure.
  const pending = err.code === "OUTCOME_UNKNOWN" || err.code === "TIMEOUT";
  const refused = err.code === "CONFIRMATION_REQUIRED" || err.code === "CANCELLED";
  return render({
    label: err.title,
    parts: [alert(err.title, lineUnder(err.title, errorBody(err)), pending || refused ? "neutral" : "bad", pending ? "clock" : "cross", 4)],
  });
}

// ---------------------------------------------------------------------------
// Agent-only helpers (small and factual)
// ---------------------------------------------------------------------------

const deniedNote = (folders: unknown) =>
  Array.isArray(folders) && folders.length
    ? `Can't see ${folders.map((f) => cleanText(f)).filter(Boolean).join(", ")}. Allow VoiceOS in System Settings → Privacy & Security → Files and Folders.`
    : "";
const NO_MATCH = "No name matched; newest first.";
/** The lead video plus three compact rows fit the notch with a footnote. */
const VIDEO_ROWS = 4;
const SMALL_ROW = 48;

interface PlainRow {
  title: string;
  subtitle?: string;
  trailing?: string;
  media: string;
}

function plainRows(items: PlainRow[], rule = false): Part {
  const html = items
    .map(
      (r) =>
        `<div class="tt-row">${r.media}<div class="tt-row-m"><div class="tt-row-t">${esc(fit(r.title, 80))}</div>${
          r.subtitle ? `<div class="tt-row-s">${esc(fit(r.subtitle, 80))}</div>` : ""
        }</div>${r.trailing ? `<div class="tt-row-tr"><span>${esc(fit(r.trailing, 16))}</span></div>` : ""}</div>`,
    )
    .join("");
  const n = items.length;
  const h = n * SMALL_ROW + Math.max(0, n - 1) * (2 * ROW_PAD + 1) + (rule && n ? ROW_PAD + 1 : 0);
  return { html: `<div class="tt-list${rule ? " tt-rule" : ""}">${html}</div>`, h };
}

// The described-video card (find_recent_videos with a confidence): numbered posters the user can name ("the
// second one"), each with its few distinguishing facts, the clear match ringed in TikTok red, and for a
// toss-up the one question the agent asks, right above the choices.

interface PickVideo {
  name: string;
  folder: string;
  duration_label?: string;
  size_label: string;
  added_label: string;
  width?: number;
  height?: number;
  poster?: string;
  number?: number;
  chips?: string[];
  best?: boolean;
  in_progress?: boolean;
  /** The lead video's moving loop (src/preview.ts): it plays big on the card. */
  motion?: unknown;
}

const PICK_CSS = `
.tt-pk{display:grid;gap:10px 8px;min-width:0}
.tt-pk-c{min-width:0;display:flex;flex-direction:column;align-items:center;gap:6px}
.tt-pk-f{position:relative;display:block;overflow:hidden;isolation:isolate;border-radius:11px;background:linear-gradient(158deg,#3b3b45 0%,#202027 52%,#121215 100%)}
html[data-k-theme=light] .tt-pk-f{background:linear-gradient(158deg,#dedee4 0%,#c9c9d1 100%)}
.tt-pk-f::after{content:"";position:absolute;inset:0;z-index:4;border-radius:inherit;pointer-events:none;box-shadow:inset 0 0 0 1px rgba(255,255,255,.08)}
html[data-k-theme=light] .tt-pk-f::after{box-shadow:inset 0 0 0 1px rgba(0,0,0,.08)}
.tt-pk-f.is-best{outline:2px solid var(--accent);outline-offset:2px}
.tt-pk-f .tt-m-i.is-fit{object-fit:contain}
.tt-pk-n{position:absolute;left:6px;top:6px;z-index:3;min-width:20px;height:20px;padding:0 6px;border-radius:999px;display:flex;align-items:center;justify-content:center;font-size:11.5px;font-weight:700;color:#fff;background:rgba(0,0,0,.55);font-variant-numeric:tabular-nums;box-shadow:0 1px 4px rgba(0,0,0,.3)}
.tt-pk-f.is-best .tt-pk-n{background:var(--accent)}
.tt-pk-t{width:100%;text-align:center;font-size:12px;font-weight:620;letter-spacing:-.005em;line-height:16px;color:var(--ink-1);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tt-pk-s{width:100%;text-align:center;font-size:11px;line-height:14px;color:var(--ink-3);overflow:hidden;display:-webkit-box;-webkit-box-orient:vertical;overflow-wrap:anywhere}
.tt-pk-s.l1{-webkit-line-clamp:1;white-space:nowrap;text-overflow:ellipsis;display:block}
.tt-pk-s.l2{-webkit-line-clamp:2}
.tt-pk-p{display:inline-block;margin-top:-1px;padding:0 6px;border-radius:999px;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;line-height:16px;color:#fff;background:var(--accent)}
.tt-pk-q{display:flex;gap:8px;align-items:flex-start;font-size:13px;font-weight:600;line-height:18px;color:var(--ink-1);min-width:0}
.tt-pk-q svg{width:15px;height:15px;flex:none;margin-top:1.5px;color:var(--accent)}
.tt-pk-q span{min-width:0;overflow-wrap:anywhere}
.tt-pk-chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px;min-width:0}
.tt-pk-chips .tt-chip{max-width:100%;overflow:hidden;text-overflow:ellipsis}
.tt-pk-chips .tt-chip.is-acc{color:#fff;background:var(--accent);box-shadow:none}
`;

/** Lead layout for one video: big poster, eyebrow, name, fact chips. */
function pickLead(v: PickVideo, src: string | undefined, eyebrow: string, best: boolean): Part {
  const mo = cardMotion(v.motion);
  const lt = tile({
    size: mo ? "h" : "l", wide: isWide(src, v.width, v.height), src, kind: "video", pill: cleanText(v.duration_label), drift: true, top: best && !mo,
    ...(mo ? { motion: mo } : {}), label: fit(v.name, 48),
  });
  const lw = besideWidth(lt);
  const name = fit(v.name, 80);
  const chipList = (Array.isArray(v.chips) ? v.chips : []).map((x) => fit(x, 34)).filter(Boolean).slice(0, 4);
  if (v.in_progress) chipList.unshift("in progress");
  // Chip rows: each chip is its text plus 16 px padding, 5 px apart.
  let rows = chipList.length ? 1 : 0;
  let used = 0;
  for (const ch of chipList) {
    const w = Math.ceil(textEms(ch) * 11) + 16;
    if (used && used + 5 + w > lw) {
      rows++;
      used = w;
    } else used += (used ? 5 : 0) + w;
  }
  rows = Math.min(rows, 2);
  const chipsHtml = chipList.length
    ? `<div class="tt-pk-chips" style="max-height:${rows * 20 + (rows - 1) * 5}px;overflow:hidden">${chipList
        .map((ch, i) => `<span class="tt-chip${v.in_progress && i === 0 ? " is-acc" : ""}">${esc(ch)}</span>`)
        .join("")}</div>`
    : "";
  const where = cleanText(v.folder).split("/").filter(Boolean).join(" › ");
  const inner = `<div class="tt-eb">${esc(eyebrow)}</div><div class="tt-h tt-c2" style="margin-top:3px">${esc(name)}</div>${
    where ? `<div class="tt-row-s" style="margin-top:3px">${esc(where)}</div>` : ""
  }${chipsHtml}`;
  const innerH = 14 + 3 + lines(name, 14.5, lw, 2) * 19 + (where ? 18 : 0) + (rows ? 7 + rows * 20 + (rows - 1) * 5 : 0);
  return { ...besideTile(lt, inner, innerH, "mid"), css: PICK_CSS };
}

/** The numbered gallery: 2–4 in a row, 5–6 as two rows of three. */
/**
 * One gallery cell's picture box for n videos (2-4 in a row, 5-6 as two rows of three), in CSS px: 3:4 when most
 * are vertical, 16:9 when most are landscape. `chars` is what one cell's loop may cost so every cell's loop fits the
 * card's picture budget together (src/preview.ts sizes a gallery's loops and posters from this, at twice the box).
 */
export function galleryCell(n: number, vertical: boolean): { w: number; h: number; chars: number; cols: number; rows: number } {
  const k = Math.max(2, Math.min(6, Math.floor(isNum(n) ? n : 2)));
  const cols = k <= 4 ? k : 3;
  const rows = Math.ceil(k / cols);
  const cellW = (COL - 8 * (cols - 1)) / cols;
  const tall = rows > 1 ? 92 : cols <= 2 ? 150 : cols === 3 ? 136 : 124;
  const w = Math.floor(Math.min(cellW, vertical ? tall * 0.75 : tall * 1.78));
  const h = vertical ? tall : Math.round(Math.min(tall, w / 1.78));
  return { w, h, chars: Math.floor((CARD_IMAGE_BUDGET - 4_000) / k), cols, rows };
}

function pickGallery(list: PickVideo[], images: Images): Part {
  const n = list.length;
  const vertical = list.filter((v) => !isWide(undefined, v.width, v.height)).length >= list.filter((v) => isWide(undefined, v.width, v.height)).length;
  // Most are vertical: 3:4 boxes; most are landscape: 16:9 boxes. A video of the other shape fits inside its box.
  const { w: boxW, h: boxH, cols, rows: rowsN } = galleryCell(n, vertical);
  const subLines = rowsN > 1 ? 1 : 2;
  // Names that share a long beginning ("Screen Recording 2026-10-21 at …") show where they differ.
  const names = list.map((v) => cleanText(v.name));
  let common = 0;
  while (names.length > 1 && names.every((x) => x.length > common && x[common] === names[0][common])) common++;
  const shownName = (x: string) => (common > 14 && x.length - common >= 3 ? `…${x.slice(Math.max(0, common - 4)).trim()}` : x);
  // Every cell gets its poster first; then, in order, a cell's small loop (an AVIF or WebP: a filmstrip needs a box of
  // its own shape) takes the poster's place while the budget allows, so no cell is ever left blank.
  const posters = list.map((v) => images(v.poster));
  const shownSrc = list.map((v, i) => {
    const mo = cardMotion(v.motion);
    if (!mo || mo.frames) return posters[i];
    images.refund?.(posters[i]?.length ?? 0);
    const loop = images(mo.src, MAX_MOTION_CHARS);
    if (loop) return loop;
    return posters[i] ? images(posters[i]) : undefined;
  });
  const cells = list
    .map((v, i) => {
      const src = shownSrc[i];
      const wide = isWide(src, v.width, v.height);
      const num = typeof v.number === "number" && v.number > 0 ? Math.round(v.number) : i + 1;
      const fitCls = wide === !vertical ? "" : " is-fit";
      const pill = fit(cleanText(v.duration_label), 10);
      const facts = (Array.isArray(v.chips) ? v.chips : []).map((x) => cleanText(x)).filter(Boolean);
      const sub = fit(facts.slice(0, 3).join(" · ") || [cleanText(v.added_label), cleanText(v.folder)].filter(Boolean).join(" · "), 90);
      const tag = v.in_progress ? '<span class="tt-pk-p">in progress</span> ' : "";
      return `<div class="tt-pk-c"><span class="tt-pk-f${v.best ? " is-best" : ""}" style="width:${boxW}px;height:${boxH}px" aria-hidden="true"><span class="tt-m-g">${PLAY_G}</span>${
        src ? `<img class="tt-m-i${fitCls}" src="${esc(src)}" alt="">` : ""
      }<span class="tt-pk-n">${num}</span>${pill ? `<span class="tt-m-d">${esc(pill)}</span>` : ""}</span><div class="tt-pk-t">${esc(fit(shownName(names[i]), 60))}</div>${
        sub || tag ? `<div class="tt-pk-s l${subLines}">${tag}${esc(sub)}</div>` : ""
      }</div>`;
    })
    .join("");
  const cellH = boxH + 6 + 16 + 6 + subLines * 14;
  return {
    html: `<div class="tt-pk" style="grid-template-columns:repeat(${cols},minmax(0,1fr))" role="list" aria-label="${esc(`${n} videos, numbered 1 to ${n}`)}">${cells}</div>`,
    h: rowsN * cellH + (rowsN - 1) * 10,
    css: PICK_CSS,
  };
}

function pickQuestion(text: string): Maybe<Part> {
  const t = fit(text, 220);
  if (!t) return null;
  return { html: `<div class="tt-pk-q">${icon("search")}<span class="tt-c3">${esc(t)}</span></div>`, h: lines(t, 13, COL - 23, 3) * 18, css: PICK_CSS };
}

function videoPickCard(c: {
  videos: PickVideo[];
  denied_folders: string[];
  note?: string;
  confidence: "exact" | "likely" | "ambiguous" | "none";
  question?: string;
  headline?: string;
  revealed?: boolean;
}): Widget {
  const videos = (Array.isArray(c.videos) ? c.videos : []).slice(0, 6);
  const denied = deniedNote(c.denied_folders);
  const label = "Videos on this computer";
  if (!videos.length) {
    return render({
      trailing: "Videos",
      label,
      parts: [headline(fit(c.headline, 80) || "No matching video", 2), para(`Describe it, say its name, or select it in ${process.platform === "win32" ? "File Explorer" : "Finder"}.`, 2), foot(denied)],
    });
  }
  // The lead's loop and the posters share the card's picture budget, so the card never crosses VoiceOS's cap
  // (in the gallery each cell's loop is drawn through the budget itself).
  const images = imageBudget(CARD_IMAGE_BUDGET - (videos.length === 1 ? (cardMotion(videos[0]?.motion)?.src.length ?? 0) : 0));
  const found = fit(c.note, 160);
  const foot1 = [c.revealed ? `Shown in ${process.platform === "win32" ? "File Explorer" : "Finder"}.` : "", denied].filter(Boolean).join(" ");
  if (videos.length === 1) {
    const v = videos[0];
    // One video that fits the words is simply found; "Best match" only means something next to other candidates.
    const eyebrow = v.in_progress ? "In progress" : c.confidence === "none" ? "Closest" : "Found it";
    return render({
      trailing: c.confidence === "none" ? "Closest" : "1 video",
      label,
      parts: [c.confidence === "none" ? headline(fit(c.headline, 80) || "No exact match", 2, true) : info(found), pickLead(v, images(v.poster), eyebrow, c.confidence !== "none"), foot(foot1)],
    });
  }
  const top =
    c.confidence === "ambiguous"
      ? pickQuestion(c.question || "Which one? Say its number.")
      : c.confidence === "none"
        ? headline(fit(c.headline, 80) || "No exact match", 2, true)
        : info(found || (c.confidence === "likely" ? "Best match first." : ""));
  const trailing = c.confidence === "ambiguous" ? "Which one?" : `${videos.length} videos`;
  let list = videos;
  for (;;) {
    const parts = [top, pickGallery(list, images), foot(foot1)];
    const h = PAD + HEADER + parts.reduce((sum, p) => sum + (p ? GAP + p.h : 0), 0);
    if (h <= 420 || list.length <= 2) return render({ trailing, label, parts });
    list = list.slice(0, -1);
  }
}

export function videoCandidatesCard(c: {
  /** width/height (optional) pick the tile's shape when there's no frame: landscape videos get a wide tile. */
  videos: Array<PickVideo>;
  query_matched: boolean;
  denied_folders: string[];
  /** Where the match was found or how close it is ("Not in Downloads. Found it in Movies › Tiny AI Lab."), shown above the videos. */
  note?: string;
  /** With a confidence (a described search): the numbered layout below; without, the original list. */
  confidence?: "exact" | "likely" | "ambiguous" | "none";
  question?: string;
  headline?: string;
  revealed?: boolean;
}): Widget {
  if (c?.confidence) return videoPickCard({ ...c, confidence: c.confidence });
  const videos = Array.isArray(c?.videos) ? c.videos : [];
  const denied = deniedNote(c?.denied_folders);
  if (!videos.length) {
    return render({
      trailing: "Recent videos",
      label: "Recent videos on this computer",
      parts: [headline("No recent videos", 1), para("None in Downloads, Desktop or Movies. Say its name, or export it first.", 2), foot(denied)],
    });
  }
  const images = imageBudget(CARD_IMAGE_BUDGET - (cardMotion(videos[0]?.motion)?.src.length ?? 0));
  const shown = videos.slice(0, VIDEO_ROWS);

  // The newest (or best-matching) video leads, with a big poster.
  const lead = shown[0];
  const leadSrc = images(lead.poster);
  const leadMo = cardMotion(lead.motion);
  const lt = tile({
    size: leadMo ? "h" : "l", wide: isWide(leadSrc, lead.width, lead.height), src: leadSrc, kind: "video", pill: cleanText(lead.duration_label), drift: true,
    ...(leadMo ? { motion: leadMo } : {}), label: fit(lead.name, 48),
  });
  const lw = besideWidth(lt);
  const name = fit(lead.name, 80);
  // Length is on the tile's pill and the shape is the tile's own; the line says where and when.
  const where = [cleanText(lead.folder), cleanText(lead.added_label)].filter(Boolean).join(" · ");
  const found = fit(c.note, 160);
  const eyebrow = found ? "Best match" : c.query_matched === false || videos.length > 1 ? "Newest" : "Found";
  const leadInner = `<div class="tt-eb">${eyebrow}</div><div class="tt-h tt-c2" style="margin-top:3px">${esc(name)}</div>${
    where ? `<div class="tt-row-s" style="margin-top:4px">${esc(where)}</div>` : ""
  }`;
  const leadH = 14 + 3 + lines(name, 14.5, lw, 2) * 19 + (where ? 19 : 0);

  const rest = shown.slice(1).map((v): PlainRow => {
    const src = images(v.poster);
    const t = tile({ size: "xs", wide: isWide(src, v.width, v.height), src, kind: "video" });
    return {
      title: v.name,
      subtitle: [cleanText(v.folder), cleanText(v.added_label)].filter(Boolean).join(" · "),
      trailing: v.duration_label,
      media: `<span class="tt-slot">${t.html}</span>`,
    };
  });
  const leadPart = besideTile(lt, leadInner, leadH, "mid");
  // A long footnote (denied folders) costs rows: drop compact rows until the card fits the notch.
  let rows = rest;
  for (;;) {
    const count = 1 + rows.length;
    const note = [videos.length > count ? `Showing ${count} of ${videos.length}.` : "", c.query_matched === false ? NO_MATCH : "", denied].filter(Boolean).join(" ");
    const parts = [info(found), leadPart, rows.length > 0 && plainRows(rows, true), foot(note)];
    const h = PAD + HEADER + parts.reduce((sum, p) => sum + (p ? GAP + p.h : 0), 0);
    if (h <= 420 || !rows.length) {
      return render({ trailing: videos.length === 1 ? "1 video" : `${videos.length} videos`, label: "Recent videos on this computer", parts });
    }
    rows = rows.slice(0, -1);
  }
}

export function imageCandidatesCard(c: {
  images: Array<{ name: string; folder: string; added_label: string; dims?: string; thumb?: string }>;
  batch_hint?: string;
  total: number;
  query_matched: boolean;
  denied_folders: string[];
}): Widget {
  const images = Array.isArray(c?.images) ? c.images : [];
  const denied = deniedNote(c?.denied_folders);
  if (!images.length) {
    return render({
      trailing: "Recent photos",
      label: "Recent photos on this computer",
      parts: [
        headline("No recent photos", 1),
        para("None in Downloads, Desktop, Pictures or Screenshots. AirDrop or export them, then ask again.", 2),
        foot(denied),
      ],
    });
  }
  const budget = imageBudget();
  const hint = fit(c.batch_hint, 60);
  const max = hint ? 5 : 6;
  const total = Math.max(isNum(c.total) ? Math.round(c.total) : 0, images.length);
  const shown = Math.min(max, images.length);
  const note = [total > shown ? `Showing ${shown} of ${total}.` : "", c.query_matched === false ? NO_MATCH : "", denied].filter(Boolean).join(" ");
  return render({
    trailing: total === 1 ? "1 photo" : `${total} photos`,
    label: "Recent photos on this computer",
    parts: [
      hint && headline(hint, 1),
      plainRows(
        images.slice(0, max).map((i): PlainRow => {
          const src = budget(i.thumb);
          const t = `<span class="tt-slot"><span class="tt-m z-ph${src ? " has-i" : ""}" aria-hidden="true"><span class="tt-m-g">${PHOTO_G}</span>${
            src ? `<img class="tt-m-i" src="${esc(src)}" alt="">` : ""
          }</span></span>`;
          return { title: i.name, subtitle: [cleanText(i.folder), cleanText(i.added_label)].filter(Boolean).join(" · "), media: t };
        }),
      ),
      foot(note),
    ],
  });
}

/**
 * The order line for a carousel, as people read it. Names that are only numbers ("1 01 · 2 02 · …", exported
 * slides) say nothing the stack doesn't: "11 slides, in order". Otherwise the line as prepare_photo_post wrote it.
 */
export function orderText(order: unknown, count?: number): string {
  const text = fit(order, 400);
  if (!text) return "";
  const items = text.split(/\s+·\s+/).map((x) => x.replace(/\s*…\s*$/, "").trim()).filter(Boolean);
  const names = items.map((x) => x.replace(/^\d+\s+/, ""));
  const n = isNum(count) && count > 0 ? Math.round(count) : items.length;
  if (items.length > 1 && names.every((x) => /^\d+$/.test(x))) return `${n} slides, in order`;
  // Names that carry their own numbers ("01 meet the cast") read "01 meet the cast", not "1 01 meet the cast".
  if (items.length > 1 && names.every((x) => /^\d+[\s._-]/.test(x))) {
    return clipText(names.join(" · ") + (/…\s*$/.test(text) ? " …" : ""), 200);
  }
  return clipText(text, 200);
}

/** "Posting as" with the account's picture (or its monogram): one quiet line beside the media. */
function postingAs(name: string, avatar?: string): string {
  const mono = initials(name);
  const pic = avatar ? `<img class="tt-av-i" src="${esc(avatar)}" alt="">` : "";
  return `<div class="tt-pa"><span class="tt-av z-xs" aria-hidden="true">${mono ? esc(mono) : icon("person")}${pic}</span><span class="tt-pa-t">Posting as <b>${esc(name)}</b></span></div>`;
}

const BUNDLE_CSS = `.tt-pa{display:flex;align-items:center;gap:8px;min-width:0;font-size:12px;line-height:16px;color:var(--ink-3)}
.tt-pa b{font-weight:620;color:var(--ink-1)}
.tt-pa-t{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tt-av.z-xs{width:24px;height:24px;font-size:9.5px}`;

export function bundleCard(b: {
  count_label: string;
  order_label: string;
  warning?: string;
  /** The post's photo count and cover index, when known (they make the title and the stack's labels). */
  count?: number;
  cover_index?: number;
  /** Every photo's thumbnail, carousel order (the stack). */
  thumbs?: string[];
}): Widget {
  const n = isNum(b?.count) && b.count > 0 ? Math.round(b.count) : 0;
  const cover = isNum(b?.cover_index) && b.cover_index >= 0 ? Math.round(b.cover_index) : undefined;
  const head = n ? plural(n, "photo") : fit(b?.count_label, 60) || "Photo carousel";
  const sub = n > 1 && cover !== undefined ? `Cover: photo ${cover + 1}` : "";
  const order = orderText(b?.order_label, n);
  const st = photoStack({ size: "xl", thumbs: b?.thumbs, count: n || undefined, cover, label: head });
  const width = besideWidth(st);
  const inner =
    `<div class="tt-h tt-1">${esc(head)}</div>` +
    (sub ? `<div class="tt-row-s" style="margin-top:2px">${esc(sub)}</div>` : "") +
    (order ? `<p class="tt-p tt-c3" style="margin-top:8px">${esc(order)}</p>` : "");
  const innerH = 19 + (sub ? 17 : 0) + (order ? 8 + lines(order, 12.5, width, 3) * 18 : 0);
  return render({
    trailing: "Photo carousel",
    label: "TikTok photo carousel",
    parts: [besideTile(st, inner, innerH, "mid"), warning(b?.warning ?? "")],
  });
}

export function creatorCard(c: {
  creator_nickname: string;
  privacy_labels: string[];
  can_post: boolean;
  duration_ok?: boolean;
  max_duration_label?: string;
  /** The creator's picture as a small data URI, when the pipeline has one. */
  avatar_data?: string;
  /** What's about to be posted, so this card is the moment the user sees it: the video (playing) or the photos (stacked). */
  kind?: MediaKind;
  file_name?: string;
  duration_label?: string;
  width?: number;
  height?: number;
  poster?: string;
  motion?: CardMotion;
  thumbs?: string[];
  count?: number;
  cover_index?: number;
}): Widget {
  const who = (Array.isArray(c?.privacy_labels) ? c.privacy_labels : []).map((l) => privacyLabel(cleanText(l))).filter(Boolean).join(", ");
  const cannot = new TikTokError("CREATOR_CANNOT_POST");
  const name = fit(c?.creator_nickname, 60) || "Your TikTok";
  const avatar = cardImage(c?.avatar_data);
  const longest = fit(c?.max_duration_label, 24);
  const after = [
    c?.can_post === false ? alert(cannot.title, cannot.card, "bad", "cross", 2) : null,
    c?.duration_ok === false
      ? warning(`Longer than your account allows${longest ? ` (${longest})` : ""}. Send it to drafts and trim it in TikTok.`)
      : null,
  ];
  if (c?.kind === "video" || c?.kind === "photos") {
    // "Here's what you're posting": the media leads; its name and the account beside it. Who can view and the
    // rest are picked on the confirmation card next, so only a single choice (it's set) is worth a word here.
    const photos = c.kind === "photos";
    const n = isNum(c.count) && c.count > 0 ? Math.round(c.count) : 0;
    const images = imageBudget(60_000);
    const src = photos ? undefined : images(c.poster);
    const mo = photos ? undefined : cardMotion(c.motion);
    const wide = !photos && isWide(src, c.width, c.height);
    // A landscape frame runs across the card, the words below it; anything else (a landscape video without a frame
    // too: its named tile) stands beside them.
    const across = wide && Boolean(src || mo);
    const media = photos
      ? photoStack({ size: "xl", thumbs: c.thumbs, count: n || undefined, cover: c.cover_index, label: n ? plural(n, "photo") : "Photos" })
      : tile({
          size: across ? "f" : wide ? "xl" : "h", wide, src, kind: "video", pill: cleanText(c.duration_label), ...(mo ? { motion: mo } : {}),
          // A wide tile is too short for the name under its glyph; the title beside it says it.
          ...(wide ? {} : { label: fit(c.file_name, 48) }),
        });
    const width = across ? COL : besideWidth(media);
    const title = photos ? (n ? plural(n, "photo") : "Photo carousel") : fit(c.file_name, 80) || "Your video";
    const cover = isNum(c.cover_index) ? Math.round(c.cover_index) : 0;
    const options = (Array.isArray(c.privacy_labels) ? c.privacy_labels : []).map((l) => privacyLabel(cleanText(l))).filter(Boolean);
    const sub = [photos && n > 1 && cover > 0 ? `Cover: photo ${cover + 1}` : "", options.length === 1 ? `Who can view: ${fit(options[0], 24)}` : ""].filter(Boolean).join(" · ");
    const inner =
      `<div class="tt-h tt-c2">${esc(title)}</div>` +
      (sub ? `<div class="tt-row-s" style="margin-top:3px">${esc(sub)}</div>` : "") +
      `<div style="margin-top:10px">${postingAs(name, avatar)}</div>`;
    const innerH = lines(title, 14.5, width, 2) * 19 + (sub ? 18 : 0) + 10 + 24;
    const part = across
      ? { html: `<div style="display:flex;flex-direction:column;gap:12px;min-width:0">${media.html}<div>${inner}</div></div>`, h: media.h + 12 + innerH }
      : besideTile(media, inner, innerH, "mid");
    return render({ trailing: "Ready to post", label: "TikTok posting options", parts: [{ ...part, css: `${part.css ?? ""}${BUNDLE_CSS}` }, ...after] });
  }
  return render({
    trailing: "Posting as",
    label: "TikTok posting options",
    parts: [
      identity(name, { small: true, avatar }),
      facts([["Who can view", who || "—"], longest && ["Longest video", longest]], true),
      ...after,
    ],
  });
}

// ---------------------------------------------------------------------------
// Sends from VoiceOS (owned by the status agent): the ledger's sends, for fetch_publish_status's lists and
// list_videos' second section. TikTok's list leaves out Only me posts and drafts, so these rows are how the
// user sees what they sent from the Mac.
// ---------------------------------------------------------------------------

export interface SendRow {
  /** The file's name without its extension, or the photos' folder ("voice clone safety slides"). */
  title: string;
  kind: MediaKind;
  mode?: WriteMode;
  count?: number;
  duration_sec?: number;
  /** ISO time it was sent. */
  started_at?: string;
  /** "Only me", "In drafts", "Processing", "Didn't finish", "Failed", "Not sent", … */
  mark: string;
  /** stalled: TikTok still hadn't finished it hours later (it stopped fetching), so it isn't shown as in progress. */
  state: "posted" | "inbox" | "processing" | "uploading" | "stalled" | "failed" | "unknown";
  /** The video's frame or the carousel's cover, as small data URIs the write kept in memory (pictures only). */
  poster?: string;
  thumb?: string;
}

const SEND_TONE: Record<SendRow["state"], Tone> = { posted: "good", inbox: "good", processing: "live", uploading: "live", stalled: "neutral", failed: "bad", unknown: "neutral" };
const SEND_ROWS = 4;
const SEND_ROW_H = 48;
const SEND_EYEBROW_H = 20;

/** Up to `max` sends as compact rows (picture, name, what · when, state pill), under an optional eyebrow. */
function sendRowsPart(rows: SendRow[], now: number, max: number, o: { eyebrow?: string; quiet?: boolean; rule?: boolean } = {}): Part {
  const images = imageBudget(90_000);
  const shown = rows.slice(0, Math.max(0, max));
  const html = shown
    .map((r) => {
      const photos = r.kind === "photos";
      const src = images(photos ? r.thumb : r.poster);
      const t = tile({ size: "xs", wide: !photos && isWide(src), src, kind: photos ? "photo" : "video", dim: r.state === "failed" });
      const at = Date.parse(String(r.started_at ?? ""));
      const n = isNum(r.count) ? Math.round(r.count) : 0;
      const what = photos ? (n > 1 ? `${n} photos` : "Photo") : isNum(r.duration_sec) && r.duration_sec > 0 ? `Video · ${duration(r.duration_sec)}` : "Video";
      const sub = [what, r.mode === "drafts" ? "Draft" : "", Number.isFinite(at) ? agoShort(at, now) : ""].filter(Boolean).join(" · ");
      const title = fit(r.title, 80) || (photos ? "Photo post" : "Video");
      return `<div class="tt-row"><span class="tt-slot">${t.html}</span><div class="tt-row-m"><div class="tt-row-t">${esc(title)}</div>${
        sub ? `<div class="tt-row-s">${esc(fit(sub, 80))}</div>` : ""
      }</div><div class="tt-row-tr">${pillHtml(r.mark, SEND_TONE[r.state] ?? "neutral")}</div></div>`;
    })
    .join("");
  const k = shown.length;
  const eyebrow = fit(o.eyebrow, 40);
  const rule = o.rule ? 9 : 0;
  const h = rule + (eyebrow ? SEND_EYEBROW_H : 0) + k * SEND_ROW_H + Math.max(0, k - 1) * (2 * ROW_PAD + 1);
  return {
    html: `<div${o.rule ? ' style="border-top:1px solid var(--line);padding-top:8px"' : ""}>${eyebrow ? `<div class="tt-eb${o.quiet ? " q" : ""}" style="margin-bottom:6px">${esc(eyebrow)}</div>` : ""}<div class="tt-list">${html}</div></div>`,
    h,
  };
}

/** fetch_publish_status's answer when the words fit several sends ("today's posts", the same video twice). */
export function sendsCard(rows: SendRow[], now: number = Date.now(), o: { headline?: string; trailing?: string; note?: string } = {}): Widget {
  const list = Array.isArray(rows) ? rows : [];
  const more = list.length > SEND_ROWS ? `Showing ${SEND_ROWS} of ${list.length}` : "";
  return render({
    trailing: o.trailing,
    label: "TikTok sends from VoiceOS",
    parts: [
      o.headline ? headline(fit(o.headline, 80), 1) : null,
      list.length ? sendRowsPart(list, now, SEND_ROWS) : para("Nothing sent yet.", 2),
      foot([more, fit(o.note, 120)].filter(Boolean).join(" · ")),
    ],
  });
}

/** list_videos with what VoiceOS sent: the public posts (fewer rows), then the sends, inside the notch. */
function listWithSends(videos: VideoSummary[], hasMore: boolean, sends: SendRow[], now: number, covers: Record<string, string> | undefined): Widget {
  const label = "Your recent TikTok posts";
  if (!videos.length) {
    const more = sends.length > SEND_ROWS ? `Showing ${SEND_ROWS} of ${sends.length}` : "";
    return render({
      label,
      parts: [headline("No public posts yet", 1), sendRowsPart(sends, now, SEND_ROWS, { eyebrow: "Private and drafts", quiet: true }), foot(more)],
    });
  }
  // Posts TikTok already lists publicly aren't repeated below them.
  const extra = sends.filter((s) => !(s.state === "posted" && s.mark !== "Only me"));
  if (!extra.length) return postsCard(videos, now, covers, { trailing: `Last ${videos.length} public posts`, label, more: hasMore });
  const images = imageBudget();
  const pub = Math.min(videos.length, 2);
  const note = [videos.length > pub ? `Showing ${pub} of ${videos.length} public` : "", hasMore ? "older posts available" : ""].filter(Boolean).join(" · ");
  const head = [overview(videos), postRows(videos, now, pub, covers, images)];
  const tail = foot(note);
  const fixed = PAD + HEADER + head.reduce((s, p) => s + GAP + p.h, 0) + (tail ? GAP + tail.h : 0) + GAP;
  let rows = 3;
  while (rows > 1 && fixed + sendRowsPart(extra, now, rows, { eyebrow: "Private and drafts", quiet: true, rule: true }).h > 420) rows--;
  return render({
    trailing: `Last ${videos.length} public posts`,
    label,
    parts: [...head, sendRowsPart(extra, now, rows, { eyebrow: "Private and drafts", quiet: true, rule: true }), tail],
    script: ACCORDION_JS,
  });
}
