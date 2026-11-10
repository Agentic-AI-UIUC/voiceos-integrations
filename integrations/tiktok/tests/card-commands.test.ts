/**
 * The writes' wider commands: hashtags and mentions folded into the signed text, the user's audience words for
 * privacy_level, and cover times in words. The cards' rules (TKC, confirm-card/card-logic.js) run here with
 * node:vm, exactly the text the cards inline; the server's twins (src/tools/writes.ts) are checked against them;
 * and a card-folded call goes end to end: model args → TKC.settle → VoiceOS's overlay → TKR.mint (the cards' copy
 * of the receipt core) → the write handler against the loopback mock Composio (tests/mock-composio.ts). Nothing
 * here reaches real Composio or TikTok.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import vm from "node:vm";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CARD_LOGIC_JS, RECEIPT_CORE_JS } from "../confirm-card/build.ts";
import { loadConfig } from "../src/config.ts";
import { createDeps, createServer, type Deps } from "../src/mcpServer.ts";
import { mintReceipt, randomNonce } from "../src/receipts.ts";
import TKR from "../src/receiptCoreScript.ts";
import { parseResult } from "../src/results.ts";
import { coverMsOf, privacyCodeOf, sendable } from "../src/tools/writes.ts";
import type { BundleImage, WriteTool } from "../src/types.ts";
import { fakeRunner, put } from "./fixtures/media/fixtures.ts";
import { startMockComposio } from "./mock-composio.ts";

type Args = Record<string, unknown>;
const TKC = vm.runInNewContext(`${CARD_LOGIC_JS}\n;TKC`) as {
  privacyCode(v: unknown): string;
  foldTags(text: unknown, hashtags: unknown, mentions: unknown, field: string): string;
  coverMs(v: unknown): string;
  coverLabel(ms: unknown): string;
  settle(tool: string, a: Args, changed: string | null): Record<string, string>;
  view(tool: string, a: Args): any;
};
/** The receipt core as the cards run it (an inlined classic script), not the server's import. */
const CARD_TKR = vm.runInNewContext(`${RECEIPT_CORE_JS}\n;TKR`) as typeof TKR;
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const settle = (tool: WriteTool, a: Args, changed: string | null = null) => plain(TKC.settle(tool, a, changed));
const fold = (text: unknown, hashtags: unknown, mentions?: unknown) => TKC.foldTags(text, hashtags, mentions, "caption");

/**
 * What the card does on voiceos:init, then what VoiceOS sends on a click: the model's args overlaid with every
 * value the card staged (the settle corrections and the receipt minted over exactly that overlay).
 */
function clicked(tool: WriteTool, args: Args, now = Date.now()): { staged: Record<string, string>; sent: Args } {
  const staged = settle(tool, args);
  const merged: Args = { ...args, ...staged };
  delete merged.confirmation_receipt;
  return { staged, sent: { ...merged, confirmation_receipt: CARD_TKR.mint(tool, merged, now, randomNonce()) } };
}

// ---------------------------------------------------------------------------
// TKC: the pure helpers
// ---------------------------------------------------------------------------

describe("TKC.privacyCode: the user's audience words as TikTok's codes", () => {
  test("words, in any case, with spaces, hyphens or underscores", () => {
    const cases: Array<[string, string]> = [
      ["everyone", "PUBLIC_TO_EVERYONE"], ["Public", "PUBLIC_TO_EVERYONE"], ["anyone", "PUBLIC_TO_EVERYONE"],
      ["followers", "FOLLOWER_OF_CREATOR"], ["FOLLOWERS", "FOLLOWER_OF_CREATOR"],
      ["friends", "MUTUAL_FOLLOW_FRIENDS"], ["mutual friends", "MUTUAL_FOLLOW_FRIENDS"], ["Mutual-Friends", "MUTUAL_FOLLOW_FRIENDS"],
      ["only me", "SELF_ONLY"], ["Only Me", "SELF_ONLY"], ["just me", "SELF_ONLY"], ["just_me", "SELF_ONLY"], ["me", "SELF_ONLY"],
      ["private", "SELF_ONLY"], ["self", "SELF_ONLY"], ["  only-me  ", "SELF_ONLY"],
    ];
    for (const [word, code] of cases) expect({ word, code: TKC.privacyCode(word) }).toEqual({ word, code });
  });

  test("TikTok's codes read as themselves; anything else as TKR.normUpper signs it", () => {
    for (const code of ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"]) {
      expect(TKC.privacyCode(code)).toBe(code);
      expect(TKC.privacyCode(` ${code.toLowerCase()} `)).toBe(code);
    }
    expect(TKC.privacyCode("public to everyone")).toBe("PUBLIC_TO_EVERYONE");
    expect(TKC.privacyCode("new_audience")).toBe("NEW_AUDIENCE");
    expect(TKC.privacyCode("my cat")).toBe("MY CAT");
    for (const v of ["", "   ", undefined, null]) expect(TKC.privacyCode(v)).toBe("");
  });
});

describe("TKC.foldTags: hashtags and mentions appended to the text", () => {
  test("normalized: # and @ prefixes, inner spaces and punctuation gone, case kept", () => {
    expect(fold("day 3", ["machine learning", "#AI", "build-in-public!"])).toBe("day 3 #machinelearning #AI #buildinpublic");
    expect(fold("", ["#café", "日本", "under_score", "2026"])).toBe("#café #日本 #under_score #2026");
    expect(fold("", ["fyp😀", "＃wide"])).toBe("#fyp #wide");
    expect(fold("", "", ["maya.makes", "@Sam_K", "@tom!", "@maya.", "jo lee"])).toBe("@maya.makes @Sam_K @tom @maya @jolee");
    // Nothing left after normalizing: nothing added.
    expect(fold("hi", ["#", "!!!", "  "], ["@", "..."])).toBe("hi");
  });

  test("a list is one tag per item; one string splits on commas, or else on spaces", () => {
    expect(fold("", "ai tech")).toBe("#ai #tech");
    expect(fold("", "#ai #tech")).toBe("#ai #tech");
    expect(fold("", "machine learning, ai")).toBe("#machinelearning #ai");
    expect(fold("", ["ai, tech"])).toBe("#ai #tech");
    expect(fold("", ["#ai #tech", "deep learning"])).toBe("#ai #tech #deeplearning");
    expect(fold("", "", "maya, sam")).toBe("@maya @sam");
    expect(fold("", "", "@maya @sam")).toBe("@maya @sam");
    // Only strings and numbers count; anything else is skipped.
    expect(fold("", [{ tag: "x" }, null, "ok", 7] as unknown[], { a: 1 })).toBe("#ok #7");
  });

  test("a word's own mark decides its kind; hashtags first, then mentions, each once in any case", () => {
    expect(fold("", ["ai", "@maya"], ["#tech", "sam"])).toBe("#ai #tech @maya @sam");
    expect(fold("", ["AI", "ai", "#Ai"], ["Maya", "maya"])).toBe("#AI @Maya");
  });

  test("tags already in the text are skipped (any case, whole tags only)", () => {
    expect(fold("Late night #AI build", ["ai", "tech"])).toBe("Late night #AI build #tech");
    expect(fold("tools #aitools", ["ai"])).toBe("tools #aitools #ai");
    expect(fold("with @Maya.Makes.", "", ["maya.makes", "maya"])).toBe("with @Maya.Makes. @maya");
    expect(fold("#ai #tech", "ai, tech", "")).toBe("#ai #tech");
    // A mention doesn't satisfy a hashtag of the same word, or the other way round.
    expect(fold("@ai", ["ai"], ["tech"])).toBe("@ai #ai @tech");
  });

  test("single spaces after the text; trailing spaces go; a final line break keeps them on the next line", () => {
    expect(fold("hello   ", ["ai"])).toBe("hello #ai");
    expect(fold("hello\n", ["ai"])).toBe("hello\n#ai");
    expect(fold("a\r\nb", ["ai"])).toBe("a\r\nb #ai");
    expect(fold(undefined, ["ai"])).toBe("#ai");
    // Nothing to add: the text comes back exactly as it was (trailing spaces too).
    expect(fold("same #ai  ", ["AI"])).toBe("same #ai  ");
    expect(fold("x", undefined, undefined)).toBe("x");
    expect(TKC.foldTags("desc", ["ai"], ["maya"], "description")).toBe("desc #ai @maya");
  });
});

describe("TKC.coverMs and coverLabel: cover times in words", () => {
  const cases: Array<[unknown, string, string]> = [
    ["0:05", "5000", "0:05"], ["1:02", "62000", "1:02"], ["0:05.5", "5500", "0:05.5"], ["1:02:03", "3723000", "1:02:03"],
    ["5s", "5000", "0:05"], ["5.5s", "5500", "0:05.5"], ["5 seconds", "5000", "0:05"], ["5 sec", "5000", "0:05"], ["1 second", "1000", "0:01"],
    ["2.5", "2500", "0:02.5"], [".5", "500", "0:00.5"], ["1m30s", "90000", "1:30"], ["1 min and 5 sec", "65000", "1:05"],
    ["500ms", "500", "0:00.5"], ["500 milliseconds", "500", "0:00.5"], ["at 0:03", "3000", "0:03"], ["  5S ", "5000", "0:05"],
    // A bare integer stays milliseconds, as before.
    ["3000", "3000", "0:03"], [3000, "3000", "0:03"], ["0003000", "3000", "0:03"], [0, "0", "0:00"], ["0", "0", "0:00"],
    [2.5, "2500", "0:02.5"],
  ];
  test("each form, as milliseconds and as the card shows it", () => {
    for (const [v, ms, label] of cases) expect({ v, ms: TKC.coverMs(v), label: TKC.coverLabel(TKC.coverMs(v)) }).toEqual({ v, ms, label });
  });

  test("what can't be read is empty", () => {
    for (const v of ["", "abc", "-5", -1, "0:75", "1:60:00", "5 parsecs", "5s later", "1.2.3", NaN, Infinity, true, {}, undefined, null]) {
      expect({ v: String(v), ms: TKC.coverMs(v) }).toEqual({ v: String(v), ms: "" });
    }
  });

  test("TKR.normInt signs the folded digit string as it always did", () => {
    for (const [v, ms] of cases) {
      expect(TKR.normInt(ms)).toBe(ms);
      expect(TKR.normInt(Number(ms))).toBe(ms);
      if (typeof v === "number" ? Number.isInteger(v) : /^\d+$/.test(String(v).trim())) expect(TKR.normInt(v)).toBe(ms);
    }
  });
});

// ---------------------------------------------------------------------------
// TKC.settle: what the card stages at init
// ---------------------------------------------------------------------------

describe("TKC.settle folds tags on every write; the direct-post rules stay direct-only", () => {
  test("videos fold into caption, photos into description; both fields staged as empty", () => {
    expect(settle("upload_video", { caption: "day 3", hashtags: ["ai"], mentions: "maya" })).toEqual({ caption: "day 3 #ai @maya", hashtags: "", mentions: "" });
    expect(settle("publish_video", { caption: "day 3", hashtags: "ai tech" })).toMatchObject({ caption: "day 3 #ai #tech", hashtags: "" });
    expect(settle("upload_photos", { title: "Lisbon", description: "best days", hashtags: ["travel"] })).toEqual({ description: "best days #travel", hashtags: "" });
    expect(settle("post_photos", { title: "Lisbon", mentions: ["@maya"] })).toMatchObject({ description: "@maya", mentions: "" });
    // The photo title is left alone.
    expect(settle("upload_photos", { title: "Lisbon", hashtags: "travel" }).title).toBeUndefined();
  });

  test("tags already in the text: only the inputs are cleared; empty or missing inputs stage nothing", () => {
    expect(settle("upload_video", { caption: "day 3 #ai", hashtags: ["AI"] })).toEqual({ hashtags: "" });
    expect(settle("upload_video", { caption: "day 3", hashtags: [] })).toEqual({ hashtags: "" });
    expect(settle("upload_video", { caption: "day 3", hashtags: "", mentions: "" })).toEqual({});
    expect(settle("upload_video", { caption: "day 3" })).toEqual({});
    // Drafts still have no privacy or disclosure rules.
    expect(settle("upload_photos", { privacy_level: "everyone", hashtags: "x" })).toEqual({ description: "#x", hashtags: "" });
  });

  test("idempotent: once staged, the next settle (an edit, or a re-init with staged values) changes nothing", () => {
    for (const tool of ["upload_video", "publish_video", "upload_photos", "post_photos"] as const) {
      const a: Args = { caption: "c", description: "d", hashtags: ["ai", "tech"], mentions: "maya", privacy_options: ["SELF_ONLY"], privacy_level: "only me" };
      Object.assign(a, settle(tool, a));
      expect({ tool, again: settle(tool, a) }).toEqual({ tool, again: {} });
      // The user's own edit to the caption is kept as written (no folding after init).
      expect({ tool, edit: settle(tool, { ...a, caption: "mine", description: "mine" }, tool.endsWith("video") ? "caption" : "description") }).toEqual({ tool, edit: {} });
    }
  });

  test("folding past TikTok's limit still folds; the card's counter says over", () => {
    const caption = "x".repeat(2195);
    const fix = settle("publish_video", { caption, hashtags: ["ai", "tech"], privacy_options: ["SELF_ONLY"] });
    expect(fix.caption).toBe(`${caption} #ai #tech`);
    const v = TKC.view("publish_video", { caption, hashtags: ["ai", "tech"], privacy_options: ["SELF_ONLY"] });
    expect(v.text.caption).toMatchObject({ length: 2205, over: true, show: true });
    expect(TKC.view("upload_photos", { description: "d".repeat(3999), hashtags: "ai" }).text.description.over).toBe(true);
  });

  test("audience words stage TikTok's code, then the existing rule checks it against privacy_options", () => {
    expect(settle("publish_video", { privacy_options: ["SELF_ONLY"], privacy_level: "only me" })).toEqual({ privacy_level: "SELF_ONLY" });
    expect(settle("post_photos", { privacy_options: ["SELF_ONLY"], privacy_level: "Just-Me" })).toEqual({ privacy_level: "SELF_ONLY" });
    expect(settle("publish_video", { privacy_options: ["SELF_ONLY", "MUTUAL_FOLLOW_FRIENDS"], privacy_level: "friends" })).toEqual({ privacy_level: "MUTUAL_FOLLOW_FRIENDS" });
    // A word for an option the creator doesn't have is cleared, as a code would be: the user picks on the card.
    expect(settle("publish_video", { privacy_options: ["SELF_ONLY"], privacy_level: "everyone" })).toEqual({ privacy_level: "" });
    // Branded content can't be Only me, in words too.
    const branded = { privacy_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"], commercial_disclosure: "true", brand_content: "true" };
    expect(settle("publish_video", { ...branded, privacy_level: "private" })).toEqual({ privacy_level: "" });
    expect(TKC.view("publish_video", { privacy_options: ["SELF_ONLY"], privacy_level: "only me" }).privacy.selected).toBe("SELF_ONLY");
  });

  test("cover words become the digit string, with a cover_label when none was given", () => {
    expect(settle("publish_video", { privacy_options: ["SELF_ONLY"], privacy_level: "SELF_ONLY", cover_ms: "0:05" })).toEqual({ cover_ms: "5000", cover_label: "0:05" });
    expect(settle("publish_video", { privacy_options: ["SELF_ONLY"], privacy_level: "SELF_ONLY", cover_ms: "2.5", cover_label: "Frame at 0:02" })).toEqual({ cover_ms: "2500" });
    // A whole number stays as it came; it still gets a label so the card says which frame.
    expect(settle("publish_video", { privacy_options: ["SELF_ONLY"], privacy_level: "SELF_ONLY", cover_ms: 3000 })).toEqual({ cover_label: "0:03" });
    expect(settle("publish_video", { privacy_options: ["SELF_ONLY"], privacy_level: "SELF_ONLY", cover_ms: "3000", cover_label: "Frame at 0:03" })).toEqual({});
    // Unreadable: left for the server to refuse; other tools have no cover.
    expect(settle("publish_video", { privacy_options: ["SELF_ONLY"], privacy_level: "SELF_ONLY", cover_ms: "the end" })).toEqual({});
    expect(settle("upload_video", { cover_ms: "0:05" })).toEqual({});
  });

  test("the receipt over the settled args signs the digit string, the same as one minted over milliseconds", () => {
    const a = { post_token: "pt", file_token: "ft", privacy_options: ["SELF_ONLY"], privacy_level: "only me", caption: "c", cover_ms: "0:05" };
    const s = { ...a, ...settle("publish_video", a) };
    expect(CARD_TKR.canonical("publish_video", s)).toBe(TKR.canonical("publish_video", { ...a, privacy_level: "SELF_ONLY", cover_ms: 5000 }));
  });
});

// ---------------------------------------------------------------------------
// The server's twins
// ---------------------------------------------------------------------------

describe("server: the same words, after the receipt", () => {
  test("privacyCodeOf and coverMsOf read exactly as TKC does", () => {
    const words: unknown[] = ["everyone", "Public", "anyone", "followers", "friends", "mutual friends", "Mutual_Friends", "only me", "just me", "me",
      "private", "self", "SELF_ONLY", " self_only ", "NEW_AUDIENCE", "my cat", "", "  ", undefined, null, 3];
    for (const w of words) expect({ w: String(w), server: privacyCodeOf(w) }).toEqual({ w: String(w), server: TKC.privacyCode(w) });
    const covers: unknown[] = ["0:05", "1:02", "0:05.5", "1:02:03", "5s", "5.5s", "5 seconds", "5 sec", "2.5", ".5", "1m30s", "1 min and 5 sec", "500ms",
      "at 0:03", " 5S ", "3000", 3000, "0003000", 0, 2.5, "", "abc", "-5", -1, "0:75", "5 parsecs", "5s later", NaN, Infinity, true, undefined, null];
    for (const c of covers) expect({ c: String(c), server: coverMsOf(c) }).toEqual({ c: String(c), server: TKC.coverMs(c) });
  });

  test("sendable drops hashtags and mentions and reads privacy and cover as TikTok's values", () => {
    const out = sendable("publish_video", { caption: "c", hashtags: ["ai"], mentions: "maya", privacy_level: "Only me", cover_ms: "0:05", allow_comment: "true" });
    expect(out).toEqual({ caption: "c", privacy_level: "SELF_ONLY", cover_ms: "5000", allow_comment: "true" });
    expect(sendable("publish_video", { cover_ms: 3000 }).cover_ms).toBe(3000);
    expect(sendable("publish_video", { cover_ms: "soon" }).cover_ms).toBe("soon");
    expect(sendable("post_photos", { description: "d", hashtags: "x", privacy_level: "friends" })).toEqual({ description: "d", privacy_level: "MUTUAL_FOLLOW_FRIENDS" });
    // Drafts carry no privacy; nothing is invented for them.
    expect(sendable("upload_video", { caption: "c", mentions: ["@maya"] })).toEqual({ caption: "c" });
    expect(sendable("upload_photos", { title: "t", privacy_level: "everyone" })).toEqual({ title: "t", privacy_level: "everyone" });
  });
});

// ---------------------------------------------------------------------------
// End to end: the card's staged values through the write handler, against the loopback mock
// ---------------------------------------------------------------------------

const TriggerRequest = z.object({ method: z.literal("voiceos/reminders/trigger"), params: z.record(z.unknown()) });
const FIXTURES = join(import.meta.dir, "fixtures", "media");
const ROOT = mkdtempSync(join(tmpdir(), "tiktok-card-commands-"));
const HOME = join(ROOT, "home");
put(HOME, "Downloads/final_export.mp4", readFileSync(join(FIXTURES, "ffmpeg-faststart.mp4")), Date.now() - 3_600_000);

const mock = startMockComposio();
afterAll(() => {
  mock.stop();
  rmSync(ROOT, { recursive: true, force: true });
});
beforeEach(() => mock.reset());

/** A photo on disk and its bundle entry (what prepare_photo_post would have minted). */
function photo(name: string): BundleImage {
  const path = join(ROOT, name);
  writeFileSync(path, new Uint8Array(900).fill(9));
  const st = statSync(path);
  return { path, name, size: st.size, mtimeMs: st.mtimeMs, width: 1080, height: 1350, format: "jpeg", has_alpha: false, credentials: "none" };
}

let n = 0;
async function harness(over: Partial<Deps> = {}) {
  const cfg = loadConfig(
    { COMPOSIO_API_KEY: mock.apiKey, COMPOSIO_USER_ID: mock.userId, COMPOSIO_CONNECTED_ACCOUNT_ID: mock.connectedAccountId },
    [`--composio-base-url=${mock.baseUrl}`, `--state-dir=${join(ROOT, `state-${++n}`)}`, `--home=${HOME}`],
  );
  const clipboard: string[] = [];
  // Photos: a stand-in relay and converter (the relay is never reached from a test); TikTok's side is the mock.
  const relay = {
    configured: true,
    async createBatch(count: number) {
      return {
        batch_id: "cafe00112233", expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        items: Array.from({ length: count }, (_, i) => ({ index: i, put_path: `/v1/batches/cafe/${i}`, public_url: `https://media.example.test/cafe/${i}.jpg` })),
      };
    },
    async putImages(batch: { items: Array<{ public_url: string }> }) {
      return batch.items.map((i) => i.public_url);
    },
    async deleteBatch() {},
  };
  const convert: Deps["convert"] = async (images) => {
    const dir = mkdtempSync(join(ROOT, "conv-"));
    const files = images.map((_, i) => {
      const path = join(dir, `${i}.jpg`);
      writeFileSync(path, new Uint8Array([0xff, 0xd8, 0xff, i]));
      return { path, bytes: 4, width: 1080, height: 1350 };
    });
    return { files, dir, cleanup: async () => rmSync(dir, { recursive: true, force: true }) };
  };
  const deps = createDeps(cfg, {
    runner: fakeRunner(), pollScheduleMs: [1], copyToClipboard: async (t) => void clipboard.push(t), relay: relay as never, convert, ...over,
  });
  const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
  await createServer(deps).connect(serverSide);
  const client = new Client({ name: "card-commands", version: "1.0.0" });
  client.setRequestHandler(TriggerRequest, async () => ({ notificationId: "n1" }));
  await client.connect(clientSide);
  const call = async (name: string, args: Args = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as any;
    return { r, j: parseResult(r) };
  };
  const clip = async () => (await call("find_recent_videos", {})).j.videos[0] as Record<string, any>;
  /** query_creator_info's fields, named as the direct writes take them. */
  const creator = async (media: Args) => {
    const info = (await call("query_creator_info", media)).j;
    return {
      post_token: info.post_token, creator_nickname: info.creator_nickname, privacy_options: info.privacy_options,
      comment_disabled: info.comment_disabled, duet_disabled: info.duet_disabled, stitch_disabled: info.stitch_disabled, max_duration_sec: info.max_duration_sec,
    };
  };
  return { deps, call, clip, creator, clipboard };
}

const sentArgs = (slug: string) => mock.executes(slug).at(-1)!.body.arguments as Record<string, unknown>;

describe("end to end: a card-folded write passes the server", () => {
  test("publish_video: tags folded into the caption, 'only me' as SELF_ONLY, '0:01' as 1000 ms", async () => {
    const h = await harness();
    const v = await h.clip();
    const args: Args = {
      file_token: v.file_token, file_name: v.name, ...(await h.creator({ file_token: v.file_token })),
      caption: "day 3 of the build", hashtags: ["machine learning", "#AI"], mentions: "maya.makes", privacy_level: "only me", cover_ms: "0:01",
    };
    const { staged, sent } = clicked("publish_video", args);
    expect(staged).toEqual({
      caption: "day 3 of the build #machinelearning #AI @maya.makes", hashtags: "", mentions: "", cover_ms: "1000", cover_label: "0:01", privacy_level: "SELF_ONLY",
      // The mock creator has Duet and Stitch off: the existing direct-post rule, unchanged.
      allow_duet: "false", allow_stitch: "false",
    });
    const { r, j } = await h.call("publish_video", sent);
    expect(r.isError).toBeUndefined();
    expect(j).toMatchObject({ outcome: "posted", privacy_level: "SELF_ONLY", privacy_label: "Only me" });
    const init = sentArgs("TIKTOK_UPLOAD_VIDEO");
    expect(init).toMatchObject({ publish: true, caption: "day 3 of the build #machinelearning #AI @maya.makes", privacy_level: "SELF_ONLY", video_cover_timestamp_ms: 1000 });
    expect(Object.keys(init)).not.toContain("hashtags");
    expect(Object.keys(init)).not.toContain("mentions");
    expect(h.deps.ledger.latest()!.details).toMatchObject({ caption: staged.caption, privacy_level: "SELF_ONLY", cover_ms: 1000 });
  });

  test("upload_video: the folded caption is what 'Copy caption' copies; the drafts init carries the file alone", async () => {
    const h = await harness();
    const v = await h.clip();
    const { sent } = clicked("upload_video", { file_token: v.file_token, file_name: v.name, caption: "late night", hashtags: "ai, tech", mentions: ["@maya"], copy_caption: "true" });
    const { j } = await h.call("upload_video", sent);
    expect(j).toMatchObject({ outcome: "inbox", caption_copied: true });
    expect(h.clipboard).toEqual(["late night #ai #tech @maya"]);
    expect(sentArgs("TIKTOK_UPLOAD_VIDEO")).toEqual({ file_to_upload: expect.any(Object), publish: false });
  });

  test("upload_photos and post_photos: tags folded into the description, sent as signed", async () => {
    const h = await harness();
    const bundle = h.deps.tokens.mintBundle({ images: [photo("one.jpg"), photo("two.jpg")], cover_index: 0 });
    const drafts = clicked("upload_photos", { bundle_token: bundle, title: "Lisbon", description: "best days", hashtags: ["travel", "#Lisbon"], mentions: "maya" });
    expect((await h.call("upload_photos", drafts.sent)).j).toMatchObject({ outcome: "inbox", kind: "photos", mode: "drafts" });
    expect(sentArgs("TIKTOK_POST_PHOTO")).toMatchObject({ post_mode: "MEDIA_UPLOAD", title: "Lisbon", description: "best days #travel #Lisbon @maya" });

    const direct = clicked("post_photos", {
      bundle_token: bundle, ...(await h.creator({ bundle_token: bundle })), title: "Lisbon", description: "", hashtags: "travel", privacy_level: "Just me",
    });
    const { j } = await h.call("post_photos", direct.sent);
    expect(j).toMatchObject({ outcome: "posted", privacy_label: "Only me" });
    const init = sentArgs("TIKTOK_POST_PHOTO");
    expect(init).toMatchObject({ post_mode: "DIRECT_POST", title: "Lisbon", description: "#travel", privacy_level: "SELF_ONLY" });
    expect(Object.keys(init)).not.toContain("hashtags");
  });
});

describe("end to end: the server sends only what was signed", () => {
  test("hashtags a card didn't fold are ignored: the signed caption goes out alone", async () => {
    const h = await harness();
    const v = await h.clip();
    const args: Args = { file_token: v.file_token, ...(await h.creator({ file_token: v.file_token })), caption: "plain", hashtags: ["ai"], mentions: "maya", privacy_level: "SELF_ONLY" };
    const { j } = await h.call("publish_video", { ...args, confirmation_receipt: mintReceipt("publish_video", args, Date.now()) });
    expect(j.outcome).toBe("posted");
    expect(sentArgs("TIKTOK_UPLOAD_VIDEO").caption).toBe("plain");
  });

  test("a receipt signed over the words: the server reads 'Only me' and '0:01' the same way", async () => {
    const h = await harness();
    const v = await h.clip();
    const args: Args = { file_token: v.file_token, ...(await h.creator({ file_token: v.file_token })), caption: "c", privacy_level: "Only me", cover_ms: "0:01" };
    const { j } = await h.call("publish_video", { ...args, confirmation_receipt: mintReceipt("publish_video", args, Date.now()) });
    expect(j).toMatchObject({ outcome: "posted", privacy_level: "SELF_ONLY" });
    expect(sentArgs("TIKTOK_UPLOAD_VIDEO")).toMatchObject({ privacy_level: "SELF_ONLY", video_cover_timestamp_ms: 1000 });
  });

  test("refusals, nothing sent: folded past the limit, a dropped staged caption, a word for an option the creator lacks, a cover past the end", async () => {
    const h = await harness();
    const v = await h.clip();
    const base: Args = { file_token: v.file_token, ...(await h.creator({ file_token: v.file_token })), caption: "c", privacy_level: "SELF_ONLY" };
    const before = mock.executes().length;
    // Folding pushed it over 2,200: the card showed "over", and the server refuses as it always has.
    const long = clicked("publish_video", { ...base, caption: "x".repeat(2195), hashtags: ["ai", "tech"] });
    expect((await h.call("publish_video", long.sent)).j).toMatchObject({ nothing_sent: true, error: { code: "CAPTION_TOO_LONG" } });
    // VoiceOS dropped the staged caption (the click came with the model's): the receipt doesn't match, and the server never folds.
    const folded = clicked("publish_video", { ...base, hashtags: ["ai"] });
    const dropped = await h.call("publish_video", { ...folded.sent, caption: "c", hashtags: ["ai"] });
    expect(dropped.j).toMatchObject({ nothing_sent: true, error: { code: "CONFIRMATION_REQUIRED", reason: "mismatch" } });
    // Signed over a word for an audience this account doesn't have: the code is checked like any other.
    const wide = { ...base, privacy_level: "everyone" };
    const widened = await h.call("publish_video", { ...wide, confirmation_receipt: mintReceipt("publish_video", wide, Date.now()) });
    expect(widened.j).toMatchObject({ nothing_sent: true, error: { code: "PRIVACY_MISMATCH", chosen: "PUBLIC_TO_EVERYONE" } });
    // The 2-second fixture has no frame at 0:05; an unreadable cover is refused too.
    for (const cover_ms of ["0:05", "soon"]) {
      const c = clicked("publish_video", { ...base, cover_ms });
      expect((await h.call("publish_video", c.sent)).j).toMatchObject({ nothing_sent: true, error: { code: "INVALID_PARAM" } });
    }
    expect(mock.executes().length).toBe(before);
  });
});
