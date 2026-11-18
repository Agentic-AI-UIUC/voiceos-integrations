/**
 * Composio REST v3.1 client (plan §5.1–5.4, §5.6; Studio brief "Composio client (REST v3.1)"). No SDK.
 *
 * - The API key goes only to `cfg.baseUrl` (backend.composio.dev, or a loopback test server), never across a
 *   redirect (`redirect: "error"`), and never to the presigned storage host.
 * - Every execute pins TIKTOK_TOOLKIT_VERSION and names the user and the connected account. The account must
 *   be ACTIVE, not disabled, a TikTok account and owned by COMPOSIO_USER_ID (checked with the list filters,
 *   because the single-account GET's user_id is deprecated); the result is cached for 60 s.
 * - Reads: one retry on a 5xx, a network error or an unreadable 200, after ~500 ms of jitter, never past the
 *   deadline. Writes: never retried; a lost answer is OUTCOME_UNKNOWN, because the post may exist, and so is a
 *   failure Composio reports without TikTok's own error code.
 * - Writes go out on a fresh connection (`keepalive: false`). On Bun 1.3.13, when a reused keep-alive socket
 *   closes before any answer, fetch re-sends the request once by itself; for a write that is a second upload.
 * - Logs (stderr): slug, duration, our code and the Composio/TikTok log ids. Nothing else.
 */
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { basename } from "node:path";
import { TIKTOK_TOOLKIT_VERSION, type Config } from "./config.ts";
import { TikTokError, isAuthShaped, normalizeError, tiktokErrorFrom, type NormalizeContext, type TikTokErrorCode } from "./errors.ts";
import { log } from "./proc.ts";
import TKR from "./receiptCoreScript.ts";
import type { Clock, StagedFile } from "./types.ts";

export interface ClientDeps {
  fetch?: typeof fetch;
  clock: Clock;
}

export interface ExecOptions {
  /** Absolute time (the clock's epoch ms) by which the whole call must be done. */
  deadline: number;
  /** A write: never retried, and a lost answer is OUTCOME_UNKNOWN. */
  write?: boolean;
  /** Per-request timeout (uploads pass a size-based one); default 8 s, always capped by the deadline. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** VoiceOS Limits: "~8 s timeouts on your own fetches". */
export const PER_REQUEST_TIMEOUT_MS = 8_000;
/** Budget for a sync (read) tool: well under VoiceOS's 30 s target. Also assertAccount's default deadline. */
export const SYNC_TOOL_BUDGET_MS = 20_000;
/** A request isn't started with less than this left before the deadline. */
export const MIN_REQUEST_MS = 1_000;
export const ACCOUNT_CACHE_MS = 60_000;

/**
 * A write that gets any 5xx back has an unknown outcome: a gateway error (502/503/504) may have hidden a
 * delivered request, and a Composio 500 can follow TikTok's accepted init. An unknown state is safer
 * than a duplicate post (plan §5.3/§5.6), so none of these are reported as "nothing was posted".
 */
const writeOutcomeLost = (status: number) => status >= 500;

/**
 * A write's app failure (HTTP 200 + successful:false) without TikTok's own error code has an unknown outcome.
 * Composio ran the tool, and its words alone can't say whether TikTok already has the post: its backend may have lost
 * TikTok's answer (a timeout, a dropped connection, a 5xx), or failed at a step after TikTok accepted the init. A
 * failure reported as "failed" gets sent again, and a second send is a duplicate post (QA, PR 47). Two kinds keep
 * their meaning: TikTok's own error (any code, listed or not: TikTok refused it), and Composio's own refusal by its
 * slug (connection, key or rate limit: answered before the tool reached TikTok, and worth its own advice).
 */
const writeAppFailureUnknown = (err: TikTokError) => err.detail.tiktok_code === undefined && err.detail.source !== "composio";
/** What a fresh account check can conclude; anything else means the check itself couldn't run. */
const ACCOUNT_CODES = new Set<TikTokErrorCode>(["NOT_CONFIGURED", "NOT_CONNECTED", "AUTH_EXPIRED", "AUTH_REVOKED"]);
const ENVELOPE_KEYS = new Set(["data", "error", "successful", "log_id"]);
/** Plain-http presigned URLs are accepted only for these (the loopback test mock). */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
/** Presigned hosts already logged by this process (spike S2 reads them to set the network permission). */
const loggedUploadHosts = new Set<string>();
const NEVER: AbortSignal = new AbortController().signal;

type Lost = "timeout" | "aborted" | "network" | "redirect";
interface Answer {
  status: number;
  ok: boolean;
  /** The parsed body; undefined when empty or not JSON. */
  json: any;
}
type Outcome = { answer: Answer; lost?: undefined } | { lost: Lost; answer?: undefined };
interface LogIds {
  composio?: string;
  tiktok?: string;
}
type BunFileLike = ReturnType<typeof Bun.file>;

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const safeId = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9._:-]{1,80}$/.test(v) ? v : undefined);
const safeSlug = (v: string) => (/^[A-Za-z0-9_]{1,64}$/.test(v) ? v : "INVALID_SLUG");

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Composio documents `data` as a string: parse each level, and surface TikTok's own error object instead of
 * dropping it (plan §5.3 v3). Unwraps `{ data, error, successful, log_id }` envelopes, at most 4 levels.
 */
export function parseData<T>(raw: unknown): T {
  let d: any = raw;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof d === "string") {
      try {
        d = JSON.parse(d);
      } catch {
        return d as T;
      }
    }
    if (d && typeof d === "object" && d.error && typeof d.error === "object" && d.error.code && d.error.code !== "ok")
      throw tiktokErrorFrom(d.error); // e.g. creator info returns spam_risk_* with HTTP 200 ("intentional", TikTok Oct 27 2026)
    const envelope = d && typeof d === "object" && "data" in d && Object.keys(d).every((k) => ENVELOPE_KEYS.has(k));
    if (!envelope) break;
    d = d.data;
  }
  return d as T;
}

/** TikTok's log_id inside a (possibly JSON-string) body, for the log line. Never throws. */
function tiktokLogId(raw: unknown): string | undefined {
  let d: any = raw;
  for (let depth = 0; depth < 4; depth++) {
    if (typeof d === "string") {
      try {
        d = JSON.parse(d);
      } catch {
        return undefined;
      }
    }
    if (!isObject(d)) return undefined;
    if (isObject(d.error) && d.error.log_id !== undefined) return safeId(d.error.log_id);
    if (!("data" in d)) return undefined;
    d = d.data;
  }
  return undefined;
}

/** Composio's own error (`{ error: { message, slug, status } }`) with a non-2xx status → our error. */
function composioError(a: Answer, ctx: NormalizeContext): TikTokError {
  const e = a.json?.error;
  const fields = isObject(e) ? e : typeof e === "string" ? { message: e } : typeof a.json?.message === "string" ? { message: a.json.message } : {};
  return normalizeError({ composioStatus: a.status, ...fields }, { ...ctx, status: a.status });
}

/**
 * The app's failure (HTTP 200 + successful:false) → our error: normalizeError(error ?? data), except that when
 * the error text is generic and `data` holds TikTok's structured error, the structured one wins (it also carries
 * TikTok's log_id).
 */
function appFailure(json: Record<string, any>, slug: string): TikTokError {
  const has = (v: unknown) => v !== undefined && v !== null && v !== "";
  const fromError = has(json.error) ? normalizeError(json.error, { slug }) : undefined;
  const fromData = has(json.data) ? normalizeError(json.data, { slug }) : undefined;
  // TikTok's structured error, even one our map doesn't list, says more than Composio's generic text.
  const tiktokSaid = (e: TikTokError) => e.code !== "UNKNOWN" || e.detail.tiktok_code !== undefined;
  if (fromData && tiktokSaid(fromData) && (!fromError || fromError.code === "UNKNOWN" || fromError.code === fromData.code)) return fromData;
  return fromError ?? fromData ?? new TikTokError("UNKNOWN", { slug });
}

function lostReadError(lost: Lost, slug: string): TikTokError {
  if (lost === "timeout") return new TikTokError("TIMEOUT", { slug });
  if (lost === "aborted") return new TikTokError("TIMEOUT", { slug, reason: "aborted" });
  if (lost === "redirect")
    return new TikTokError("UNKNOWN", { slug, reason: "redirect", message: "Composio answered with a redirect, which this integration doesn't follow." });
  return new TikTokError("TIKTOK_SERVER", { slug, reason: "network" });
}

const uploadFailed = (reason: string, status?: number) =>
  new TikTokError("UPLOAD_FAILED", { reason, ...(status !== undefined ? { status } : {}), nothing_sent: true });

/** The presigned URL, if it's safe to send the file to: https, or plain http on loopback (the test mock). */
function uploadTarget(raw: unknown): URL | undefined {
  if (typeof raw !== "string" || !raw) return undefined;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return undefined;
  }
  if (u.username || u.password) return undefined;
  if (u.protocol === "https:") return u;
  if (u.protocol === "http:" && LOOPBACK_HOSTS.has(u.hostname)) return u;
  return undefined;
}

const toolkitOf = (a: any): string | undefined => {
  const t = typeof a?.toolkit === "string" ? a.toolkit : a?.toolkit?.slug ?? a?.toolkit_slug;
  return typeof t === "string" ? t.toLowerCase() : undefined;
};
/** Belt and braces on top of the list filters: an item another toolkit or another user owns never counts. */
const isOurs = (a: any, id: string, userId: string) =>
  a?.id === id && (toolkitOf(a) ?? "tiktok") === "tiktok" && !(typeof a?.user_id === "string" && a.user_id !== userId);

/** Why a listed account can't be used (plan §5.3/§5.6), or undefined when it's ACTIVE and enabled. */
function accountProblem(a: any): TikTokError | undefined {
  const status = String(a?.status ?? "").trim().toUpperCase();
  const disabled = a?.is_disabled === true;
  if (status === "ACTIVE" && !disabled) return undefined;
  const detail = { account_status: status || "UNKNOWN" };
  if (status === "EXPIRED") return new TikTokError("AUTH_EXPIRED", detail);
  if (status === "INITIATED" || status === "INITIALIZING") return new TikTokError("NOT_CONNECTED", { ...detail, reason: "connecting" });
  if (status === "ACTIVE") return new TikTokError("AUTH_REVOKED", { ...detail, disabled: true });
  return new TikTokError("AUTH_REVOKED", detail); // REVOKED, INACTIVE, FAILED, and anything newer
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class ComposioClient {
  private readonly cfg: Config;
  private readonly clock: Clock;
  private readonly doFetch: (input: string, init: RequestInit) => Promise<Response>;
  private verified: { id: string; at: number } | null = null;

  constructor(cfg: Config, deps: ClientDeps) {
    this.cfg = cfg;
    this.clock = deps.clock;
    const f = deps.fetch ?? globalThis.fetch;
    this.doFetch = (input, init) => f(input, init);
  }

  private apiKey(): string {
    const k = this.cfg.apiKey?.trim();
    if (!k) throw new TikTokError("NOT_CONFIGURED", { field: "COMPOSIO_API_KEY" });
    return k;
  }

  private accountId(): string {
    const id = this.cfg.connectedAccountId?.trim();
    if (!id) throw new TikTokError("NOT_CONFIGURED", { field: "COMPOSIO_CONNECTED_ACCOUNT_ID" });
    return id;
  }

  /** The Composio user id the connection is owned by, once adopted (auto mode only; see assertAccount). */
  private adoptedUserId: string | undefined;

  /** COMPOSIO_USER_ID left empty or at its "default" means auto: use whichever user owns the connection. */
  private get autoUser(): boolean {
    const configured = this.cfg.userId?.trim();
    return !configured || configured === "default";
  }

  private get userId(): string {
    return this.adoptedUserId ?? (this.cfg.userId?.trim() || "default");
  }

  /**
   * The configured connected account must be listed for COMPOSIO_USER_ID and the TikTok toolkit, ACTIVE and
   * enabled; otherwise nothing runs. Cached 60 s per id; `fresh` bypasses the cache. `deadline` (default
   * now + 20 s) bounds every request, including the one diagnostic lookup on a miss. Returns the id.
   */
  async assertAccount(signal: AbortSignal, opts: { fresh?: boolean; deadline?: number } = {}): Promise<string> {
    this.apiKey();
    const id = this.accountId();
    const started = this.clock.now();
    if (!opts.fresh && this.verified?.id === id && started - this.verified.at < ACCOUNT_CACHE_MS) return id;
    this.verified = null;
    const deadline = opts.deadline ?? started + SYNC_TOOL_BUDGET_MS;
    let code = "ok";
    try {
      const items = await this.listAccounts({ connected_account_ids: id, user_ids: this.userId, toolkit_slugs: "tiktok" }, signal, deadline, true);
      let acct = items.find((a) => isOurs(a, id, this.userId));
      // Auto mode (no user id configured): the connection may sit under the user id it was created for in
      // Composio (e.g. "voiceos-tiktok"). Adopt that owner rather than refusing; an explicit id stays strict.
      if (!acct && this.autoUser) {
        acct = await this.adoptOwner(id, signal, deadline);
        if (!acct) throw new TikTokError("NOT_CONNECTED", { reason: "not_found" });
      }
      if (!acct) throw await this.whyMissing(id, signal, deadline);
      const problem = accountProblem(acct);
      if (problem) throw problem;
      this.verified = { id, at: this.clock.now() };
      return id;
    } catch (e) {
      const err = e instanceof TikTokError ? e : normalizeError(e, { slug: "connected_accounts", composioOwn: true });
      code = err.code;
      throw err;
    } finally {
      log(`account check ${Math.max(0, this.clock.now() - started)}ms ${code}`);
    }
  }

  private async listAccounts(query: Record<string, string>, signal: AbortSignal | undefined, deadline: number, retry: boolean): Promise<any[]> {
    const a = await this.read("GET", `/connected_accounts?${new URLSearchParams(query)}`, undefined, {
      deadline,
      signal,
      slug: "connected_accounts",
      retry,
    });
    if (a.status === 401 || a.status === 403) throw new TikTokError("NOT_CONFIGURED", { reason: "key_rejected", status: a.status });
    if (!a.ok) throw composioError(a, { slug: "connected_accounts", composioOwn: true });
    if (!Array.isArray(a.json?.items)) throw new TikTokError("TIKTOK_SERVER", { slug: "connected_accounts", reason: "unreadable_response" });
    return a.json.items;
  }

  /**
   * Auto mode only: list the id without the user filter and, when it is a TikTok connection, adopt its owner as
   * the user id for every later call. Returns the account, or undefined (then whyMissing explains). The owner's
   * id is never logged.
   */
  private async adoptOwner(id: string, signal: AbortSignal | undefined, deadline: number): Promise<any | undefined> {
    let items: any[];
    try {
      items = await this.listAccounts({ connected_account_ids: id, toolkit_slugs: "tiktok" }, signal, deadline, false);
    } catch {
      return undefined; // like whyMissing: a failed second lookup falls back to the plain message
    }
    const acct = items.find((a) => a?.id === id && (toolkitOf(a) ?? "tiktok") === "tiktok" && typeof a?.user_id === "string" && a.user_id.trim());
    if (!acct) return undefined;
    this.adoptedUserId = String(acct.user_id).trim();
    log("account check adopted the connection's owner as the Composio user id");
    return acct;
  }

  /**
   * The filtered list didn't return the id. One lookup without the user filter tells "connected under a
   * different Composio user id" apart from "no such TikTok connection". Diagnostic only: no retry, inside the
   * same deadline, and any failure falls back to the plain message. The other user id never leaves here.
   */
  private async whyMissing(id: string, signal: AbortSignal | undefined, deadline: number): Promise<TikTokError> {
    try {
      const items = await this.listAccounts({ connected_account_ids: id, toolkit_slugs: "tiktok" }, signal, deadline, false);
      const elsewhere = items.some((a) => a?.id === id && (toolkitOf(a) ?? "tiktok") === "tiktok" && a?.user_id !== this.userId);
      if (elsewhere) return new TikTokError("NOT_CONNECTED", { reason: "other_user" });
    } catch {
      /* fall back to the plain message */
    }
    return new TikTokError("NOT_CONNECTED", { reason: "not_found" });
  }

  /** POST /tools/execute/{slug} with the pinned version; returns parseData(json.data). See ExecOptions. */
  async exec<T = unknown>(slug: string, args: Record<string, unknown>, opts: ExecOptions): Promise<T> {
    const started = this.clock.now();
    const ids: LogIds = {};
    let code = "ok";
    try {
      return await this.execute<T>(slug, args, opts, ids);
    } catch (e) {
      const err = e instanceof TikTokError ? e : normalizeError(e, { slug });
      if (ids.tiktok && err.detail.log_id === undefined) err.detail.log_id = ids.tiktok;
      code = err.code;
      throw err;
    } finally {
      log(
        `exec ${safeSlug(slug)} ${Math.max(0, this.clock.now() - started)}ms ${code}` +
          `${ids.composio ? ` log_id=${ids.composio}` : ""}${ids.tiktok ? ` tiktok_log_id=${ids.tiktok}` : ""}`,
      );
    }
  }

  private async execute<T>(slug: string, args: Record<string, unknown>, opts: ExecOptions, ids: LogIds): Promise<T> {
    if (opts.deadline - this.clock.now() < MIN_REQUEST_MS) throw new TikTokError("TIMEOUT", { slug });
    const connected_account_id = await this.assertAccount(opts.signal ?? NEVER, { deadline: opts.deadline });
    const body = { user_id: this.userId, connected_account_id, version: TIKTOK_TOOLKIT_VERSION, arguments: args };
    const path = `/tools/execute/${encodeURIComponent(slug)}`;
    let a: Answer;
    if (opts.write) {
      const left = opts.deadline - this.clock.now();
      if (left < MIN_REQUEST_MS) throw new TikTokError("TIMEOUT", { slug });
      const r = await this.attempt("POST", path, body, { timeoutMs: Math.min(opts.timeoutMs ?? PER_REQUEST_TIMEOUT_MS, left), signal: opts.signal, fresh: true });
      // Never retried: a lost answer may still have posted.
      if (r.lost) throw new TikTokError("OUTCOME_UNKNOWN", { slug, reason: r.lost });
      a = r.answer;
      this.noteIds(a, ids);
      if (writeOutcomeLost(a.status) || (a.ok && !isObject(a.json))) throw new TikTokError("OUTCOME_UNKNOWN", { slug, status: a.status });
    } else {
      a = await this.read("POST", path, body, { deadline: opts.deadline, signal: opts.signal, timeoutMs: opts.timeoutMs, slug, retry: true });
      this.noteIds(a, ids);
    }
    if (!a.ok) throw await this.reconcile(composioError(a, { slug }), opts);
    if (a.json.successful === false) {
      const err = appFailure(a.json, slug);
      if (opts.write && writeAppFailureUnknown(err)) {
        // The next call checks the connection afresh, so a connection that lapsed is caught before anything is sent again.
        this.verified = null;
        throw new TikTokError("OUTCOME_UNKNOWN", { slug, reason: "app_failure" });
      }
      throw await this.reconcile(err, opts);
    }
    try {
      return parseData<T>(a.json.data);
    } catch (e) {
      throw await this.reconcile(e instanceof TikTokError ? e : normalizeError(e, { slug }), opts);
    }
  }

  private noteIds(a: Answer, ids: LogIds) {
    ids.composio = safeId(a.json?.log_id) ?? ids.composio;
    ids.tiktok = tiktokLogId(a.json?.data) ?? ids.tiktok;
  }

  /**
   * Expiry detection (plan §5.6): after an auth-shaped error, check the account again, bypassing the cache.
   * Not ACTIVE → that's the answer (EXPIRED → AUTH_EXPIRED, …). ACTIVE while TikTok says access_token_invalid →
   * AUTH_REVOKED (the user removed the app's access in TikTok). A check that couldn't run changes nothing.
   */
  private async reconcile(err: TikTokError, opts: ExecOptions): Promise<TikTokError> {
    const tokenInvalid = err.detail.tiktok_code === "access_token_invalid";
    if (!tokenInvalid && !isAuthShaped(err)) return err;
    try {
      await this.assertAccount(opts.signal ?? NEVER, { fresh: true, deadline: opts.deadline });
    } catch (e) {
      return e instanceof TikTokError && ACCOUNT_CODES.has(e.code) ? e : err;
    }
    return tokenInvalid ? new TikTokError("AUTH_REVOKED", { tiktok_code: "access_token_invalid", account_status: "ACTIVE" }) : err;
  }

  /** A read: one retry on a 5xx, a network error or an unreadable 200, after ~500 ms of jitter, if it fits before the deadline. */
  private async read(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    o: { deadline: number; signal?: AbortSignal; timeoutMs?: number; slug: string; retry: boolean },
  ): Promise<Answer> {
    for (let attempt = 0; ; attempt++) {
      const left = o.deadline - this.clock.now();
      if (left < MIN_REQUEST_MS) throw new TikTokError("TIMEOUT", { slug: o.slug });
      const r = await this.attempt(method, path, body, { timeoutMs: Math.min(o.timeoutMs ?? PER_REQUEST_TIMEOUT_MS, left), signal: o.signal });
      const retryable = r.lost ? r.lost === "network" : r.answer.status >= 500 || (r.answer.ok && !isObject(r.answer.json));
      if (retryable && o.retry && attempt === 0 && (await this.backoff(o.deadline, o.signal))) continue;
      if (r.lost) throw lostReadError(r.lost, o.slug);
      if (r.answer.ok && !isObject(r.answer.json)) throw new TikTokError("TIKTOK_SERVER", { slug: o.slug, reason: "unreadable_response" });
      return r.answer;
    }
  }

  /** Sleeps ~500 ms (250–750) unless that would leave less than MIN_REQUEST_MS before the deadline. */
  private async backoff(deadline: number, signal?: AbortSignal): Promise<boolean> {
    const wait = 250 + Math.floor(Math.random() * 500);
    if (deadline - this.clock.now() - wait < MIN_REQUEST_MS) return false;
    try {
      await this.clock.sleep(wait, signal);
    } catch {
      return false;
    }
    return !signal?.aborted;
  }

  /** One request to Composio (cfg.baseUrl only). Transport failures come back as `lost`, never thrown. */
  private async attempt(
    method: "GET" | "POST",
    path: string,
    body: unknown,
    o: { timeoutMs: number; signal?: AbortSignal; fresh?: boolean },
  ): Promise<Outcome> {
    const key = this.apiKey();
    const timeout = AbortSignal.timeout(Math.max(1, Math.floor(o.timeoutMs)));
    const signal = o.signal ? AbortSignal.any([timeout, o.signal]) : timeout;
    let res: Response;
    let text: string;
    try {
      res = await this.doFetch(`${this.cfg.baseUrl}${path}`, {
        method,
        headers: { "x-api-key": key, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        ...(o.fresh ? { keepalive: false } : {}),
        signal,
      });
      text = await res.text(); // a body cut off mid-way is a lost answer too
    } catch (e) {
      if (o.signal?.aborted) return { lost: "aborted" };
      if (timeout.aborted) return { lost: "timeout" };
      const code = (e as { code?: unknown })?.code;
      if (code === "UnexpectedRedirect" || /redirect/i.test(String((e as Error)?.message ?? ""))) return { lost: "redirect" };
      return { lost: "network" };
    }
    let json: any;
    const trimmed = text.trim();
    if (trimmed) {
      try {
        json = JSON.parse(trimmed);
      } catch {
        json = undefined;
      }
    }
    return { answer: { status: res.status, ok: res.ok, json } };
  }

  /**
   * Stages a local video for `file_to_upload` (plan §5.3–5.4): streaming MD5, then POST /files/upload/request,
   * then (unless MD5 dedup already holds it) a streamed PUT to the presigned URL with content-type = mimetype
   * (+ x-ms-blob-type: BlockBlob on Azure) and no API key. Any failure → UPLOAD_FAILED {nothing_sent: true};
   * a missing or rejected key → NOT_CONFIGURED.
   */
  async stageFile(path: string, mimetype: string, toolSlug: string, deadline: number, signal?: AbortSignal): Promise<StagedFile> {
    this.apiKey();
    const started = this.clock.now();
    let code = "ok";
    let size = 0;
    try {
      if (deadline - this.clock.now() < MIN_REQUEST_MS) throw uploadFailed("timeout");
      const file = Bun.file(path);
      const name = basename(path);
      const md5 = await this.md5Of(path, deadline, signal);
      size = file.size;
      const left = deadline - this.clock.now();
      if (left < MIN_REQUEST_MS) throw uploadFailed("timeout");
      const r = await this.attempt(
        "POST",
        "/files/upload/request",
        { toolkit_slug: "tiktok", tool_slug: toolSlug, filename: name, mimetype, md5 },
        { timeoutMs: Math.min(PER_REQUEST_TIMEOUT_MS, left), signal },
      );
      if (r.lost) throw uploadFailed(r.lost);
      const a = r.answer;
      if (a.status === 401 || a.status === 403) throw new TikTokError("NOT_CONFIGURED", { reason: "key_rejected", status: a.status });
      if (!a.ok || !isObject(a.json) || typeof a.json.key !== "string" || !a.json.key) throw uploadFailed("request_failed", a.status);
      const presigned = a.json.new_presigned_url ?? a.json.newPresignedUrl;
      if (presigned) await this.putFile(presigned, file, mimetype, a.json.metadata?.storage_backend, deadline, signal);
      return { name, mimetype, s3key: a.json.key };
    } catch (e) {
      const err = e instanceof TikTokError && (e.code === "UPLOAD_FAILED" || e.code === "NOT_CONFIGURED") ? e : uploadFailed("error");
      code = err.code;
      throw err;
    } finally {
      log(`stage ${safeSlug(toolSlug)} ${Math.max(0, this.clock.now() - started)}ms ${code} ${(size / 1_048_576).toFixed(1)}MB`);
    }
  }

  /**
   * Streaming MD5 (files reach 4 GB): never holds the whole file. Read with node:fs, not `Bun.file().stream()`:
   * on Bun 1.3.13, iterating a Bun file stream ends the process's stdin (found 2026-11-06). VoiceOS launches
   * `bun` from PATH, so a Mac with its own Bun 1.3.13 in ~/.bun/bin runs this server on it; with stdin ended,
   * the server exits once the write finishes, VoiceOS marks the integration "error", and every TikTok tool is
   * missing from later turns until a Reload. tests/stdin-survives.test.ts guards it.
   */
  private async md5Of(path: string, deadline: number, signal?: AbortSignal): Promise<string> {
    const hash = createHash("md5");
    const handle = await open(path, "r");
    try {
      const buf = Buffer.allocUnsafe(4 << 20);
      for (;;) {
        if (signal?.aborted) throw uploadFailed("aborted");
        if (this.clock.now() > deadline) throw uploadFailed("timeout");
        const { bytesRead } = await handle.read(buf, 0, buf.length, null);
        if (!bytesRead) break;
        hash.update(buf.subarray(0, bytesRead));
      }
    } finally {
      await handle.close();
    }
    return hash.digest("hex");
  }

  private async putFile(rawUrl: unknown, file: BunFileLike, mimetype: string, backend: unknown, deadline: number, signal?: AbortSignal) {
    const target = uploadTarget(rawUrl);
    if (!target) throw uploadFailed("insecure_upload_url");
    if (!loggedUploadHosts.has(target.host)) {
      loggedUploadHosts.add(target.host);
      log(`composio upload host ${target.host}`); // host only: the URL carries a signature
    }
    const left = deadline - this.clock.now();
    if (left < MIN_REQUEST_MS) throw uploadFailed("timeout");
    const headers: Record<string, string> = { "content-type": mimetype }; // must match what was presigned
    if (backend === "azure_blob_storage") headers["x-ms-blob-type"] = "BlockBlob";
    const timeout = AbortSignal.timeout(Math.floor(left));
    let res: Response;
    try {
      res = await this.doFetch(target.href, {
        method: "PUT",
        headers,
        body: file, // Bun streams a BunFile body with its Content-Length
        redirect: "error",
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      });
      await res.arrayBuffer().catch(() => undefined); // drain the (empty or XML) answer
    } catch {
      throw uploadFailed(signal?.aborted ? "aborted" : timeout.aborted ? "timeout" : "network");
    }
    if (!res.ok) throw uploadFailed("put_failed", res.status);
  }
}

// ---------------------------------------------------------------------------
// Argument builders: the one place where card values become Composio arguments.
// The widget bridge stages card values as strings, so "true"/"false" and digit strings are normalized here,
// exactly as the receipt (receiptCoreScript.ts) normalizes them: what the user approved is what TikTok gets.
// ---------------------------------------------------------------------------

/** true | "true" (anything else, including "TRUE", is false — as TKR.normBool). */
export const bool = (v: unknown): boolean => v === true || v === "true";

/** A finite number, or a /^\d+$/ string (trimmed, as TKR.normInt); otherwise undefined. */
export const int = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v === "string") {
    const t = v.trim();
    return /^\d+$/.test(t) ? Number(t) : undefined;
  }
  return undefined;
};

const caption = (v: unknown): string => TKR.normCaption(v);
const upper = (v: unknown): string => TKR.normUpper(v);
const fileArg = (f: StagedFile): StagedFile => ({ name: f.name, mimetype: f.mimetype, s3key: f.s3key });

/** Video drafts: TikTok takes no caption or privacy here. */
export function videoDraftArgs(file: StagedFile): Record<string, unknown> {
  return { file_to_upload: fileArg(file), publish: false };
}

export function videoDirectArgs(
  file: StagedFile,
  a: Record<string, unknown>,
  c: { comment_disabled: boolean; duet_disabled: boolean; stitch_disabled: boolean },
): Record<string, unknown> {
  const cover = int(a.cover_ms);
  const disclosed = bool(a.commercial_disclosure);
  return {
    file_to_upload: fileArg(file),
    publish: true,
    caption: caption(a.caption),
    privacy_level: upper(a.privacy_level),
    disable_comment: !!c.comment_disabled || !bool(a.allow_comment),
    disable_duet: !!c.duet_disabled || !bool(a.allow_duet), // always true for private accounts (TikTok disables Duet there)
    disable_stitch: !!c.stitch_disabled || !bool(a.allow_stitch),
    brand_organic_toggle: disclosed && bool(a.brand_organic), // both always sent: TikTok marks them required
    brand_content_toggle: disclosed && bool(a.brand_content),
    is_aigc: bool(a.is_aigc),
    ...(cover !== undefined ? { video_cover_timestamp_ms: cover } : {}),
  };
}

/** Photo drafts: title and description carry into TikTok's editor; empty ones are left out. */
export function photoDraftArgs(urls: string[], cover: number, a: Record<string, unknown>): Record<string, unknown> {
  const title = caption(a.title);
  const description = caption(a.description);
  return {
    post_mode: "MEDIA_UPLOAD",
    photo_images: [...urls],
    photo_cover_index: cover,
    ...(title ? { title } : {}),
    ...(description ? { description } : {}),
  };
}

/** Photo direct post. This schema version has no is_aigc. */
export function photoDirectArgs(urls: string[], cover: number, a: Record<string, unknown>, c: { comment_disabled: boolean }): Record<string, unknown> {
  const disclosed = bool(a.commercial_disclosure);
  return {
    post_mode: "DIRECT_POST",
    photo_images: [...urls],
    photo_cover_index: cover,
    title: caption(a.title),
    description: caption(a.description),
    privacy_level: upper(a.privacy_level),
    disable_comment: !!c.comment_disabled || !bool(a.allow_comment),
    auto_add_music: bool(a.auto_add_music),
    brand_organic_toggle: disclosed && bool(a.brand_organic),
    brand_content_toggle: disclosed && bool(a.brand_content),
  };
}
