/**
 * A loopback fake of the media relay (plan §4.4), for relay.test.ts and the
 * tools' end-to-end tests. It implements the HTTP contract:
 *
 *   POST   /v1/batches {count}               → 201 {batch_id, expires_at, items[{index, put_path, public_url}]}
 *   PUT    /v1/batches/{id}/{index}          → 201 {bytes, sha256} | 400 type/magic | 404 | 409 already | 410 deleted | 413
 *   DELETE /v1/batches/{id}                  → 204 (idempotent, unknown ids too)
 *   GET    /p/{id}/{index}.jpg               → 200 bytes (public, no auth) | 404
 *
 * Every authenticated call must carry `Authorization: Bearer <token>` (else 401).
 * Knobs are plain mutable fields; `reset()` clears them and all recorded state, but not requests still on
 * the wire: a PUT the client aborted can arrive after it. Isolate tests with a fresh relay, not reset().
 */
import { createHash, randomBytes } from "node:crypto";

export interface RelayCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  /** Request body size. */
  bytes: number;
  /** What the mock answered. */
  status: number;
}

export interface MockRelayObject {
  bytes: Uint8Array;
  contentType: string;
}

export interface MockRelayBatch {
  batch_id: string;
  count: number;
  expires_at: string;
  objects: Map<number, MockRelayObject>;
  deleted: boolean;
}

export interface MockRelay {
  /** http://127.0.0.1:<port> (no trailing slash): pass it as the relay base. */
  baseUrl: string;
  token: string;
  /** Every request, in arrival order (the status is filled in when it's answered). */
  calls: RelayCall[];
  batches: Map<string, MockRelayBatch>;
  /** Batch ids DELETEd, in order; repeats are kept. */
  deletes: string[];
  // ---- knobs ----
  /** Item indexes whose FIRST PUT answers 503 (later PUTs behave normally). */
  failPutOnce: Set<number>;
  /** Item indexes whose PUTs always answer 503. */
  failPutAlways: Set<number>;
  /** Force this HTTP status for every PUT of these item indexes (e.g. 403, 409). */
  putStatus: Map<number, number>;
  /** Force the batch-create answer to this status (e.g. 500, 403). */
  createStatus?: number;
  /** Replace the batch-create JSON body (to test malformed answers). */
  createBody?: unknown;
  /** Return the batch's items in reverse order (the client must sort by index). */
  shuffleItems: boolean;
  /** Hold each PUT this long before answering, so parallelism is observable. */
  putDelayMs: number;
  /** PUTs being handled right now, and the most seen at once. */
  inFlight: number;
  maxInFlight: number;
  // ---- helpers ----
  /** PUT calls, optionally only those for one item index. */
  puts(index?: number): RelayCall[];
  reset(): void;
  stop(): void;
}

const MAX_OBJECT_BYTES = 20 * 1024 * 1024;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const isJpeg = (b: Uint8Array) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
const isWebp = (b: Uint8Array) =>
  b.length >= 12 &&
  String.fromCharCode(b[0], b[1], b[2], b[3]) === "RIFF" &&
  String.fromCharCode(b[8], b[9], b[10], b[11]) === "WEBP";

export function startMockRelay(opts: { token?: string } = {}): MockRelay {
  const token = opts.token ?? "relay-test-token";
  const putCounts = new Map<string, number>();

  const state: MockRelay = {
    baseUrl: "",
    token,
    calls: [],
    batches: new Map(),
    deletes: [],
    failPutOnce: new Set(),
    failPutAlways: new Set(),
    putStatus: new Map(),
    createStatus: undefined,
    createBody: undefined,
    shuffleItems: false,
    putDelayMs: 0,
    inFlight: 0,
    maxInFlight: 0,
    puts(index?: number) {
      return state.calls.filter(
        (c) => c.method === "PUT" && (index === undefined || c.path.endsWith(`/${index}`)),
      );
    },
    reset() {
      state.calls.length = 0;
      state.batches.clear();
      state.deletes.length = 0;
      state.failPutOnce.clear();
      state.failPutAlways.clear();
      state.putStatus.clear();
      state.createStatus = undefined;
      state.createBody = undefined;
      state.shuffleItems = false;
      state.putDelayMs = 0;
      state.inFlight = 0;
      state.maxInFlight = 0;
      putCounts.clear();
    },
    stop() {
      server.stop(true);
    },
  };

  async function handle(req: Request, call: RelayCall, body: Uint8Array): Promise<Response> {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    // Public GET: no auth (TikTok fetches these).
    if (req.method === "GET" && parts[0] === "p" && parts.length === 3) {
      const batch = state.batches.get(parts[1]);
      const index = Number(parts[2].replace(/\.(jpg|webp)$/, ""));
      const obj = batch && !batch.deleted ? batch.objects.get(index) : undefined;
      if (!obj) return new Response("not found", { status: 404 });
      return new Response(obj.bytes, { status: 200, headers: { "content-type": obj.contentType, "x-robots-tag": "noindex" } });
    }

    if (req.headers.get("authorization") !== `Bearer ${token}`) return json(401, { error: "unauthorized" });

    // POST /v1/batches
    if (req.method === "POST" && parts.length === 2 && parts[0] === "v1" && parts[1] === "batches") {
      if (state.createStatus !== undefined) return json(state.createStatus, { error: "forced" });
      let count: unknown;
      try {
        count = JSON.parse(new TextDecoder().decode(body)).count;
      } catch {
        return json(400, { error: "bad json" });
      }
      if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 35) {
        return json(400, { error: "count must be 1..35" });
      }
      const batch_id = `b_${randomBytes(16).toString("base64url")}`;
      const expires_at = new Date(Date.now() + TWO_HOURS_MS).toISOString();
      state.batches.set(batch_id, { batch_id, count, expires_at, objects: new Map(), deleted: false });
      let items = Array.from({ length: count }, (_, index) => ({
        index,
        put_path: `/v1/batches/${batch_id}/${index}`,
        public_url: `${state.baseUrl}/p/${batch_id}/${index}.jpg`,
      }));
      if (state.shuffleItems) items = items.reverse();
      return json(201, state.createBody ?? { batch_id, expires_at, items });
    }

    // PUT /v1/batches/{id}/{index}
    if (req.method === "PUT" && parts.length === 4 && parts[0] === "v1" && parts[1] === "batches") {
      const [, , id, rawIndex] = parts;
      const index = Number(rawIndex);
      const key = `${id}/${rawIndex}`;
      const nth = (putCounts.get(key) ?? 0) + 1;
      putCounts.set(key, nth);
      state.inFlight++;
      state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
      try {
        if (state.putDelayMs > 0) await Bun.sleep(state.putDelayMs);
        const forced = state.putStatus.get(index);
        if (forced !== undefined) return json(forced, { error: "forced" });
        if (state.failPutAlways.has(index)) return json(503, { error: "unavailable" });
        if (state.failPutOnce.has(index) && nth === 1) return json(503, { error: "unavailable" });
        const batch = state.batches.get(id);
        if (!batch) return json(404, { error: "no such batch" });
        if (batch.deleted) return json(410, { error: "gone" });
        if (!Number.isInteger(index) || index < 0 || index >= batch.count) return json(404, { error: "bad index" });
        const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (type !== "image/jpeg" && type !== "image/webp") return json(400, { error: "bad type" });
        if (type === "image/jpeg" ? !isJpeg(body) : !isWebp(body)) return json(400, { error: "bad magic" });
        if (body.length > MAX_OBJECT_BYTES) return json(413, { error: "too large" });
        if (batch.objects.has(index)) return json(409, { error: "already uploaded" });
        batch.objects.set(index, { bytes: body, contentType: type });
        return json(201, { bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") });
      } finally {
        state.inFlight--;
      }
    }

    // DELETE /v1/batches/{id}
    if (req.method === "DELETE" && parts.length === 3 && parts[0] === "v1" && parts[1] === "batches") {
      const id = parts[2];
      state.deletes.push(id);
      const batch = state.batches.get(id);
      if (batch) {
        batch.deleted = true;
        batch.objects.clear();
      }
      return new Response(null, { status: 204 });
    }

    return json(404, { error: "no route" });
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = new Uint8Array(await req.arrayBuffer());
      const headers: Record<string, string> = {};
      req.headers.forEach((v, k) => {
        headers[k] = v;
      });
      const call: RelayCall = { method: req.method, path: url.pathname, headers, bytes: body.length, status: 0 };
      state.calls.push(call);
      const res = await handle(req, call, body);
      call.status = res.status;
      return res;
    },
  });

  state.baseUrl = `http://127.0.0.1:${server.port}`;
  return state;
}
