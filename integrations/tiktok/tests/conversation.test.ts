/**
 * The transcript hook (src/conversation.ts): the one note VoiceOS adds to a turn about the TikTok video in progress.
 * The owner's live run (2026-11-05) is the main case: "ai data center power final" → card → "acctualli i want it to
 * be apost" → the agent asked "which video?". The note must name that video, say how to get its token back, and give
 * the next step, from memory only, with no path.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import {
  FRESH_MS, NOTE_MAX, PRONOUN_FRESH_MS, TRANSCRIPT_HOOK, isHookTool, plainTitle, transcriptContext, transcriptHook, type FocusSnapshot, type HookState,
} from "../src/conversation.ts";
import { Ledger } from "../src/ledger.ts";
import { createDeps, createServer } from "../src/mcpServer.ts";

const T0 = Date.parse("2026-11-05T20:42:00Z");

function clockAt(ms: number) {
  const c = { t: ms, now: () => c.t };
  return c;
}

function stateWith(opts: { focus?: FocusSnapshot; write?: (l: Ledger) => void; now?: number } = {}): HookState & { clock: { t: number; now(): number } } {
  const clock = clockAt(T0);
  const ledger = new Ledger(clock as any);
  opts.write?.(ledger);
  if (opts.now !== undefined) clock.t = opts.now;
  return { clock, ledger, ...(opts.focus ? { session: { current: () => opts.focus } } : {}) };
}

const AI_VIDEO: FocusSnapshot = { title: "ai data center power final", folder: "Downloads", duration_sec: 47.4, orientation: "vertical", how: "picked", at: T0 };

describe("transcriptContext", () => {
  test("the owner's turn: 'acctualli i want it to be apost' names the video in focus, how to get it back, and the post step", () => {
    const note = transcriptContext("acctualli i want it to be apost", stateWith({ focus: AI_VIDEO, now: T0 + 25_000 }))!;
    expect(note.startsWith("TikTok: ")).toBe(true);
    expect(note).toContain('"ai data center power final" (Downloads, 0:47, vertical), picked just now');
    expect(note).toContain('"It/that one" = "ai data center power final"');
    expect(note).toContain('find_recent_videos pick "current"');
    expect(note).toContain("Change only what they mention.");
    expect(note.length).toBeLessThanOrEqual(NOTE_MAX);
  });

  test("'make it a post' and 'post it instead' get the post step; 'just a draft' gets the drafts step", () => {
    const s = stateWith({ focus: AI_VIDEO, now: T0 + 60_000 });
    for (const said of ["make it a post", "post it instead", "actually publish it"]) {
      expect(transcriptContext(said, s)).toContain("Post: query_creator_info, then publish_video, same video and caption.");
    }
    for (const said of ["no just a draft", "send it to my inbox", "send it to my phone instead"]) {
      expect(transcriptContext(said, s)).toContain("Drafts: upload_video, same video and caption.");
    }
  });

  test("a negated mode is dropped: 'post it instead of drafts' posts, 'just a draft, not a post' drafts, both at once gets no mode step", () => {
    const s = stateWith({ focus: AI_VIDEO, now: T0 + 60_000 });
    expect(transcriptContext("post it instead of drafts", s)).toContain("Post: query_creator_info");
    expect(transcriptContext("no wait just a draft not a post", s)).toContain("Drafts: upload_video");
    expect(transcriptContext("i don't want it in drafts, put it up", s)).toContain("Post: query_creator_info");
    const both = transcriptContext("should i post it or draft it", s)!;
    expect(both).not.toContain("Post: ");
    expect(both).not.toContain("Drafts: ");
  });

  test("captions, privacy, the AI label, the other one and 'did it go up?' each get their one step", () => {
    const s = stateWith({ focus: AI_VIDEO, now: T0 + 60_000 });
    expect(transcriptContext("add some trending captions about ai and a caption related to the title of the vid", s)).toContain(
      "Write the caption/hashtags yourself from the title and their words",
    );
    expect(transcriptContext("make it only me", s)).toContain("Change only the privacy");
    expect(transcriptContext("it's ai generated", s)).toContain("AI label: is_aigc on publish_video");
    expect(transcriptContext("no the other one", s)).toContain("A different video: find_recent_videos, offer the others.");
    expect(transcriptContext("did it go up?", s)).toContain("Status: fetch_publish_status.");
  });

  test("what the user last asked for rides along: post, Only me, AI label, caption; a refused card says it needs a click", () => {
    const focus: FocusSnapshot = {
      ...AI_VIDEO, how: "post_not_sent", mode: "post", privacy_level: "SELF_ONLY", is_aigc: true, caption: "AI's power bill is real #AI #DataCenters",
    };
    const note = transcriptContext("add some trending hashtags", stateWith({ focus, now: T0 + 2 * 60_000 }))!;
    expect(note).toContain("post card not sent (needs a click on the card) 2 min ago.");
    expect(note).toContain('Last asked: post, Only me, AI label on, caption "AI\'s power bill is real #AI #DataCenters".');
    expect(note).toContain("Write the caption/hashtags yourself");
    expect(note.length).toBeLessThanOrEqual(NOTE_MAX);
  });

  test("from the ledger alone (no focus memory): the last send, its caption and a query on its title", () => {
    const s = stateWith({
      write: (l) => {
        const e = l.start({
          tool: "upload_video", kind: "video", mode: "drafts", media: { names: ["ai data center power final.mp4"], count: 1 },
          details: { caption: "AI lives in the cloud, but its power bill is real #AI" },
        });
        l.update(e.task_id, { stage: "done", last_status: "SEND_TO_USER_INBOX" });
      },
      now: T0 + 3 * 60_000,
    });
    const note = transcriptContext("actually i want it to be a post", s)!;
    expect(note).toContain('"ai data center power final": in the TikTok inbox (drafts), 3 min ago, caption "AI lives in the cloud, but its power bill is real #AI".');
    expect(note).toContain('find_recent_videos query "ai data center power final"');
    expect(note).not.toContain("pick");
    expect(note).not.toContain(".mp4");
  });

  test("a refused send (card not clicked) is said as such", () => {
    const s = stateWith({
      focus: AI_VIDEO,
      write: (l) => {
        const e = l.start({ tool: "publish_video", kind: "video", mode: "direct", media: { names: [], count: 0 }, details: {} });
        l.update(e.task_id, { stage: "failed", error_code: "CONFIRMATION_REQUIRED" });
      },
      now: T0 + 30_000,
    });
    expect(transcriptContext("post it", s)).toContain("Last send: not sent: the post card wasn't clicked, just now.");
  });

  test("quiet when it isn't about TikTok, when there's nothing fresh, or when a bare pronoun comes long after", () => {
    expect(transcriptContext("what's the weather tomorrow", stateWith({ focus: AI_VIDEO }))).toBeUndefined();
    expect(transcriptContext("post it", stateWith({}))).toBeUndefined();
    expect(transcriptContext("post it", stateWith({ focus: AI_VIDEO, now: T0 + FRESH_MS + 1 }))).toBeUndefined();
    // "it" alone counts only while the TikTok conversation is recent.
    expect(transcriptContext("make it louder", stateWith({ focus: AI_VIDEO, now: T0 + 60_000 }))).toBeDefined();
    expect(transcriptContext("make it louder", stateWith({ focus: AI_VIDEO, now: T0 + PRONOUN_FRESH_MS + 1 }))).toBeUndefined();
    expect(transcriptContext("", stateWith({ focus: AI_VIDEO }))).toBeUndefined();
  });

  test("a focus reader that throws or is missing its method doesn't break the turn", () => {
    const s: HookState = { clock: clockAt(T0), ledger: new Ledger(clockAt(T0) as any), session: { current: () => { throw new Error("boom"); } } };
    expect(transcriptContext("post it", s)).toBeUndefined();
    expect(transcriptContext("post it", { ...s, session: {} })).toBeUndefined();
  });

  test("long titles and captions are clipped; the note stays within its cap and carries no path", () => {
    const s = stateWith({
      focus: { ...AI_VIDEO, title: "x".repeat(300) },
      write: (l) => {
        l.start({ tool: "upload_video", kind: "video", mode: "drafts", media: { names: ["/Users/someone/Movies/secret.mov"], count: 1 }, details: { caption: "c".repeat(3000) } });
      },
      now: T0 + 1_000,
    });
    const note = transcriptContext("post it with a new caption", s)!;
    expect(note.length).toBeLessThanOrEqual(NOTE_MAX);
    expect(note).not.toContain("/Users");
    expect(plainTitle("/Users/someone/Movies/secret.mov")).toBe("secret");
  });
});

describe("transcriptHook (the MCP tool VoiceOS calls)", () => {
  test("answers continue with the note, or continue alone; a bad payload is still continue", () => {
    const s = stateWith({ focus: AI_VIDEO, now: T0 + 1_000 });
    const parse = (r: ReturnType<typeof transcriptHook>) => JSON.parse(r.content[0].text);
    const on = parse(transcriptHook({ payload_json: JSON.stringify({ hookApiVersion: 1, event: "transcript", transcript: "make it a post" }) }, s));
    expect(on.decision).toBe("continue");
    expect(on.additionalContext).toContain("ai data center power final");
    expect(on.updatedText).toBeUndefined();
    expect(parse(transcriptHook({ payload_json: JSON.stringify({ transcript: "play some jazz" }) }, s))).toEqual({ decision: "continue" });
    expect(parse(transcriptHook({ payload_json: "{not json" }, s))).toEqual({ decision: "continue" });
    expect(parse(transcriptHook({}, s))).toEqual({ decision: "continue" });
  });

  test("served by the real server over MCP, fast, and named so VoiceOS hides it from the agent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tiktok-hook-"));
    try {
      const cfg = loadConfig({}, ["--composio-base-url=http://127.0.0.1:9/api/v3.1", `--state-dir=${join(dir, "state")}`, `--home=${dir}`]);
      const deps = createDeps(cfg, { session: { current: () => ({ ...AI_VIDEO, at: Date.now() }) } });
      const [server, clientSide] = InMemoryTransport.createLinkedPair();
      await createServer(deps).connect(server);
      const client = new Client({ name: "voiceos", version: "0.1.40" });
      await client.connect(clientSide);
      expect(isHookTool(TRANSCRIPT_HOOK)).toBe(true);
      const t0 = performance.now();
      const res: any = await client.callTool({ name: TRANSCRIPT_HOOK, arguments: { payload_json: JSON.stringify({ hookApiVersion: 1, event: "transcript", transcript: "actually make it a post", source: "voice" }) } });
      expect(performance.now() - t0).toBeLessThan(200);
      const json = JSON.parse(res.content[0].text);
      expect(json.decision).toBe("continue");
      expect(json.additionalContext).toContain('"ai data center power final"');
      await client.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
