/**
 * End to end through the real modules: the MCP server over an in-memory
 * transport, the real Composio client against the loopback mock
 * (tests/mock-composio.ts), real tokens, receipts (signed with mintReceipt,
 * exactly as a card signs them), the real file finder over a temporary home
 * holding tiny real MP4/MOV fixtures, and a fake Runner (no osascript, sips or
 * pbcopy). Status polls wait 1 ms.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TIKTOK_TOOLKIT_VERSION, loadConfig } from "../src/config.ts";
import { createDeps, createServer, type Deps } from "../src/mcpServer.ts";
import { mintReceipt } from "../src/receipts.ts";
import { parseResult } from "../src/results.ts";
import type { WriteTool } from "../src/types.ts";
import { fakeRunner, put } from "./fixtures/media/fixtures.ts";
import { reply, startMockComposio } from "./mock-composio.ts";
import { z } from "zod";

const TriggerRequest = z.object({ method: z.literal("voiceos/reminders/trigger"), params: z.record(z.unknown()) });

const FIXTURES = join(import.meta.dir, "fixtures", "media");
const ROOT = mkdtempSync(join(tmpdir(), "tiktok-tools-e2e-"));
const HOME = join(ROOT, "home");
// "Date added" is the file's birth time. macOS moves it back with an older mtime; Windows keeps the real
// creation time. Writing the newer video last makes it the newest on both.
put(HOME, "Desktop/second_take.mov", readFileSync(join(FIXTURES, "ffmpeg-qt.mov")), Date.now() - 7_200_000);
put(HOME, "Downloads/final_export.mp4", readFileSync(join(FIXTURES, "ffmpeg-faststart.mp4")), Date.now() - 3_600_000);

const mock = startMockComposio();
afterAll(() => {
  mock.stop();
  rmSync(ROOT, { recursive: true, force: true });
});
beforeEach(() => mock.reset());

let n = 0;
async function harness(over: Partial<Deps> = {}) {
  const cfg = loadConfig(
    { COMPOSIO_API_KEY: mock.apiKey, COMPOSIO_USER_ID: mock.userId, COMPOSIO_CONNECTED_ACCOUNT_ID: mock.connectedAccountId },
    [`--composio-base-url=${mock.baseUrl}`, `--state-dir=${join(ROOT, `state-${++n}`)}`, `--home=${HOME}`],
  );
  const deps = createDeps(cfg, { runner: fakeRunner(), pollScheduleMs: [1], copyToClipboard: async () => {}, ...over });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createServer(deps).connect(serverSide);
  const client = new Client({ name: "e2e", version: "1.0.0" });
  const triggers: any[] = [];
  client.setRequestHandler(TriggerRequest, async (req) => (triggers.push(req.params), { notificationId: `n${triggers.length}` }));
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as any;
    return { r, j: parseResult(r), blocks: parseResult(r)._voiceos_glance?.blocks ?? [] };
  };
  const signed = (tool: WriteTool, args: Record<string, unknown>) => ({ ...args, confirmation_receipt: mintReceipt(tool, args, Date.now()) });
  const videos = async () => (await call("find_recent_videos", {})).j.videos as Array<Record<string, any>>;
  return { deps, call, signed, videos, triggers };
}

const executes = (slug: string) => mock.executes(slug).length;

describe("reads against the mock", () => {
  test("stats, recent posts, post details and an empty status", async () => {
    const h = await harness();
    const stats = await h.call("get_user_stats", { include_profile: true });
    expect(stats.j).toMatchObject({ ok: true, username: mock.user.username });
    expect(typeof stats.j.follower_count).toBe("number");
    expect(stats.blocks).toHaveLength(1);
    const body = mock.executes("TIKTOK_GET_USER_STATS")[0].body;
    expect(body).toMatchObject({ user_id: mock.userId, connected_account_id: mock.connectedAccountId, version: TIKTOK_TOOLKIT_VERSION });
    expect(body.arguments.fields).toHaveLength(10);

    const list = await h.call("list_videos", { max_count: 2 });
    expect(mock.executes("TIKTOK_LIST_VIDEOS")[0].body.arguments).toEqual({ max_count: 2 });
    expect(list.j.videos.length).toBeGreaterThan(0);
    expect(list.j.videos[0].share_url).toMatch(/^https:\/\//);
    expect(list.j.note).toContain("user-written");

    const id = list.j.videos[0].id;
    const details = await h.call("query_videos", { video_ids: [id] });
    expect(details.j.videos[0]).toMatchObject({ id });
    expect(Array.isArray(details.j.videos[0].hashtags ?? [])).toBe(true);

    const none = await h.call("fetch_publish_status", {});
    expect(none.j.state).toBe("none");
    expect(executes("TIKTOK_FETCH_PUBLISH_STATUS")).toBe(0);
  });
});

describe("upload_video end to end", () => {
  test("receipt → staging PUT → one drafts init → status walk → completion card and ledger", async () => {
    const h = await harness();
    const [clip] = await h.videos();
    expect(clip).toMatchObject({ name: "final_export.mp4", folder: "Downloads", duration_sec: 2, mime: "video/mp4" });
    expect(JSON.stringify(clip)).not.toContain(HOME);
    const { r, j, blocks } = await h.call("upload_video", h.signed("upload_video", { file_token: clip.file_token, file_name: clip.name }));
    expect(r.isError).toBeUndefined();
    expect(j).toMatchObject({ outcome: "inbox", status: "SEND_TO_USER_INBOX", kind: "video", mode: "drafts", file_name: "final_export.mp4" });
    expect(blocks).toHaveLength(1);

    const request = mock.calls.find((c) => c.path === "/files/upload/request")!;
    expect(request.body).toMatchObject({ toolkit_slug: "tiktok", tool_slug: "TIKTOK_UPLOAD_VIDEO", filename: "final_export.mp4", mimetype: "video/mp4" });
    expect(mock.presigned.puts).toHaveLength(1);
    expect(mock.presigned.puts[0].bytes).toBe(clip.size);
    expect(mock.presigned.puts[0].headers["x-api-key"]).toBeUndefined();
    const inits = mock.executes("TIKTOK_UPLOAD_VIDEO");
    expect(inits).toHaveLength(1);
    expect(inits[0].body.version).toBe(TIKTOK_TOOLKIT_VERSION);
    expect(inits[0].body.arguments).toEqual({ file_to_upload: { name: "final_export.mp4", mimetype: "video/mp4", s3key: expect.any(String) }, publish: false });
    expect(executes("TIKTOK_FETCH_PUBLISH_STATUS")).toBeGreaterThanOrEqual(2);
    // The account was checked before the big upload.
    const order = mock.calls.map((c) => c.slug ?? c.path);
    expect(order.indexOf("/connected_accounts")).toBeLessThan(order.indexOf("/files/upload/request"));

    const entry = h.deps.ledger.latest()!;
    expect(entry).toMatchObject({ stage: "done", publish_id: j.publish_id, last_status: "SEND_TO_USER_INBOX" });
    expect(JSON.stringify(entry)).not.toContain(HOME);

    const status = await h.call("fetch_publish_status", {});
    expect(status.j).toMatchObject({ publish_id: j.publish_id, state: "inbox", kind: "video", mode: "drafts", names: ["final_export.mp4"] });
  });

  test("CONFIRMATION_REQUIRED for a missing, mismatched or reused receipt makes zero Composio calls", async () => {
    const h = await harness();
    const [clip] = await h.videos();
    const good = h.signed("upload_video", { file_token: clip.file_token, caption: "day 3" });
    await h.call("upload_video", good);
    const before = mock.calls.length;
    const missing = await h.call("upload_video", { file_token: clip.file_token, caption: "day 3" });
    const mismatched = await h.call("upload_video", { ...good, caption: "day 4" });
    const reused = await h.call("upload_video", good);
    expect(mock.calls.length).toBe(before);
    for (const [res, reason] of [[missing, "missing"], [mismatched, "mismatch"], [reused, "reused"]] as const) {
      expect(res.r.isError).toBe(true);
      expect(res.j).toMatchObject({ outcome: "refused", nothing_sent: true, error: { code: "CONFIRMATION_REQUIRED", reason } });
    }
  });

  test("a dropped init answer is OUTCOME_UNKNOWN, sent once and never retried", async () => {
    const h = await harness();
    const [clip] = await h.videos();
    mock.once("TIKTOK_UPLOAD_VIDEO", () => reply.drop());
    const { r, j } = await h.call("upload_video", h.signed("upload_video", { file_token: clip.file_token }));
    expect(r.isError).toBe(true);
    expect(j).toMatchObject({ outcome: "unknown", error: { code: "OUTCOME_UNKNOWN" } });
    expect(executes("TIKTOK_UPLOAD_VIDEO")).toBe(1);
    expect(executes("TIKTOK_FETCH_PUBLISH_STATUS")).toBe(0);
    expect(h.deps.ledger.latest()).toMatchObject({ stage: "unknown" });
  });

  test("one write at a time: the second upload starts staging only after the first init has answered", async () => {
    const h = await harness();
    const [a, b] = await h.videos();
    const seen: Array<{ what: string; at: number }> = [];
    mock.onRoute("POST", "/files/upload/request", (c) => void seen.push({ what: `request:${c.body?.filename}`, at: Date.now() }));
    mock.on("TIKTOK_UPLOAD_VIDEO", (args, c) => {
      seen.push({ what: `init:${args.file_to_upload?.name}`, at: Date.now() });
      return { ...mock.defaultReply("TIKTOK_UPLOAD_VIDEO", args, c), delayMs: 150 };
    });
    const [ra, rb] = await Promise.all([
      h.call("upload_video", h.signed("upload_video", { file_token: a.file_token })),
      h.call("upload_video", h.signed("upload_video", { file_token: b.file_token })),
    ]);
    expect([ra.j.outcome, rb.j.outcome]).toEqual(["inbox", "inbox"]);
    expect(seen.map((s) => s.what)).toEqual([`request:${a.name}`, `init:${a.name}`, `request:${b.name}`, `init:${b.name}`]);
    expect(seen[2].at - seen[1].at).toBeGreaterThanOrEqual(140);
  });
});

describe("publish_video end to end", () => {
  test("query_creator_info → the server's direct-post rules → a SELF_ONLY post", async () => {
    const h = await harness();
    const [clip] = await h.videos();
    const info = (await h.call("query_creator_info", { file_token: clip.file_token })).j;
    expect(info).toMatchObject({ can_post: true, duration_ok: true, privacy_options: ["SELF_ONLY"] });
    const base = {
      post_token: info.post_token, file_token: clip.file_token, creator_nickname: info.creator_nickname, privacy_options: info.privacy_options,
      comment_disabled: info.comment_disabled, duet_disabled: info.duet_disabled, stitch_disabled: info.stitch_disabled,
      max_duration_sec: info.max_duration_sec, caption: "day 3 of building VoiceOS #buildinpublic", privacy_level: "SELF_ONLY",
    };
    const before = mock.calls.length;
    const rules: Array<[Record<string, unknown>, string]> = [
      [{ privacy_level: "" }, "PRIVACY_MISMATCH"],
      [{ privacy_level: "FOLLOWER_OF_CREATOR" }, "PRIVACY_MISMATCH"],
      [{ commercial_disclosure: "true" }, "DISCLOSURE_INCOMPLETE"],
      [{ commercial_disclosure: "true", brand_content: "true" }, "BRANDED_PRIVATE_BLOCKED"],
    ];
    for (const [extra, code] of rules) {
      const { j } = await h.call("publish_video", h.signed("publish_video", { ...base, ...extra }));
      expect({ code: j.error.code, nothing_sent: j.nothing_sent }).toEqual({ code, nothing_sent: true });
    }
    expect(mock.calls.length).toBe(before);

    const { j } = await h.call("publish_video", h.signed("publish_video", { ...base, allow_comment: "true", allow_duet: "true" }));
    expect(j).toMatchObject({ outcome: "posted", status: "PUBLISH_COMPLETE", privacy_label: "Only me", forced_off: ["Duet"] });
    expect(mock.executes("TIKTOK_UPLOAD_VIDEO")[0].body.arguments).toMatchObject({
      publish: true, privacy_level: "SELF_ONLY", disable_comment: false, disable_duet: true, disable_stitch: true,
      brand_organic_toggle: false, brand_content_toggle: false, caption: base.caption,
    });
  });

  test("a video longer than the creator's maximum gets FILE_TOO_LONG and no post_token", async () => {
    const h = await harness();
    const [clip] = await h.videos();
    mock.creator.max_video_post_duration_sec = 1;
    const { r, j } = await h.call("query_creator_info", { file_token: clip.file_token });
    expect(r.isError).toBe(true);
    expect(j).toMatchObject({ error: { code: "FILE_TOO_LONG", max: 1, dur: 2 }, can_post: false, drafts_ok: true });
    expect(j.post_token).toBeUndefined();
  });
});

describe("photo writes without the media relay token", () => {
  test("upload_photos and post_photos are refused with RELAY_NOT_CONFIGURED, and nothing is called", async () => {
    // The relay base is the deployed one (src/config.ts), but with no MEDIA_RELAY_TOKEN the client isn't configured:
    // it refuses before any network call (the relay is never reached from a test).
    const h = await harness();
    expect(h.deps.cfg.relayToken).toBeUndefined();
    expect(h.deps.relay.configured).toBe(false);
    for (const tool of ["upload_photos", "post_photos"] as const) {
      const { r, j } = await h.call(tool, { bundle_token: "bt1.anything", post_token: "pt1.anything" });
      expect(r.isError).toBe(true);
      expect(j).toMatchObject({ outcome: "refused", nothing_sent: true, error: { code: "RELAY_NOT_CONFIGURED" } });
    }
    expect(mock.calls).toHaveLength(0);
  });
});

describe("a write slower than VoiceOS's call limit (soft deadline shortened)", () => {
  test("answers 'working', finishes against the mock, then queues the reminder", async () => {
    const h = await harness({ softDeadlineMs: 40 });
    const [v] = await h.videos();
    // TikTok takes its time answering the init: the call has answered by then.
    mock.on("TIKTOK_UPLOAD_VIDEO", (a, c) => ({ ...mock.defaultReply("TIKTOK_UPLOAD_VIDEO", a, c), delayMs: 300 }));
    const { j } = await h.call("upload_video", h.signed("upload_video", { file_token: v.file_token }));
    expect(j).toMatchObject({ ok: true, outcome: "working", running: true });
    expect(executes("TIKTOK_UPLOAD_VIDEO") <= 1).toBe(true);
    await h.deps.jobs.idle();
    expect(executes("TIKTOK_UPLOAD_VIDEO")).toBe(1);
    expect(h.triggers).toHaveLength(1);
    expect(h.triggers[0]).toMatchObject({ speak: false, actions: [{ id: "show_post", label: "Show" }], data: { entry: j.task_id } });
    expect(h.triggers[0].message).toContain("final_export.mp4");
    expect(h.deps.ledger.latest()!.stage).toBe("done");
  });
});
