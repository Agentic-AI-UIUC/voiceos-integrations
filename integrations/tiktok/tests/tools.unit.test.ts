/**
 * The twelve tools through the MCP surface, with every side effect faked: a
 * recording Composio client, an in-memory token store and spent-receipt set,
 * a fake relay, converter, clipboard and file finders, and a virtual clock
 * whose sleeps return at once. Nothing here touches the network, the
 * clipboard or macOS tools.
 */
import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { z } from "zod";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import * as cards from "../src/cards.ts";
import { MEDIA_RELAY_BASE, loadConfig } from "../src/config.ts";
import { TikTokError } from "../src/errors.ts";
import { createDeps, createServer, type Deps } from "../src/mcpServer.ts";
import { mintReceipt } from "../src/receipts.ts";
import { parseResult } from "../src/results.ts";
import { CAPABILITY_GUIDANCE } from "../src/mcpServer.ts";
import { pollScheduleFrom } from "../src/main.ts";
import { TOOL_META, photoToolsEnabled } from "../src/tools.ts";
import type { BundleImage, BundleRef, FileRef, FoundImage, FoundVideo, ImageRef, PostRef, WriteTool } from "../src/types.ts";
import { encodeMicroFrame, encodePhotoFrame, joinMicroPreview, joinPhotoStack, splitPhotoStack } from "../src/microPreview.ts";

/** A real (decodable) micro frame that differs per file name, so the server's preview check sees realistic input. */
function fakeFrame(seed: string): string {
  let hsh = 0;
  for (const ch of seed) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
  const w = 18, h = 32, rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = (hsh >> 3) + i * 3; rgb[i * 3 + 1] = (hsh >> 11) + i; rgb[i * 3 + 2] = (hsh >> 19) + i * 7;
  }
  return encodeMicroFrame(rgb, w, h);
}

/** A real (decodable) photo-stack frame that differs per photo name. */
function fakePhotoFrame(seed: string): string {
  let hsh = 7;
  for (const ch of seed) hsh = (hsh * 31 + ch.charCodeAt(0)) >>> 0;
  const w = 24, h = 32, rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = (hsh >> 5) + i * 5; rgb[i * 3 + 1] = (hsh >> 13) + i * 2; rgb[i * 3 + 2] = (hsh >> 21) + i * 3;
  }
  return encodePhotoFrame(rgb, w, h);
}

const TriggerRequest = z.object({ method: z.literal("voiceos/reminders/trigger"), params: z.record(z.unknown()) });

const T0 = Date.UTC(2026, 10, 3, 18, 0, 0);
const NOW_SEC = Math.floor(T0 / 1000);
const MIN = 60_000;

const ROOT = mkdtempSync(join(tmpdir(), "tiktok-tools-unit-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeClock(start = T0) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw signal.reason;
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => void (t += ms),
    sleeps,
  };
}

class FakeTokens {
  private readonly map = new Map<string, { kind: string; ref: unknown }>();
  private n = 0;
  private mint(kind: string, ref: unknown) {
    const token = `${kind}t1.fake.${++this.n}`;
    this.map.set(token, { kind, ref: structuredClone(ref) });
    return token;
  }
  private get<T>(kind: string, token: unknown, name: string): T {
    const e = this.map.get(String(token ?? "").trim());
    if (!e || e.kind !== kind) throw new TikTokError("TOKEN_STALE", { kind: name });
    return structuredClone(e.ref) as T;
  }
  mintFile = (r: FileRef) => this.mint("f", r);
  mintImage = (r: ImageRef) => this.mint("i", r);
  mintBundle = (r: BundleRef) => this.mint("b", r);
  mintPost = (r: PostRef) => this.mint("p", r);
  file = (t: unknown) => this.get<FileRef>("f", t, "file");
  image = (t: unknown) => this.get<ImageRef>("i", t, "image");
  bundle = (t: unknown) => this.get<BundleRef>("b", t, "bundle");
  post = (t: unknown) => this.get<PostRef>("p", t, "post");
}

type Step = string | { status: string; fail_reason?: string } | Error;

const USER = {
  display_name: "Maya Makes", username: "maya.makes", follower_count: 12_345, following_count: 321, likes_count: 1_234_567, video_count: 48,
  bio_description: "Baker in Lisbon", is_verified: false, avatar_url_100: "https://p16-sign.tiktokcdn-us.com/a.jpeg",
  profile_deep_link: "https://vm.tiktok.com/abc/",
};
const CAP150 = `Late night bake #sourdough @maya.makes ${"crumb ".repeat(30)}`.slice(0, 150);
const VIDEOS = [
  {
    id: "7431000000000000001", create_time: NOW_SEC - 3 * 86_400, title: "", video_description: "Cat tries ramen #cats #fyp with @maya.makes",
    duration: 23, width: 1080, height: 1920, cover_image_url: "https://p16-sign.tiktokcdn-us.com/c1.jpeg",
    share_url: "https://www.tiktok.com/@maya.makes/video/7431000000000000001", embed_link: "https://www.tiktok.com/embed/v2/7431000000000000001",
    view_count: 8_400, like_count: 612, comment_count: 40, share_count: 12,
  },
  {
    id: "7431000000000000002", create_time: NOW_SEC - 9 * 86_400, title: "", video_description: CAP150, duration: 0, width: 1080, height: 1350,
    share_url: "https://www.tiktok.com/@maya.makes/video/7431000000000000002", view_count: 50, like_count: 5, comment_count: 1, share_count: 0,
  },
];

class FakeClient {
  readonly execs: Array<{ slug: string; args: any; opts: any }> = [];
  readonly staged: Array<{ path: string; mimetype: string; toolSlug: string; deadline: number }> = [];
  accountChecks = 0;
  readonly statusSeq = new Map<string, Step[]>();
  creator: Record<string, unknown> = {
    creator_nickname: "Maya Makes", creator_username: "maya.makes", privacy_level_options: ["SELF_ONLY"],
    comment_disabled: false, duet_disabled: true, stitch_disabled: true, max_video_post_duration_sec: 600,
  };
  private n = 0;
  readonly responders: Record<string, (args: any) => unknown> = {
    TIKTOK_GET_USER_STATS: ({ fields }: { fields: string[] }) => ({ user: Object.fromEntries(fields.map((f) => [f, (USER as any)[f]])) }),
    TIKTOK_LIST_VIDEOS: ({ max_count }: { max_count: number }) => ({ videos: VIDEOS.slice(0, max_count), cursor: (NOW_SEC - 9 * 86_400) * 1000, has_more: true }),
    TIKTOK_QUERY_VIDEOS: ({ video_ids }: { video_ids: string[] }) => ({ videos: VIDEOS.filter((v) => video_ids.includes(v.id)) }),
    TIKTOK_QUERY_CREATOR_INFO: () => ({ ...this.creator }),
    TIKTOK_UPLOAD_VIDEO: (a: any) => ({ publish_id: `${a.publish ? "v_pub_file" : "v_inbox_file"}~v2.${++this.n}`, published: a.publish }),
    TIKTOK_POST_PHOTO: () => ({ publish_id: `p_pub_url~v2.${++this.n}` }),
    TIKTOK_FETCH_PUBLISH_STATUS: ({ publish_id }: { publish_id: string }) => {
      const seq = this.statusSeq.get(publish_id) ?? this.defaultSeq(publish_id);
      this.statusSeq.set(publish_id, seq);
      const step = seq.length > 1 ? seq.shift()! : seq[0];
      if (step instanceof Error) throw step;
      return typeof step === "string" ? { status: step, fail_reason: "", publicaly_available_post_id: [], uploaded_bytes: 1 } : step;
    },
  };
  constructor(private readonly events: string[]) {}
  private defaultSeq(id: string): Step[] {
    if (id.startsWith("v_inbox")) return ["PROCESSING_UPLOAD", "SEND_TO_USER_INBOX"];
    if (id.startsWith("v_pub")) return ["PROCESSING_UPLOAD", "PUBLISH_COMPLETE"];
    if (id.startsWith("p_")) return ["PROCESSING_DOWNLOAD", "SEND_TO_USER_INBOX"];
    return [new TikTokError("INVALID_PARAM", { tiktok_code: "invalid_publish_id" })];
  }
  async assertAccount(_signal: AbortSignal): Promise<string> {
    this.accountChecks++;
    this.events.push("account");
    return "ca_test";
  }
  async exec<T>(slug: string, args: Record<string, unknown>, opts: any): Promise<T> {
    this.events.push(`exec:${slug}`);
    this.execs.push({ slug, args: structuredClone(args), opts });
    const r = this.responders[slug];
    if (!r) throw new Error(`no responder for ${slug}`);
    return (await r(args)) as T;
  }
  async stageFile(path: string, mimetype: string, toolSlug: string, deadline: number) {
    this.events.push(`stage:${basename(path)}`);
    this.staged.push({ path, mimetype, toolSlug, deadline });
    return { name: basename(path), mimetype, s3key: `staged/${basename(path)}` };
  }
  slugs(): string[] {
    return this.execs.map((e) => e.slug);
  }
}

const bucket = () => ({ allow: true, taken: 0, tryTake() { if (!this.allow) return false; this.taken++; return true; }, msUntilNext: () => 0 });

function realFile(rel: string, bytes = 2048): { path: string; size: number; mtimeMs: number } {
  const path = join(ROOT, rel);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, new Uint8Array(bytes).fill(7));
  const st = statSync(path);
  return { path, size: st.size, mtimeMs: st.mtimeMs };
}

function video(rel: string, extra: Partial<FoundVideo> = {}): FoundVideo {
  const f = realFile(rel);
  return { ...f, name: basename(rel), folder: "Downloads", addedMs: T0 - 2 * MIN, mime: "video/mp4", duration_sec: 23, width: 1080, height: 1920, ...extra };
}

function image(rel: string, extra: Partial<FoundImage> = {}): FoundImage {
  const f = realFile(rel, 512);
  return {
    ...f, name: basename(rel), folder: "Downloads", addedMs: T0 - MIN, ext: rel.split(".").pop()!.toLowerCase(),
    width: 4032, height: 3024, format: "heic", has_alpha: false, is_screenshot: false, ...extra,
  };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

async function harness(over: Partial<Deps> & { videos?: FoundVideo[]; images?: FoundImage[]; batchHint?: string; stateDir?: string } = {}) {
  const events: string[] = [];
  const clock = fakeClock();
  const client = new FakeClient(events);
  const tokens = new FakeTokens();
  const spent = { set: new Set<string>(), has(d: string) { return this.set.has(d); }, spend(d: string) { this.set.add(d); } };
  const relay = {
    configured: true,
    created: [] as number[],
    deleted: [] as string[],
    puts: [] as number[][],
    failPut: undefined as TikTokError | undefined,
    async createBatch(count: number) {
      events.push("relay:create");
      relay.created.push(count);
      return {
        batch_id: "abcdef1234567890", expires_at: new Date(T0 + 3_600_000).toISOString(),
        items: Array.from({ length: count }, (_, i) => ({ index: i, put_path: `/v1/batches/abcdef/${i}`, public_url: `https://media.example.test/abcdef/${i}.jpg` })),
      };
    },
    async putImages(batch: { items: { public_url: string }[] }, files: { bytes: Uint8Array }[]) {
      events.push("relay:put");
      if (relay.failPut) throw relay.failPut;
      relay.puts.push(files.map((f) => f.bytes.length));
      return batch.items.map((i) => i.public_url);
    },
    async deleteBatch(id: string) {
      events.push("relay:delete");
      relay.deleted.push(id);
    },
  };
  const limits = { creatorInfo: bucket(), writeInit: bucket(), status: bucket() };
  // Pictures: every URL asked for is recorded; the ones in `pictures` come back as data URIs.
  const images = {
    asked: [] as Array<{ url: unknown; width?: number }>,
    pictures: new Map<string, string>(),
    async dataUri(url: unknown, o: { width?: number } = {}) {
      images.asked.push({ url, width: o.width });
      return images.pictures.get(String(url));
    },
    async many(urls: Record<string, unknown>, o: { width?: number } = {}) {
      const out: Record<string, string> = {};
      for (const [k, u] of Object.entries(urls)) {
        images.asked.push({ url: u, width: o.width });
        const hit = images.pictures.get(String(u));
        if (hit) out[k] = hit;
      }
      return out;
    },
  };
  // Local frames: a poster per requested width, and a micro preview that differs per file (as real ones do).
  const previews = {
    calls: [] as Array<{ name: string; opts: any }>,
    off: false,
    /** The loop a `motion` request gets back (none unless a test sets it). */
    motion: undefined as undefined | { src: string; frames?: number; fps?: number },
    async make(path: string, _info: unknown, opts: any = {}) {
      previews.calls.push({ name: basename(path), opts });
      if (previews.off) return {};
      const micro = joinMicroPreview([fakeFrame(basename(path))], { durationSec: 23 });
      return {
        ...(opts.posterWidth ? { poster: `data:image/jpeg;base64,/9j/${opts.posterWidth}${basename(path).length}` } : {}),
        ...(opts.micro === false ? {} : { micro }),
        ...(opts.motion && previews.motion ? { motion: previews.motion } : {}),
      };
    },
  };
  // Photos: a stack (first five, count and cover in the header) and thumbnails that name their photo and width.
  const photoLook = {
    calls: [] as Array<{ names: string[]; opts: any }>,
    off: false,
    async make(paths: string[], opts: any = {}) {
      photoLook.calls.push({ names: paths.map((p) => basename(p)), opts });
      if (photoLook.off) return {};
      const take = paths.slice(0, Math.min(35, opts.max ?? 5));
      const width = opts.thumbWidth ?? 150;
      const thumbs = width ? take.map((p) => `data:image/jpeg;base64,${Buffer.from(`${width}:${basename(p)}`).toString("base64")}`) : undefined;
      const stack = opts.frames === false ? "" : joinPhotoStack(take.slice(0, 5).map((p) => fakePhotoFrame(basename(p))), { count: opts.count ?? paths.length, cover: opts.cover });
      return { ...(stack ? { stack } : {}), ...(thumbs ? { thumbs } : {}) };
    },
  };
  const clipboard: string[] = [];
  const cleaned: string[] = [];
  const vids = over.videos ?? [video("Downloads/final_export.mp4")];
  const imgs = over.images ?? [];
  // The harness's own options (videos, images, batchHint) aren't dependencies: `images` would shadow Deps.images.
  const { videos: _videos, images: _images, batchHint: _batchHint, stateDir: _stateDir, ...depsOver } = over;
  const cfg = loadConfig(
    { COMPOSIO_API_KEY: "test_key", COMPOSIO_CONNECTED_ACCOUNT_ID: "ca_test" },
    // Each harness its own state folder: the ledger persists there (a restart test reuses one on purpose).
    ["--composio-base-url=http://127.0.0.1:9/api/v3.1", `--state-dir=${over.stateDir ?? mkdtempSync(join(ROOT, "state-"))}`, `--home=${ROOT}`],
  );
  const deps = createDeps(cfg, {
    clock,
    client,
    tokens,
    spent,
    relay,
    limits,
    images,
    preview: (path, info, opts) => previews.make(path, info, opts),
    photoPreview: (paths, opts) => photoLook.make(paths, opts),
    runner: async () => ({ code: 127, stdout: "", stderr: "not in unit tests", timedOut: false }),
    findVideos: async (o) => ({ videos: vids.slice(0, o.limit), query_matched: !o.query || vids.some((v) => v.name.includes(o.query!)), denied_folders: [], searched_folders: ["Downloads"] }),
    findImages: async (o) => ({ images: imgs.slice(0, o.limit), query_matched: true, denied_folders: [], unsupported_count: 0, searched_folders: ["Downloads"], ...(over.batchHint ? { batch_hint: over.batchHint } : {}) }),
    sipsMeta: async (paths) => new Map(paths.map((p) => [p, p.includes("broken") ? null : { width: 4032, height: 3024, format: "heic", has_alpha: false }])),
    credentials: async (p) => (p.includes("ai") ? "ai" : "none"),
    convert: async (images) => {
      events.push("convert");
      const dir = mkdtempSync(join(ROOT, "conv-"));
      const files = images.map((_, i) => {
        const path = join(dir, `${i}.jpg`);
        writeFileSync(path, new Uint8Array([0xff, 0xd8, 0xff, i, 1, 2]));
        return { path, bytes: 6, width: 1080, height: 810 };
      });
      return { files, dir, cleanup: async () => void (cleaned.push(dir), rmSync(dir, { recursive: true, force: true })) };
    },
    copyToClipboard: async (text) => {
      events.push("clipboard");
      clipboard.push(text);
    },
    ...depsOver,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createServer(deps).connect(serverSide);
  const mcp = new Client({ name: "unit", version: "1.0.0" });
  // VoiceOS's side of the reminders: record each trigger (or refuse it, when a test says so).
  const triggers: any[] = [];
  const reminderHost = { refuse: undefined as Error | undefined };
  mcp.setRequestHandler(TriggerRequest, async (req) => {
    if (reminderHost.refuse) throw reminderHost.refuse;
    triggers.push(req.params);
    return { notificationId: `n${triggers.length}` };
  });
  await mcp.connect(clientSide);
  const action = (notificationId: string, actionId: string, data?: Record<string, unknown>) =>
    mcp.request({ method: "voiceos/reminders/action", params: { notificationId, actionId, ...(data ? { data } : {}) } }, z.object({}).passthrough()) as Promise<any>;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await mcp.callTool({ name, arguments: args })) as any;
    return { r, j: parseResult(r), blocks: parseResult(r)._voiceos_glance?.blocks ?? [] };
  };
  const signed = (tool: WriteTool, args: Record<string, unknown>) => ({ ...args, confirmation_receipt: mintReceipt(tool, args, clock.now()) });
  const fileToken = async () => (await call("find_recent_videos", {})).j.videos[0].file_token as string;
  const post = (media_token: string, extra: Partial<PostRef> = {}) =>
    tokens.mintPost({
      connected_account_id: "ca_test", creator_nickname: "Maya Makes", creator_username: "maya.makes", privacy_options: ["SELF_ONLY"],
      comment_disabled: false, duet_disabled: true, stitch_disabled: true, max_duration_sec: 600, media_token, media_kind: "video", fetched_at: clock.now(), ...extra,
    });
  return { deps, mcp, triggers, reminderHost, action, clock, client, tokens, spent, relay, limits, images, previews, photoLook, clipboard, cleaned, events, call, signed, fileToken, post, close: () => mcp.close() };
}

const noPaths = (j: unknown) => expect(JSON.stringify(j)).not.toContain(ROOT);

/** What a card function was given (the cards themselves are tested in cards.test.ts). Restored after each test. */
afterEach(() => mock.restore());
const cardSpy = <K extends keyof typeof cards>(name: K) => spyOn(cards, name as never) as unknown as { mock: { calls: any[][] } };

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("registration", () => {
  test("TOOL_META is the contract's twelve, in order; it also answers by name", () => {
    const names = ["get_user_stats", "list_videos", "query_videos", "fetch_publish_status", "query_creator_info", "find_recent_videos",
      "find_recent_images", "prepare_photo_post", "upload_video", "publish_video", "upload_photos", "post_photos"];
    expect(TOOL_META.map((t) => t.name)).toEqual(names);
    expect(Object.keys(TOOL_META)).toEqual(names);
    expect(TOOL_META.publish_video.execution).toEqual({ mode: "background", estimatedDurationMs: 180_000 });
    expect(TOOL_META.filter((t) => t.photo).map((t) => t.name)).toEqual(["find_recent_images", "prepare_photo_post", "upload_photos", "post_photos"]);
    expect(TOOL_META.filter((t) => t.visibility === "agent").map((t) => t.name)).toEqual(["query_creator_info", "find_recent_videos", "find_recent_images", "prepare_photo_post"]);
    // Photo tools are enabled only with a configured relay.
    expect(photoToolsEnabled()).toBe(Boolean(MEDIA_RELAY_BASE.trim()));
    expect(photoToolsEnabled({ relayBase: "" })).toBe(false);
    expect(photoToolsEnabled({ relayBase: "http://127.0.0.1:5" })).toBe(true);
    for (const t of TOOL_META) {
      expect(t.description).toMatch(/Use (only )?when/);
      expect(t.description).not.toMatch(/\bnever\b|\bdon't\b|\bstop\b|\bverbatim\b|spoken yes/i);
      expect(t.annotations.readOnlyHint).toBe(!t.write);
    }
  });

  test("the server's instructions state facts, not steering; --poll-schedule only applies against a loopback mock", () => {
    expect(CAPABILITY_GUIDANCE).not.toMatch(/\bsay so\b|instead of|before answering|explain only|\bnever\b|\bdon't\b|\bdo not\b|use this connected/i);
    expect(CAPABILITY_GUIDANCE).toContain("Only me");
    expect(pollScheduleFrom(["--poll-schedule=1,2,3"], "http://127.0.0.1:4100/api/v3.1")).toEqual([1, 2, 3]);
    expect(pollScheduleFrom(["--poll-schedule=1,2,3"], "https://backend.composio.dev/api/v3.1")).toBeUndefined();
    expect(pollScheduleFrom(["--poll-schedule=fast"], "http://127.0.0.1:4100/api/v3.1")).toBeUndefined();
    expect(pollScheduleFrom([], "http://127.0.0.1:4100/api/v3.1")).toBeUndefined();
  });

  test("tools/list serves the twelve with titles, annotations and the contract's schemas", async () => {
    const h = await harness();
    const [s, c] = InMemoryTransport.createLinkedPair();
    await createServer(h.deps).connect(s);
    const mcp = new Client({ name: "list", version: "1" });
    await mcp.connect(c);
    const { tools } = await mcp.listTools();
    // Plus VoiceOS's hidden transcript hook endpoint (src/conversation.ts), which the agent never sees.
    expect(tools.map((t) => t.name)).toEqual([...TOOL_META.map((t) => t.name), "voiceos_hook_transcript"]);
    const by = Object.fromEntries(tools.map((t) => [t.name, t])) as Record<string, any>;
    for (const name of ["get_user_stats", "list_videos", "query_videos", "fetch_publish_status", "query_creator_info"]) {
      expect(by[name].inputSchema.additionalProperties).toBe(false);
    }
    expect(by.list_videos.inputSchema.properties.max_count).toMatchObject({ type: "integer", minimum: 1, maximum: 20, default: 5 });
    expect(by.query_videos.inputSchema.required).toEqual(["video_ids"]);
    expect(by.prepare_photo_post.inputSchema.properties.image_tokens).toMatchObject({ type: "array", minItems: 1, maxItems: 35 });
    expect(by.prepare_photo_post.inputSchema.required).toEqual(["image_tokens"]);
    expect(by.publish_video.inputSchema.required).toEqual(["post_token", "file_token"]);
    expect(by.post_photos.inputSchema.required).toEqual(["bundle_token", "post_token"]);
    expect(by.publish_video.inputSchema.properties.allow_comment).toEqual({
      anyOf: [{ type: "boolean" }, { type: "string", enum: ["true", "false"] }], default: false, description: expect.any(String),
    });
    // Cover times in words ("0:05", "5s") as well as milliseconds; audience words as well as TikTok's codes.
    expect(by.publish_video.inputSchema.properties.cover_ms.anyOf).toEqual([{ type: "integer", minimum: 0 }, { type: "string", maxLength: 40 }]);
    for (const name of ["publish_video", "post_photos"]) {
      expect(by[name].inputSchema.properties.privacy_level).toEqual({ type: "string", default: "", description: expect.any(String) });
    }
    for (const name of ["upload_video", "publish_video", "upload_photos", "post_photos"]) {
      for (const key of ["hashtags", "mentions"]) {
        expect(by[name].inputSchema.properties[key]).toEqual({ anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }], description: expect.any(String) });
      }
      expect(by[name].inputSchema.required).not.toContain("hashtags");
    }
    expect(by.upload_video.inputSchema.properties.caption.maxLength).toBe(2200);
    expect(by.upload_photos.inputSchema.properties.title.maxLength).toBe(90);
    expect(by.post_photos.inputSchema.properties.description.maxLength).toBe(4000);
    expect(by.upload_video.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(by.find_recent_videos.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    // No $ref between properties: every field is its own schema object.
    expect(JSON.stringify(tools)).not.toContain("$ref");
    await mcp.close();
  });
});

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

describe("reads", () => {
  test("get_user_stats asks for the stats + basic fields, adds the profile fields on request, and keeps only those", async () => {
    const h = await harness();
    const { j, blocks } = await h.call("get_user_stats", {});
    expect(h.client.execs[0].args.fields).toEqual(["follower_count", "following_count", "likes_count", "video_count", "display_name", "username", "avatar_url_100", "avatar_url"]);
    expect(j).toMatchObject({ ok: true, username: "maya.makes", follower_count: 12_345, likes_count: 1_234_567, video_count: 48 });
    expect(j.bio_description).toBeUndefined();
    expect(j.summary).toBe("You have 12.3K followers and 1.23M likes across 48 public videos.".replace("1.23M", j.summary.match(/and (\S+) likes/)[1]));
    expect(blocks).toHaveLength(1);
    const p = await h.call("get_user_stats", { include_profile: true });
    expect(h.client.execs[1].args.fields).toHaveLength(11);
    expect(p.j).toMatchObject({ bio_description: "Baker in Lisbon", is_verified: false, profile_deep_link: "https://vm.tiktok.com/abc/" });
  });

  test("summaries use the singular for a count of one (a brand-new account reads right)", async () => {
    const h = await harness();
    h.client.responders.TIKTOK_GET_USER_STATS = () => ({ follower_count: 1, likes_count: 0, video_count: 1, username: "new.one" });
    expect((await h.call("get_user_stats", {})).j.summary).toBe("You have 1 follower and 0 likes across 1 public video.");
    h.client.responders.TIKTOK_LIST_VIDEOS = () => ({ videos: [{ ...VIDEOS[0], view_count: 1 }], has_more: false });
    expect((await h.call("list_videos", {})).j.summary).toBe("Your latest public post has 1 view.");
  });

  test("get_user_stats: a missing profile scope retries once without the profile fields", async () => {
    const h = await harness();
    let n = 0;
    const base = h.client.responders.TIKTOK_GET_USER_STATS;
    h.client.responders.TIKTOK_GET_USER_STATS = (a) => {
      if (n++ === 0) throw new TikTokError("SCOPE_MISSING", { scope: "user.info.profile" });
      return base(a);
    };
    const { j } = await h.call("get_user_stats", { include_profile: true });
    expect(h.client.execs.map((e) => e.args.fields.length)).toEqual([11, 8]);
    expect(j).toMatchObject({ ok: true, profile_unavailable: true, follower_count: 12_345 });
    expect(j.bio_description).toBeUndefined();
  });

  test("list_videos always passes max_count, keeps share_url, marks captions untrusted and keeps them out of the summary", async () => {
    const h = await harness();
    const { j } = await h.call("list_videos", { cursor: 1_793_000_000_000 });
    expect(h.client.execs[0].args).toEqual({ max_count: 5, cursor: 1_793_000_000_000 });
    expect(j.count).toBe(2);
    expect(j.videos[0]).toMatchObject({ id: VIDEOS[0].id, share_url: VIDEOS[0].share_url, view_count: 8_400, duration_label: "0:23" });
    expect(j.videos[0].posted_label).toContain("3 days ago");
    expect(j.has_more).toBe(true);
    expect(j.cursor).toBe((NOW_SEC - 9 * 86_400) * 1000);
    expect(j.note).toContain("user-written");
    expect(j.summary).not.toContain("ramen");
    h.client.responders.TIKTOK_LIST_VIDEOS = () => ({ videos: [], has_more: false });
    expect((await h.call("list_videos", { max_count: 3 })).j.summary).toBe("No public posts yet. Private (Only me) posts and drafts don't show up here.");
  });

  test("query_videos computes hashtags, mentions, posted label, aspect, the 150-char cut and engagement (views ≥ 100 only)", async () => {
    const h = await harness();
    const one = await h.call("query_videos", { video_ids: [VIDEOS[0].id] });
    expect(one.j.videos[0]).toMatchObject({
      hashtags: ["#cats", "#fyp"], mentions: ["maya.makes"], aspect: "9:16", engagement_rate: Math.round((664 / 8400) * 10_000) / 10_000,
    });
    expect(one.j.summary).toBe("That post has 8.4K views and 612 likes.");
    const both = await h.call("query_videos", { video_ids: [VIDEOS[0].id, VIDEOS[1].id, "7431000000000000999"] });
    const second = both.j.videos[1];
    expect(second.caption_truncated).toBe(true);
    expect(second.engagement_rate).toBeUndefined();
    expect(both.j.missing_ids).toEqual(["7431000000000000999"]);
    expect(both.j.note).toContain("user-written");
  });

  test("get_user_stats always fetches the profile picture for the card, and keeps its URL out of a stats-only result", async () => {
    const h = await harness();
    const pic = "data:image/jpeg;base64,/9j/AAAA";
    h.images.pictures.set(USER.avatar_url_100, pic);
    const card = cardSpy("statsCard");
    const { j, blocks } = await h.call("get_user_stats", {});
    expect(h.images.asked).toEqual([{ url: USER.avatar_url_100, width: undefined }]);
    expect(card.mock.calls[0][0]).toMatchObject({ avatar_data: pic, username: "maya.makes", include_profile: false });
    expect(j.avatar_url_100).toBeUndefined();
    expect(JSON.stringify({ ...j, _voiceos_glance: undefined })).not.toContain("data:image");
    expect(blocks).toHaveLength(1);
    // With the profile the URL is data too, as before.
    expect((await h.call("get_user_stats", { include_profile: true })).j.avatar_url_100).toBe(USER.avatar_url_100);
    // No picture (not on the CDN allowlist, timed out, …): the card still renders, with its monogram.
    h.images.pictures.clear();
    const bare = await h.call("get_user_stats", {});
    expect(bare.j.ok).toBe(true);
    expect(card.mock.calls[2][0].avatar_data).toBeUndefined();
    expect(bare.blocks).toHaveLength(1);
  });

  test("list_videos fetches covers for the rows the card shows, keyed by post id, and remembers the average views", async () => {
    const h = await harness();
    const many = Array.from({ length: 8 }, (_, i) => ({
      ...VIDEOS[0], id: `74310000000000001${i}`, view_count: 1000 * (i + 1), cover_image_url: `https://p16-common-sign.tiktokcdn-us.com/c${i}.jpeg`,
    }));
    h.client.responders.TIKTOK_LIST_VIDEOS = () => ({ videos: many, has_more: false });
    h.images.pictures.set(many[0].cover_image_url, "data:image/jpeg;base64,/9j/C0");
    const list = cardSpy("videoListCard");
    const detail = cardSpy("postDetailsCard");
    const { j } = await h.call("list_videos", { max_count: 8 });
    expect(h.images.asked.map((a) => a.url)).toEqual(many.slice(0, 6).map((v) => v.cover_image_url));
    expect(list.mock.calls[0][2]).toEqual({ covers: { [many[0].id]: "data:image/jpeg;base64,/9j/C0" } });
    expect(JSON.stringify({ ...j, _voiceos_glance: undefined })).not.toContain("data:image");
    // The next single-post query compares against those posts' average, from memory (one TikTok call, not two).
    h.client.responders.TIKTOK_QUERY_VIDEOS = () => ({ videos: [many[2]] });
    h.images.pictures.set(many[2].cover_image_url, "data:image/jpeg;base64,/9j/BIG");
    const one = await h.call("query_videos", { video_ids: [many[2].id] });
    expect(h.client.slugs()).toEqual(["TIKTOK_LIST_VIDEOS", "TIKTOK_QUERY_VIDEOS"]);
    expect(one.j).toMatchObject({ channel_avg_views: 4500, channel_avg_posts: 8 });
    // The hero tile's cover: longest side 312 px (2× its 156).
    expect(h.images.asked.at(-1)).toEqual({ url: many[2].cover_image_url, width: 312 });
    expect(detail.mock.calls[0][2]).toEqual({ cover: "data:image/jpeg;base64,/9j/BIG", channelAvgViews: 4500 });
    // A later page (cursor) doesn't replace the memory; after 30 minutes it's gone.
    await h.call("list_videos", { cursor: 1 });
    expect((await h.call("query_videos", { video_ids: [many[2].id] })).j.channel_avg_views).toBe(4500);
    h.clock.advance(31 * MIN);
    expect((await h.call("query_videos", { video_ids: [many[2].id] })).j.channel_avg_views).toBeUndefined();
  });

  test("get_user_stats prefers the sharper 168 px avatar_url for the card when TikTok sends both", async () => {
    const h = await harness();
    const sharp = "https://p16-sign.tiktokcdn-us.com/a~c5_168x168.jpeg";
    h.client.responders.TIKTOK_GET_USER_STATS = () => ({ user: { ...USER, avatar_url: sharp } });
    h.images.pictures.set(sharp, "data:image/jpeg;base64,/9j/SH");
    const card = cardSpy("statsCard");
    const { j } = await h.call("get_user_stats", { include_profile: true });
    expect(h.images.asked).toEqual([{ url: sharp, width: undefined }]);
    expect(card.mock.calls[0][0]).toMatchObject({ avatar_data: "data:image/jpeg;base64,/9j/SH" });
    // The data keeps the 100 px URL it always had, and never the other one.
    expect(j.avatar_url_100).toBe(USER.avatar_url_100);
    expect(JSON.stringify({ ...j, _voiceos_glance: undefined })).not.toContain("c5_168x168");
    // One that isn't on TikTok's image CDN gives way to the 100 px one that is.
    h.images.asked.length = 0;
    h.client.responders.TIKTOK_GET_USER_STATS = () => ({ user: { ...USER, avatar_url: "https://example.com/a.jpeg" } });
    await h.call("get_user_stats", {});
    expect(h.images.asked).toEqual([{ url: USER.avatar_url_100, width: undefined }]);
  });

  test("list_videos with one public post draws it as the hero, so its cover is asked for at hero size", async () => {
    const h = await harness();
    h.client.responders.TIKTOK_LIST_VIDEOS = () => ({ videos: [VIDEOS[0]], has_more: false });
    await h.call("list_videos", {});
    expect(h.images.asked).toEqual([{ url: VIDEOS[0].cover_image_url, width: 312 }]);
  });

  test("query_videos for several posts asks for their covers at list size", async () => {
    const h = await harness();
    const card = cardSpy("postsDetailsCard");
    h.images.pictures.set(VIDEOS[0].cover_image_url, "data:image/png;base64,iVBO");
    await h.call("query_videos", { video_ids: [VIDEOS[0].id, VIDEOS[1].id] });
    // VIDEOS[1] has no cover_image_url: only the one that does is asked for.
    expect(h.images.asked).toEqual([{ url: VIDEOS[0].cover_image_url, width: undefined }]);
    expect(card.mock.calls[0][2]).toEqual({ covers: { [VIDEOS[0].id]: "data:image/png;base64,iVBO" } });
  });

  test("fetch_publish_status: nothing sent yet → the 'none' state, without calling Composio", async () => {
    const h = await harness();
    const { j, blocks } = await h.call("fetch_publish_status", {});
    expect(j).toMatchObject({ ok: true, state: "none" });
    expect(blocks).toHaveLength(1);
    expect(h.client.execs).toHaveLength(0);
  });

  test("fetch_publish_status: a write still staging is answered from the ledger, without calling Composio", async () => {
    const h = await harness();
    h.deps.ledger.start({ tool: "upload_video", kind: "video", mode: "drafts", media: { names: ["clip.mp4"], count: 1 }, details: {} });
    const { j } = await h.call("fetch_publish_status", {});
    expect(j).toMatchObject({ state: "staging", stage: "staging", summary: "Still uploading to TikTok.", names: ["clip.mp4"] });
    expect(h.client.execs).toHaveLength(0);
  });

  test("fetch_publish_status: asks TikTok, enriches from the ledger, and maps fail_reason", async () => {
    const h = await harness();
    const e = h.deps.ledger.start({
      tool: "publish_video", kind: "video", mode: "direct", media: { names: ["clip.mp4"], count: 1 }, details: { caption: "day 3", privacy_level: "SELF_ONLY" },
    });
    h.deps.ledger.update(e.task_id, { stage: "processing", publish_id: "v_pub_file~v2.9" });
    h.client.statusSeq.set("v_pub_file~v2.9", ["PUBLISH_COMPLETE"]);
    const up = await h.call("fetch_publish_status", {});
    expect(h.client.execs[0]).toMatchObject({ slug: "TIKTOK_FETCH_PUBLISH_STATUS", args: { publish_id: "v_pub_file~v2.9" } });
    expect(up.j).toMatchObject({ state: "posted", status: "PUBLISH_COMPLETE", caption: "day 3", privacy_label: "Only me", kind: "video", mode: "direct" });
    expect(up.j.summary).toContain("It's up, set to Only me.");
    expect(h.deps.ledger.get(e.task_id)!.stage).toBe("done");
    h.client.statusSeq.set("v_other", [{ status: "FAILED", fail_reason: "spam_risk_text" }]);
    const failed = await h.call("fetch_publish_status", { publish_id: "v_other" });
    expect(failed.j).toMatchObject({ state: "failed", fail_reason: "spam_risk_text", error: { code: "CAPTION_FLAGGED" } });
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("agent-only helpers", () => {
  test("find_recent_videos mints a file_token per video and never shows a path", async () => {
    const h = await harness({ videos: [video("Movies/Exports/final_export.mov", { folder: join(ROOT, "Movies/Exports"), mime: "video/quicktime" })] });
    const { j, blocks } = await h.call("find_recent_videos", { limit: 3 });
    expect(j.videos[0]).toMatchObject({
      name: "final_export.mov", folder: "Movies/Exports", size_label: expect.any(String), duration_label: "0:23", added_label: "2 min ago", mime: "video/quicktime",
    });
    expect(j.videos[0].file_token).toMatch(/^ft1\./);
    expect(j.query_matched).toBe(true);
    expect(blocks).toHaveLength(1);
    noPaths(j);
    expect(h.tokens.file(j.videos[0].file_token).path).toBe(join(ROOT, "Movies/Exports/final_export.mov"));
  });

  test("find_recent_videos returns each video's preview (bound to its token) and puts its poster on the card", async () => {
    const h = await harness({ videos: [video("Downloads/final_export.mp4"), video("Desktop/b-roll.mov", { mime: "video/quicktime", width: 1920, height: 1080 })] });
    const card = cardSpy("videoCandidatesCard");
    const { j } = await h.call("find_recent_videos", {});
    // Twice each tile's CSS width (the notch is a 2× display): the lead's hero tile, then the small rows.
    expect(h.previews.calls.map((c) => [c.name, c.opts.posterWidth])).toEqual([["final_export.mp4", 216], ["b-roll.mov", 64]]);
    const [a, b] = j.videos;
    expect(a.preview).toMatch(/^p1\.23~/);
    expect(a.preview).not.toBe(b.preview);
    expect(h.tokens.file(a.file_token).preview).toBe(a.preview);
    // The poster is the card's picture only: not in the data.
    expect(JSON.stringify({ ...j, _voiceos_glance: undefined })).not.toContain("data:image");
    const shown = card.mock.calls[0][0].videos;
    expect(shown.map((v: any) => v.poster)).toEqual(["data:image/jpeg;base64,/9j/21616", "data:image/jpeg;base64,/9j/6410"]);
    expect(shown[1]).toMatchObject({ width: 1920, height: 1080 });
    // No frames to be had (no ffmpeg, no Quick Look): tokens and the card as before.
    h.previews.off = true;
    const bare = await h.call("find_recent_videos", {});
    expect(bare.j.videos[0].preview).toBeUndefined();
    expect(h.tokens.file(bare.j.videos[0].file_token).preview).toBeUndefined();
    expect(card.mock.calls[1][0].videos[0].poster).toBeUndefined();
  });

  test("find_recent_videos says plainly when the match was in another folder, or spelled differently", async () => {
    const elsewhere = video("Movies/Tiny AI Lab/ep01-strawberry-tokens.mp4", { folder: join(ROOT, "Movies/Tiny AI Lab") });
    const h = await harness({
      findVideos: async () => ({
        videos: [elsewhere], query_matched: true, query_fuzzy: true, found_elsewhere: true, requested_folders: ["Downloads"],
        denied_folders: [], searched_folders: ["Downloads", "Desktop", "Movies"],
      }),
    });
    const card = cardSpy("videoCandidatesCard");
    const { j } = await h.call("find_recent_videos", { query: "strawbery tokens", folders: ["Downloads"] });
    expect(j).toMatchObject({
      query_matched: true, query_fuzzy: true, found_elsewhere: true, requested_folders: ["Downloads"], searched_folders: ["Downloads", "Desktop", "Movies"],
    });
    expect(j.videos[0]).toMatchObject({ name: "ep01-strawberry-tokens.mp4", folder: "Movies/Tiny AI Lab" });
    expect(j.summary).toBe('Not in Downloads. Found it in Movies › Tiny AI Lab. The file name is spelled a little differently than "strawbery tokens".');
    expect(card.mock.calls[0][0].note).toBe("Not in Downloads. Found it in Movies › Tiny AI Lab.");
    noPaths(j);
    // Found where asked, but only as a near spelling.
    const near = await harness({
      findVideos: async () => ({ videos: [elsewhere], query_matched: true, query_fuzzy: true, denied_folders: [], searched_folders: ["Movies"] }),
    });
    const n = await near.call("find_recent_videos", { query: "strawbery", folders: ["Movies"] });
    expect(n.j.summary).toBe('1 close match for "strawbery" (the file name is spelled a little differently), best first.');
    expect(n.j.found_elsewhere).toBeUndefined();
  });

  test("query_creator_info: exactly one media token, else INVALID_PARAM with no TikTok call", async () => {
    const h = await harness();
    const ft = await h.fileToken();
    for (const args of [{}, { file_token: ft, bundle_token: "bt1.x" }]) {
      const { r, j } = await h.call("query_creator_info", args);
      expect(r.isError).toBe(true);
      expect(j.error.code).toBe("INVALID_PARAM");
    }
    expect(h.client.execs).toHaveLength(0);
  });

  test("query_creator_info returns the write tools' input names and a post_token bound to the account, media and time", async () => {
    const h = await harness();
    const ft = await h.fileToken();
    const { j } = await h.call("query_creator_info", { file_token: ft });
    expect(j).toMatchObject({
      creator_nickname: "Maya Makes", creator_username: "maya.makes", privacy_options: ["SELF_ONLY"], comment_disabled: false,
      duet_disabled: true, stitch_disabled: true, max_duration_sec: 600, duration_ok: true, can_post: true,
    });
    expect(h.tokens.post(j.post_token)).toMatchObject({ connected_account_id: "ca_test", media_token: ft, media_kind: "video", fetched_at: T0 });
    expect(h.limits.creatorInfo.taken).toBe(1);
  });

  test("query_creator_info puts the account's picture on its card, not in the data", async () => {
    const h = await harness();
    const ft = await h.fileToken();
    const url = "https://p16-common-sign.tiktokcdn-us.com/avt~c5_168x168.jpeg";
    h.client.creator.creator_avatar_url = url;
    h.images.pictures.set(url, "data:image/jpeg;base64,/9j/AV");
    const card = cardSpy("creatorCard");
    const { j } = await h.call("query_creator_info", { file_token: ft });
    expect(card.mock.calls[0][0]).toMatchObject({ creator_nickname: "Maya Makes", avatar_data: "data:image/jpeg;base64,/9j/AV" });
    expect(JSON.stringify({ ...j, _voiceos_glance: undefined })).not.toContain("data:image");
    expect(j.creator_avatar_url).toBeUndefined();
  });

  test("query_creator_info: a video over the creator's maximum gets FILE_TOO_LONG and no post_token", async () => {
    const h = await harness({ videos: [video("Downloads/long.mp4", { duration_sec: 700 })] });
    h.client.creator.max_video_post_duration_sec = 600;
    const { r, j } = await h.call("query_creator_info", { file_token: await h.fileToken() });
    expect(r.isError).toBe(true);
    expect(j).toMatchObject({ error: { code: "FILE_TOO_LONG", max: 600, dur: 700 }, duration_ok: false, can_post: false });
    expect(j.post_token).toBeUndefined();
  });

  test("query_creator_info: an empty creator-info bucket is RATE_LIMITED before TikTok is asked", async () => {
    const h = await harness();
    const ft = await h.fileToken();
    h.limits.creatorInfo.allow = false;
    expect((await h.call("query_creator_info", { file_token: ft })).j.error.code).toBe("RATE_LIMITED");
    expect(h.client.execs).toHaveLength(0);
  });

  test("find_recent_images mints image tokens and passes the batch hint; no images → NO_PHOTOS", async () => {
    const h = await harness({ images: [image("Downloads/IMG_1.HEIC"), image("Downloads/IMG_2.HEIC")], batchHint: "2 images arrived together at 10:42" });
    const { j } = await h.call("find_recent_images", { source: "recent_batch" });
    expect(j.images.map((i: any) => i.name)).toEqual(["IMG_1.HEIC", "IMG_2.HEIC"]);
    expect(j.images[0].image_token).toMatch(/^it1\./);
    expect(j.batch_hint).toBe("2 images arrived together at 10:42");
    noPaths(j);
    const empty = await harness();
    const none = await empty.call("find_recent_images", {});
    expect(none.r.isError).toBe(true);
    expect(none.j.error.code).toBe("NO_PHOTOS");
  });

  test("prepare_photo_post checks count (as TikTok's card, not a schema error), duplicates, readability and cover", async () => {
    const imgs = [image("Downloads/beach.heic"), image("Downloads/sunset.heic"), image("Downloads/broken.heic")];
    const h = await harness({ images: imgs });
    const toks = (await h.call("find_recent_images", {})).j.images.map((i: any) => i.image_token);
    expect((await h.call("prepare_photo_post", { image_tokens: Array(36).fill(toks[0]) })).j.error).toMatchObject({ code: "TOO_MANY_PHOTOS", n: 36 });
    expect((await h.call("prepare_photo_post", { image_tokens: [] })).j.error.code).toBe("NO_PHOTOS");
    expect((await h.call("prepare_photo_post", { image_tokens: [toks[0], toks[0]] })).j.error.code).toBe("INVALID_PARAM");
    expect((await h.call("prepare_photo_post", { image_tokens: [toks[0], toks[2]] })).j.error).toMatchObject({ code: "IMAGE_UNREADABLE", name: "broken.heic" });
    expect((await h.call("prepare_photo_post", { image_tokens: [toks[0]], cover_index: 1 })).j.error.code).toBe("INVALID_PARAM");
    const okRes = await h.call("prepare_photo_post", { image_tokens: [toks[1], toks[0]], cover_index: 1 });
    expect(okRes.j).toMatchObject({ ok: true, count: 2, cover_index: 1, names: ["sunset.heic", "beach.heic"] });
    expect(okRes.j.count_label).toContain("2 photos");
    const bundle = h.tokens.bundle(okRes.j.bundle_token);
    expect(bundle.images.map((i) => i.name)).toEqual(["sunset.heic", "beach.heic"]);
    expect(bundle.cover_index).toBe(1);
    noPaths(okRes.j);
  });
});

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

describe("upload_video (drafts)", () => {
  test("copies the caption first, takes a rate token, stages, inits once in drafts mode, polls to the inbox", async () => {
    const h = await harness();
    const ft = await h.fileToken();
    h.events.length = 0;
    const { r, j, blocks } = await h.call("upload_video", h.signed("upload_video", { file_token: ft, caption: "day 3\r\n#build", copy_caption: "true", file_name: "final_export.mp4" }));
    expect(r.isError).toBeUndefined();
    expect(j).toMatchObject({ ok: true, outcome: "inbox", status: "SEND_TO_USER_INBOX", kind: "video", mode: "drafts", file_name: "final_export.mp4", caption_copied: true });
    expect(j.publish_id).toMatch(/^v_inbox_file/);
    expect(blocks).toHaveLength(1);
    expect(h.clipboard).toEqual(["day 3\n#build"]);
    expect(h.events.slice(0, 4)).toEqual(["clipboard", "account", "stage:final_export.mp4", "exec:TIKTOK_UPLOAD_VIDEO"]);
    const init = h.client.execs.find((e) => e.slug === "TIKTOK_UPLOAD_VIDEO")!;
    expect(init.args).toEqual({ file_to_upload: { name: "final_export.mp4", mimetype: "video/mp4", s3key: "staged/final_export.mp4" }, publish: false });
    expect(init.opts).toMatchObject({ write: true, timeoutMs: 62_000 }); // 60 s + 2 s per started MB
    expect(h.limits.writeInit.taken).toBe(1);
    expect(h.client.slugs().filter((s) => s === "TIKTOK_FETCH_PUBLISH_STATUS")).toHaveLength(2);
    expect(h.clock.sleeps).toEqual([5_000, 10_000]);
    const entry = h.deps.ledger.latest()!;
    expect(entry).toMatchObject({ stage: "done", publish_id: j.publish_id, last_status: "SEND_TO_USER_INBOX", media: { names: ["final_export.mp4"], count: 1 } });
    expect(entry.details).toEqual({ caption: "day 3\n#build", caption_copied: true });
    noPaths(j);
    noPaths(h.deps.ledger.list());
    expect(JSON.stringify(h.deps.ledger.list())).not.toContain("ft1.");
  });

  test("copy_caption off: the clipboard is never touched", async () => {
    const h = await harness();
    const ft = await h.fileToken();
    await h.call("upload_video", h.signed("upload_video", { file_token: ft, caption: "day 3" }));
    // Switched on with nothing to copy: the user's clipboard is left alone.
    await h.call("upload_video", h.signed("upload_video", { file_token: ft, caption: "  \n", copy_caption: "true" }));
    expect(h.clipboard).toEqual([]);
  });

  test("CONFIRMATION_REQUIRED for a missing, edited or reused receipt: nothing reaches Composio", async () => {
    const h = await harness();
    const ft = await h.fileToken();
    const before = h.client.execs.length;
    const missing = await h.call("upload_video", { file_token: ft, caption: "a" });
    const edited = await h.call("upload_video", { ...h.signed("upload_video", { file_token: ft, caption: "a" }), caption: "b" });
    const good = h.signed("upload_video", { file_token: ft, caption: "a" });
    await h.call("upload_video", good);
    const used = h.client.execs.length + h.client.staged.length;
    const reused = await h.call("upload_video", good);
    for (const [res, reason] of [[missing, "missing"], [edited, "mismatch"], [reused, "reused"]] as const) {
      expect(res.r.isError).toBe(true);
      expect(res.j).toMatchObject({ outcome: "refused", nothing_sent: true, error: { code: "CONFIRMATION_REQUIRED", reason, nothing_sent: true } });
      expect(res.blocks).toHaveLength(1);
      // VoiceOS's task panel prints a failed task's text verbatim: plain words only; the JSON is structuredContent.
      expect(res.r.content).toHaveLength(1);
      expect(res.r.content[0]!.text).toContain("Nothing reached TikTok");
      expect(res.r.content[0]!.text).not.toContain("{");
      expect(res.r.structuredContent).toBe(res.j);
    }
    expect(before).toBe(0);
    expect(h.client.execs.length + h.client.staged.length).toBe(used);
    // Refusals are recorded too, so "did it go up?" answers about the latest attempt.
    expect(h.deps.ledger.size).toBe(4);
    expect(h.deps.ledger.latest()).toMatchObject({ stage: "failed", error_code: "CONFIRMATION_REQUIRED", media: { names: [], count: 0 } });
  });

  test("after a refused write, fetch_publish_status reports the older upload that reached TikTok, plus one clause about the refusal", async () => {
    const h = await harness();
    const ft = await h.fileToken();
    // Only a refusal so far: that's what there is to report.
    await h.call("upload_video", { file_token: ft });
    const first = await h.call("fetch_publish_status", {});
    expect(first.j).toMatchObject({ state: "failed", stage: "failed", error: { code: "CONFIRMATION_REQUIRED" } });
    expect(first.j.summary).toContain("It didn't go up");
    await h.call("upload_video", h.signed("upload_video", { file_token: ft }));
    await h.call("upload_video", { file_token: ft }); // no receipt: a spoken or typed "yes"
    const st = await h.call("fetch_publish_status", {});
    expect(st.j).toMatchObject({ state: "inbox", names: ["final_export.mp4"], newer_not_sent: { what: "video draft", error_code: "CONFIRMATION_REQUIRED" } });
    expect(st.j.summary).toStartWith('"final_export" is in your TikTok inbox.');
    expect(st.j.summary).toContain("Also: a newer video draft attempt just now wasn't sent (it needs the card's button clicked");
  });

  test("a stale file_token, a moved file and an over-long caption are refused before anything is sent", async () => {
    const h = await harness({ videos: [video("Downloads/moving.mp4")] });
    const ft = await h.fileToken();
    expect((await h.call("upload_video", h.signed("upload_video", { file_token: "ft1.bogus" }))).j.error.code).toBe("TOKEN_STALE");
    expect((await h.call("upload_video", h.signed("upload_video", { file_token: ft, caption: "x".repeat(2201) }))).j.error).toMatchObject({
      code: "CAPTION_TOO_LONG", length: 2201, limit: 2200, nothing_sent: true,
    });
    rmSync(join(ROOT, "Downloads/moving.mp4"));
    expect((await h.call("upload_video", h.signed("upload_video", { file_token: ft }))).j.error.code).toBe("FILE_NOT_FOUND");
    expect(h.client.execs).toHaveLength(0);
    expect(h.client.staged).toHaveLength(0);
  });

  test("a card naming another file than its file_token is refused before anything is sent", async () => {
    const recording = "Screen Recording 2026-11-03 at 9.41.00 PM.mov";
    const h = await harness({
      videos: [video("Downloads/final_export.mp4"), video("Desktop/private_take.mp4"), video(`Movies/${recording}`, { mime: "video/quicktime" })],
    });
    const plain = (s: string) => s.normalize("NFKC").replace(/[  ]/g, " ");
    const found = (await h.call("find_recent_videos", {})).j.videos as Array<{ name: string; file_token: string }>;
    const tokenOf = (name: string) => found.find((v) => plain(v.name) === plain(name))!.file_token;
    const mixed = await h.call("upload_video", h.signed("upload_video", { file_token: tokenOf("private_take.mp4"), file_name: "final_export.mp4" }));
    expect(mixed.r.isError).toBe(true);
    expect(mixed.j).toMatchObject({ outcome: "refused", nothing_sent: true, error: { code: "CONFIRMATION_REQUIRED", reason: "card_mismatch" } });
    expect(h.client.execs).toHaveLength(0);
    expect(h.client.staged).toHaveLength(0);
    // The same name as a model may retype it: another case, a plain space for macOS's narrow one, no extension.
    for (const [name, shown] of [
      ["private_take.mp4", "Private_Take.MP4"],
      [recording, "Screen Recording 2026-11-03 at 9.41.00 PM.mov"],
      ["final_export.mp4", "final_export"],
    ]) {
      const { j } = await h.call("upload_video", h.signed("upload_video", { file_token: tokenOf(name), file_name: shown }));
      expect({ shown, ok: j.ok }).toEqual({ shown, ok: true });
    }
  });

  test("a card's preview has to be the one minted for its file_token; leaving it out is fine", async () => {
    const h = await harness({ videos: [video("Downloads/final_export.mp4"), video("Desktop/private_take.mp4")] });
    const [a, b] = (await h.call("find_recent_videos", {})).j.videos as Array<{ file_token: string; preview: string }>;
    // Another file's frames, or this file's frames with another duration, could mislead: refused before anything is sent.
    for (const preview of [b.preview, a.preview.replace(/^p1\.23~/, "p1.42~")]) {
      const res = await h.call("upload_video", h.signed("upload_video", { file_token: a.file_token, preview }));
      expect(res.j).toMatchObject({ outcome: "refused", nothing_sent: true, error: { code: "CONFIRMATION_REQUIRED", reason: "card_mismatch" } });
    }
    const direct = await h.call("publish_video", h.signed("publish_video", {
      file_token: a.file_token, post_token: h.post(a.file_token), preview: b.preview, creator_nickname: "Maya Makes", privacy_options: ["SELF_ONLY"], privacy_level: "SELF_ONLY",
    }));
    expect(direct.j.error).toMatchObject({ code: "CONFIRMATION_REQUIRED", reason: "card_mismatch" });
    expect(h.client.execs).toHaveLength(0);
    expect(h.client.staged).toHaveLength(0);
    // A garbled copy only hides frames on the card (each frame has a checksum), so it isn't a reason to refuse.
    expect((await h.call("upload_video", h.signed("upload_video", { file_token: a.file_token, preview: "p1~AAAAAAAAAA" }))).j.ok).toBe(true);
    // Its own preview (any surrounding spaces aside), or none at all, goes through.
    expect((await h.call("upload_video", h.signed("upload_video", { file_token: a.file_token, preview: ` ${a.preview} ` }))).j.ok).toBe(true);
    expect((await h.call("upload_video", h.signed("upload_video", { file_token: b.file_token }))).j.ok).toBe(true);
    // A token minted without a preview can't be shown with one.
    h.previews.off = true;
    const plain = (await h.call("find_recent_videos", {})).j.videos[0].file_token;
    const res = await h.call("upload_video", h.signed("upload_video", { file_token: plain, preview: a.preview }));
    expect(res.j.error).toMatchObject({ code: "CONFIRMATION_REQUIRED", reason: "card_mismatch" });
  });

  test("the completion card and 'did it go up?' show the sent video's poster frame; it stays out of the data and the logs", async () => {
    const h = await harness();
    const ft = await h.fileToken();
    const done = cardSpy("writeResultCard");
    const status = cardSpy("statusCard");
    const logs: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
    let up: Awaited<ReturnType<typeof h.call>>;
    try {
      up = await h.call("upload_video", h.signed("upload_video", { file_token: ft }));
    } finally {
      console.error = original;
    }
    const poster = "data:image/jpeg;base64,/9j/24016";
    expect(h.previews.calls.at(-1)).toMatchObject({ name: "final_export.mp4", opts: { posterWidth: 240, micro: false } });
    expect(done.mock.calls.at(-1)![0]).toMatchObject({ outcome: "inbox", name: "final_export.mp4", poster });
    expect(h.deps.ledger.latest()!.poster).toBe(poster);
    expect(JSON.stringify({ ...up!.j, _voiceos_glance: undefined })).not.toContain("data:image");
    expect(logs.join("\n")).not.toContain("data:image");
    const st = await h.call("fetch_publish_status", {});
    expect(status.mock.calls.at(-1)![0]).toMatchObject({ state: "inbox", poster });
    expect(JSON.stringify({ ...st.j, _voiceos_glance: undefined })).not.toContain("data:image");
    // A refused write has no poster (nothing was sent); "did it go up?" still shows the video that went, with its frame.
    await h.call("upload_video", { file_token: ft });
    expect(done.mock.calls.at(-1)![0].poster).toBeUndefined();
    await h.call("fetch_publish_status", {});
    expect(status.mock.calls.at(-1)![0]).toMatchObject({ state: "inbox", poster });
  });

  test("an empty write-init bucket is RATE_LIMITED with nothing uploaded", async () => {
    const h = await harness();
    const ft = await h.fileToken();
    h.limits.writeInit.allow = false;
    const { j } = await h.call("upload_video", h.signed("upload_video", { file_token: ft }));
    expect(j).toMatchObject({ outcome: "failed", nothing_sent: true, error: { code: "RATE_LIMITED" } });
    expect(h.client.staged).toHaveLength(0);
    expect(h.deps.ledger.latest()).toMatchObject({ stage: "failed", error_code: "RATE_LIMITED" });
  });

  test("a lost init answer is OUTCOME_UNKNOWN: one init, no retry, no polling", async () => {
    const h = await harness();
    const ft = await h.fileToken();
    h.client.responders.TIKTOK_UPLOAD_VIDEO = () => {
      throw new TikTokError("OUTCOME_UNKNOWN", { slug: "TIKTOK_UPLOAD_VIDEO" });
    };
    const { r, j } = await h.call("upload_video", h.signed("upload_video", { file_token: ft }));
    expect(r.isError).toBe(true);
    expect(j).toMatchObject({ outcome: "unknown", error: { code: "OUTCOME_UNKNOWN" } });
    expect(j.nothing_sent).toBeUndefined();
    expect(h.client.slugs()).toEqual(["TIKTOK_UPLOAD_VIDEO"]);
    expect(h.deps.ledger.latest()).toMatchObject({ stage: "unknown", error_code: "OUTCOME_UNKNOWN" });
  });

  test("TikTok refusing the init (drafts cap) is a failure, not polled", async () => {
    const h = await harness();
    const ft = await h.fileToken();
    h.client.responders.TIKTOK_UPLOAD_VIDEO = () => {
      throw new TikTokError("DRAFTS_CAP", { tiktok_code: "spam_risk_too_many_pending_share", log_id: "202611030000AA" });
    };
    const { j } = await h.call("upload_video", h.signed("upload_video", { file_token: ft }));
    expect(j).toMatchObject({ outcome: "failed", error: { code: "DRAFTS_CAP", log_id: "202611030000AA" } });
    expect(h.client.slugs()).toEqual(["TIKTOK_UPLOAD_VIDEO"]);
    expect(h.deps.ledger.latest()!.stage).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Past VoiceOS's 60 s call limit: the soft deadline, the detached job, the reminder
// ---------------------------------------------------------------------------

/** A gate a fake step waits on until the test opens it. */
function gate() {
  let open!: () => void;
  const shut = new Promise<void>((r) => (open = r));
  return { shut, open };
}

describe("writes that outlive their call", () => {
  test("still uploading at the soft deadline: 'working', the upload carries on, then a reminder whose Show opens the card", async () => {
    const h = await harness({ softDeadlineMs: 30 });
    const ft = await h.fileToken();
    const g = gate();
    const stage = h.client.stageFile.bind(h.client);
    h.client.stageFile = async (...a: Parameters<typeof stage>) => (await g.shut, stage(...a));
    const status = cardSpy("statusCard");
    const done = cardSpy("writeResultCard");
    const { r, j } = await h.call("upload_video", h.signed("upload_video", { file_token: ft }));
    expect(r.isError).toBeUndefined();
    expect(j).toMatchObject({ ok: true, outcome: "working", running: true, working: "uploading", stage: "staging", kind: "video", mode: "drafts", file_name: "final_export.mp4" });
    expect(j.summary).toBe("Uploading to your TikTok drafts. I'll let you know when it's in your inbox, or ask 'did it go up?'");
    expect(j.title).toBe("Uploading to your TikTok drafts");
    expect(j.publish_id).toBeUndefined();
    // The card: the status card's Uploading look, with the video's frame. Nothing claims success.
    expect(status.mock.calls.at(-1)![0]).toMatchObject({ state: "uploading", mode: "drafts", name: "final_export.mp4", poster: "data:image/jpeg;base64,/9j/24016" });
    expect(JSON.stringify(j)).not.toMatch(/"outcome":"(inbox|posted)"/);
    expect(h.client.slugs()).not.toContain("TIKTOK_UPLOAD_VIDEO");
    // "Did it go up?" meanwhile: honest, from the ledger, without asking TikTok.
    const mid = await h.call("fetch_publish_status", {});
    expect(mid.j).toMatchObject({ state: "staging", running: true, summary: "Still uploading to TikTok. I'll let you know when it's in your inbox." });
    expect(h.triggers).toHaveLength(0);
    // The upload finishes after the call answered: one init, polled to the inbox, then the reminder.
    g.open();
    await h.deps.jobs.idle();
    expect(h.client.slugs().filter((s) => s === "TIKTOK_UPLOAD_VIDEO")).toHaveLength(1);
    const entry = h.deps.ledger.latest()!;
    expect(entry).toMatchObject({ task_id: j.task_id, stage: "done", last_status: "SEND_TO_USER_INBOX" });
    expect(h.triggers).toEqual([
      {
        message: "In your TikTok inbox: final_export.mp4. Open TikTok and tap the notification to finish.",
        speak: false,
        actions: [{ id: "show_post", label: "Show" }],
        data: { entry: j.task_id },
      },
    ]);
    expect(done.mock.calls.at(-1)![0]).toMatchObject({ outcome: "inbox", poster: "data:image/jpeg;base64,/9j/24016" });
    // Show: the completion card, opened by VoiceOS without an agent turn. A second click gets the same answer.
    const show = await h.action("n1", "show_post", { entry: j.task_id });
    expect(show).toMatchObject({ ok: true, responseText: h.triggers[0].message, view: { blocks: [{ type: "widget", label: "Sent to TikTok drafts" }] } });
    expect(show.view.blocks[0].height).toBeGreaterThan(59);
    expect(await h.action("n1", "show_post", { entry: j.task_id })).toEqual(show);
    // Only the one fixed action; an unknown entry (VoiceOS restarted) says so instead of guessing.
    await expect(h.action("n1", "delete_post", { entry: j.task_id })).rejects.toThrow(/Unknown action/);
    const gone = await h.action("n2", "show_post", { entry: "t_000000000000" });
    expect(gone.responseText).toContain("VoiceOS restarted");
    // Once it ended, "did it go up?" no longer says it's running.
    expect((await h.call("fetch_publish_status", {})).j.running).toBeUndefined();
  });

  test("TikTok already has it at the soft deadline: 'working' with the publish_id; a failure afterwards still reaches the user", async () => {
    const h = await harness({ softDeadlineMs: 30 });
    const ft = await h.fileToken();
    const g = gate();
    const poll = h.client.responders.TIKTOK_FETCH_PUBLISH_STATUS;
    h.client.responders.TIKTOK_FETCH_PUBLISH_STATUS = async (a) => (await g.shut, poll(a));
    const done = cardSpy("writeResultCard");
    const post = h.post(ft);
    const { j } = await h.call("publish_video", h.signed("publish_video", {
      file_token: ft, post_token: post, creator_nickname: "Maya Makes", privacy_options: ["SELF_ONLY"], privacy_level: "SELF_ONLY",
    }));
    expect(j).toMatchObject({ outcome: "working", working: "processing", stage: "processing", mode: "direct", privacy_label: "Only me" });
    expect(j.publish_id).toMatch(/^v_pub_file/);
    expect(j.summary).toBe("TikTok has it and is processing it. I'll let you know when it's posted, or ask 'did it go up?'");
    expect(done.mock.calls.at(-1)![0]).toMatchObject({ outcome: "processing", poster: "data:image/jpeg;base64,/9j/24016" });
    h.client.statusSeq.set(j.publish_id, [{ status: "FAILED", fail_reason: "duration_check_failed" }]);
    g.open();
    await h.deps.jobs.idle();
    expect(h.deps.ledger.latest()).toMatchObject({ stage: "failed", error_code: "FILE_TOO_LONG" });
    expect(h.triggers).toHaveLength(1);
    expect(h.triggers[0].message).toStartWith("Your TikTok post (final_export.mp4) didn't go through.");
    expect(h.triggers[0].message.length).toBeLessThanOrEqual(2000);
    const show = await h.action("n1", "show_post", { entry: j.task_id });
    expect(show.view.blocks[0].label).toBe(new TikTokError("FILE_TOO_LONG").title);
    expect(h.client.slugs().filter((s) => s === "TIKTOK_UPLOAD_VIDEO")).toHaveLength(1);
  });

  test("a staging failure after the early answer: nothing was sent, and the reminder says so", async () => {
    const h = await harness({ softDeadlineMs: 30 });
    const ft = await h.fileToken();
    const g = gate();
    h.client.stageFile = async () => {
      await g.shut;
      throw new TikTokError("UPLOAD_FAILED", { nothing_sent: true, reason: "network" });
    };
    const { j } = await h.call("upload_video", h.signed("upload_video", { file_token: ft }));
    expect(j.outcome).toBe("working");
    g.open();
    await h.deps.jobs.idle();
    expect(h.client.slugs()).not.toContain("TIKTOK_UPLOAD_VIDEO");
    expect(h.deps.ledger.latest()).toMatchObject({ stage: "failed", error_code: "UPLOAD_FAILED" });
    expect(h.triggers[0].message).toStartWith("Your TikTok upload (final_export.mp4) didn't go through.");
    expect(h.triggers[0].message).toMatch(/nothing was (posted|sent)|nothing reached TikTok/i);
  });

  test("a reminder VoiceOS refuses is logged by its code only; 'did it go up?' still answers", async () => {
    const h = await harness({ softDeadlineMs: 30 });
    const ft = await h.fileToken();
    const g = gate();
    const stage = h.client.stageFile.bind(h.client);
    h.client.stageFile = async (...a: Parameters<typeof stage>) => (await g.shut, stage(...a));
    h.reminderHost.refuse = new McpError(ErrorCode.InvalidRequest, "notify permission missing for final_export.mp4");
    await h.call("upload_video", h.signed("upload_video", { file_token: ft }));
    const lines: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void lines.push(a.map(String).join(" "));
    try {
      g.open();
      await h.deps.jobs.idle();
    } finally {
      console.error = original;
    }
    expect(lines.join("\n")).toContain(`reminder not queued: ${ErrorCode.InvalidRequest}`);
    expect(lines.join("\n")).not.toMatch(/final_export|permission missing/);
    expect(h.triggers).toHaveLength(0);
    const st = await h.call("fetch_publish_status", {});
    expect(st.j).toMatchObject({ state: "inbox" });
  });

  test("VoiceOS cancelling the call doesn't stop the upload: it ends, and the reminder still comes", async () => {
    const h = await harness();
    const ft = await h.fileToken();
    const g = gate();
    const stage = h.client.stageFile.bind(h.client);
    h.client.stageFile = async (...a: Parameters<typeof stage>) => (await g.shut, stage(...a));
    const ac = new AbortController();
    const call = h.mcp.callTool({ name: "upload_video", arguments: h.signed("upload_video", { file_token: ft }) }, undefined, { signal: ac.signal });
    await Bun.sleep(20);
    ac.abort("VoiceOS timed out");
    await expect(call).rejects.toThrow();
    await Bun.sleep(10);
    g.open();
    await h.deps.jobs.idle();
    expect(h.client.slugs().filter((s) => s === "TIKTOK_UPLOAD_VIDEO")).toHaveLength(1);
    expect(h.deps.ledger.latest()).toMatchObject({ stage: "done" });
    expect(h.triggers).toHaveLength(1);
  });

  test("a write that finishes within the soft deadline answers as before: no reminder", async () => {
    const h = await harness();
    const ft = await h.fileToken();
    const { j } = await h.call("upload_video", h.signed("upload_video", { file_token: ft }));
    expect(j.outcome).toBe("inbox");
    await h.deps.jobs.idle();
    expect(h.triggers).toHaveLength(0);
  });
});

describe("status polling", () => {
  test("waits 5, 10, 20, 40 s then every 60 s; transient check errors don't fail the write", async () => {
    const h = await harness();
    const ft = await h.fileToken();
    h.client.statusSeq.set("v_inbox_file~v2.1", [
      "PROCESSING_UPLOAD", new TikTokError("TIMEOUT"), new TikTokError("TIKTOK_SERVER", { status: 503 }), "PROCESSING_UPLOAD", "PROCESSING_UPLOAD",
      "SEND_TO_USER_INBOX",
    ]);
    const { j } = await h.call("upload_video", h.signed("upload_video", { file_token: ft }));
    expect(j.outcome).toBe("inbox");
    expect(h.clock.sleeps).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000]);
  });

  test("a FAILED status maps fail_reason to our code and records it", async () => {
    const h = await harness();
    const ft = await h.fileToken();
    h.client.statusSeq.set("v_inbox_file~v2.1", ["PROCESSING_UPLOAD", { status: "FAILED", fail_reason: "duration_check_failed" }]);
    const { r, j } = await h.call("upload_video", h.signed("upload_video", { file_token: ft }));
    expect(r.isError).toBe(true);
    expect(j).toMatchObject({ outcome: "failed", status: "FAILED", error: { code: "FILE_TOO_LONG", fail_reason: "duration_check_failed" } });
    expect(h.deps.ledger.latest()).toMatchObject({ stage: "failed", fail_reason: "duration_check_failed", error_code: "FILE_TOO_LONG" });
  });

  test("after 30 minutes it reports 'still processing' (not failed) and the ledger stays at processing", async () => {
    const h = await harness();
    const ft = await h.fileToken();
    h.client.statusSeq.set("v_inbox_file~v2.1", ["PROCESSING_UPLOAD"]);
    const { r, j } = await h.call("upload_video", h.signed("upload_video", { file_token: ft }));
    expect(r.isError).toBeUndefined();
    expect(j).toMatchObject({ outcome: "processing", status: "PROCESSING_UPLOAD" });
    expect(h.clock.sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(30 * MIN);
    expect(h.deps.ledger.latest()!.stage).toBe("processing");
  });

  test("an auth failure while checking stops watching, honestly: TikTok has the post", async () => {
    const h = await harness();
    const ft = await h.fileToken();
    h.client.statusSeq.set("v_inbox_file~v2.1", [new TikTokError("AUTH_REVOKED")]);
    const { j } = await h.call("upload_video", h.signed("upload_video", { file_token: ft }));
    expect(j).toMatchObject({ outcome: "processing", status_check: { code: "AUTH_REVOKED" } });
    expect(h.client.slugs().filter((s) => s === "TIKTOK_FETCH_PUBLISH_STATUS")).toHaveLength(1);
  });
});

describe("one write at a time per account", () => {
  const until = async (pred: () => boolean) => {
    const start = Date.now();
    while (!pred()) {
      if (Date.now() - start > 3_000) throw new Error("timed out waiting");
      await new Promise((r) => setTimeout(r, 2));
    }
  };

  test("the second write starts only after the first's init answered, while the first is still being watched", async () => {
    const h = await harness({ videos: [video("Downloads/a.mp4"), video("Downloads/b.mp4")] });
    const found = (await h.call("find_recent_videos", {})).j.videos;
    let openInit!: () => void;
    const initGate = new Promise<void>((r) => (openInit = r));
    let openStatus!: () => void;
    const statusGate = new Promise<void>((r) => (openStatus = r));
    let n = 0;
    h.client.responders.TIKTOK_UPLOAD_VIDEO = async () => {
      const k = ++n;
      h.events.push(`init${k}:start`);
      if (k === 1) await initGate;
      h.events.push(`init${k}:done`);
      return { publish_id: `v_inbox_file~v2.${k}` };
    };
    h.client.responders.TIKTOK_FETCH_PUBLISH_STATUS = async ({ publish_id }) => {
      if (publish_id.endsWith(".1")) await statusGate;
      return { status: "SEND_TO_USER_INBOX" };
    };
    const first = h.call("upload_video", h.signed("upload_video", { file_token: found[0].file_token }));
    await until(() => h.events.includes("init1:start"));
    const second = h.call("upload_video", h.signed("upload_video", { file_token: found[1].file_token }));
    await new Promise((r) => setTimeout(r, 20));
    expect(h.events).not.toContain("stage:b.mp4");
    expect(h.deps.queue.depth("ca_test")).toBe(2);
    openInit();
    await until(() => h.events.includes("init2:done"));
    expect(h.events.indexOf("stage:b.mp4")).toBeGreaterThan(h.events.indexOf("init1:done"));
    openStatus();
    const [a, b] = await Promise.all([first, second]);
    expect([a.j.outcome, b.j.outcome]).toEqual(["inbox", "inbox"]);
  });
});

describe("publish_video (direct)", () => {
  const base = (ft: string, pt: string, extra: Record<string, unknown> = {}) => ({
    post_token: pt, file_token: ft, creator_nickname: "Maya Makes", privacy_options: ["SELF_ONLY"], comment_disabled: false,
    duet_disabled: true, stitch_disabled: true, max_duration_sec: 600, caption: "day 3", privacy_level: "SELF_ONLY", ...extra,
  });

  test("direct-post rules refuse before anything is sent", async () => {
    const h = await harness();
    const ft = await h.fileToken();
    const pt = h.post(ft);
    const cases: Array<[Record<string, unknown>, string, Record<string, unknown>?]> = [
      [{ privacy_level: "" }, "PRIVACY_MISMATCH", { chosen: "", options: ["SELF_ONLY"] }],
      [{ privacy_level: "PUBLIC_TO_EVERYONE" }, "PRIVACY_MISMATCH", { chosen: "PUBLIC_TO_EVERYONE" }],
      [{ privacy_level: "EVERYONE" }, "PRIVACY_MISMATCH"],
      [{ commercial_disclosure: "true" }, "DISCLOSURE_INCOMPLETE"],
      [{ commercial_disclosure: true, brand_content: "true" }, "BRANDED_PRIVATE_BLOCKED"],
      [{ creator_nickname: "Someone Else" }, "TOKEN_STALE", { kind: "post" }],
      [{ privacy_options: "SELF_ONLY,PUBLIC_TO_EVERYONE" }, "TOKEN_STALE"],
      [{ file_name: "someone_else.mp4" }, "CONFIRMATION_REQUIRED", { reason: "card_mismatch" }],
      [{ cover_ms: "99000" }, "INVALID_PARAM"],
    ];
    for (const [extra, code, detail] of cases) {
      const { r, j } = await h.call("publish_video", h.signed("publish_video", base(ft, pt, extra)));
      expect({ code: j.error.code, isError: r.isError, nothing_sent: j.nothing_sent }).toEqual({ code, isError: true, nothing_sent: true });
      if (detail) expect(j.error).toMatchObject(detail);
    }
    const other = await harness({ videos: [video("Downloads/long.mp4", { duration_sec: 700 })] });
    const lft = await other.fileToken();
    const tooLong = await other.call("publish_video", other.signed("publish_video", base(lft, other.post(lft, { max_duration_sec: 600 }))));
    expect(tooLong.j.error).toMatchObject({ code: "FILE_TOO_LONG", max: 600, dur: 700 });
    // A post_token minted for another file.
    const wrong = await h.call("publish_video", h.signed("publish_video", base(ft, h.post("ft1.another"))));
    expect(wrong.j.error).toMatchObject({ code: "TOKEN_STALE", kind: "post" });
    expect(h.client.execs).toHaveLength(0);
    expect(h.client.staged).toHaveLength(0);
    expect(other.client.execs).toHaveLength(0);
  });

  test("sends the direct args: card strings normalized, creator-disabled interactions forced off, both brand toggles; inbox ends it honestly", async () => {
    const h = await harness();
    const ft = await h.fileToken();
    const pt = h.post(ft, { comment_disabled: true });
    h.client.responders.TIKTOK_UPLOAD_VIDEO = () => ({ publish_id: "v_pub_file~v2.7" });
    h.client.statusSeq.set("v_pub_file~v2.7", ["PROCESSING_UPLOAD", "SEND_TO_USER_INBOX"]);
    const args = base(ft, pt, {
      comment_disabled: true, allow_comment: "true", allow_duet: "true", commercial_disclosure: "true", brand_organic: "true", is_aigc: "true", cover_ms: "3000",
    });
    const { j } = await h.call("publish_video", h.signed("publish_video", args));
    const init = h.client.execs.find((e) => e.slug === "TIKTOK_UPLOAD_VIDEO")!;
    expect(init.args).toMatchObject({
      publish: true, caption: "day 3", privacy_level: "SELF_ONLY", disable_comment: true, disable_duet: true, disable_stitch: true,
      brand_organic_toggle: true, brand_content_toggle: false, is_aigc: true, video_cover_timestamp_ms: 3000,
    });
    expect(j).toMatchObject({ outcome: "inbox", privacy_label: "Only me", forced_off: ["comments", "Duet"] });
    expect(h.deps.ledger.latest()!.details).toMatchObject({
      privacy_level: "SELF_ONLY", allow_comment: false, allow_duet: false, brand_organic: true, brand_content: false, is_aigc: true, cover_ms: 3000,
    });
  });

  test("creator info over 10 minutes old at its turn is fetched again; a privacy that's gone refuses with nothing sent", async () => {
    const h = await harness();
    const ft = await h.fileToken();
    const pt = h.post(ft, { fetched_at: T0 - 11 * MIN });
    h.client.creator.privacy_level_options = ["MUTUAL_FOLLOW_FRIENDS"];
    const { j } = await h.call("publish_video", h.signed("publish_video", base(ft, pt)));
    expect(j).toMatchObject({ nothing_sent: true, error: { code: "PRIVACY_MISMATCH", options: ["MUTUAL_FOLLOW_FRIENDS"] } });
    expect(h.client.slugs()).toEqual(["TIKTOK_QUERY_CREATOR_INFO"]);
    expect(h.client.staged).toHaveLength(0);
  });
});

describe("photo writes", () => {
  async function bundled(h: Awaited<ReturnType<typeof harness>>, cover = 0) {
    const toks = (await h.call("find_recent_images", {})).j.images.map((i: any) => i.image_token);
    return (await h.call("prepare_photo_post", { image_tokens: toks, cover_index: cover })).j.bundle_token as string;
  }
  const pics = () => [image("Pictures/one.heic"), image("Pictures/two.heic"), image("Pictures/three.heic")];

  test("a card showing another photo count than its bundle is refused before anything is sent", async () => {
    const h = await harness({ images: pics() });
    const bt = await bundled(h);
    h.events.length = 0;
    const { r, j } = await h.call("upload_photos", h.signed("upload_photos", { bundle_token: bt, count_label: "2 photos · cover: photo 1" }));
    expect(r.isError).toBe(true);
    expect(j).toMatchObject({ outcome: "refused", nothing_sent: true, error: { code: "CONFIRMATION_REQUIRED", reason: "card_mismatch" } });
    expect(h.events).toEqual([]);
    expect((await h.call("upload_photos", h.signed("upload_photos", { bundle_token: bt, count_label: "3 photos · cover: photo 1" }))).j.ok).toBe(true);
  });

  test("upload_photos: convert → relay batch → PUT → MEDIA_UPLOAD init; the batch goes once TikTok has the photos", async () => {
    const h = await harness({ images: pics() });
    const bt = await bundled(h, 1);
    h.events.length = 0;
    const { j } = await h.call("upload_photos", h.signed("upload_photos", { bundle_token: bt, title: "Lisbon weekend", description: "best 3 days #travel" }));
    expect(j).toMatchObject({ ok: true, outcome: "inbox", kind: "photos", mode: "drafts", count: 3 });
    const init = h.client.execs.find((e) => e.slug === "TIKTOK_POST_PHOTO")!;
    expect(init.args).toEqual({
      post_mode: "MEDIA_UPLOAD", photo_images: [0, 1, 2].map((i) => `https://media.example.test/abcdef/${i}.jpg`), photo_cover_index: 1,
      title: "Lisbon weekend", description: "best 3 days #travel",
    });
    expect(h.relay.puts).toEqual([[6, 6, 6]]);
    expect(h.cleaned).toHaveLength(1);
    // The folder's own name, never a path (photos carry real paths: C:\… on Windows).
    expect(h.deps.ledger.latest()!.media.folder).toBe("Pictures");
    const order = h.events.filter((e) => !e.startsWith("account"));
    expect(order.slice(0, 5)).toEqual(["convert", "relay:create", "relay:put", "exec:TIKTOK_POST_PHOTO", "exec:TIKTOK_FETCH_PUBLISH_STATUS"]);
    // Deleted after the status left PROCESSING_DOWNLOAD (the second check), not while TikTok was still pulling.
    expect(order.indexOf("relay:delete")).toBeGreaterThan(order.lastIndexOf("exec:TIKTOK_FETCH_PUBLISH_STATUS") - 1);
    expect(h.relay.deleted).toEqual(["abcdef1234567890"]);
  });

  test("a relay failure deletes the batch and never calls TikTok", async () => {
    const h = await harness({ images: pics() });
    const bt = await bundled(h);
    h.relay.failPut = new TikTokError("RELAY_UNAVAILABLE");
    const { j } = await h.call("upload_photos", h.signed("upload_photos", { bundle_token: bt }));
    expect(j).toMatchObject({ outcome: "failed", nothing_sent: true, error: { code: "RELAY_UNAVAILABLE" } });
    expect(h.relay.deleted).toEqual(["abcdef1234567890"]);
    expect(h.client.slugs().includes("TIKTOK_POST_PHOTO")).toBe(false);
    expect(h.cleaned).toHaveLength(1);
  });

  test("post_photos: DIRECT_POST with comments forced off when the creator disabled them", async () => {
    const h = await harness({ images: pics() });
    const bt = await bundled(h);
    const pt = h.post(bt, { media_kind: "photos", comment_disabled: true });
    h.client.responders.TIKTOK_POST_PHOTO = () => ({ publish_id: "p_pub_url~v2.5" });
    h.client.statusSeq.set("p_pub_url~v2.5", ["PROCESSING_DOWNLOAD", "PUBLISH_COMPLETE"]);
    const { j } = await h.call("post_photos", h.signed("post_photos", {
      bundle_token: bt, post_token: pt, creator_nickname: "Maya Makes", privacy_options: ["SELF_ONLY"], comment_disabled: true,
      title: "Lisbon", description: "", privacy_level: "SELF_ONLY", allow_comment: "true", auto_add_music: "true",
    }));
    expect(h.client.execs.find((e) => e.slug === "TIKTOK_POST_PHOTO")!.args).toMatchObject({
      post_mode: "DIRECT_POST", privacy_level: "SELF_ONLY", disable_comment: true, auto_add_music: true, brand_organic_toggle: false, brand_content_toggle: false,
    });
    expect(j).toMatchObject({ outcome: "posted", count: 3, privacy_label: "Only me" });
  });

  test("prepare_photo_post returns the stack as `preview`, bound to its bundle_token with the thumbnails; the card shows them", async () => {
    const h = await harness({ images: [...pics(), image("Pictures/four.heic"), image("Pictures/five.heic"), image("Pictures/six.heic")] });
    const toks = (await h.call("find_recent_images", {})).j.images.map((i: any) => i.image_token);
    const { j, blocks } = await h.call("prepare_photo_post", { image_tokens: toks, cover_index: 2 });
    const look = h.photoLook.calls.at(-1)!;
    expect(look.names).toEqual(["one.heic", "two.heic", "three.heic", "four.heic", "five.heic", "six.heic"]);
    // Every photo, at a size the whole carousel fits one card in (240 px for six 4:3 photos).
    expect(look.opts).toMatchObject({ count: 6, cover: 2, max: 6, thumbWidth: 240, thumbBudget: 210_000 });
    expect(look.opts.tall).toBeUndefined();
    expect(splitPhotoStack(j.preview)).toMatchObject({ count: 6, cover: 2 });
    expect(splitPhotoStack(j.preview)!.frames).toHaveLength(5);
    expect(j.preview.length).toBeLessThanOrEqual(720);
    // The thumbnails are for the cards only: never in the data the model reads.
    expect(JSON.stringify({ ...j, _voiceos_glance: undefined })).not.toContain("data:image");
    const bundle = h.tokens.bundle(j.bundle_token);
    expect(bundle.preview).toBe(j.preview);
    expect(bundle.thumbs).toHaveLength(6);
    expect(blocks[0].html).toContain(bundle.thumbs![0]);
    expect(blocks[0].html).toContain('class="tt-ps');
    // No pictures (sips couldn't): no preview, a token all the same.
    h.photoLook.off = true;
    const bare = (await h.call("prepare_photo_post", { image_tokens: toks.slice(0, 2) })).j;
    expect(bare.preview).toBeUndefined();
    expect(h.tokens.bundle(bare.bundle_token).preview).toBeUndefined();
  });

  test("a photo card's preview has to be its own bundle's stack; a garbled one is ignored, none is fine", async () => {
    const h = await harness({ images: pics() });
    const toks = (await h.call("find_recent_images", {})).j.images.map((i: any) => i.image_token);
    const a = (await h.call("prepare_photo_post", { image_tokens: toks })).j;
    const b = (await h.call("prepare_photo_post", { image_tokens: [toks[2], toks[1], toks[0]], cover_index: 1 })).j;
    const own = splitPhotoStack(a.preview)!;
    const refusals = [
      b.preview, // another bundle's photos
      joinPhotoStack([own.frames[1], own.frames[0], own.frames[2]], { count: 3, cover: 0 }), // this bundle's, reordered
      joinPhotoStack(own.frames, { count: 3, cover: 2 }), // another cover
      joinPhotoStack(own.frames, { count: 4, cover: 0 }), // another count
      joinPhotoStack([own.frames[0], fakePhotoFrame("stranger.heic")], { count: 3, cover: 0 }), // a stranger
    ];
    for (const preview of refusals) {
      const res = await h.call("upload_photos", h.signed("upload_photos", { bundle_token: a.bundle_token, preview }));
      expect(res.j).toMatchObject({ outcome: "refused", nothing_sent: true, error: { code: "CONFIRMATION_REQUIRED", reason: "card_mismatch" } });
    }
    const pt = h.post(a.bundle_token, { media_kind: "photos" });
    const direct = await h.call("post_photos", h.signed("post_photos", {
      bundle_token: a.bundle_token, post_token: pt, preview: b.preview, creator_nickname: "Maya Makes", privacy_options: ["SELF_ONLY"], privacy_level: "SELF_ONLY",
    }));
    expect(direct.j.error).toMatchObject({ code: "CONFIRMATION_REQUIRED", reason: "card_mismatch" });
    expect(h.client.slugs().includes("TIKTOK_POST_PHOTO")).toBe(false);
    // Its own stack (spaces aside), a subset in order (frames the card couldn't decode), garbage, or none: accepted.
    for (const preview of [` ${a.preview} `, joinPhotoStack([own.frames[0], own.frames[2]], { count: 3, cover: 0 }), "s1~AAAAAAAAAA", "not a stack", undefined]) {
      const ok = await h.call("upload_photos", h.signed("upload_photos", { bundle_token: a.bundle_token, ...(preview !== undefined ? { preview } : {}) }));
      expect(ok.j.ok).toBe(true);
    }
  });

  test("the completion card and 'did it go up?' show the carousel's own thumbnails", async () => {
    const h = await harness({ images: pics() });
    const bt = await bundled(h, 1);
    const thumbs = h.tokens.bundle(bt).thumbs!;
    const { j, blocks } = await h.call("upload_photos", h.signed("upload_photos", { bundle_token: bt }));
    expect(j).toMatchObject({ ok: true, outcome: "inbox", count: 3 });
    expect(JSON.stringify({ ...j, _voiceos_glance: undefined })).not.toContain("data:image");
    for (const t of thumbs) expect(blocks[0].html).toContain(t);
    const status = await h.call("fetch_publish_status", {});
    for (const t of thumbs) expect(status.blocks[0].html).toContain(t);
    expect(status.blocks[0].html).toContain("1/3");
  });

  test("a direct photo post's completion card and 'did it go up?' show the whole carousel too", async () => {
    const h = await harness({ images: [...pics(), image("Pictures/four.heic"), image("Pictures/five.heic"), image("Pictures/six.heic"), image("Pictures/seven.heic")] });
    const toks = (await h.call("find_recent_images", {})).j.images.map((i: any) => i.image_token);
    const bt = (await h.call("prepare_photo_post", { image_tokens: toks, cover_index: 1 })).j.bundle_token as string;
    const thumbs = h.tokens.bundle(bt).thumbs!;
    expect(thumbs).toHaveLength(7);
    const pt = h.post(bt, { media_kind: "photos" });
    h.client.responders.TIKTOK_POST_PHOTO = () => ({ publish_id: "p_pub_all~v2" });
    h.client.statusSeq.set("p_pub_all~v2", ["PROCESSING_DOWNLOAD", "PUBLISH_COMPLETE"]);
    const { j, blocks } = await h.call("post_photos", h.signed("post_photos", {
      bundle_token: bt, post_token: pt, creator_nickname: "Maya Makes", privacy_options: ["SELF_ONLY"], privacy_level: "SELF_ONLY",
    }));
    expect(j).toMatchObject({ outcome: "posted", count: 7 });
    for (const t of thumbs) expect(blocks[0].html).toContain(t);
    expect(blocks[0].html).toContain("7/7");
    expect(blocks[0].html).toContain('<span class="tt-ps-cv">Cover</span>');
    const status = await h.call("fetch_publish_status", {});
    for (const t of thumbs) expect(status.blocks[0].html).toContain(t);
  });

  test("query_creator_info's card shows what's about to be posted: the photos' stack, or the video playing", async () => {
    const h = await harness({ images: pics() });
    const bt = await bundled(h);
    const photos = await h.call("query_creator_info", { bundle_token: bt });
    for (const t of h.tokens.bundle(bt).thumbs!) expect(photos.blocks[0].html).toContain(t);
    expect(photos.blocks[0].html).toContain("Ready to post");
    expect(JSON.stringify({ ...photos.j, _voiceos_glance: undefined })).not.toContain("data:image");
    const ft = await h.fileToken();
    h.previews.motion = { src: `data:image/webp;base64,${Buffer.from("RIFF0000WEBPVP8X").toString("base64")}` };
    const video = await h.call("query_creator_info", { file_token: ft });
    expect(h.previews.calls.at(-1)!.opts).toMatchObject({ motion: true, micro: false, posterWidth: 240 });
    expect(video.blocks[0].html).toContain(h.previews.motion.src);
    expect(video.blocks[0].html).toContain("Posting as");
    expect(JSON.stringify({ ...video.j, _voiceos_glance: undefined })).not.toContain("data:image");
  });

  test("find_recent_images puts real thumbnails on the rows the card shows (no stack frames)", async () => {
    const h = await harness({ images: pics() });
    const { j, blocks } = await h.call("find_recent_images", {});
    expect(h.photoLook.calls.at(-1)!.opts).toMatchObject({ frames: false, thumbWidth: 96 });
    expect(h.photoLook.calls.at(-1)!.names).toEqual(["one.heic", "two.heic", "three.heic"]);
    expect(JSON.stringify(j.images)).not.toContain("data:image");
    expect(blocks[0].html).toContain(`data:image/jpeg;base64,${Buffer.from("96:two.heic").toString("base64")}`);
  });

  test("with no relay configured every photo write is RELAY_NOT_CONFIGURED before the receipt or any work", async () => {
    const h = await harness({ images: pics() });
    const bt = await bundled(h);
    h.relay.configured = false;
    const args = h.signed("upload_photos", { bundle_token: bt });
    const { j } = await h.call("upload_photos", args);
    expect(j).toMatchObject({ outcome: "refused", nothing_sent: true, error: { code: "RELAY_NOT_CONFIGURED" } });
    expect((await h.call("post_photos", { bundle_token: bt, post_token: "pt1.x" })).j.error.code).toBe("RELAY_NOT_CONFIGURED");
    expect(h.spent.set.size).toBe(0);
    expect(h.relay.created).toEqual([]);
    expect(h.client.execs).toHaveLength(0);
  });
});
