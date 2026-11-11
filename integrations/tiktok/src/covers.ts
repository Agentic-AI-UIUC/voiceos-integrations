/**
 * Remote pictures for the result cards: the profile picture (`avatar_url_100`) and post covers
 * (`cover_image_url`). Widgets have no network, so each picture travels inside the card as a small JPEG
 * `data:` URI.
 *
 * Only from TikTok's image CDN, exact hosts (TIKTOK_IMAGE_HOSTS, which the build also writes into the
 * manifest's network permission), https only, no redirects followed, 1.5 s per picture, at most 1.5 MB read.
 * `sips` scales each one down to a ≤ 120 px wide JPEG (a picture that's already a small JPEG or PNG is used
 * as it is). Results are cached by URL for 30 minutes, and requests for the same URL share one fetch.
 *
 * Best effort: every failure is "no picture" and the card shows its fallback tile. Logs carry counts,
 * durations and outcome codes, never a URL (they're signed links to the user's media).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TIKTOK_IMAGE_HOSTS } from "./config.ts";
import { log } from "./proc.ts";
import type { Clock, Runner } from "./types.ts";

export const IMAGE_TIMEOUT_MS = 1_500;
export const IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;
/** Covers and the avatar: ≤ 120 px wide (a 9:16 cover comes out 120 × 213). */
export const IMAGE_WIDTH = 120;
export const IMAGE_CACHE_MS = 30 * 60_000;
/** A picture already this small (JPEG or PNG) goes into the card as it is: no sips pass. */
const DIRECT_MAX_BYTES = 20 * 1024;
/** What a card accepts (the cards' own check is the same pattern). */
export const DATA_URI_RE = /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/;
/** Largest data URI handed to a card, so a few covers stay well inside a card's size budget. */
const MAX_DATA_URI = 45 * 1024;
const CACHE_MAX = 200;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/** The URL as a fetchable https URL on one of the allowed hosts, else undefined. */
export function allowedImageUrl(raw: unknown, hosts: readonly string[] = TIKTOK_IMAGE_HOSTS): URL | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (!text || text.length > 4096 || /\s/.test(text)) return undefined;
  let u: URL;
  try {
    u = new URL(text);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return undefined;
  const host = u.hostname.toLowerCase();
  return hosts.some((h) => h.toLowerCase() === host) ? u : undefined;
}

type Kind = "jpeg" | "png" | "other";
function kindOf(b: Uint8Array): Kind {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  return "other";
}

const dataUri = (b: Uint8Array, kind: "jpeg" | "png"): string | undefined => {
  const uri = `data:image/${kind};base64,${Buffer.from(b).toString("base64")}`;
  return uri.length <= MAX_DATA_URI ? uri : undefined;
};

/** Outcome codes for the log line (no URLs). */
type Outcome = "ok" | "cached" | "host" | "http" | "big" | "type" | "timeout" | "net" | "scale";

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
 * Bytes of any image ImageIO reads → a JPEG no wider than `width`, through sips (never upscaled). Undefined
 * when sips isn't there (CI) or fails; a small JPEG/PNG is then still usable as it is.
 */
async function scaleDown(bytes: Uint8Array, width: number, runner: Runner, tmpRoot: string): Promise<Uint8Array | undefined> {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpRoot, "tiktok-img-"));
    const src = join(dir, "in");
    const out = join(dir, "out.jpg");
    writeFileSync(src, bytes);
    const meta = await runner(["sips", "-g", "pixelWidth", "-g", "pixelHeight", src], { timeoutMs: 1_500 });
    const w = int(meta.stdout, "pixelWidth");
    if (meta.code !== 0 || !(w > 0)) return undefined;
    const resize = w > width ? ["--resampleWidth", String(width)] : [];
    const r = await runner(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "70", ...resize, src, "--out", out], { timeoutMs: 2_000 });
    if (r.code !== 0) return undefined;
    const jpeg = new Uint8Array(readFileSync(out));
    return kindOf(jpeg) === "jpeg" ? jpeg : undefined;
  } catch {
    return undefined;
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
}

export interface RemoteImagesOptions {
  runner: Runner;
  clock: Clock;
  fetch?: FetchLike;
  hosts?: readonly string[];
  tmpRoot?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

/** The avatar and cover fetcher, with its URL-keyed cache. One per server (Deps.images). */
export class RemoteImages {
  private readonly cache = new Map<string, { at: number; uri: string }>();
  private readonly inflight = new Map<string, Promise<{ uri?: string; outcome: Outcome }>>();
  private readonly fetchImpl: FetchLike;
  private readonly hosts: readonly string[];
  private readonly tmpRoot: string;
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(private readonly o: RemoteImagesOptions) {
    this.fetchImpl = o.fetch ?? ((url, init) => fetch(url, init));
    this.hosts = o.hosts ?? TIKTOK_IMAGE_HOSTS;
    this.tmpRoot = o.tmpRoot ?? tmpdir();
    this.timeoutMs = o.timeoutMs ?? IMAGE_TIMEOUT_MS;
    this.maxBytes = o.maxBytes ?? IMAGE_MAX_BYTES;
  }

  /** One picture as a JPEG/PNG data URI, or undefined. Never throws. */
  async dataUri(url: unknown, opts: { width?: number; signal?: AbortSignal } = {}): Promise<string | undefined> {
    const started = this.o.clock.now();
    const r = await this.one(url, opts.width ?? IMAGE_WIDTH, opts.signal);
    log(`image ${r.outcome} ${Math.max(0, this.o.clock.now() - started)}ms`);
    return r.uri;
  }

  /**
   * Several pictures in parallel, keyed as given (post id → URL). Whatever hasn't arrived within `budgetMs`
   * is left out of this answer (it still lands in the cache for the next read). Never throws.
   */
  async many(urls: Record<string, unknown>, opts: { width?: number; budgetMs?: number; signal?: AbortSignal } = {}): Promise<Record<string, string>> {
    const started = this.o.clock.now();
    const entries = Object.entries(urls);
    const out: Record<string, string> = {};
    if (!entries.length) return out;
    const counts: Partial<Record<Outcome, number>> = {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<void>((resolve) => (timer = setTimeout(resolve, Math.max(0, opts.budgetMs ?? 2_000))));
    const all = Promise.all(
      entries.map(async ([key, url]) => {
        const r = await this.one(url, opts.width ?? IMAGE_WIDTH, opts.signal);
        counts[r.outcome] = (counts[r.outcome] ?? 0) + 1;
        if (r.uri) out[key] = r.uri;
      }),
    );
    await Promise.race([all, budget]);
    clearTimeout(timer);
    const got = Object.keys(out).length;
    const detail = Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(" ");
    log(`images ${got}/${entries.length}${detail ? ` ${detail}` : ""} ${Math.max(0, this.o.clock.now() - started)}ms`);
    return { ...out };
  }

  private async one(raw: unknown, width: number, signal?: AbortSignal): Promise<{ uri?: string; outcome: Outcome }> {
    const u = allowedImageUrl(raw, this.hosts);
    if (!u) return { outcome: "host" };
    const key = `${width}|${u.href}`;
    const now = this.o.clock.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at <= IMAGE_CACHE_MS) return { uri: hit.uri, outcome: "cached" };
    if (hit) this.cache.delete(key);
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = this.load(u, width, signal)
      .then((uri) => {
        this.remember(key, uri);
        return { uri, outcome: "ok" as Outcome };
      })
      .catch((e: unknown) => ({ outcome: e instanceof Skip ? e.outcome : (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError" ? "timeout" : "net" }) as { uri?: string; outcome: Outcome })
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, p);
    return p;
  }

  private remember(key: string, uri: string): void {
    this.cache.set(key, { at: this.o.clock.now(), uri });
    while (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private async load(u: URL, width: number, signal?: AbortSignal): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException("Image request timed out", "TimeoutError")), this.timeoutMs);
    const timeout = controller.signal;
    try {
    const res = await this.fetchImpl(u.href, {
      method: "GET",
      redirect: "manual",
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      headers: { accept: "image/jpeg,image/png,image/webp,image/*;q=0.8" },
    });
    if (res.status !== 200) {
      await res.body?.cancel().catch(() => {});
      throw new Skip("http");
    }
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (type && !type.startsWith("image/") && !type.startsWith("application/octet-stream")) {
      await res.body?.cancel().catch(() => {});
      throw new Skip("type");
    }
    const bytes = await readCapped(res, this.maxBytes);
    if (!bytes.length) throw new Skip("type");
    const kind = kindOf(bytes);
    if (kind !== "other" && bytes.length <= DIRECT_MAX_BYTES) {
      const uri = dataUri(bytes, kind);
      if (uri) return uri;
    }
    const jpeg = await scaleDown(bytes, width, this.o.runner, this.tmpRoot);
    const uri = jpeg ? dataUri(jpeg, "jpeg") : undefined;
    if (!uri) throw new Skip("scale");
    return uri;
    } finally { clearTimeout(timer); }
  }
}
