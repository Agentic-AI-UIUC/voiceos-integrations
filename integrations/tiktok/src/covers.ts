/**
 * Remote pictures for the result cards: the profile picture (`avatar_url`, else `avatar_url_100`; creator info's
 * `creator_avatar_url`) and post covers (`cover_image_url`). Widgets have no network, so each picture travels
 * inside the card as a small `data:` URI.
 *
 * Where from: TikTok's image CDN only. An https URL on the default port, without user info, whose host is exactly
 * one DNS label under one of TIKTOK_IMAGE_HOSTS' domains (src/config.ts: `*.tiktokcdn-us.com`, …; the build writes
 * the same patterns into the manifest's network permission). No redirects followed, at most 1.5 MB read. A refused
 * URL logs why and its hostname, once (never the URL, path or query: they're signed links to the user's media).
 *
 * Timing: a card waits up to IMAGE_WAIT_MS for its pictures (less when the caller's signal ends sooner), but each
 * fetch runs on for up to FETCH_TIMEOUT_MS and lands in the cache, so the next card has it. Requests for the same
 * picture share one fetch, which no single caller can cancel. Results are cached by URL for 2 hours (a signed URL
 * TikTok hands out lives about that long, and the same URL is the same picture).
 *
 * Size: scaled so its longest side is `width` px (2× the tile it's drawn in; never upscaled) and re-encoded as a JPEG
 * at quality 82 by sips (on Windows, src/windows.ts's PowerShell stand-in). A JPEG, PNG, WebP or AVIF that's already
 * small goes in as it is, and so does one sips can't read (no decoder, a timeout) while it fits the size cap.
 *
 * Best effort: every failure is "no picture" and the card shows its fallback tile. Logs carry counts, durations,
 * outcome codes and refused hostnames, never a URL.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TIKTOK_IMAGE_HOSTS } from "./config.ts";
import { log } from "./proc.ts";
import type { Clock, Runner } from "./types.ts";

/** How long a card waits for its pictures. What isn't there by then lands in the cache for the next card. */
export const IMAGE_WAIT_MS = 2_500;
/** The fetch itself (connect, TLS, body), like a Composio request's 8 s. It runs on after the card stops waiting. */
export const FETCH_TIMEOUT_MS = 8_000;
export const IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;
/**
 * The default longest side, px: a list row's cover (src/cards.ts `s` tile, 60 px on its long side) and an avatar
 * (a 56 px circle), both at 2×.
 */
export const IMAGE_PX = 120;
export const IMAGE_CACHE_MS = 2 * 3_600_000;
export const JPEG_QUALITY = 82;
/** One more try when quality 82 doesn't fit the cap (a busy cover). */
const JPEG_QUALITY_FALLBACK = 62;
/** A picture already this small (JPEG, PNG, WebP or AVIF) goes in as it is: no sips pass. */
const DIRECT_MAX_BYTES = 20 * 1024;
/** What a card draws as a still (src/cards.ts cardImage): base64 JPEG, PNG, WebP or AVIF. */
export const DATA_URI_RE = /^data:image\/(jpeg|png|webp|avif);base64,[A-Za-z0-9+/=]+$/;
/** Largest data URI for a big picture (a lone post's cover), in characters. */
export const MAX_DATA_URI = 45 * 1024;
/**
 * Largest data URI for a small one (an avatar, a list row's cover): four rows plus the sends' posters stay inside a
 * card's 200,000-character picture budget (src/cards.ts).
 */
export const SMALL_DATA_URI = 28_000;
/** Sizes up to this many px are "small". */
const SMALL_PX = 160;
const CACHE_MAX = 200;
/** sips per picture: probe, then convert. Generous because the Windows stand-in starts PowerShell; background time, not the card's. */
const PROBE_TIMEOUT_MS = 4_000;
const CONVERT_TIMEOUT_MS = 5_000;
/** Pictures scaled at once (six covers would otherwise start twelve PowerShells together on Windows). */
const SCALE_CONCURRENCY = 3;
/** JPEG first: every decoder reads it (Windows without the WebP codec too). */
const ACCEPT = "image/jpeg,image/png;q=0.9,image/webp;q=0.8,image/*;q=0.5";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * Whether `host` fits `pattern`: the same name, or for "*.domain" exactly one DNS label under the domain (not the
 * bare domain, not a deeper name, not a lookalike such as `x.domain.evil.com` or `evildomain`).
 */
export function hostMatches(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (!p.startsWith("*.")) return h === p;
  const suffix = p.slice(1);
  return h.endsWith(suffix) && LABEL.test(h.slice(0, h.length - suffix.length));
}

/** Why a URL isn't fetched (for the log): none given, not a URL, not https, user info, a port, another host. */
type Refusal = "none" | "form" | "scheme" | "userinfo" | "port" | "domain";

function vet(raw: unknown, hosts: readonly string[]): { url: URL } | { why: Refusal; host?: string } {
  if (raw === undefined || raw === null) return { why: "none" };
  if (typeof raw !== "string") return { why: "form" };
  const text = raw.trim();
  if (!text) return { why: "none" };
  if (text.length > 4096 || /\s/.test(text)) return { why: "form" };
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return { why: "form" };
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:") return { why: "scheme", host };
  if (u.username || u.password) return { why: "userinfo", host };
  if (u.port && u.port !== "443") return { why: "port", host };
  return hosts.some((p) => hostMatches(host, p)) ? { url: u } : { why: "domain", host };
}

/** The URL as a fetchable https URL on TikTok's image CDN, else undefined. */
export function allowedImageUrl(raw: unknown, hosts: readonly string[] = TIKTOK_IMAGE_HOSTS): URL | undefined {
  const v = vet(raw, hosts);
  return "url" in v ? v.url : undefined;
}

/** A hostname fit for a log line: letters, digits, dots and hyphens only, else "-". */
const loggable = (host?: string): string => (host && /^[a-z0-9.-]{1,253}$/.test(host) ? host : "-");

type Kind = "jpeg" | "png" | "webp" | "avif" | "other";
const ascii = (b: Uint8Array, from: number, to: number): string => String.fromCharCode(...b.subarray(from, to));
function kindOf(b: Uint8Array): Kind {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length > 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "webp";
  if (b.length > 12 && ascii(b, 4, 8) === "ftyp" && /^avi[fs]$/.test(ascii(b, 8, 12))) return "avif";
  return "other";
}

/** The bytes as a data URI of at most `cap` characters, else undefined (measured before encoding a big body). */
function asUri(b: Uint8Array, kind: Exclude<Kind, "other">, cap: number): string | undefined {
  if (Math.ceil(b.length / 3) * 4 + 24 > cap) return undefined;
  const uri = `data:image/${kind};base64,${Buffer.from(b).toString("base64")}`;
  return uri.length <= cap ? uri : undefined;
}

/** Outcome codes for the log line (no URLs). "wait": the card stopped waiting; the fetch goes on into the cache. */
type Outcome = "ok" | "cached" | "none" | "host" | "off" | "wait" | "http" | "big" | "type" | "timeout" | "net" | "scale";
type Result = { uri?: string; outcome: Outcome };
interface Job {
  done: Promise<Result>;
  started: number;
  /** A card stopped waiting for it: its end is logged on its own line. */
  late: boolean;
}
const isJob = (j: Result | Job): j is Job => "done" in j;

class Skip extends Error {
  constructor(readonly outcome: Outcome) {
    super(outcome);
  }
}

/** Read a body up to `max` bytes; more than that is a Skip("big"). */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new Skip("big");
  }
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Skip("big");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

const int = (s: string, key: string): number => {
  const m = new RegExp(`${key}:\\s*(\\d+)`).exec(s);
  return m ? Number(m[1]) : 0;
};

/**
 * Bytes of any image ImageIO (or, on Windows, System.Drawing/WIC) reads → a JPEG data URI whose longest side is at
 * most `px`, within `cap` characters. Undefined when sips isn't there (CI), can't read it, times out, or the result
 * doesn't fit even at the fallback quality.
 */
async function scaleDown(bytes: Uint8Array, px: number, cap: number, runner: Runner, tmpRoot: string): Promise<string | undefined> {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpRoot, "tiktok-img-"));
    const src = join(dir, "in");
    const out = join(dir, "out.jpg");
    writeFileSync(src, bytes);
    const meta = await runner(["sips", "-g", "pixelWidth", "-g", "pixelHeight", src], { timeoutMs: PROBE_TIMEOUT_MS });
    const w = int(meta.stdout, "pixelWidth");
    const h = int(meta.stdout, "pixelHeight") || w;
    if (meta.code !== 0 || !(w > 0)) return undefined;
    // sips (and the Windows stand-in) take a width: the one that brings the longest side to px (rounded down, so
    // the height they work out from it stays within px too).
    const long = Math.max(w, h);
    const width = long > px ? Math.max(1, Math.floor((w * px) / long)) : w;
    const resize = width < w ? ["--resampleWidth", String(width)] : [];
    for (const q of [JPEG_QUALITY, JPEG_QUALITY_FALLBACK]) {
      const r = await runner(["sips", "-s", "format", "jpeg", "-s", "formatOptions", String(q), ...resize, src, "--out", out], { timeoutMs: CONVERT_TIMEOUT_MS });
      if (r.code !== 0) return undefined;
      const jpeg = new Uint8Array(readFileSync(out));
      if (kindOf(jpeg) !== "jpeg") return undefined;
      const uri = asUri(jpeg, "jpeg", cap);
      if (uri) return uri;
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

/** Resolves once `ms` have passed or `signal` aborts, whichever is first; `stop()` releases the timer. */
function waitFor(ms: number, signal?: AbortSignal): { done: Promise<void>; stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const done = new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    timer = setTimeout(resolve, Math.max(0, ms));
    onAbort = () => resolve();
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  return {
    done,
    stop: () => {
      clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    },
  };
}

const pxOf = (w: unknown): number => (typeof w === "number" && Number.isFinite(w) && w >= 16 && w <= 1080 ? Math.round(w) : IMAGE_PX);

export interface RemoteImagesOptions {
  runner: Runner;
  clock: Clock;
  fetch?: FetchLike;
  /** Host patterns (TIKTOK_IMAGE_HOSTS). */
  hosts?: readonly string[];
  tmpRoot?: string;
  /** How long a card waits for its pictures (IMAGE_WAIT_MS). */
  waitMs?: number;
  /** How long one fetch may take, body included (FETCH_TIMEOUT_MS). */
  fetchTimeoutMs?: number;
  maxBytes?: number;
  /** Fetch nothing: a test server (a loopback Composio, whose made-up URLs are on TikTok's CDN hosts). */
  offline?: boolean;
}

/** The avatar and cover fetcher, with its URL-keyed cache. One per server (Deps.images). */
export class RemoteImages {
  private readonly cache = new Map<string, { at: number; uri: string }>();
  private readonly inflight = new Map<string, Job>();
  private readonly refusals = new Set<string>();
  private readonly fetchImpl: FetchLike;
  private readonly hosts: readonly string[];
  private readonly tmpRoot: string;
  private readonly waitMs: number;
  private readonly fetchTimeoutMs: number;
  private readonly maxBytes: number;
  private scaling = 0;
  private readonly queued: Array<() => void> = [];

  constructor(private readonly o: RemoteImagesOptions) {
    this.fetchImpl = o.fetch ?? ((url, init) => fetch(url, init));
    this.hosts = o.hosts ?? TIKTOK_IMAGE_HOSTS;
    this.tmpRoot = o.tmpRoot ?? tmpdir();
    this.waitMs = o.waitMs ?? IMAGE_WAIT_MS;
    this.fetchTimeoutMs = o.fetchTimeoutMs ?? FETCH_TIMEOUT_MS;
    this.maxBytes = o.maxBytes ?? IMAGE_MAX_BYTES;
  }

  /**
   * One picture as a data URI, or undefined. `width` is the longest side in px (IMAGE_PX by default). Waits up to
   * IMAGE_WAIT_MS, or until `signal` aborts; a fetch still going then finishes into the cache. Never throws.
   */
  async dataUri(url: unknown, opts: { width?: number; signal?: AbortSignal } = {}): Promise<string | undefined> {
    const started = this.o.clock.now();
    const wait = waitFor(this.waitMs, opts.signal);
    const r = await this.settle(this.start(url, pxOf(opts.width)), wait.done);
    wait.stop();
    log(`image ${r.outcome} ${Math.max(0, this.o.clock.now() - started)}ms`);
    return r.uri;
  }

  /**
   * Several pictures in parallel, keyed as given (post id → URL). Whatever hasn't arrived within `budgetMs`
   * (IMAGE_WAIT_MS by default) or before `signal` aborts is left out of this answer; it still lands in the cache for
   * the next read. Never throws.
   */
  async many(urls: Record<string, unknown>, opts: { width?: number; budgetMs?: number; signal?: AbortSignal } = {}): Promise<Record<string, string>> {
    const started = this.o.clock.now();
    const entries = Object.entries(urls);
    const out: Record<string, string> = {};
    if (!entries.length) return out;
    const px = pxOf(opts.width);
    const counts: Partial<Record<Outcome, number>> = {};
    const wait = waitFor(opts.budgetMs ?? this.waitMs, opts.signal);
    await Promise.all(
      entries.map(async ([key, url]) => {
        const r = await this.settle(this.start(url, px), wait.done);
        counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
        if (r.uri) out[key] = r.uri;
      }),
    );
    wait.stop();
    const got = Object.keys(out).length;
    const detail = Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(" ");
    log(`images ${got}/${entries.length}${detail ? ` ${detail}` : ""} ${Math.max(0, this.o.clock.now() - started)}ms`);
    return out;
  }

  /** The job's result, or "wait" when `stop` comes first (the job then runs on into the cache). */
  private async settle(job: Result | Job, stop: Promise<void>): Promise<Result> {
    if (!isJob(job)) return job;
    const r = await Promise.race([job.done, stop.then(() => undefined)]);
    if (r) return r;
    job.late = true;
    return { outcome: "wait" };
  }

  /** A cached or refused picture right away, else the (shared) fetch for it. */
  private start(raw: unknown, px: number): Result | Job {
    if (this.o.offline) return { outcome: "off" };
    const v = vet(raw, this.hosts);
    if (!("url" in v)) {
      if (v.why === "none") return { outcome: "none" };
      this.refused(v.why, v.host);
      return { outcome: "host" };
    }
    const key = `${px}|${v.url.href}`;
    const now = this.o.clock.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at <= IMAGE_CACHE_MS) return { uri: hit.uri, outcome: "cached" };
    if (hit) this.cache.delete(key);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const job: Job = { started: now, late: false, done: Promise.resolve<Result>({ outcome: "net" }) };
    job.done = this.load(v.url, px)
      .then(
        (uri): Result => {
          this.remember(key, uri);
          return { uri, outcome: "ok" };
        },
        (e: unknown): Result => ({
          outcome: e instanceof Skip ? e.outcome : (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError" ? "timeout" : "net",
        }),
      )
      .then((r) => {
        this.inflight.delete(key);
        if (job.late) log(`image late ${r.outcome} ${Math.max(0, this.o.clock.now() - job.started)}ms`);
        return r;
      });
    this.inflight.set(key, job);
    return job;
  }

  /** Why a URL was refused and its hostname, once each (a new CDN host shows up here first). */
  private refused(why: Refusal, host?: string): void {
    const line = `${why} ${loggable(host)}`;
    if (this.refusals.has(line) || this.refusals.size >= 64) return;
    this.refusals.add(line);
    log(`image refused ${line}`);
  }

  private remember(key: string, uri: string): void {
    this.cache.set(key, { at: this.o.clock.now(), uri });
    while (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  /** At most SCALE_CONCURRENCY scale jobs at a time. */
  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.scaling >= SCALE_CONCURRENCY) await new Promise<void>((r) => this.queued.push(r));
    this.scaling++;
    try {
      return await fn();
    } finally {
      this.scaling--;
      this.queued.shift()?.();
    }
  }

  /** The bytes, within FETCH_TIMEOUT_MS and the size cap, from a 200 that looks like an image. */
  private async download(u: URL): Promise<Uint8Array> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Image request timed out", "TimeoutError")), this.fetchTimeoutMs);
    try {
      const at = u;
      const res = await this.fetchImpl(at.href, { method: "GET", redirect: "manual", signal: controller.signal, headers: { accept: ACCEPT } });
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => {});
        log(`image http ${res.status} ${loggable(at.hostname)}`);
        throw new Skip("http");
      }
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      if (type && !type.startsWith("image/") && !type.startsWith("application/octet-stream") && !type.startsWith("binary/octet-stream")) {
        await res.body?.cancel().catch(() => {});
        throw new Skip("type");
      }
      return await readCapped(res, this.maxBytes);
    } finally {
      clearTimeout(timer);
    }
  }

  private async load(u: URL, px: number): Promise<string> {
    const bytes = await this.download(u);
    if (!bytes.length) throw new Skip("type");
    const kind = kindOf(bytes);
    const cap = px <= SMALL_PX ? SMALL_DATA_URI : MAX_DATA_URI;
    if (kind !== "other" && bytes.length <= DIRECT_MAX_BYTES) {
      const uri = asUri(bytes, kind, cap);
      if (uri) return uri;
    }
    const scaled = await this.slot(() => scaleDown(bytes, px, cap, this.o.runner, this.tmpRoot));
    if (scaled) return scaled;
    // sips couldn't (no decoder for it, Windows without the codec, a timeout): as it is, when it fits.
    const direct = kind !== "other" ? asUri(bytes, kind, cap) : undefined;
    if (direct) return direct;
    throw new Skip("scale");
  }
}
