/**
 * TikTok media relay (plan §4.4): a Cloudflare Worker plus one SQLite-backed
 * Durable Object per batch. It implements exactly what src/relay.ts sends and
 * expects (and what tests/mock-relay.ts fakes):
 *
 *   POST   /v1/batches {count}             → 201 {batch_id, expires_at, items[{index, put_path, public_url}]}
 *   PUT    /v1/batches/{id}/{index}        → 201 {bytes} | 400 type/magic | 404 | 409 already | 410 expired | 413
 *   DELETE /v1/batches/{id}                → 204 (idempotent, unknown ids too)
 *   GET    /p/{id}/{index}.jpg|.webp       → 200 bytes (public, no auth) | 404 (unknown or deleted) | 410 (expired)
 *
 * POST, PUT and DELETE need `Authorization: Bearer <RELAY_TOKEN>` (a Worker
 * secret). Nothing here ever answers 3xx, lists anything, or logs more than the
 * method, status, the batch id's first 6 chars and a byte count.
 *
 * Not shipped by VoiceOS Publish: deploy it with `npx -y wrangler@4 deploy`.
 */
import { DurableObject } from "cloudflare:workers";

interface Env {
  /** Bearer token for POST/PUT/DELETE (`wrangler secret put RELAY_TOKEN`). */
  RELAY_TOKEN?: string;
  BATCHES: DurableObjectNamespace<Batch>;
  /** TikTok URL-property signature files: {"tiktok….txt": "tiktok-developers-site-verification=…"}. */
  TIKTOK_VERIFICATION?: Record<string, string> | string;
}

const MAX_COUNT = 35;
/** Same cap as src/images.ts MAX_IMAGE_BYTES. */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const TTL_MS = 2 * 60 * 60 * 1000;
/** After expiry a tiny row (no image data) keeps answering 410 this long, then the object is wiped. */
const TOMBSTONE_MS = 24 * 60 * 60 * 1000;
/** SQLite rows and BLOBs max out at 2 MB in a Durable Object: store images in 1 MiB chunks. */
const CHUNK_BYTES = 1024 * 1024;
const BATCH_ID = /^b_[A-Za-z0-9_-]{22}$/;
const INDEX = /^(0|[1-9][0-9]?)$/;
const VERIFY_FILE = /^[A-Za-z0-9._-]{1,128}\.txt$/;

const COMMON_HEADERS: Record<string, string> = {
  "x-robots-tag": "noindex, nofollow, noarchive",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const empty = (status: number, headers?: Record<string, string>) => new Response(null, { status, headers });

const isJpeg = (b: Uint8Array) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isWebp = (b: Uint8Array) =>
  b.length >= 12 &&
  b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && // RIFF
  b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50; // WEBP

function base64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Constant-time bearer check: both sides are hashed first so their lengths don't leak either. */
async function authorized(req: Request, env: Env): Promise<boolean> {
  const expected = typeof env.RELAY_TOKEN === "string" ? env.RELAY_TOKEN : "";
  const header = req.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(given)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const same = crypto.subtle.timingSafeEqual(a, b);
  return same && expected.length >= 32 && given.length > 0;
}

function verificationFiles(env: Env): Record<string, string> {
  const raw = env.TIKTOK_VERIFICATION;
  try {
    const map = typeof raw === "string" ? JSON.parse(raw) : raw;
    return map && typeof map === "object" ? (map as Record<string, string>) : {};
  } catch {
    return {};
  }
}

interface Outcome {
  res: Response;
  batch?: string;
  bytes?: number;
}

async function route(req: Request, env: Env): Promise<Outcome> {
  const url = new URL(req.url);
  const parts = url.pathname.split("/").slice(1); // empty segments kept: "/p/x/" never matches
  const method = req.method;

  // ---- Public: the images TikTok pulls, and the TikTok signature file ----
  if (parts[0] === "p" || parts.length === 1) {
    if (method !== "GET" && method !== "HEAD") return { res: empty(405, { allow: "GET, HEAD" }) };
    // Signature file at the root or under /p/ (the verified URL prefix).
    const name = parts[parts.length - 1];
    if ((parts.length === 1 || (parts.length === 2 && parts[0] === "p")) && VERIFY_FILE.test(name)) {
      const body = verificationFiles(env)[name];
      if (typeof body === "string") {
        return { res: new Response(method === "HEAD" ? null : body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }) };
      }
      return { res: json(404, { error: "not found" }) };
    }
    if (parts.length === 3 && parts[0] === "p" && BATCH_ID.test(parts[1])) {
      const m = /^(0|[1-9][0-9]?)\.(jpg|jpeg|webp)$/.exec(parts[2]);
      if (m && Number(m[1]) < MAX_COUNT) {
        const batch = parts[1];
        const stub = env.BATCHES.get(env.BATCHES.idFromName(batch));
        const res = await stub.fetch(new Request(`https://batch/get/${m[1]}`, { method }));
        return { res, batch, bytes: Number(res.headers.get("content-length") ?? 0) };
      }
    }
    return { res: json(404, { error: "not found" }) };
  }

  // ---- Authenticated: everything under /v1 ----
  if (parts[0] === "v1") {
    if (!(await authorized(req, env))) return { res: json(401, { error: "unauthorized" }) };
    if (parts[1] !== "batches") return { res: json(404, { error: "no route" }) };

    if (parts.length === 2) {
      if (method !== "POST") return { res: empty(405, { allow: "POST" }) };
      return createBatch(req, env, url);
    }

    const batch = parts[2];
    if (parts.length === 3) {
      if (method !== "DELETE") return { res: empty(405, { allow: "DELETE" }) };
      if (BATCH_ID.test(batch)) await env.BATCHES.get(env.BATCHES.idFromName(batch)).remove();
      return { res: empty(204), batch };
    }

    if (parts.length === 4) {
      if (method !== "PUT") return { res: empty(405, { allow: "PUT" }) };
      const bytes = Number(req.headers.get("content-length") ?? 0);
      if (!BATCH_ID.test(batch)) return { res: json(404, { error: "no such batch" }), bytes };
      if (!INDEX.test(parts[3]) || Number(parts[3]) >= MAX_COUNT) return { res: json(404, { error: "bad index" }), batch, bytes };
      if (bytes > MAX_IMAGE_BYTES) return { res: json(413, { error: "too large" }), batch, bytes };
      const stub = env.BATCHES.get(env.BATCHES.idFromName(batch));
      const res = await stub.fetch(new Request(`https://batch/put/${parts[3]}`, req));
      return { res, batch, bytes };
    }
    return { res: json(404, { error: "no route" }) };
  }

  return { res: json(404, { error: "not found" }) };
}

async function createBatch(req: Request, env: Env, url: URL): Promise<Outcome> {
  if (Number(req.headers.get("content-length") ?? 0) > 1024) return { res: json(413, { error: "body too large" }) };
  let count: unknown;
  try {
    const text = await req.text();
    if (text.length > 1024) return { res: json(413, { error: "body too large" }) };
    count = (JSON.parse(text) as { count?: unknown } | null)?.count;
  } catch {
    return { res: json(400, { error: "bad json" }) };
  }
  if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > MAX_COUNT) {
    return { res: json(400, { error: `count must be 1..${MAX_COUNT}` }) };
  }
  const batch_id = `b_${base64url(crypto.getRandomValues(new Uint8Array(16)))}`; // 128 random bits
  const now = Date.now();
  const expires = now + TTL_MS;
  const created = await env.BATCHES.get(env.BATCHES.idFromName(batch_id)).init(count, now, expires);
  if (!created) return { res: json(503, { error: "try again" }), batch: batch_id };
  const origin = `https://${url.host}`;
  const items = Array.from({ length: count }, (_, index) => ({
    index,
    put_path: `/v1/batches/${batch_id}/${index}`,
    public_url: `${origin}/p/${batch_id}/${index}.jpg`,
  }));
  return { res: json(201, { batch_id, expires_at: new Date(expires).toISOString(), items }), batch: batch_id };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    let out: Outcome;
    try {
      out = await route(req, env);
    } catch {
      out = { res: json(500, { error: "relay error" }) };
    }
    const res = new Response(out.res.body, out.res); // DO responses have immutable headers
    for (const [k, v] of Object.entries(COMMON_HEADERS)) res.headers.set(k, v);
    // Method, status, batch prefix and bytes only: never a token, a URL, a path or image contents.
    console.log(`${req.method} ${res.status} ${out.batch ? out.batch.slice(0, 6) : "-"} ${Number.isFinite(out.bytes) ? out.bytes : 0}`);
    return res;
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// One Durable Object per batch
// ---------------------------------------------------------------------------

interface Meta {
  count: number;
  created_at: number;
  expires_at: number;
  state: "active" | "expired";
}

export class Batch extends DurableObject<Env> {
  /** The batch row, or null when this object was never initialised (reads never create tables). */
  #meta(): Meta | null {
    try {
      const rows = this.ctx.storage.sql.exec("SELECT count, created_at, expires_at, state FROM batch WHERE id = 1").toArray();
      return (rows[0] as unknown as Meta | undefined) ?? null;
    } catch (e) {
      if (e instanceof Error && /no such table/i.test(e.message)) return null;
      throw e;
    }
  }

  #hasObject(index: number): boolean {
    return this.ctx.storage.sql.exec("SELECT 1 FROM objects WHERE idx = ?", index).toArray().length > 0;
  }

  /** RPC from POST /v1/batches. False only on an id collision (practically impossible). */
  async init(count: number, createdAt: number, expiresAt: number): Promise<boolean> {
    if (this.#meta()) return false;
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec(
        "CREATE TABLE IF NOT EXISTS batch (id INTEGER PRIMARY KEY CHECK (id = 1), count INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, state TEXT NOT NULL)",
      );
      sql.exec("CREATE TABLE IF NOT EXISTS objects (idx INTEGER PRIMARY KEY, content_type TEXT NOT NULL, size INTEGER NOT NULL, chunks INTEGER NOT NULL)");
      sql.exec("CREATE TABLE IF NOT EXISTS chunks (idx INTEGER NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY (idx, seq))");
      sql.exec("INSERT INTO batch (id, count, created_at, expires_at, state) VALUES (1, ?, ?, ?, 'active')", count, createdAt, expiresAt);
    });
    await this.ctx.storage.setAlarm(expiresAt);
    return true;
  }

  /** RPC from DELETE /v1/batches/{id}: wipe everything now (GET then answers 404). Idempotent. */
  async remove(): Promise<void> {
    if (!this.#meta()) return; // never created, or already wiped: write nothing
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  /** Expiry: drop the images at expires_at, keep a tombstone so GET says 410, then wipe the object. */
  async alarm(): Promise<void> {
    const meta = this.#meta();
    if (!meta) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const now = Date.now();
    if (now < meta.expires_at) {
      await this.ctx.storage.setAlarm(meta.expires_at);
      return;
    }
    if (now >= meta.expires_at + TOMBSTONE_MS) {
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      sql.exec("DELETE FROM chunks");
      sql.exec("DELETE FROM objects");
      sql.exec("UPDATE batch SET state = 'expired' WHERE id = 1");
    });
    await this.ctx.storage.setAlarm(meta.expires_at + TOMBSTONE_MS);
  }

  async fetch(req: Request): Promise<Response> {
    const [, op, rawIndex] = new URL(req.url).pathname.split("/");
    const index = Number(rawIndex);
    if (op === "put") return this.#put(req, index);
    if (op === "get") return this.#get(req, index);
    return json(404, { error: "no route" });
  }

  #gone(meta: Meta): boolean {
    return meta.state !== "active" || Date.now() >= meta.expires_at;
  }

  async #put(req: Request, index: number): Promise<Response> {
    let meta = this.#meta();
    if (!meta) return json(404, { error: "no such batch" });
    if (this.#gone(meta)) return json(410, { error: "expired" });
    if (!Number.isInteger(index) || index < 0 || index >= meta.count) return json(404, { error: "bad index" });
    const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "image/jpeg" && type !== "image/webp") return json(400, { error: "bad type" });
    if (Number(req.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) return json(413, { error: "too large" });
    if (this.#hasObject(index)) return json(409, { error: "already uploaded" });

    const body = await readCapped(req, MAX_IMAGE_BYTES);
    if (body === null) return json(413, { error: "too large" });
    if (body.length === 0 || !(type === "image/jpeg" ? isJpeg(body) : isWebp(body))) return json(400, { error: "bad magic" });

    // Re-check after the await: the batch may have been deleted, or a retried PUT may have landed meanwhile.
    meta = this.#meta();
    if (!meta) return json(404, { error: "no such batch" });
    if (this.#gone(meta)) return json(410, { error: "expired" });
    if (this.#hasObject(index)) return json(409, { error: "already uploaded" });

    const sql = this.ctx.storage.sql;
    this.ctx.storage.transactionSync(() => {
      let seq = 0;
      for (let off = 0; off < body.length; off += CHUNK_BYTES, seq++) {
        sql.exec("INSERT INTO chunks (idx, seq, data) VALUES (?, ?, ?)", index, seq, body.subarray(off, off + CHUNK_BYTES));
      }
      sql.exec("INSERT INTO objects (idx, content_type, size, chunks) VALUES (?, ?, ?, ?)", index, type, body.length, seq);
    });
    return json(201, { bytes: body.length });
  }

  #get(req: Request, index: number): Response {
    const meta = this.#meta();
    if (!meta) return json(404, { error: "not found" });
    if (this.#gone(meta)) return json(410, { error: "expired" });
    const obj = this.ctx.storage.sql
      .exec("SELECT content_type, size, chunks FROM objects WHERE idx = ?", index)
      .toArray()[0] as { content_type: string; size: number; chunks: number } | undefined;
    if (!obj) return json(404, { error: "not found" });
    const headers = { "content-type": obj.content_type, "content-length": String(obj.size) };
    if (req.method === "HEAD") return new Response(null, { status: 200, headers });
    const parts = this.ctx.storage.sql
      .exec("SELECT data FROM chunks WHERE idx = ? ORDER BY seq", index)
      .toArray()
      .map((r) => r.data as ArrayBuffer);
    const total = parts.reduce((n, p) => n + p.byteLength, 0);
    if (parts.length !== obj.chunks || total !== obj.size) return json(500, { error: "corrupt object" });
    return new Response(new Blob(parts, { type: obj.content_type }), { status: 200, headers });
  }
}

/** The request body, or null when it's over `cap` bytes. */
async function readCapped(req: Request, cap: number): Promise<Uint8Array | null> {
  if (!req.body) return new Uint8Array(0);
  if (req.headers.get("content-length") !== null) {
    // The runtime enforces the declared length, which was already checked against the cap.
    return new Uint8Array(await req.arrayBuffer());
  }
  const reader = req.body.getReader();
  const pieces: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    pieces.push(value);
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of pieces) {
    out.set(p, off);
    off += p.byteLength;
  }
  return out;
}
