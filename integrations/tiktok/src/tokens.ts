/**
 * Server tokens: what the model holds instead of file paths and account facts
 * (plan §7.1 "Token set"; Studio brief "Server tokens").
 *
 *   file_token    find_recent_videos   one video: path, size, mtime, …        15 min
 *   image_token   find_recent_images   one image: path, size, mtime, …        30 min
 *   bundle_token  prepare_photo_post   ordered images + cover index           30 min
 *   post_token    query_creator_info   account, nickname, options, flags,     10 min
 *                                      the media token it was fetched for
 *
 * A token is "<kind>t1.<exp base36>.<nonce, 24 hex>.<mac, base64url>". The ref
 * itself stays in this process's registry under the nonce; the token string
 * never carries a path, name or account id. mac = HMAC-SHA256(key,
 * "<kind>t1|<nonce>|<exp36>|<canonical ref>") with a random per-process key, so
 * a token can't be forged, re-kinded or have its expiry stretched, and a
 * server restart invalidates every token (the agent looks the file up again).
 *
 * Text the user edits on the card (caption, title, description) is never bound
 * here: the confirmation receipt covers it (src/receipts.ts).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { statSync, type Stats } from "node:fs";
import { basename } from "node:path";
import { TikTokError } from "./errors.ts";
import type { BundleRef, Clock, FileRef, ImageRef, PostRef } from "./types.ts";

export const FILE_TTL_MS = 15 * 60_000,
  IMAGE_TTL_MS = 30 * 60_000,
  BUNDLE_TTL_MS = 30 * 60_000,
  POST_TTL_MS = 10 * 60_000;

export type TokenKind = "file" | "image" | "bundle" | "post";

interface RefOf {
  file: FileRef;
  image: ImageRef;
  bundle: BundleRef;
  post: PostRef;
}

const PREFIX: Record<TokenKind, string> = { file: "ft1", image: "it1", bundle: "bt1", post: "pt1" };
const TTL: Record<TokenKind, number> = { file: FILE_TTL_MS, image: IMAGE_TTL_MS, bundle: BUNDLE_TTL_MS, post: POST_TTL_MS };
const TOKEN = /^([fibp]t1)\.([0-9a-z]{1,11})\.([0-9a-f]{24})\.([A-Za-z0-9_-]{43})$/;
const DEFAULT_MAX = 2000;
const MIN_KEY_BYTES = 16;

interface Entry {
  kind: TokenKind;
  exp: number;
  /** A private copy of what was minted. */
  ref: unknown;
}

const stale = (kind: TokenKind) => new TikTokError("TOKEN_STALE", { kind });

export class TokenStore {
  private readonly key: Uint8Array;
  private readonly max: number;
  /** nonce → entry, oldest first (Map keeps insertion order). */
  private readonly registry = new Map<string, Entry>();

  constructor(
    private readonly clock: Clock,
    opts: { key?: Uint8Array; max?: number } = {},
  ) {
    if (opts.key !== undefined && opts.key.length < MIN_KEY_BYTES) {
      throw new RangeError(`TokenStore key must be at least ${MIN_KEY_BYTES} bytes`);
    }
    this.key = opts.key !== undefined ? Uint8Array.from(opts.key) : crypto.getRandomValues(new Uint8Array(32));
    this.max = opts.max !== undefined && Number.isFinite(opts.max) ? Math.max(1, Math.floor(opts.max)) : DEFAULT_MAX;
  }

  mintFile(ref: FileRef): string {
    return this.mint("file", ref);
  }
  mintImage(ref: ImageRef): string {
    return this.mint("image", ref);
  }
  mintBundle(ref: BundleRef): string {
    return this.mint("bundle", ref);
  }
  mintPost(ref: PostRef): string {
    return this.mint("post", ref);
  }

  /** Unknown, malformed, another kind's, expired or tampered → TikTokError("TOKEN_STALE", { kind: "file" }). */
  file(token: unknown): FileRef {
    return this.resolve("file", token);
  }
  image(token: unknown): ImageRef {
    return this.resolve("image", token);
  }
  bundle(token: unknown): BundleRef {
    return this.resolve("bundle", token);
  }
  post(token: unknown): PostRef {
    return this.resolve("post", token);
  }

  private mint<K extends TokenKind>(kind: K, ref: RefOf[K]): string {
    const copy = structuredClone(ref);
    const exp = Math.floor(this.clock.now()) + TTL[kind];
    let nonce: string;
    do nonce = randomHex(12);
    while (this.registry.has(nonce));
    this.admit(nonce, { kind, exp, ref: copy });
    const exp36 = exp.toString(36);
    return `${PREFIX[kind]}.${exp36}.${nonce}.${this.mac(PREFIX[kind], nonce, exp36, copy)}`;
  }

  private resolve<K extends TokenKind>(kind: K, token: unknown): RefOf[K] {
    const m = typeof token === "string" ? TOKEN.exec(token.trim()) : null;
    if (!m || m[1] !== PREFIX[kind]) throw stale(kind);
    const [, prefix, exp36, nonce, mac] = m as unknown as [string, string, string, string, string];
    const entry = this.registry.get(nonce);
    if (!entry || entry.kind !== kind || entry.exp.toString(36) !== exp36) throw stale(kind);
    // Recomputed from what this process holds, compared as text in constant time.
    if (!sameText(this.mac(prefix, nonce, exp36, entry.ref), mac)) throw stale(kind);
    if (this.clock.now() > entry.exp) {
      this.registry.delete(nonce);
      throw stale(kind);
    }
    return structuredClone(entry.ref) as RefOf[K];
  }

  /** Bounded: when full, drop expired tokens first, then the oldest. */
  private admit(nonce: string, entry: Entry): void {
    if (this.registry.size >= this.max) {
      const now = this.clock.now();
      for (const [k, e] of this.registry) if (now > e.exp) this.registry.delete(k);
      for (const k of this.registry.keys()) {
        if (this.registry.size < this.max) break;
        this.registry.delete(k);
      }
    }
    this.registry.set(nonce, entry);
  }

  private mac(prefix: string, nonce: string, exp36: string, ref: unknown): string {
    return createHmac("sha256", this.key).update(`${prefix}|${nonce}|${exp36}|${canonical(ref)}`, "utf8").digest("base64url");
  }
}

/**
 * The file must still be what the token bound (plan §6.5 "Re-stat the file"):
 * gone → FILE_NOT_FOUND; no longer readable → FOLDER_PERMISSION_DENIED;
 * different size or mtime → TOKEN_STALE { reason: "file_changed" }. Errors
 * carry the basename only. mtimes within 1 ms count as equal, so a ref whose
 * mtime was rounded to whole milliseconds still matches. `kind: "image"` makes
 * a changed photo's message speak of photos rather than the video.
 */
export function restat(ref: { path: string; size: number; mtimeMs: number; folder?: string }, kind?: "image"): void {
  const name = basename(ref.path);
  let st: Stats;
  try {
    st = statSync(ref.path);
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === "EACCES" || code === "EPERM") {
      const top = typeof ref.folder === "string" ? ref.folder.split("/")[0] : "";
      throw new TikTokError("FOLDER_PERMISSION_DENIED", top ? { name, folders: [top] } : { name });
    }
    throw new TikTokError("FILE_NOT_FOUND", { name });
  }
  if (!st.isFile()) throw new TikTokError("FILE_NOT_FOUND", { name });
  if (st.size !== ref.size || !(Math.abs(st.mtimeMs - ref.mtimeMs) < 1)) {
    throw new TikTokError("TOKEN_STALE", { reason: "file_changed", name, ...(kind ? { kind } : {}) });
  }
}

/** Deterministic JSON: object keys sorted, undefined members dropped. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

/** Constant-time comparison of two strings (as bytes, so a changed last base64url character always counts). */
function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}
