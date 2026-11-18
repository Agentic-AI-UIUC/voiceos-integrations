/**
 * Media relay client (plan §4.4, §5.7; Studio brief "Media relay client").
 *
 * TikTok's photo endpoint only pulls images from URLs on a domain verified for
 * the app, so approved carousels are PUT to a short-lived relay on that domain:
 *
 *   POST   {base}/v1/batches {count}   → 201 { batch_id, expires_at, items: [{ index, put_path, public_url }] }
 *   PUT    {base}{put_path}             → 201 | 409 (already uploaded) — Content-Type image/jpeg | image/webp
 *   DELETE {base}/v1/batches/{id}       → 204 (idempotent)
 *
 * Every call carries `Authorization: Bearer <MEDIA_RELAY_TOKEN>` and refuses
 * redirects. Nothing here runs before the user approved the card, and nothing
 * here ever logs the token, a URL or a path: only the batch id's first 6 chars.
 */
import { TikTokError } from "./errors.ts";
import { log } from "./proc.ts";
import type { Clock } from "./types.ts";

export interface RelayBatch {
  batch_id: string;
  expires_at: string;
  items: { index: number; put_path: string; public_url: string }[];
}

const MAX_PHOTOS = 35;
const PARALLEL_PUTS = 4;
const CREATE_TIMEOUT_MS = 15_000;
const PUT_TIMEOUT_MS = 60_000;
const DELETE_TIMEOUT_MS = 10_000;
/** Batch ids go into a URL path and the logs: keep them to a safe alphabet. */
const BATCH_ID = /^[A-Za-z0-9_-]{1,128}$/;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** https anywhere; plain http only on loopback (the test mocks). The bearer token never travels in cleartext. */
function allowedOrigin(raw: string): URL | undefined {
  try {
    const u = new URL(raw);
    if (u.protocol === "https:" || (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname))) return u;
  } catch {
    /* not a URL */
  }
  return undefined;
}

const prefix = (batchId: string) => batchId.slice(0, 6);

/** Read and discard a response body so the connection is released. */
async function drain(res: Response): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
    /* already consumed or aborted */
  }
}

/** Why an aborted call stopped: the caller's own TikTokError, a deadline, or a cancel. */
function abortError(signal: AbortSignal): TikTokError {
  const reason: unknown = signal.reason;
  if (reason instanceof TikTokError) return reason;
  if (reason instanceof Error && reason.name === "TimeoutError") return new TikTokError("RELAY_UNAVAILABLE", { reason: "timeout" });
  return new TikTokError("CANCELLED");
}

/** Validate the relay's batch answer: exactly `count` items with indexes 0..count-1, absolute paths, http(s) URLs. */
function parseBatch(body: unknown, count: number): RelayBatch {
  const bad = () => new TikTokError("RELAY_UNAVAILABLE", { reason: "bad_response" });
  if (!body || typeof body !== "object") throw bad();
  const b = body as Record<string, unknown>;
  if (typeof b.batch_id !== "string" || !BATCH_ID.test(b.batch_id)) throw bad();
  if (typeof b.expires_at !== "string" || !b.expires_at) throw bad();
  if (!Array.isArray(b.items) || b.items.length !== count) throw bad();
  const items = b.items.map((raw: unknown) => {
    const it = (raw ?? {}) as Record<string, unknown>;
    const index = it.index;
    const put_path = it.put_path;
    const public_url = it.public_url;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= count) throw bad();
    // "/…" but not "//…": the PUT must stay on the relay's own origin.
    if (typeof put_path !== "string" || !put_path.startsWith("/") || put_path.startsWith("//")) throw bad();
    if (typeof public_url !== "string" || !allowedOrigin(public_url)) throw bad();
    return { index, put_path, public_url };
  });
  items.sort((x, y) => x.index - y.index);
  if (items.some((it, i) => it.index !== i)) throw bad(); // duplicate or missing index
  return { batch_id: b.batch_id, expires_at: b.expires_at, items };
}

export class RelayClient {
  /** True when both the relay base (https, or loopback http) and MEDIA_RELAY_TOKEN are set. */
  readonly configured: boolean;
  readonly #base: string;
  readonly #origin: string;
  readonly #token: string;
  readonly #fetch: typeof fetch;
  readonly #clock: Clock;

  constructor(base: string, token: string | undefined, deps: { fetch?: typeof fetch; clock: Clock }) {
    const trimmed = String(base ?? "").trim().replace(/\/+$/, "");
    const origin = trimmed ? allowedOrigin(trimmed) : undefined;
    this.#base = origin ? trimmed : "";
    this.#origin = origin?.origin ?? "";
    this.#token = String(token ?? "").trim();
    this.configured = Boolean(this.#base && this.#token);
    this.#fetch = deps.fetch ?? fetch;
    this.#clock = deps.clock;
  }

  #assertConfigured(): void {
    if (!this.configured) throw new TikTokError("RELAY_NOT_CONFIGURED", { nothing_sent: true });
  }

  /** One authenticated request on the relay's origin, with its own timeout, never following redirects. */
  #request(path: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<Response> {
    const url = `${this.#base}${path}`;
    if (new URL(url).origin !== this.#origin) return Promise.reject(new TikTokError("RELAY_UNAVAILABLE", { reason: "bad_path" }));
    const timeout = AbortSignal.timeout(timeoutMs);
    return this.#fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${this.#token}` },
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
  }

  /** POST /v1/batches. Not configured → RELAY_NOT_CONFIGURED (no network); any failure → RELAY_UNAVAILABLE. */
  async createBatch(count: number, signal?: AbortSignal): Promise<RelayBatch> {
    this.#assertConfigured();
    if (!Number.isInteger(count) || count < 1) throw new TikTokError("NO_PHOTOS", { nothing_sent: true });
    if (count > MAX_PHOTOS) throw new TikTokError("TOO_MANY_PHOTOS", { n: count, nothing_sent: true });
    const started = this.#clock.now();
    let res: Response;
    try {
      res = await this.#request(
        "/v1/batches",
        // keepalive:false — on a dropped reused socket Bun silently re-sends a POST; a fresh connection can't be replayed.
        { method: "POST", keepalive: false, headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ count }) },
        CREATE_TIMEOUT_MS,
        signal,
      );
    } catch (e) {
      if (e instanceof TikTokError) throw e;
      if (signal?.aborted) throw abortError(signal);
      log(`relay: create failed (${e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network error"})`);
      throw new TikTokError("RELAY_UNAVAILABLE", { reason: e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network" });
    }
    if (!res.ok) {
      await drain(res);
      log(`relay: create failed (HTTP ${res.status})`);
      throw new TikTokError("RELAY_UNAVAILABLE", { status: res.status });
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      log("relay: create answered with unreadable JSON");
      throw new TikTokError("RELAY_UNAVAILABLE", { reason: "bad_response" });
    }
    let batch: RelayBatch;
    try {
      batch = parseBatch(body, count);
    } catch (e) {
      log("relay: create answered with a malformed batch");
      throw e;
    }
    log(`relay: batch ${prefix(batch.batch_id)} created for ${count} in ${this.#clock.now() - started} ms`);
    return batch;
  }

  /**
   * PUT every file to its item, 4 at a time. 201 (or any 2xx) and 409 mean
   * stored; a 5xx or network error gets ONE retry; any other answer, or a
   * second failure, → RELAY_UNAVAILABLE (no new PUT starts after a failure).
   * `files[i]` goes to the item with index i. Returns public URLs in carousel order.
   */
  async putImages(
    batch: RelayBatch,
    files: { bytes: Uint8Array; mime: "image/jpeg" | "image/webp" }[],
    signal?: AbortSignal,
    onProgress?: (done: number) => void,
  ): Promise<string[]> {
    this.#assertConfigured();
    const items = [...(batch?.items ?? [])].sort((a, b) => a.index - b.index);
    if (!files || items.length !== files.length || items.some((it, i) => it.index !== i)) {
      throw new TikTokError("UNKNOWN", { message: "The photos didn't match the relay batch, so nothing was sent.", nothing_sent: true });
    }
    const id = prefix(String(batch.batch_id ?? ""));
    const started = this.#clock.now();
    const inner = new AbortController();
    const linked = signal ? AbortSignal.any([signal, inner.signal]) : inner.signal;
    let firstFailure: unknown;
    let done = 0;
    try {
      await pool(
        PARALLEL_PUTS,
        items.map((item, i) => async () => {
          try {
            await this.#putOne(item.put_path, files[i], linked);
          } catch (e) {
            firstFailure ??= e;
            inner.abort(); // stop the other in-flight PUTs
            throw e;
          }
          done++;
          try {
            onProgress?.(done);
          } catch {
            /* a progress callback can't break the upload */
          }
        }),
      );
    } catch (e) {
      if (signal?.aborted) {
        log(`relay: batch ${id} upload stopped by the caller after ${done}/${items.length}`);
        throw abortError(signal);
      }
      const err = firstFailure ?? e;
      const failure = err instanceof TikTokError ? err : new TikTokError("RELAY_UNAVAILABLE", { reason: "network" });
      log(`relay: batch ${id} upload failed after ${done}/${items.length} (${failure.detail.status ?? failure.detail.reason ?? failure.code})`);
      throw failure;
    }
    log(`relay: batch ${id} stored ${items.length} photo(s) in ${this.#clock.now() - started} ms`);
    return items.map((it) => it.public_url);
  }

  async #putOne(putPath: string, file: { bytes: Uint8Array; mime: string }, signal: AbortSignal): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      let res: Response | undefined;
      try {
        res = await this.#request(putPath, { method: "PUT", headers: { "content-type": file.mime }, body: file.bytes }, PUT_TIMEOUT_MS, signal);
      } catch (e) {
        if (e instanceof TikTokError) throw e;
        if (signal.aborted) throw e; // cancelled, or another PUT failed: no retry
        if (attempt >= 1) throw new TikTokError("RELAY_UNAVAILABLE", { reason: "network" });
      }
      if (res) {
        await drain(res);
        if (res.ok || res.status === 409) return; // 409: already uploaded (a retried PUT that had landed)
        if (res.status < 500 || attempt >= 1) throw new TikTokError("RELAY_UNAVAILABLE", { status: res.status });
      }
      await this.#clock.sleep(300 + Math.floor(Math.random() * 400), signal);
    }
  }

  /** DELETE the batch: best-effort, idempotent, never throws (the relay also expires it after 2 h). */
  async deleteBatch(batchId: string): Promise<void> {
    try {
      if (!this.configured || typeof batchId !== "string" || !BATCH_ID.test(batchId)) return;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const res = await this.#request(`/v1/batches/${encodeURIComponent(batchId)}`, { method: "DELETE" }, DELETE_TIMEOUT_MS);
          await drain(res);
          if (res.status < 500) {
            log(`relay: batch ${prefix(batchId)} delete → HTTP ${res.status}`);
            return;
          }
        } catch {
          /* network error: one more try */
        }
        if (attempt === 0) await this.#clock.sleep(300);
      }
      log(`relay: batch ${prefix(batchId)} delete didn't go through; it expires on its own`);
    } catch {
      /* best-effort by contract */
    }
  }
}

/**
 * Run tasks with at most `limit` in flight; results keep task order. After a
 * failure no new task starts; in-flight ones settle, then the first error is thrown.
 */
export async function pool<T>(limit: number, tasks: Array<() => Promise<T>>): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  const width = Math.max(1, Math.min(Math.floor(limit) || 1, tasks.length));
  let next = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async () => {
    while (!failed && next < tasks.length) {
      const i = next++;
      try {
        results[i] = await tasks[i]();
      } catch (e) {
        if (!failed) {
          failed = true;
          firstError = e;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  if (failed) throw firstError;
  return results;
}
