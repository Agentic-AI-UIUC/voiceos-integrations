/**
 * From a video's metadata to plain facts ("vertical", "0:37", "AirDropped from iPhone 15 Pro", "made in Final
 * Cut Pro"), checking those facts against a parsed description (src/finderParse.ts), ranking, and deciding how
 * sure the answer is:
 *   exact     one video fits everything said (or the user named a position, a superlative, the selection…)
 *   likely    several fit, one clearly best (or nothing was described: the newest)
 *   ambiguous several fit equally: ask ONE short question that names the difference
 *   none      nothing fits everything: say what's missing, show the closest
 * Also the one-line descriptor per video and that question. Pure functions; `now` is injected.
 */
import { APPS, SITES, described, type Describe, type Orientation, type SourceKind } from "./finderParse.ts";
import { queryOf, scoreName } from "./finderText.ts";
import type { VideoDetailsInfo } from "./media.ts";
import type { FileFacts } from "./spotlight.ts";

export type Confidence = "exact" | "likely" | "ambiguous" | "none";

export interface Facts {
  name: string;
  /** Display folder: "Downloads", "Movies/Tiny AI Lab". */
  folder: string;
  size: number;
  addedMs: number;
  createdMs?: number;
  duration_sec?: number;
  width?: number;
  height?: number;
  has_audio?: boolean;
  title?: string;
  comment?: string;
  tags?: string[];
  finder_comment?: string;
  /** Where-from hosts, without "www.". */
  hosts: string[];
  orientation?: Orientation;
  /** "4K", "1080p", "720p". */
  quality?: string;
  sources: Set<SourceKind>;
  sites: Set<string>;
  apps: Set<string>;
  /** "iPhone 15 Pro", "Sony ILCE-7M4". */
  device?: string;
  /** "screen recording", "AirDropped from iPhone 15 Pro", "downloaded from youtube.com", "made in Final Cut Pro". */
  sourceLabel?: string;
  /** Whether Spotlight/quarantine facts were available (else "downloaded"/"AirDropped"/apps are unknown, not "no"). */
  metaOk: boolean;
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

const SCREEN_NAME =
  /^(?:screen ?recording|screen ?shot video|screenrecording|rpreplay|cleanshot|bildschirmaufnahme|enregistrement de l.écran|grabación de pantalla|gravação de tela|gravação do ecrã|registrazione schermo|schermopname|skärminspelning|skjermopptak|skærmoptagelse|nagranie ekranu|запись экрана|画面収録|屏幕录制|螢幕錄影|화면 기록|ekran kaydı)/i;
const IOS_SCREEN = /^(?:rpreplay|screenrecording_)/i;
const PHONE_MODEL = /\b(?:iphone|ipad|pixel|galaxy|oneplus|xiaomi|redmi|huawei|oppo|vivo|motorola|moto [a-z]|nokia|nothing phone)\b|^sm-[a-z]\d/i;
const PHONE_MAKE = /^(?:apple|samsung|google|oneplus|xiaomi|huawei|oppo|vivo|motorola|lge|nothing|honor|realme)$/i;
const CAMERA_MAKE = /^(?:canon|sony|nikon|fujifilm|fuji|panasonic|gopro|dji|insta360|blackmagic|olympus|om digital|leica|ricoh|sigma|hasselblad|zoom|z cam|red)\b/i;
const PHONE_NAME = /^(?:img|vid|pxl|mvimg)_\d{3,}/i;
const CAMERA_NAME = /^(?:gopr\d|gx\d{6}|gh\d{6}|dji_\d|mvi_\d|dsc\d|c\d{4}\.mp4|priv)/i;
const BROWSERS = /^(?:safari|google chrome|chrome|chromium|arc|firefox|brave browser|brave|microsoft edge|opera|vivaldi|orion|dia|comet|zen|sigmaos|duckduckgo|yt-dlp|downie|4k video downloader|transmission|qbittorrent|folx|jdownloader)/i;
const AGENT_SITE: Array<[RegExp, string]> = [
  [/^slack/i, "slack"], [/^discord/i, "discord"], [/^telegram/i, "telegram"], [/^whatsapp/i, "whatsapp"], [/^messages$/i, "messages"],
  [/^mail$|outlook|spark/i, "email"], [/^dropbox/i, "dropbox"], [/google drive/i, "drive"],
];
const NAME_SITES = ["youtube", "tiktok", "instagram", "twitter", "reddit", "vimeo", "facebook"];
/** A YouTube id in brackets, as yt-dlp names its files. */
const YTDLP = /\[[A-Za-z0-9_-]{11}\]\.\w+$/;
/** Apps, most specific first (the first found names the source). Each: where to look (meta = encoder/comment/apps/agent; all = + name/title). */
const APP_DETECT: Array<[string, RegExp, "meta" | "all"]> = [
  ["capcut", /capcut/i, "all"], ["finalcut", /final ?cut/i, "meta"], ["premiere", /premiere/i, "meta"], ["davinci", /davinci|resolve/i, "meta"],
  ["imovie", /imovie/i, "all"], ["remotion", /remotion/i, "all"], ["screenstudio", /screen ?studio/i, "meta"], ["descript", /descript/i, "meta"],
  ["canva", /\bcanva\b/i, "meta"], ["clipchamp", /clipchamp/i, "meta"], ["handbrake", /handbrake/i, "all"], ["obs", /\bobs\b/i, "meta"],
  ["photobooth", /photo ?booth/i, "meta"], ["aftereffects", /after ?effects/i, "meta"], ["keynote", /keynote/i, "meta"],
  ["quicktime", /quicktime|core media/i, "meta"], ["ffmpeg", /\blav[fc]\d|ffmpeg/i, "meta"],
];

const hostOf = (url: string): string | undefined => {
  try {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) return undefined;
    return u.hostname.replace(/^(?:www|m|mobile)\./, "").toLowerCase() || undefined;
  } catch {
    return undefined;
  }
};

/** Pixel size → the words people use. */
export function orientationOf(w?: number, h?: number): Orientation | undefined {
  if (!(typeof w === "number" && typeof h === "number" && w > 0 && h > 0)) return undefined;
  if (h > w * 1.05) return "vertical";
  if (w > h * 1.05) return "landscape";
  return "square";
}

export function qualityOf(w?: number, h?: number): string | undefined {
  if (!(typeof w === "number" && typeof h === "number" && w > 0 && h > 0)) return undefined;
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  if (long >= 3800 || short >= 2100) return "4K";
  if (short >= 1000 && short < 1300) return "1080p";
  if (short >= 700 && short < 900) return "720p";
  return undefined;
}

/** Everything known about one video, as plain facts. `ff` undefined = Spotlight/quarantine weren't asked. */
export function factsOf(
  base: { name: string; folder: string; size: number; addedMs: number },
  info: VideoDetailsInfo | undefined,
  ff: FileFacts | undefined,
  metaOk: boolean,
): Facts {
  const spot = ff?.spot;
  const width = info?.width ?? spot?.width;
  const height = info?.height ?? spot?.height;
  const duration = info?.duration_sec ?? spot?.duration_sec;
  let audio = info?.has_audio;
  if (audio === undefined && spot?.audio_channels !== undefined) audio = spot.audio_channels > 0;
  if (audio === undefined && spot?.codecs) audio = spot.codecs.some((c) => /aac|audio|mp3|mpeg layer|pcm|ac-?3|opus|alac|lpcm/i.test(c));
  const make = info?.make ?? spot?.make;
  const model = info?.model ?? spot?.model;
  const hosts = [...new Set((spot?.where_froms ?? []).map(hostOf).filter((h): h is string => Boolean(h)))];
  const agent = ff?.agent ?? "";
  const metaText = [info?.encoder, info?.comment, info?.author, ...(spot?.encoding_apps ?? []), spot?.creator, agent].filter(Boolean).join(" | ");
  const allText = `${metaText} | ${base.name} | ${info?.title ?? ""} | ${spot?.title ?? ""}`;

  const sources = new Set<SourceKind>();
  if (SCREEN_NAME.test(base.name) || info?.author === "ReplayKitRecording" || /screen ?studio|cleanshot/i.test(metaText)) sources.add("screen_recording");
  if ((model && PHONE_MODEL.test(model)) || (make && PHONE_MAKE.test(make) && model) || IOS_SCREEN.test(base.name)) sources.add("phone");
  else if (!make && PHONE_NAME.test(base.name)) sources.add("phone");
  if ((make && CAMERA_MAKE.test(make) && !/mobile/i.test(make)) || CAMERA_NAME.test(base.name)) sources.add("camera");
  if (agent === "sharingd") sources.add("airdrop");

  const sites = new Set<string>();
  for (const h of hosts) {
    for (const [key, site] of Object.entries(SITES)) if (site.hosts.some((sh) => h === sh || h.endsWith(`.${sh}`))) sites.add(key);
  }
  for (const [re, key] of AGENT_SITE) if (re.test(agent)) sites.add(key);
  const nameText = `${base.name} ${info?.title ?? ""}`.toLowerCase();
  for (const key of NAME_SITES) if (new RegExp(`\\b${key}\\b`).test(nameText)) sites.add(key);
  if (YTDLP.test(base.name)) sites.add("youtube");
  if (hosts.length || BROWSERS.test(agent) || sites.size) sources.add("downloaded");

  const apps = new Set<string>();
  for (const [key, re, where] of APP_DETECT) if (re.test(where === "all" ? allText : metaText)) apps.add(key);

  const device = model ? (make && !model.toLowerCase().startsWith(make.toLowerCase()) && !/^apple$/i.test(make) ? `${make} ${model}` : model) : undefined;
  const f: Facts = {
    name: base.name,
    folder: base.folder,
    size: base.size,
    addedMs: base.addedMs,
    hosts,
    sources,
    sites,
    apps,
    metaOk,
  };
  const created = info?.created_ms ?? spot?.created_ms;
  if (created !== undefined) f.createdMs = created;
  if (duration !== undefined) f.duration_sec = duration;
  if (width && height) {
    f.width = width;
    f.height = height;
    f.orientation = orientationOf(width, height);
    const q = qualityOf(width, height);
    if (q) f.quality = q;
  }
  if (audio !== undefined) f.has_audio = audio;
  const title = info?.title ?? spot?.title;
  if (title) f.title = title;
  if (info?.comment) f.comment = info.comment;
  if (spot?.tags?.length) f.tags = spot.tags;
  if (spot?.finder_comment) f.finder_comment = spot.finder_comment;
  if (device) f.device = device;
  f.sourceLabel = sourceLabel(f, hosts);
  return f;
}

function sourceLabel(f: Facts, hosts: string[]): string | undefined {
  if (f.sources.has("screen_recording")) return f.sources.has("phone") ? "iPhone screen recording" : "screen recording";
  if (f.sources.has("airdrop")) return f.device ? `AirDropped from ${f.device}` : "AirDropped";
  if (f.sources.has("phone") || f.sources.has("camera")) return f.device ? `from ${f.device}` : f.sources.has("phone") ? "from a phone" : "from a camera";
  if (f.sources.has("downloaded")) {
    const known = hosts.find((h) => Object.values(SITES).some((s) => s.hosts.some((sh) => h === sh || h.endsWith(`.${sh}`)) && !/googlevideo|cdn|usercontent|fbcdn|twimg/.test(h)));
    const host = known ?? hosts[hosts.length - 1];
    if (host) return `downloaded from ${host}`;
    const site = [...f.sites][0];
    return site ? `from ${SITES[site].label}` : "downloaded";
  }
  const app = APP_DETECT.find(([key]) => f.apps.has(key) && key !== "quicktime" && key !== "ffmpeg")?.[0] ?? [...f.apps][0];
  if (app) return app === "remotion" ? "made with Remotion" : app === "ffmpeg" ? "rendered with ffmpeg" : `made in ${APPS[app].label}`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Words: when, length, the descriptor
// ---------------------------------------------------------------------------

const clock = (ms: number) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/ /g, " ");
const dayStart = (ms: number) => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const daysBetween = (a: number, b: number) => Math.round((dayStart(b) - dayStart(a)) / 86_400_000);

/** "just now", "12 min ago", "today 9:14 AM", "yesterday 9:14 PM", "Monday 3:02 PM", "Nov 3", "Nov 3, 2025". */
export function whenLabel(ms: number, now: number): string {
  if (!Number.isFinite(ms)) return "";
  const diff = now - ms;
  if (diff >= 0 && diff < 60_000) return "just now";
  if (diff >= 0 && diff < 60 * 60_000) return `${Math.floor(diff / 60_000)} min ago`;
  const days = daysBetween(ms, now);
  if (days === 0) return `today ${clock(ms)}`;
  if (days === 1) return `yesterday ${clock(ms)}`;
  if (days > 1 && days < 7) return `${new Date(ms).toLocaleDateString("en-US", { weekday: "long" })} ${clock(ms)}`;
  const sameYear = new Date(ms).getFullYear() === new Date(now).getFullYear();
  return new Date(ms).toLocaleDateString("en-US", sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}

/** The day only, for questions: "today", "yesterday", "Monday", "Nov 3". */
export function dayWord(ms: number, now: number): string {
  const days = daysBetween(ms, now);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days > 1 && days < 7) return new Date(ms).toLocaleDateString("en-US", { weekday: "long" });
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** 37 → "0:37", 72.4 → "1:12". */
export function clockDuration(sec?: number): string {
  if (typeof sec !== "number" || !Number.isFinite(sec) || sec < 0) return "";
  const t = Math.round(sec);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** "vertical · 0:37 · added yesterday 9:14 PM · Movies › Tiny AI Lab · downloaded from youtube.com". */
export function descriptor(f: Facts, now: number): string {
  const look = [f.quality === "4K" ? "4K" : "", f.orientation ?? ""].filter(Boolean).join(" ");
  const parts = [
    look,
    clockDuration(f.duration_sec),
    `added ${whenLabel(f.addedMs, now)}`,
    f.folder.split("/").filter(Boolean).join(" › "),
    f.sourceLabel ?? "",
    f.has_audio === false ? "no sound" : "",
  ];
  return parts.filter(Boolean).join(" · ");
}

/** Short chips for the card: ["vertical", "0:37", "yesterday 9:14 PM", "screen recording"]. */
export function chips(f: Facts, now: number): string[] {
  return [
    [f.quality === "4K" ? "4K" : "", f.orientation ?? ""].filter(Boolean).join(" "),
    whenLabel(f.addedMs, now),
    f.sourceLabel ?? "",
    f.has_audio === false ? "no sound" : "",
  ].filter(Boolean);
}

// ---------------------------------------------------------------------------
// Checking a description
// ---------------------------------------------------------------------------

export type Verdict = "yes" | "no" | "unknown";

export interface Check {
  /** What was asked, in the user's terms: "vertical", "from yesterday". */
  label: string;
  verdict: Verdict;
  /** Why it holds (for `why`): "added yesterday 9:14 PM", "0:37 long". */
  why?: string;
}

export interface Evaluation {
  checks: Check[];
  no: number;
  unknown: number;
  /** Keyword score (0 when none asked or none matched). */
  kw: number;
  kwFuzzy: boolean;
  near?: Array<[string, string]>;
  /** 0–1: how close the length is to the one said. */
  closeness: number;
}

const inWindow = (t: number | undefined, w: { from: number; to: number }) => typeof t === "number" && t >= w.from && t < w.to;

export function evaluate(d: Describe, f: Facts, now: number): Evaluation {
  const checks: Check[] = [];
  let closeness = 0;
  if (d.time) {
    const w = d.time;
    if (inWindow(f.addedMs, w)) checks.push({ label: w.label, verdict: "yes", why: `added ${whenLabel(f.addedMs, now)}` });
    else if (w.basis === "either" && inWindow(f.createdMs, w)) checks.push({ label: w.label, verdict: "yes", why: `made ${whenLabel(f.createdMs!, now)}` });
    else checks.push({ label: w.label, verdict: "no" });
  }
  if (d.duration) {
    const dur = f.duration_sec;
    const w = d.duration;
    if (dur === undefined) checks.push({ label: w.label, verdict: "unknown" });
    else {
      const ok = (w.min === undefined || dur >= w.min) && (w.max === undefined || dur <= w.max);
      checks.push({ label: w.label, verdict: ok ? "yes" : "no", why: `${clockDuration(dur)} long` });
      if (ok && w.target !== undefined) {
        const tol = Math.max(1, ((w.max ?? w.target) - (w.min ?? w.target)) / 2);
        closeness = Math.max(0, 1 - Math.abs(dur - w.target) / tol);
      } else if (ok) closeness = 1;
    }
  }
  if (d.orientation) {
    checks.push(f.orientation ? { label: d.orientation, verdict: f.orientation === d.orientation ? "yes" : "no", why: f.orientation } : { label: d.orientation, verdict: "unknown" });
  }
  if (d.quality) {
    const q = d.quality;
    const label = q === "4k" ? "4K" : q === "hd" ? "HD" : q;
    if (!(f.width && f.height)) checks.push({ label, verdict: "unknown" });
    else {
      const long = Math.max(f.width, f.height);
      const short = Math.min(f.width, f.height);
      const ok = q === "4k" ? long >= 3800 || short >= 2100 : q === "1080p" ? short >= 1000 && short < 1300 : q === "720p" ? short >= 700 && short < 900 : short >= 700;
      checks.push({ label, verdict: ok ? "yes" : "no", why: `${f.width}×${f.height}` });
    }
  }
  if (d.audio) {
    const label = d.audio === "silent" ? "no sound" : "with sound";
    if (f.has_audio === undefined) checks.push({ label, verdict: "unknown" });
    else checks.push({ label, verdict: (d.audio === "silent") === !f.has_audio ? "yes" : "no", why: f.has_audio ? "has sound" : "no sound" });
  }
  for (const s of d.sources) {
    const label = { screen_recording: "screen recording", phone: "from a phone", camera: "from a camera", airdrop: "AirDropped", downloaded: "downloaded from a website" }[s];
    const ok = s === "camera" ? f.sources.has("camera") || f.sources.has("phone") : f.sources.has(s);
    // Name-based facts hold without Spotlight; "downloaded"/"AirDropped" need the metadata.
    const needsMeta = s === "downloaded" || s === "airdrop";
    checks.push({ label, verdict: ok ? "yes" : needsMeta && !f.metaOk ? "unknown" : "no", ...(ok && f.sourceLabel ? { why: f.sourceLabel } : {}) });
  }
  if (d.sites.length) {
    const label = `from ${d.sites.map((k) => SITES[k]?.label ?? k).join(" or ")}`;
    const ok = d.sites.some((k) => f.sites.has(k));
    checks.push({ label, verdict: ok ? "yes" : f.metaOk ? "no" : "unknown", ...(ok && f.sourceLabel ? { why: f.sourceLabel } : {}) });
  }
  if (d.apps.length) {
    const label = `made in ${d.apps.map((k) => APPS[k]?.label ?? k).join(" or ")}`;
    const ok = d.apps.some((k) => f.apps.has(k) || (k === "quicktime" && f.sources.has("screen_recording")));
    checks.push({ label, verdict: ok ? "yes" : f.metaOk ? "no" : "unknown", ...(ok ? { why: label } : {}) });
  }
  let kw = 0;
  let kwFuzzy = false;
  let near: Array<[string, string]> | undefined;
  if (d.keywords.length || d.boost) {
    const q = queryOf(d.keywords, d.boost);
    const byName = scoreName(q, f.name);
    const label = d.keywords.length ? `"${d.keywords.join(" ")}"` : "an export";
    if (byName.hit && (d.keywords.length || byName.score > 1)) {
      kw = byName.score;
      kwFuzzy = byName.fuzzy;
      near = byName.near;
      checks.push({ label, verdict: "yes", why: byName.fuzzy ? "name is spelled a little differently" : "name matches" });
    } else if (d.keywords.length) {
      const other = [f.title, f.comment, f.finder_comment, ...(f.tags ?? []), ...f.hosts, f.folder].filter(Boolean).join(" | ");
      const byOther = other ? scoreName(q, other) : undefined;
      if (byOther?.hit) {
        kw = Math.round(byOther.score * 0.9 * 100) / 100;
        kwFuzzy = byOther.fuzzy;
        near = byOther.near;
        const where = f.tags?.length && scoreName(q, f.tags.join(" ")).hit ? "Finder tag matches" : f.title && scoreName(q, f.title).hit ? "title matches" : scoreName(q, f.folder).hit ? "folder matches" : "details match";
        checks.push({ label, verdict: "yes", why: where });
      } else checks.push({ label, verdict: "no" });
    }
  }
  return {
    checks,
    no: checks.filter((c) => c.verdict === "no").length,
    unknown: checks.filter((c) => c.verdict === "unknown").length,
    kw,
    kwFuzzy,
    ...(near ? { near } : {}),
    closeness,
  };
}

/** Does this one word match the video's name or details (title, tags, comments, hosts, folder)? */
export function keywordHit(word: string, f: Facts): boolean {
  const q = queryOf([word], false);
  if (scoreName(q, f.name).hit) return true;
  const other = [f.title, f.comment, f.finder_comment, ...(f.tags ?? []), ...f.hosts, f.folder].filter(Boolean).join(" | ");
  return Boolean(other) && scoreName(q, other).hit;
}

// ---------------------------------------------------------------------------
// Ranking and confidence
// ---------------------------------------------------------------------------

export interface Scored<T> {
  item: T;
  facts: Facts;
  ev: Evaluation;
  /** Set when this is the video in progress. */
  focus?: boolean;
}

export interface Ranking<T> {
  /** Best first: full matches, then (when there are none) the closest. */
  ranked: Scored<T>[];
  /** How many of `ranked` fit everything said. */
  fits: number;
  confidence: Confidence;
  /** When confidence is none: what the closest video didn't fit. */
  unmet: string[];
  /** When ambiguous: how many at the top are equally good. */
  tied: number;
  /** The best match only matched a keyword as a near spelling. */
  fuzzy: boolean;
}

const attr = (s: Scored<unknown>, by: "added" | "duration" | "size") => (by === "added" ? s.facts.addedMs : by === "duration" ? s.facts.duration_sec : s.facts.size);

/**
 * Ranks every candidate against the description. Fits (no "no" verdict) come first, ordered by an asked
 * superlative/ordinal, else by keyword score, length closeness, the video in progress and arrival.
 */
export function rank<T>(items: Array<{ item: T; facts: Facts; focus?: boolean }>, d: Describe, now: number): Ranking<T> {
  const scored: Scored<T>[] = items.map((x) => ({ ...x, ev: evaluate(d, x.facts, now) }));
  const newer = (a: Scored<T>, b: Scored<T>) => b.facts.addedMs - a.facts.addedMs || (a.facts.name < b.facts.name ? -1 : a.facts.name > b.facts.name ? 1 : 0);
  const focusFirst = d.current === "soft";
  const base = (a: Scored<T>, b: Scored<T>) =>
    a.ev.unknown - b.ev.unknown ||
    b.ev.kw - a.ev.kw ||
    b.ev.closeness - a.ev.closeness ||
    (focusFirst ? Number(Boolean(b.focus)) - Number(Boolean(a.focus)) : 0) ||
    newer(a, b);
  const fits = scored.filter((s) => s.ev.no === 0);

  if (!fits.length) {
    const closest = [...scored].sort((a, b) => a.ev.no - b.ev.no || base(a, b));
    return {
      ranked: closest,
      fits: 0,
      confidence: "none",
      unmet: closest[0] ? closest[0].ev.checks.filter((c) => c.verdict === "no").map((c) => c.label) : [],
      tied: 0,
      fuzzy: false,
    };
  }

  // The order the user asked for: an explicit superlative/ordinal, else a length or size preference.
  const order = d.order ?? (d.lengthPref ? { by: "duration" as const, dir: d.lengthPref === "long" ? ("desc" as const) : ("asc" as const), index: 1, label: d.lengthPref } : undefined) ??
    (d.sizePref ? { by: "size" as const, dir: d.sizePref === "big" ? ("desc" as const) : ("asc" as const), index: 1, label: d.sizePref } : undefined);
  let list: Scored<T>[];
  if (order && !(order.by === "added" && order.dir === "desc" && order.index === 1 && (d.keywords.length || d.boost))) {
    const known = fits.filter((s) => attr(s, order.by) !== undefined);
    const unknown = fits.filter((s) => attr(s, order.by) === undefined);
    known.sort((a, b) => {
      const x = attr(a, order.by)!;
      const y = attr(b, order.by)!;
      return (order.dir === "desc" ? y - x : x - y) || base(a, b);
    });
    list = [...known, ...unknown.sort(base)];
    if (order.index > 1 && list.length >= order.index) list = [list[order.index - 1], ...list.filter((_, i) => i !== order.index - 1)];
  } else list = [...fits].sort(base);
  const rest = scored.filter((s) => s.ev.no > 0).sort((a, b) => a.ev.no - b.ev.no || base(a, b));
  const ranked = [...list, ...rest];
  const top = list[0];
  const second = list[1];
  const fuzzy = top.ev.kwFuzzy;
  const isDescribed = described(d);

  let confidence: Confidence;
  let tied = 1;
  if (list.length === 1) confidence = !isDescribed || top.ev.unknown || fuzzy ? "likely" : "exact";
  else if (order && (d.order || d.lengthPref || d.sizePref)) {
    // A superlative or ordinal picks one, unless the top two are the same on that measure (or it's only a preference).
    const x = attr(top, order.by);
    const y = attr(second, order.by);
    const same = x === undefined || y === undefined || (order.by === "duration" ? Math.abs(x - y) < 1 : order.by === "size" ? Math.abs(x - y) <= Math.max(x, y) * 0.01 : Math.abs(x - y) < 1000);
    if (d.order && order.index > 1) confidence = "exact";
    else if (same) confidence = "ambiguous";
    else if (d.order) confidence = "exact";
    else confidence = x !== undefined && y !== undefined && Math.max(x, y) >= Math.min(x, y) * 1.5 ? "likely" : "ambiguous";
    if (confidence === "ambiguous") tied = Math.min(list.length, 3);
  } else if (!isDescribed) {
    // Nothing (or only a folder) said: the newest, unless the newest few arrived together (a batch, or copies).
    const batch = list.filter((s) => top.facts.addedMs - s.facts.addedMs < 2 * 60_000);
    confidence = batch.length > 1 ? "ambiguous" : "likely";
    if (batch.length > 1) tied = Math.min(3, batch.length);
  }
  else if ((d.keywords.length || d.boost) && top.ev.kw >= second.ev.kw + 0.3) confidence = fuzzy ? "likely" : top.ev.kw >= second.ev.kw + 0.5 && !top.ev.unknown ? "exact" : "likely";
  else if (d.duration?.target !== undefined && top.ev.closeness - second.ev.closeness >= 0.45) confidence = "likely";
  else if (focusFirst && top.focus) confidence = "likely";
  // Only a kind was said ("my screen recording", "the 4K one"): people mean the latest of that kind, unless
  // the latest two arrived together (a batch, or two copies of one recording).
  else if (!d.time && !d.duration && !d.keywords.length && !d.boost && top.facts.addedMs - second.facts.addedMs > 6 * 3_600_000) confidence = "likely";
  else {
    confidence = "ambiguous";
    const same = list.filter((s) => s.ev.kw === top.ev.kw && s.ev.unknown === top.ev.unknown);
    // Without words or a length to tell them apart, the toss-up is between the latest batch only.
    const kindOnly = !d.duration && !d.keywords.length && !d.boost;
    tied = kindOnly ? same.filter((s) => top.facts.addedMs - s.facts.addedMs <= 6 * 3_600_000).length : same.length;
  }
  return { ranked, fits: list.length, confidence, unmet: [], tied: Math.max(1, tied), fuzzy };
}

// ---------------------------------------------------------------------------
// One short question that names the difference
// ---------------------------------------------------------------------------

const megabytes = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
const stem = (name: string) => name.replace(/\.[^.]{1,5}$/, "").replace(/[_]+/g, " ").replace(/\s+/g, " ").trim();
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/**
 * "the 0:37 vertical one from yesterday, or the 1:12 landscape one from Monday?" Only what differs between
 * the candidates is said (length, shape, day or time, how it was made, folder); names when nothing else does.
 */
export function whichQuestion(list: Facts[], now: number, o: { names?: boolean } = {}): string {
  const c = list.slice(0, 3);
  if (c.length < 2) return "";
  const differ = <V>(get: (f: Facts) => V | undefined, same: (a: V, b: V) => boolean) => {
    const vals = c.map(get);
    if (vals.some((v) => v === undefined)) return false;
    for (let i = 0; i < vals.length; i++) for (let j = i + 1; j < vals.length; j++) if (same(vals[i]!, vals[j]!)) return false;
    return true;
  };
  const durOk = differ((f) => f.duration_sec, (a, b) => Math.abs(a - b) < Math.max(2, Math.min(a, b) * 0.1) || clockDuration(a) === clockDuration(b));
  const orientOk = differ((f) => f.orientation, (a, b) => a === b);
  const dayOk = differ((f) => dayWord(f.addedMs, now), (a, b) => a === b);
  const timeOk = !dayOk && differ((f) => f.addedMs, (a, b) => Math.abs(a - b) < 20 * 60_000 || clock(a) === clock(b));
  const sourceOk = differ((f) => f.sourceLabel ?? "", (a, b) => a === b);
  const folderOk = differ((f) => f.folder, (a, b) => a === b);
  const extOf = (f: Facts) => (/\.([a-z0-9]{2,4})$/i.exec(f.name)?.[1] ?? "").toLowerCase();
  const extOk = differ(extOf, (a, b) => a === b);
  const sizeOk = differ((f) => f.size, (a, b) => Math.max(a, b) < Math.min(a, b) * 1.8);
  const phrase = (f: Facts) => {
    const noun = sourceOk && f.sourceLabel === "screen recording" ? "screen recording" : "one";
    const bits = ["the", durOk ? clockDuration(f.duration_sec) : "", orientOk ? f.orientation ?? "" : "", noun];
    if (dayOk) bits.push(`from ${dayWord(f.addedMs, now)}`);
    else if (timeOk) bits.push(`from ${clock(f.addedMs)}`);
    if (sourceOk && noun === "one" && f.sourceLabel) bits.push(f.sourceLabel.replace(/^made in /, "made in "));
    if (folderOk && !dayOk && !durOk && !orientOk) bits.push(`in ${f.folder.split("/").pop()}`);
    if (!durOk && !orientOk && !dayOk && !timeOk && !sourceOk && !folderOk) {
      // Copies of one video: the file type, or the size.
      if (extOk) bits.splice(1, 0, `.${extOf(f)}`);
      else if (sizeOk) bits.splice(1, 0, megabytes(f.size));
    }
    return bits.filter(Boolean).join(" ");
  };
  // Names, from where they start to differ when they share a long beginning ("…under 20MB").
  const stems = c.map((f) => stem(f.name));
  let common = 0;
  while (stems.every((x) => x.length > common && x[common] === stems[0][common])) common++;
  const named = (x: string) => `“${common > 14 && x.length - common >= 2 ? `…${clip(x.slice(Math.max(0, common - 6)).trim(), 34)}` : clip(x, 40)}”`;
  let parts: string[];
  if (o.names) parts = stems.map(named);
  else if (durOk || orientOk || dayOk || timeOk || sourceOk || folderOk || extOk || sizeOk) parts = c.map(phrase);
  else parts = stems.map(named);
  // Two that read the same (or a very long question): fall back to names.
  if (new Set(parts).size < parts.length || parts.join(", ").length > 180) parts = stems.map(named);
  if (new Set(parts).size < parts.length) parts = c.map((_, i) => `number ${i + 1}`);
  const more = list.length > 3 ? ", or another one" : "";
  const body = parts.length === 2 && !more ? `${parts[0]}, or ${parts[1]}` : `${parts.slice(0, -1).join(", ")}${more ? `, ${parts[parts.length - 1]}${more}` : `, or ${parts[parts.length - 1]}`}`;
  return `Which one: ${body}?`;
}
