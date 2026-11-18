/**
 * A loopback stand-in for Composio's REST API v3.1 and the TikTok toolkit behind it.
 * Test infrastructure only (agents A, G and H share it); nothing here ships.
 *
 * It answers the four routes the integration uses, the way the real ones answer (plan §5.1, §5.3; contract "mock-composio"):
 *   GET  /api/v3.1/connected_accounts?connected_account_ids=&user_ids=&toolkit_slugs=&statuses=   filtered list
 *   GET  /api/v3.1/connected_accounts/{id}
 *   POST /api/v3.1/tools/execute/{SLUG}     { user_id, connected_account_id, version, arguments }
 *   POST /api/v3.1/files/upload/request     { toolkit_slug, tool_slug, filename, mimetype, md5 }
 *   PUT  /presigned/{key}                   the "storage host" (same server; no API key; content-type must match)
 *
 * Responses look like the real ones:
 *   - Composio envelope `{ successful: true, data: <TikTok body>, error: null, log_id }`, where the TikTok body is
 *     `{ data: {...}, error: { code: "ok", message: "", log_id } }`.
 *   - The app's failures: HTTP 200 + `{ successful: false, data: <TikTok body with the error>, error: "<text naming the code>" }`.
 *   - Composio's own errors: `{ error: { message, slug, status } }` with that HTTP status (wrong API key → 401 "Unauthorized").
 *
 * Default behaviour per slug (all 9 TikTok tools; state is mutable on the returned object):
 *   TIKTOK_GET_USER_STATS        `{ user }` with only the requested `fields` (Composio's default: the 4 stats fields)
 *   TIKTOK_LIST_VIDEOS           `{ videos, cursor (ms), has_more }` from `mock.videos`, honouring `max_count` (default 10, 1–20) and `cursor`
 *   TIKTOK_QUERY_VIDEOS          `{ videos }` for the ids found (1–20 ids)
 *   TIKTOK_QUERY_CREATOR_INFO    `mock.creator` (SELF_ONLY only, duet/stitch disabled: a private, unaudited account)
 *   TIKTOK_UPLOAD_VIDEO          `{ publish_id: "v_inbox_file~v2.<n>" | "v_pub_file~v2.<n>", published }`; direct posts check
 *                                privacy_level against `mock.creator.privacy_level_options` and require both brand toggles
 *   TIKTOK_POST_PHOTO            `{ publish_id: "p_pub_url~v2.<n>" }`; checks 1–35 https (or loopback http) URLs, cover index, limits,
 *                                DIRECT_POST privacy; `mock.verifiedUrlPrefixes` (non-empty) → others get url_ownership_unverified
 *   TIKTOK_FETCH_PUBLISH_STATUS  walks `setStatusSequence(id)` (then repeats the last step); ids the mock issued walk a default:
 *                                video drafts PROCESSING_UPLOAD → SEND_TO_USER_INBOX, video direct → PUBLISH_COMPLETE,
 *                                photos PROCESSING_DOWNLOAD → SEND_TO_USER_INBOX / PUBLISH_COMPLETE; unknown ids → invalid_publish_id
 *   TIKTOK_PUBLISH_VIDEO, TIKTOK_UPLOAD_VIDEOS   plausible publish ids (the integration doesn't call them; shapes unverified)
 *
 * Execute resolution order (first answer wins):
 *   1. `onRoute(method, path, fn)` responders (any route, before the API-key check: they can model a gateway);
 *   2. the API-key check (wrong key → 401 { error: { slug: "Unauthorized" } });
 *   3. `once(slug, fn)` responders (FIFO, one call each), then `on(slug, fn)`;
 *   4. the connected-account checks (unknown id / other user / other toolkit → 404 ActionExecute_ConnectedAccountNotFound;
 *      EXPIRED → 400 ActionExecute_ConnectedAccountExpired; other non-ACTIVE or is_disabled → 400 ActionExecute_ConnectedAccountInactive);
 *   5. `tiktokTokenInvalid` → access_token_invalid (TikTok revoked the token while Composio still says ACTIVE);
 *   6. the default above.
 * A responder that returns `undefined` falls through to the next step. `MockReply.drop` reads the whole request and then destroys
 * the socket without answering (a lost answer); `delayMs` waits before answering (or dropping).
 *
 * Usage:
 *   const mock = startMockComposio();                       // mock.baseUrl = http://127.0.0.1:<port>/api/v3.1
 *   const cfg = loadConfig({ COMPOSIO_API_KEY: mock.apiKey, COMPOSIO_CONNECTED_ACCOUNT_ID: mock.connectedAccountId },
 *                          [`--composio-base-url=${mock.baseUrl}`]);
 *   beforeEach(() => mock.reset()); afterAll(() => mock.stop());
 *   mock.on("TIKTOK_QUERY_CREATOR_INFO", () => reply.tiktokError("spam_risk_too_many_posts"));   // HTTP 200, error inside
 *   mock.once("TIKTOK_LIST_VIDEOS", () => reply.composioError(500));                           // next call only
 *   mock.once("TIKTOK_UPLOAD_VIDEO", () => reply.drop());                                      // lost answer
 *   mock.on("TIKTOK_UPLOAD_VIDEO", () => reply.fail("spam_risk_too_many_pending_share"));      // successful:false
 *   mock.setStatusSequence(id, [{ status: "PROCESSING_UPLOAD" }, { status: "FAILED", fail_reason: "spam_risk_text" }]);
 *   mock.account.status = "EXPIRED";  mock.account.user_id = "someone-else";  mock.account.toolkit = "github";
 *   mock.presigned.storageBackend = "azure_blob_storage";  mock.presigned.dedup = true;
 *   mock.executes("TIKTOK_UPLOAD_VIDEO").length              // how many inits reached "Composio"
 *
 * Standalone (verify.ts / manual runs): `bun tests/mock-composio.ts [--port=N]` prints the base URL and credentials.
 *
 * Note for client code (verified on Bun 1.3.13): when a pooled keep-alive socket closes before any answer, Bun's fetch
 * silently re-sends the request once. `drop` therefore shows two calls for a POST sent on a reused connection unless
 * the client sends it with `keepalive: false` (src/client.ts does, for writes).
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export const MOCK_API_KEY = "mock_composio_project_key_0123456789";
export const MOCK_USER_ID = "default";
export const MOCK_CONNECTED_ACCOUNT_ID = "ca_mockTikTok0001";
/** The fixtures' "now": 2026-11-03T00:00:00Z in UTC seconds (TikTok's create_time unit). */
export const MOCK_NOW_SEC = 1_793_664_000;

const API_PREFIX = "/api/v3.1";

export const TIKTOK_SLUGS = [
  "TIKTOK_GET_USER_STATS",
  "TIKTOK_LIST_VIDEOS",
  "TIKTOK_QUERY_VIDEOS",
  "TIKTOK_FETCH_PUBLISH_STATUS",
  "TIKTOK_QUERY_CREATOR_INFO",
  "TIKTOK_UPLOAD_VIDEO",
  "TIKTOK_POST_PHOTO",
  "TIKTOK_PUBLISH_VIDEO",
  "TIKTOK_UPLOAD_VIDEOS",
] as const;

export interface MockCall {
  method: string;
  /** Path without the `/api/v3.1` prefix and without the query: "/tools/execute/TIKTOK_LIST_VIDEOS", "/connected_accounts", "/files/upload/request", "/presigned/<key>". */
  path: string;
  /** Query parameters (repeated keys joined with ","). */
  query: Record<string, string>;
  /** For executes: the tool slug. */
  slug?: string;
  /** Parsed JSON body (undefined for PUT bodies and non-JSON bodies). */
  body?: any;
  /** Raw request body length in bytes. */
  bytes: number;
  /** Request headers, lower-cased names. */
  headers: Record<string, string>;
}

export type MockReply = {
  status?: number;
  json?: unknown;
  /** Raw body text (wins over json); "" gives an empty body. */
  text?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  /** Read the request, then destroy the socket without answering: a lost answer. */
  drop?: boolean;
};

type Maybe<T> = T | undefined | void;
export type SlugResponder = (args: any, call: MockCall) => Maybe<MockReply> | Promise<Maybe<MockReply>>;
export type RouteResponder = (call: MockCall) => Maybe<MockReply> | Promise<Maybe<MockReply>>;

export interface MockAccount {
  status: string;
  is_disabled?: boolean;
  /** Toolkit slug; default "tiktok". */
  toolkit?: string;
  /** Owning Composio user id; default the mock's userId. */
  user_id?: string;
  status_reason?: string | null;
}

export interface MockCreator {
  creator_avatar_url: string;
  creator_username: string;
  creator_nickname: string;
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec: number;
}

export interface MockStatusStep {
  status: string;
  fail_reason?: string;
  /** Extra fields are merged into the status data (e.g. publicaly_available_post_id). */
  [extra: string]: unknown;
}

export interface MockPut {
  path: string;
  key: string;
  headers: Record<string, string>;
  bytes: number;
  /** MD5 (hex) of the bytes the mock received. */
  md5: string;
}

export interface MockIssuedPost {
  publish_id: string;
  kind: "video" | "photo";
  mode: "drafts" | "direct";
  slug: string;
  args: any;
  /** Bytes the presigned PUT delivered for this video's s3key (0 when unknown or deduplicated). */
  bytes: number;
  count?: number;
}

export interface MockComposio {
  /** http://127.0.0.1:<port>/api/v3.1 — pass as --composio-base-url or Config.baseUrl. */
  baseUrl: string;
  /** http://127.0.0.1:<port> */
  origin: string;
  apiKey: string;
  userId: string;
  connectedAccountId: string;
  /** Mutable; the list filters and executes honour status, is_disabled, user_id and toolkit. */
  account: MockAccount;
  /** Mutable creator info (QUERY_CREATOR_INFO answers it; direct posts are checked against its privacy options). */
  creator: MockCreator;
  /** Mutable TikTok user (GET_USER_STATS picks the requested fields from it). */
  user: Record<string, unknown>;
  /** Mutable public posts, any order (LIST_VIDEOS sorts newest first). */
  videos: Array<Record<string, any>>;
  /** Non-empty: photo URLs must start with one of these, else url_ownership_unverified. Empty: any https/loopback URL. */
  verifiedUrlPrefixes: string[];
  /** TikTok rejects the token (access_token_invalid) on every TikTok tool while Composio still reports ACTIVE. */
  tiktokTokenInvalid: boolean;
  /** Every request, in order (presigned PUTs included). */
  calls: MockCall[];
  executes(slug?: string): MockCall[];
  /** Override a tool until reset (return undefined to fall through to the default). */
  on(slug: string, responder: SlugResponder): void;
  /** Override the next call of a tool only (FIFO per slug; runs before `on`). */
  once(slug: string, responder: SlugResponder): void;
  /** Override any route (path without /api/v3.1, e.g. "/connected_accounts", "/files/upload/request", /^\/presigned\//). Method "*" = any. */
  onRoute(method: string, path: string | RegExp, responder: RouteResponder): void;
  /** The default answer for a tool, e.g. to wrap it: `mock.on(s, (a, c) => ({ ...mock.defaultReply(s, a, c), delayMs: 300 }))`. */
  defaultReply(slug: string, args: any, call?: MockCall): MockReply;
  /** FETCH_PUBLISH_STATUS for this id walks `seq`, then repeats its last step. */
  setStatusSequence(publishId: string, seq: MockStatusStep[]): void;
  /** Publish ids the mock handed out (UPLOAD_VIDEO / POST_PHOTO / PUBLISH_VIDEO). */
  issued: Map<string, MockIssuedPost>;
  presigned: { puts: MockPut[]; storageBackend: "s3" | "azure_blob_storage"; dedup: boolean };
  /** Restore every default (state objects are mutated in place, so references stay valid) and clear calls and overrides. */
  reset(): void;
  stop(): void;
}

// ---------------------------------------------------------------------------
// Reply helpers
// ---------------------------------------------------------------------------

const randHex = (bytes: number) => randomBytes(bytes).toString("hex");
/** TikTok-style log id: timestamp + hex, e.g. "20261103120000A1B2C3D4E5F6A7B8C9D0". */
export const tiktokLogId = () => `20261103120000${randHex(10).toUpperCase()}`;
const composioLogId = () => `log_${randHex(6)}`;

/** A TikTok API body: `{ data, error: { code, message, log_id } }`. */
export function tiktokBody(data: unknown, error: { code?: string; message?: string } = {}) {
  return { data, error: { code: error.code ?? "ok", message: error.message ?? "", log_id: tiktokLogId() } };
}

const TIKTOK_MESSAGES: Record<string, string> = {
  access_token_invalid: "The access token is invalid or not found in the request.",
  scope_not_authorized: "The user did not authorize the scope required for completing this request.",
  rate_limit_exceeded: "The API rate limit was exceeded. Please try again later.",
  spam_risk_too_many_posts: "The daily post cap from the API is reached for the current user.",
  spam_risk_too_many_pending_share: "The daily upload cap from the API is reached for the current user.",
  spam_risk_user_banned_from_posting: "The user is banned from making new posts.",
  reached_active_user_cap: "The daily quota for active publishing users from your client is reached.",
  unaudited_client_can_only_post_to_private_accounts: "Unaudited clients can only post to a private account.",
  privacy_level_option_mismatch: "privacy_level is not one of the privacy_level_options returned by creator_info.",
  url_ownership_unverified: "The domain or URL prefix of the photo URLs isn't verified for this client.",
  invalid_file_upload: "The file doesn't meet the API specifications.",
  invalid_params: "The request parameters are invalid.",
  invalid_publish_id: "The publish_id doesn't exist.",
  app_version_check_failed: "The TikTok app version is too old for this feature.",
  internal_error: "Something went wrong on TikTok's side.",
};

export const reply = {
  /** Composio success around a TikTok ok body. */
  ok(data: unknown): MockReply {
    return { json: { successful: true, data: tiktokBody(data), error: null, log_id: composioLogId() } };
  },
  /** HTTP 200 + successful:true with TikTok's error object inside (how creator info reports spam_risk_* and reached_active_user_cap). */
  tiktokError(code: string, message?: string, data: unknown = {}): MockReply {
    return { json: { successful: true, data: tiktokBody(data, { code, message: message ?? TIKTOK_MESSAGES[code] ?? code }), error: null, log_id: composioLogId() } };
  },
  /** The app's failure as Composio reports it: HTTP 200 + successful:false; the error text names TikTok's code, data holds TikTok's body. */
  fail(code: string, message?: string): MockReply {
    const msg = message ?? TIKTOK_MESSAGES[code] ?? code;
    return {
      json: {
        successful: false,
        data: tiktokBody({}, { code, message: msg }),
        error: `TikTok API error: ${code}: ${msg}`,
        log_id: composioLogId(),
      },
    };
  },
  /** Composio's own error envelope with that HTTP status. */
  composioError(status: number, slug = status >= 500 ? "InternalServerError" : "BadRequest", message?: string): MockReply {
    return { status, json: { error: { message: message ?? `Mock Composio error ${status}`, slug, status } } };
  },
  /** Destroy the socket after reading the request: the answer is lost. */
  drop(delayMs?: number): MockReply {
    return { drop: true, ...(delayMs ? { delayMs } : {}) };
  },
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DAY = 86_400;
const cdn = (id: string) =>
  `https://p16-sign.tiktokcdn-us.com/obj/tos-useast5-p-0068-tx/mock-cover-${id}?x-expires=${MOCK_NOW_SEC + DAY}&x-signature=mock`;
const video = (id: string, ageDays: number, extra: Record<string, unknown>) => ({
  id,
  create_time: MOCK_NOW_SEC - Math.round(ageDays * DAY),
  title: "",
  video_description: "",
  duration: 15,
  width: 1080,
  height: 1920,
  cover_image_url: cdn(id),
  share_url: `https://www.tiktok.com/@mock.creator/video/${id}`,
  embed_link: `https://www.tiktok.com/player/v1/${id}`,
  view_count: 0,
  like_count: 0,
  comment_count: 0,
  share_count: 0,
  ...extra,
});

/** 150 characters exactly: TikTok's cut for captions in list/query responses. */
const CUT_CAPTION =
  "Three weeks of sourdough experiments in one video: the starter, the fold schedule, the cold proof, and the bake that finally worked #sourdough #bread";

export function defaultVideos(): Array<Record<string, any>> {
  return [
    video("7438291034572910101", 1, {
      video_description: "Sunday pasta, start to finish 🍝 #cooking #pasta",
      duration: 23, view_count: 15_230, like_count: 1_204, comment_count: 87, share_count: 33,
    }),
    video("7438291034572910102", 2, {
      title: "Knife skills",
      video_description: "Knife skills 101 with @chef.ana: dice, mince, julienne #cooking",
      duration: 58, view_count: 999_500, like_count: 81_022, comment_count: 1_933, share_count: 4_410,
    }),
    video("7438291034572910103", 4, {
      video_description: CUT_CAPTION.padEnd(150, ".").slice(0, 150),
      duration: 187, view_count: 4_211, like_count: 390, comment_count: 41, share_count: 12,
    }),
    video("7438291034572910104", 7, {
      video_description: "Market haul, landscape edition",
      duration: 41, width: 1920, height: 1080, view_count: 2_005, like_count: 150, comment_count: 9, share_count: 2,
    }),
    video("7438291034572910105", 10, {
      video_description: "Five-minute breakfast tacos #breakfast",
      duration: 31, view_count: 33_871, like_count: 2_877, comment_count: 112, share_count: 240,
    }),
    video("7438291034572910106", 15, {
      video_description: "Testing a new mic, ignore",
      duration: 9, view_count: 87, like_count: 3, comment_count: 0, share_count: 0,
    }),
    video("7438291034572910107", 21, {
      video_description: "First video! Hi 👋",
      duration: 12, view_count: 512, like_count: 61, comment_count: 14, share_count: 1,
    }),
  ];
}

export function defaultUser(): Record<string, unknown> {
  return {
    open_id: "-000mockOpenId00000000000000000000",
    union_id: "mock-union-id-0001",
    avatar_url: "https://p16-sign.tiktokcdn-us.com/tos-useast5-avt-0068-tx/mock-avatar~c5_168x168.jpeg",
    avatar_url_100: "https://p16-sign.tiktokcdn-us.com/tos-useast5-avt-0068-tx/mock-avatar~c5_100x100.jpeg",
    avatar_large_url: "https://p16-sign.tiktokcdn-us.com/tos-useast5-avt-0068-tx/mock-avatar~c5_1080x1080.jpeg",
    display_name: "Mock Creator",
    username: "mock.creator",
    bio_description: "Cooking, mostly. 🍳",
    profile_deep_link: "https://vm.tiktok.com/ZMmock0001/",
    is_verified: false,
    follower_count: 12_873,
    following_count: 311,
    likes_count: 402_118,
    video_count: 7,
  };
}

export function defaultCreator(): MockCreator {
  return {
    creator_avatar_url: "https://p16-sign.tiktokcdn-us.com/tos-useast5-avt-0068-tx/mock-avatar~c5_168x168.jpeg",
    creator_username: "mock.creator",
    creator_nickname: "Mock Creator",
    privacy_level_options: ["SELF_ONLY"],
    comment_disabled: false,
    duet_disabled: true,
    stitch_disabled: true,
    max_video_post_duration_sec: 600,
  };
}

/** Composio's default for TIKTOK_GET_USER_STATS when `fields` is omitted. */
const DEFAULT_STATS_FIELDS = ["follower_count", "following_count", "likes_count", "video_count"];

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const isObject = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const clone = <T>(v: T): T => structuredClone(v);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const LOOPBACK_URL = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//;

function queryOf(url: URL): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of new Set(url.searchParams.keys())) out[key] = url.searchParams.getAll(key).join(",");
  return out;
}
const listParam = (q: Record<string, string>, key: string) =>
  q[key] === undefined ? undefined : q[key].split(",").map((s) => s.trim()).filter(Boolean);

function headersOf(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? v.join(", ") : String(v);
  return out;
}

export function startMockComposio(opts: { apiKey?: string; userId?: string; connectedAccountId?: string; port?: number } = {}): MockComposio {
  const apiKey = opts.apiKey ?? MOCK_API_KEY;
  const userId = opts.userId ?? MOCK_USER_ID;
  const connectedAccountId = opts.connectedAccountId ?? MOCK_CONNECTED_ACCOUNT_ID;

  const account: MockAccount = { status: "ACTIVE" };
  const creator: MockCreator = defaultCreator();
  const user: Record<string, unknown> = defaultUser();
  const videos: Array<Record<string, any>> = defaultVideos();
  const verifiedUrlPrefixes: string[] = [];
  const calls: MockCall[] = [];
  const persistent = new Map<string, SlugResponder>();
  const queued = new Map<string, SlugResponder[]>();
  const routes: Array<{ method: string; path: string | RegExp; responder: RouteResponder }> = [];
  const sequences = new Map<string, { steps: MockStatusStep[]; i: number }>();
  const walks = new Map<string, number>();
  const issued = new Map<string, MockIssuedPost>();
  const uploads = new Map<string, { mimetype: string; md5: string; filename: string; bytes: number }>();
  const presigned: MockComposio["presigned"] = { puts: [], storageBackend: "s3", dedup: false };
  let counter = 0;
  const nextNumber = () => `74382910345${String(++counter).padStart(8, "0")}`;

  const accountJson = () => ({
    id: connectedAccountId,
    status: account.status,
    status_reason: account.status_reason ?? null,
    is_disabled: account.is_disabled === true,
    user_id: account.user_id ?? userId,
    toolkit: { slug: account.toolkit ?? "tiktok" },
    auth_config: { id: "ac_mockTikTokAuth01", auth_scheme: "OAUTH2", is_composio_managed: false, is_disabled: false },
    // A fake token, so tests can check it never leaks into results or logs.
    state: { authScheme: "OAUTH2", val: { status: account.status, access_token: "act.mock-secret-token-never-leak" } },
    params: {},
    created_at: "2026-10-30T18:00:00.000Z",
    updated_at: "2026-11-02T18:00:00.000Z",
  });

  const kindOf = (id: string): "video" | "photo" => (id.startsWith("p_") ? "photo" : "video");
  const defaultSteps = (kind: "video" | "photo", mode: "drafts" | "direct"): MockStatusStep[] => [
    { status: kind === "photo" ? "PROCESSING_DOWNLOAD" : "PROCESSING_UPLOAD" },
    { status: mode === "direct" ? "PUBLISH_COMPLETE" : "SEND_TO_USER_INBOX" },
  ];

  function statusData(publishId: string, step: MockStatusStep) {
    const post = issued.get(publishId);
    const kind = post?.kind ?? kindOf(publishId);
    const { status, fail_reason, ...extra } = step;
    const done = status !== "PROCESSING_UPLOAD" && status !== "PROCESSING_DOWNLOAD";
    return {
      status,
      ...(fail_reason ? { fail_reason } : {}),
      publicaly_available_post_id: [] as string[],
      ...(kind === "photo"
        ? { downloaded_bytes: done ? 524_288 * (post?.count ?? 1) : 0 }
        : { uploaded_bytes: post?.bytes ?? 0 }),
      ...extra,
    };
  }

  function issue(slug: string, kind: "video" | "photo", mode: "drafts" | "direct", prefix: string, args: any, bytes = 0, count?: number) {
    const publish_id = `${prefix}~v2.${nextNumber()}`;
    issued.set(publish_id, { publish_id, kind, mode, slug, args: clone(args), bytes, ...(count ? { count } : {}) });
    return publish_id;
  }

  const privacyProblem = (level: unknown): MockReply | undefined => {
    const v = typeof level === "string" ? level : "";
    return creator.privacy_level_options.includes(v)
      ? undefined
      : reply.fail("privacy_level_option_mismatch", `privacy_level ${v || "(empty)"} isn't one of: ${creator.privacy_level_options.join(", ")}`);
  };

  function defaultReply(slug: string, args: any, _call?: MockCall): MockReply {
    const a = isObject(args) ? args : {};
    switch (slug) {
      case "TIKTOK_GET_USER_STATS": {
        const fields = Array.isArray(a.fields) && a.fields.length ? a.fields.map(String) : DEFAULT_STATS_FIELDS;
        const picked: Record<string, unknown> = {};
        for (const f of fields) if (f in user) picked[f] = clone(user[f]);
        return reply.ok({ user: picked });
      }
      case "TIKTOK_LIST_VIDEOS": {
        const max = a.max_count ?? 10;
        if (!Number.isInteger(max) || max < 1 || max > 20) return reply.fail("invalid_params", "max_count must be an integer from 1 to 20.");
        const cursor = a.cursor;
        if (cursor !== undefined && (!Number.isInteger(cursor) || cursor < 0)) return reply.fail("invalid_params", "cursor must be a UTC Unix timestamp in milliseconds.");
        const sorted = [...videos].sort((x, y) => y.create_time - x.create_time);
        const older = cursor === undefined ? sorted : sorted.filter((v) => v.create_time * 1000 < cursor);
        const page = older.slice(0, max);
        const last = page[page.length - 1];
        return reply.ok({
          videos: page.map(clone),
          cursor: last ? last.create_time * 1000 : (cursor ?? MOCK_NOW_SEC * 1000),
          has_more: older.length > page.length,
        });
      }
      case "TIKTOK_QUERY_VIDEOS": {
        const ids = a.video_ids;
        if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20) return reply.fail("invalid_params", "video_ids must hold 1 to 20 ids.");
        const want = new Set(ids.map(String));
        return reply.ok({ videos: videos.filter((v) => want.has(String(v.id))).map(clone) });
      }
      case "TIKTOK_FETCH_PUBLISH_STATUS": {
        const id = typeof a.publish_id === "string" ? a.publish_id : "";
        if (!id || id.length > 64) return reply.fail("invalid_params", "publish_id is required (at most 64 characters).");
        const seq = sequences.get(id);
        if (seq) {
          const step = seq.steps[Math.min(seq.i++, seq.steps.length - 1)];
          return reply.ok(statusData(id, step));
        }
        const post = issued.get(id);
        if (!post) return reply.fail("invalid_publish_id");
        const steps = defaultSteps(post.kind, post.mode);
        const i = walks.get(id) ?? 0;
        walks.set(id, i + 1);
        return reply.ok(statusData(id, steps[Math.min(i, steps.length - 1)]));
      }
      case "TIKTOK_QUERY_CREATOR_INFO":
        return reply.ok(clone(creator));
      case "TIKTOK_UPLOAD_VIDEO": {
        const f = a.file_to_upload;
        if (!isObject(f) || typeof f.s3key !== "string" || !f.s3key || typeof f.name !== "string" || typeof f.mimetype !== "string")
          return reply.fail("invalid_params", "file_to_upload must be { name, mimetype, s3key }.");
        const publish = a.publish === true;
        if (publish) {
          const p = privacyProblem(a.privacy_level);
          if (p) return p;
          if (typeof a.caption === "string" && a.caption.length > 2200) return reply.fail("invalid_params", "caption is longer than 2200 characters.");
          if (typeof a.brand_content_toggle !== "boolean" || typeof a.brand_organic_toggle !== "boolean")
            return reply.fail("invalid_params", "brand_content_toggle and brand_organic_toggle are required.");
        }
        const id = issue(slug, "video", publish ? "direct" : "drafts", publish ? "v_pub_file" : "v_inbox_file", a, uploads.get(f.s3key)?.bytes ?? 0);
        return reply.ok({ publish_id: id, published: publish });
      }
      case "TIKTOK_POST_PHOTO": {
        const images = a.photo_images;
        if (
          !Array.isArray(images) || images.length < 1 || images.length > 35 ||
          images.some((u) => typeof u !== "string" || u.length > 2083 || !(u.startsWith("https://") || LOOPBACK_URL.test(u)))
        )
          return reply.fail("invalid_params", "photo_images must hold 1 to 35 https URLs.");
        const cover = a.photo_cover_index;
        if (!Number.isInteger(cover) || cover < 0 || cover >= images.length) return reply.fail("invalid_params", "photo_cover_index is out of range.");
        const mode = a.post_mode ?? "MEDIA_UPLOAD";
        if (mode !== "MEDIA_UPLOAD" && mode !== "DIRECT_POST") return reply.fail("invalid_params", "post_mode must be DIRECT_POST or MEDIA_UPLOAD.");
        if (typeof a.title === "string" && a.title.length > 90) return reply.fail("invalid_params", "title is longer than 90 characters.");
        if (typeof a.description === "string" && a.description.length > 4000) return reply.fail("invalid_params", "description is longer than 4000 characters.");
        if (verifiedUrlPrefixes.length && images.some((u: string) => !verifiedUrlPrefixes.some((p) => u.startsWith(p))))
          return reply.fail("url_ownership_unverified");
        if (mode === "DIRECT_POST") {
          const p = privacyProblem(a.privacy_level);
          if (p) return p;
        }
        const id = issue(slug, "photo", mode === "DIRECT_POST" ? "direct" : "drafts", "p_pub_url", a, 0, images.length);
        return reply.ok({ publish_id: id });
      }
      case "TIKTOK_PUBLISH_VIDEO": {
        if (typeof a.video_url !== "string" || !a.video_url) return reply.fail("invalid_params", "video_url is required.");
        const p = privacyProblem(a.privacy_level);
        if (p) return p;
        return reply.ok({ publish_id: issue(slug, "video", "direct", "v_pub_url", a) });
      }
      case "TIKTOK_UPLOAD_VIDEOS": {
        const items: unknown[] = Array.isArray(a.files_to_upload) ? a.files_to_upload : Array.isArray(a.videos) ? a.videos : [];
        if (!items.length) return reply.fail("invalid_params", "files_to_upload must hold at least one file.");
        return reply.ok({ uploads: items.map(() => ({ publish_id: issue(slug, "video", "drafts", "v_inbox_file", a) })) });
      }
      default:
        return { status: 404, json: { error: { message: `Tool ${slug} not found`, slug: "Tool_ToolNotFound", status: 404 } } };
    }
  }

  async function executeReply(slug: string, call: MockCall): Promise<MockReply> {
    const body = call.body;
    if (!isObject(body)) return reply.composioError(400, "BadRequest", "The request body must be a JSON object.");
    const args = isObject(body.arguments) ? body.arguments : {};
    const next = queued.get(slug)?.shift();
    if (next) {
      const r = await next(args, call);
      if (r) return r;
    }
    const on = persistent.get(slug);
    if (on) {
      const r = await on(args, call);
      if (r) return r;
    }
    if (!(TIKTOK_SLUGS as readonly string[]).includes(slug)) return defaultReply(slug, args, call);
    const owner = account.user_id ?? userId;
    const idOk = body.connected_account_id === undefined || body.connected_account_id === connectedAccountId;
    if (!idOk || String(body.user_id ?? "") !== owner || (account.toolkit ?? "tiktok") !== "tiktok")
      return reply.composioError(404, "ActionExecute_ConnectedAccountNotFound", "No connected account found for this user and toolkit.");
    if (account.status !== "ACTIVE" || account.is_disabled) {
      const expired = account.status === "EXPIRED" && !account.is_disabled;
      return reply.composioError(
        400,
        expired ? "ActionExecute_ConnectedAccountExpired" : "ActionExecute_ConnectedAccountInactive",
        `The connected account is ${account.is_disabled ? "disabled" : account.status}.`,
      );
    }
    if (tiktokTokenInvalidRef.value) return reply.fail("access_token_invalid");
    return defaultReply(slug, args, call);
  }

  function uploadRequestReply(call: MockCall, origin: string): MockReply {
    const b = call.body;
    if (
      !isObject(b) || typeof b.toolkit_slug !== "string" || typeof b.tool_slug !== "string" || typeof b.filename !== "string" ||
      !b.filename || typeof b.mimetype !== "string" || typeof b.md5 !== "string" || !/^[0-9a-f]{32}$/i.test(b.md5)
    )
      return reply.composioError(400, "BadRequest", "toolkit_slug, tool_slug, filename, mimetype and an md5 hex digest are required.");
    const safeName = b.filename.replace(/[^A-Za-z0-9._-]+/g, "_");
    const key = `${b.toolkit_slug}/${b.tool_slug}/${b.md5.toLowerCase()}/${safeName}`;
    uploads.set(key, { mimetype: b.mimetype, md5: b.md5.toLowerCase(), filename: b.filename, bytes: uploads.get(key)?.bytes ?? 0 });
    const url = `${origin}/presigned/${key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=3600&X-Amz-Signature=${randHex(16)}`;
    return {
      json: {
        id: `file_${randHex(6)}`,
        key,
        type: presigned.dedup ? "existing" : "new",
        metadata: { storage_backend: presigned.storageBackend },
        ...(presigned.dedup ? {} : { new_presigned_url: url, newPresignedUrl: url }),
      },
    };
  }

  function presignedReply(call: MockCall, md5: string): MockReply {
    const key = decodeURIComponent(call.path.slice("/presigned/".length));
    const upload = uploads.get(key);
    const xml = (code: string, message: string) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
    const asXml = { "content-type": "application/xml" };
    if (call.method !== "PUT") return { status: 405, text: xml("MethodNotAllowed", "Use PUT."), headers: asXml };
    if (!upload) return { status: 403, text: xml("AccessDenied", "Request has expired or the key is unknown."), headers: asXml };
    if ((call.headers["content-type"] ?? "") !== upload.mimetype)
      return { status: 403, text: xml("SignatureDoesNotMatch", "The request signature we calculated does not match the signature you provided."), headers: asXml };
    if (presigned.storageBackend === "azure_blob_storage" && call.headers["x-ms-blob-type"] !== "BlockBlob")
      return { status: 400, text: xml("MissingRequiredHeader", "An HTTP header that's mandatory for this request is not specified: x-ms-blob-type."), headers: asXml };
    upload.bytes = call.bytes;
    presigned.puts.push({ path: call.path, key, headers: { ...call.headers }, bytes: call.bytes, md5 });
    return presigned.storageBackend === "azure_blob_storage"
      ? { status: 201, text: "", headers: { "content-md5": Buffer.from(md5, "hex").toString("base64") } }
      : { status: 200, text: "", headers: { etag: `"${md5}"` } };
  }

  const tiktokTokenInvalidRef = { value: false };
  let origin = "";

  async function route(req: IncomingMessage, call: MockCall, putMd5: string): Promise<MockReply> {
    for (const r of routes) {
      const methodOk = r.method === "*" || r.method.toUpperCase() === call.method;
      const pathOk = typeof r.path === "string" ? r.path === call.path : r.path.test(call.path);
      if (methodOk && pathOk) {
        const out = await r.responder(call);
        if (out) return out;
      }
    }
    if (call.path.startsWith("/presigned/")) return presignedReply(call, putMd5);
    if (!(req.url ?? "").startsWith(API_PREFIX)) return reply.composioError(404, "NotFound", `No mock route for ${call.method} ${call.path}`);
    if (call.headers["x-api-key"] !== apiKey) return reply.composioError(401, "Unauthorized", "Invalid API key provided.");
    let m: RegExpMatchArray | null;
    if (call.method === "POST" && (m = call.path.match(/^\/tools\/execute\/([^/]+)$/))) return executeReply(call.slug ?? m[1], call);
    if (call.method === "GET" && call.path === "/connected_accounts") {
      const ids = listParam(call.query, "connected_account_ids");
      const users = listParam(call.query, "user_ids");
      const toolkits = listParam(call.query, "toolkit_slugs");
      const statuses = listParam(call.query, "statuses");
      const a = accountJson();
      const hit =
        (!ids || ids.includes(a.id)) && (!users || users.includes(a.user_id)) &&
        (!toolkits || toolkits.includes(a.toolkit.slug)) && (!statuses || statuses.includes(a.status));
      const items = hit ? [a] : [];
      return { json: { items, next_cursor: null, total_pages: 1, current_page: 1, total_items: items.length } };
    }
    if (call.method === "GET" && (m = call.path.match(/^\/connected_accounts\/([^/]+)$/))) {
      if (decodeURIComponent(m[1]) !== connectedAccountId) return reply.composioError(404, "ConnectedAccount_NotFound", "Connected account not found.");
      return { json: accountJson() };
    }
    if (call.method === "POST" && call.path === "/files/upload/request") return uploadRequestReply(call, origin);
    return reply.composioError(404, "NotFound", `No mock route for ${call.method} ${call.path}`);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", origin);
    const full = url.pathname;
    const path = full.startsWith(API_PREFIX) ? full.slice(API_PREFIX.length) || "/" : full;
    const isPut = path.startsWith("/presigned/");
    const hash = createHash("md5");
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      bytes += buf.length;
      if (isPut) hash.update(buf);
      else chunks.push(buf);
    }
    let body: any;
    if (!isPut && chunks.length) {
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        body = undefined;
      }
    }
    const exec = req.method === "POST" ? path.match(/^\/tools\/execute\/([^/]+)$/) : null;
    const call: MockCall = {
      method: (req.method ?? "GET").toUpperCase(),
      path,
      query: queryOf(url),
      ...(exec ? { slug: decodeURIComponent(exec[1]) } : {}),
      ...(body !== undefined ? { body } : {}),
      bytes,
      headers: headersOf(req),
    };
    calls.push(call);
    const r = await route(req, call, hash.digest("hex"));
    if (r.delayMs) await sleep(r.delayMs);
    if (r.drop) {
      req.socket.destroy();
      return;
    }
    if (res.destroyed || req.socket.destroyed) return;
    const text = r.text !== undefined ? r.text : r.json !== undefined ? JSON.stringify(r.json) : "";
    const type = r.text !== undefined ? "text/plain; charset=utf-8" : "application/json";
    res.writeHead(r.status ?? 200, { "content-type": type, ...r.headers });
    res.end(text);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      try {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `mock crashed: ${(e as Error)?.message}`, slug: "MockCrash", status: 500 } }));
      } catch {
        /* socket gone */
      }
    });
  });
  // Bun binds synchronously, so the port is known right away.
  server.listen(opts.port ?? 0, "127.0.0.1");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("mock-composio: the server didn't bind");
  origin = `http://127.0.0.1:${address.port}`;

  function reset() {
    for (const k of Object.keys(account)) delete (account as Record<string, unknown>)[k];
    Object.assign(account, { status: "ACTIVE" });
    for (const k of Object.keys(creator)) delete (creator as unknown as Record<string, unknown>)[k];
    Object.assign(creator, defaultCreator());
    for (const k of Object.keys(user)) delete user[k];
    Object.assign(user, defaultUser());
    videos.splice(0, videos.length, ...defaultVideos());
    verifiedUrlPrefixes.length = 0;
    tiktokTokenInvalidRef.value = false;
    calls.length = 0;
    persistent.clear();
    queued.clear();
    routes.length = 0;
    sequences.clear();
    walks.clear();
    issued.clear();
    uploads.clear();
    presigned.puts.length = 0;
    presigned.storageBackend = "s3";
    presigned.dedup = false;
  }

  const mock: MockComposio = {
    baseUrl: `${origin}${API_PREFIX}`,
    origin,
    apiKey,
    userId,
    connectedAccountId,
    account,
    creator,
    user,
    videos,
    verifiedUrlPrefixes,
    get tiktokTokenInvalid() {
      return tiktokTokenInvalidRef.value;
    },
    set tiktokTokenInvalid(v: boolean) {
      tiktokTokenInvalidRef.value = v;
    },
    calls,
    executes: (slug?: string) => calls.filter((c) => c.slug !== undefined && (slug === undefined || c.slug === slug)),
    on(slug, responder) {
      persistent.set(slug, responder);
    },
    once(slug, responder) {
      const list = queued.get(slug) ?? [];
      list.push(responder);
      queued.set(slug, list);
    },
    onRoute(method, path, responder) {
      routes.push({ method, path, responder });
    },
    defaultReply,
    setStatusSequence(publishId, seq) {
      if (!seq.length) throw new Error("setStatusSequence needs at least one step");
      sequences.set(publishId, { steps: seq.map((s) => ({ ...s })), i: 0 });
    },
    issued,
    presigned,
    reset,
    stop() {
      server.closeAllConnections?.();
      server.close();
    },
  };
  return mock;
}

if (import.meta.main) {
  const portArg = process.argv.find((a) => a.startsWith("--port="));
  const mock = startMockComposio({ port: portArg ? Number(portArg.slice("--port=".length)) : undefined });
  // Standalone use only (never imported by the shipped server): stdout is fine here.
  console.log(`MOCK_COMPOSIO_BASE_URL=${mock.baseUrl}`);
  console.log(`COMPOSIO_API_KEY=${mock.apiKey}`);
  console.log(`COMPOSIO_USER_ID=${mock.userId}`);
  console.log(`COMPOSIO_CONNECTED_ACCOUNT_ID=${mock.connectedAccountId}`);
}
