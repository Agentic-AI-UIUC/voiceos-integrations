/**
 * The persisted ledger (src/ledger.ts) and the two reads that answer from it: fetch_publish_status finding
 * the send the user means ("the voice clone carousel") and list_videos' via_voiceos section ("what did I post
 * today?" when every post is Only me). Temp state folders and a recording fake Composio only.
 */
import { afterAll, afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as cards from "../src/cards.ts";
import { loadConfig } from "../src/config.ts";
import { INTERRUPTED, LEDGER_FILE, LEDGER_MAX_AGE_MS, LEDGER_SIZE, Ledger, matchAbout, parseAbout, type NewLedgerEntry } from "../src/ledger.ts";
import { createDeps, type Deps } from "../src/mcpServer.ts";
import { parseResult } from "../src/results.ts";
import { ChannelMemo, REFRESH_MAX, fetchPublishStatus, listVideos } from "../src/tools/reads.ts";
import type { ToolExtra } from "../src/tools.ts";
import type { LedgerEntry, LedgerStage, PublishStatus } from "../src/types.ts";

const ROOT = mkdtempSync(join(tmpdir(), "tiktok-status-"));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));
afterEach(() => mock.restore());

/** Local noon, so "today" and "yesterday" mean the same in every time zone the suite runs in. */
const NOON = new Date(2026, 10, 6, 12, 0, 0).getTime();
const MIN = 60_000;
const DAY = 86_400_000;

function clockAt(t = NOON) {
  const c = { t, now: () => c.t, sleep: async (ms: number) => void (c.t += ms), set: (ms: number) => void (c.t = ms) };
  return c;
}

let dirs = 0;
const stateFile = () => join(ROOT, `s${++dirs}`, LEDGER_FILE);

const video = (name: string, o: Partial<NewLedgerEntry> = {}): NewLedgerEntry => ({
  tool: "publish_video",
  kind: "video",
  mode: "direct",
  media: { names: [name], count: 1, folder: "Tiny AI Lab", duration_sec: 42 },
  details: { caption: `${name.replace(/\.mp4$/, "").replace(/-/g, " ")} #ai #fyp`, privacy_level: "SELF_ONLY", is_aigc: true },
  ...o,
});
const carousel = (folder: string, n = 11, o: Partial<NewLedgerEntry> = {}): NewLedgerEntry => ({
  tool: "post_photos",
  kind: "photos",
  mode: "direct",
  media: { names: Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(2, "0")}.png`), count: n, folder, cover_index: 0 },
  details: { title: "Voice cloning: 5 safety rules", description: "save this", privacy_level: "SELF_ONLY" },
  thumbs: ["data:image/jpeg;base64,/9j/T0"],
  ...o,
});
const refusedVideo = (): NewLedgerEntry => ({ tool: "upload_video", kind: "video", mode: "drafts", media: { names: [], count: 0 }, details: {} });

/** Record a send at `at`, moved to `stage` (done ones get TikTok's final status), with a publish_id unless refused. */
function send(l: Ledger, c: ReturnType<typeof clockAt>, e: NewLedgerEntry, at: number, stage: LedgerStage = "done", extra: Partial<{ error_code: string; last_status: PublishStatus }> = {}): LedgerEntry {
  const keep = c.t;
  c.set(at);
  const s = l.start(e);
  const refused = e.media.count === 0;
  const pid = refused || stage === "staging" ? undefined : `${e.kind === "video" ? "v_pub" : "p_pub"}_${s.task_id}`;
  const last: PublishStatus | undefined = stage === "done" ? (e.mode === "drafts" ? "SEND_TO_USER_INBOX" : "PUBLISH_COMPLETE") : undefined;
  l.update(s.task_id, { stage, ...(pid ? { publish_id: pid } : {}), ...(last ? { last_status: last } : {}), ...(refused ? { error_code: "CONFIRMATION_REQUIRED" } : {}), ...extra });
  c.set(keep);
  return l.get(s.task_id)!;
}

// ---------------------------------------------------------------------------
// A recording Composio and just enough of Deps for the two reads
// ---------------------------------------------------------------------------

function fakeDeps(ledger: Ledger, clock: ReturnType<typeof clockAt>, o: { statuses?: Record<string, string>; videos?: unknown[]; bucket?: number; running?: string[] } = {}) {
  const execs: Array<{ slug: string; args: any }> = [];
  let tokens = o.bucket ?? 25;
  const deps = {
    clock,
    ledger,
    channel: new ChannelMemo(),
    limits: { status: { tryTake: () => (tokens > 0 ? (tokens--, true) : false) } },
    jobs: { isRunning: (id: string) => (o.running ?? []).includes(id) },
    images: { dataUri: async () => undefined, many: async () => ({}) },
    client: {
      assertAccount: async () => "ca_test",
      exec: async (slug: string, args: any) => {
        execs.push({ slug, args });
        if (slug === "TIKTOK_LIST_VIDEOS") return { videos: o.videos ?? [], has_more: false };
        if (slug === "TIKTOK_FETCH_PUBLISH_STATUS") {
          const id = String(args.publish_id);
          return { status: o.statuses?.[id] ?? (id.startsWith("v_pub") || id.startsWith("p_pub") ? "PUBLISH_COMPLETE" : "SEND_TO_USER_INBOX"), fail_reason: "" };
        }
        throw new Error(`no responder for ${slug}`);
      },
    },
  } as unknown as Deps;
  const call = async (fn: typeof fetchPublishStatus, args: Record<string, unknown> = {}) => {
    const r = await fn(args, deps, {} as ToolExtra);
    const j = parseResult(r);
    return { r, j, blocks: j._voiceos_glance?.blocks ?? [] };
  };
  return { deps, execs, call, left: () => tokens };
}

const noLog = () => {
  const lines: string[] = [];
  spyOn(console, "error").mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
  return lines;
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

describe("the ledger on disk", () => {
  test("round-trips through a restart: names, folder, settings and clipped text; no pictures, paths or tokens", () => {
    const file = stateFile();
    const c = clockAt();
    const a = new Ledger(c, { file });
    const long = `${"word ".repeat(60)}#ai`;
    const v = send(a, c, video("ep05-enigma-recipe.mp4", { details: { caption: long, privacy_level: "SELF_ONLY", is_aigc: true } }), NOON - 30 * MIN);
    a.update(v.task_id, { poster: "data:image/jpeg;base64,/9j/POSTER", caption_copied: true });
    const p = send(a, c, carousel("voice clone safety slides"), NOON - 10 * MIN);
    // The in-memory copy keeps the full caption and the pictures.
    expect(a.get(v.task_id)!.details.caption).toBe(long);
    expect(a.get(v.task_id)!.poster).toBe("data:image/jpeg;base64,/9j/POSTER");

    const text = readFileSync(file, "utf8");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    if (process.platform !== "win32") expect(statSync(join(file, "..")).mode & 0o777).toBe(0o700);
    expect(text).not.toContain("data:image");
    expect(text).not.toContain(ROOT);
    expect(text).not.toContain("/");
    expect(JSON.parse(text).version).toBe(1);

    const b = new Ledger(c, { file });
    expect(b.size).toBe(2);
    const v2 = b.get(v.task_id)!;
    expect(v2).toMatchObject({ tool: "publish_video", kind: "video", mode: "direct", stage: "done", publish_id: v.publish_id, last_status: "PUBLISH_COMPLETE" });
    expect(v2.media).toEqual({ names: ["ep05-enigma-recipe.mp4"], count: 1, folder: "Tiny AI Lab", duration_sec: 42 });
    expect(v2.details).toMatchObject({ privacy_level: "SELF_ONLY", is_aigc: true, caption_copied: true });
    expect(v2.details.caption!.length).toBe(150);
    expect(v2.details.caption!.endsWith("…")).toBe(true);
    expect(v2.poster).toBeUndefined();
    expect(b.get(p.task_id)!.media).toMatchObject({ folder: "voice clone safety slides", count: 11, cover_index: 0 });
    expect(b.get(p.task_id)!.thumbs).toBeUndefined();
    expect(b.byPublishId(p.publish_id!)!.task_id).toBe(p.task_id);
    expect(b.list().map((e) => e.task_id)).toEqual([p.task_id, v.task_id]);
  });

  test("a path that sneaks into a name is cut to its last part on disk", () => {
    const file = stateFile();
    const c = clockAt();
    const l = new Ledger(c, { file });
    l.start(video("clip.mp4", { media: { names: ["/Users/maya/Movies/secret/clip.mp4"], count: 1, folder: "/Users/maya/Movies/secret" }, details: { caption: "hi" } }));
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain("/Users");
    expect(new Ledger(c, { file }).latest()!.media).toMatchObject({ names: ["clip.mp4"], folder: "secret" });
  });

  test("so is a real path on this platform (C:\\Users\\… on Windows)", () => {
    const file = stateFile();
    const c = clockAt();
    const folder = resolve("Movies", "secret");
    new Ledger(c, { file }).start(video("clip.mp4", { media: { names: [join(folder, "clip.mp4")], count: 1, folder }, details: { caption: "hi" } }));
    expect(readFileSync(file, "utf8")).not.toContain(JSON.stringify(folder).slice(1, -1));
    expect(new Ledger(c, { file }).latest()!.media).toMatchObject({ names: ["clip.mp4"], folder: "secret" });
  });

  test("a corrupt file starts an empty ledger, logged by name only, and the next save repairs it", () => {
    const file = stateFile();
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, '{"version":1,"entries":[{"caption":"secret words"');
    const logs = noLog();
    const c = clockAt();
    const l = new Ledger(c, { file });
    expect(l.size).toBe(0);
    expect(logs.join("\n")).toContain("ledger.json isn't valid JSON");
    expect(logs.join("\n")).not.toContain("secret");
    l.start(video("a.mp4"));
    expect(JSON.parse(readFileSync(file, "utf8")).entries).toHaveLength(1);
  });

  test("malformed entries are dropped and counted; the good ones load", () => {
    const file = stateFile();
    const c = clockAt();
    const a = new Ledger(c, { file });
    send(a, c, video("good.mp4"), NOON - MIN);
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.entries.push({ task_id: "t_000000000000", tool: "rm -rf", kind: "video", mode: "direct", stage: "done", created_at: "x", media: { names: [], count: 0 } });
    raw.entries.push("nope", null, { ...raw.entries[0] }); // a duplicate id too
    writeFileSync(file, JSON.stringify(raw));
    const logs = noLog();
    const b = new Ledger(c, { file });
    expect(b.size).toBe(1);
    expect(logs.join("\n")).toContain("ignored 4 unreadable entries in ledger.json");
    expect(logs.join("\n")).not.toContain("rm -rf");
  });

  test(`keeps the last ${LEDGER_SIZE} entries for 30 days`, () => {
    const file = stateFile();
    const c = clockAt();
    const a = new Ledger(c, { file });
    send(a, c, video("ancient.mp4"), NOON - LEDGER_MAX_AGE_MS - MIN);
    send(a, c, video("old-but-kept.mp4"), NOON - LEDGER_MAX_AGE_MS + 60 * MIN);
    expect(new Ledger(c, { file }).list().map((e) => e.media.names[0])).toEqual(["old-but-kept.mp4"]);
    for (let i = 0; i < LEDGER_SIZE + 5; i++) send(a, c, video(`clip${i}.mp4`), NOON - (LEDGER_SIZE + 5 - i) * MIN);
    const b = new Ledger(c, { file });
    expect(b.size).toBe(LEDGER_SIZE);
    expect(b.latest()!.media.names).toEqual([`clip${LEDGER_SIZE + 4}.mp4`]);
    expect(b.list().at(-1)!.media.names).toEqual(["clip5.mp4"]);
    // A month later the whole file has aged out.
    c.set(NOON + LEDGER_MAX_AGE_MS + DAY);
    expect(new Ledger(c, { file }).size).toBe(0);
  });

  test("a write cut off by a restart: staging → not sent (interrupted), uploading → not confirmed, processing keeps its id", () => {
    const file = stateFile();
    const c = clockAt();
    const a = new Ledger(c, { file });
    const s = send(a, c, video("staging.mp4"), NOON - 3 * MIN, "staging");
    const u = a.start(video("uploading.mp4"));
    a.update(u.task_id, { stage: "uploading" });
    const p = send(a, c, video("processing.mp4"), NOON - MIN, "processing");
    const b = new Ledger(c, { file });
    expect(b.get(s.task_id)).toMatchObject({ stage: "failed", error_code: INTERRUPTED });
    expect(b.get(u.task_id)).toMatchObject({ stage: "unknown", error_code: "OUTCOME_UNKNOWN" });
    expect(b.get(p.task_id)).toMatchObject({ stage: "processing", publish_id: p.publish_id });
  });

  test("two servers on one file keep each other's entries", () => {
    const file = stateFile();
    const c = clockAt();
    const a = new Ledger(c, { file });
    const b = new Ledger(c, { file });
    const x = a.start(video("from-a.mp4"));
    const y = b.start(video("from-b.mp4"));
    a.update(x.task_id, { stage: "processing", publish_id: "v_pub_x" });
    // a's save merged b's entry in (it's still b's to move along).
    expect(a.get(y.task_id)!.stage).toBe("staging");
    b.update(y.task_id, { stage: "processing", publish_id: "v_pub_y" });
    const fresh = new Ledger(c, { file });
    expect(fresh.list().map((e) => e.media.names[0]).sort()).toEqual(["from-a.mp4", "from-b.mp4"]);
    expect(fresh.get(x.task_id)!.publish_id).toBe("v_pub_x");
    expect(fresh.get(y.task_id)!.publish_id).toBe("v_pub_y");
    // A newer copy on disk wins over an older one in memory.
    a.update(x.task_id, { last_status: "PROCESSING_UPLOAD" });
    expect(a.get(y.task_id)!.publish_id).toBe("v_pub_y");
  });

  test.skipIf(process.platform === "win32")("a save that fails is logged once and never throws: the ledger keeps working in memory", () => {
    const dir = join(ROOT, `ro${++dirs}`);
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o500);
    const logs = noLog();
    const c = clockAt();
    const l = new Ledger(c, { file: join(dir, "sub", LEDGER_FILE) });
    const e = l.start(video("a.mp4"));
    l.update(e.task_id, { stage: "processing", publish_id: "v_pub_1" });
    chmodSync(dir, 0o700);
    expect(l.get(e.task_id)!.publish_id).toBe("v_pub_1");
    if (process.getuid?.() !== 0) expect(logs.filter((x) => x.includes("couldn't save ledger.json"))).toHaveLength(1);
    expect(logs.join("\n")).not.toContain(ROOT);
  });

  test("createDeps persists the ledger in the state folder, next to spent-receipts.json", () => {
    const state = join(ROOT, `cfg${++dirs}`);
    const cfg = loadConfig({}, ["--composio-base-url=http://127.0.0.1:9/api/v3.1", `--state-dir=${state}`, `--home=${ROOT}`]);
    const deps = createDeps(cfg, { clock: clockAt() });
    expect(existsSync(join(state, LEDGER_FILE))).toBe(false); // nothing on disk until something is sent
    deps.ledger.start(video("a.mp4"));
    expect(existsSync(join(state, LEDGER_FILE))).toBe(true);
    expect(createDeps(cfg, { clock: clockAt() }).ledger.latest()!.media.names).toEqual(["a.mp4"]);
  });
});

// ---------------------------------------------------------------------------
// Matching the user's words
// ---------------------------------------------------------------------------

/** The owner's morning: videos as Only me, the 11-photo carousel, then a refused "approve" for a draft. */
function morning(file?: string) {
  const c = clockAt();
  const l = new Ledger(c, file ? { file } : {});
  const names = ["ai-history-speedrun.mp4", "ep05-enigma-recipe.mp4", "prompt-glow-up.mp4", "voice-on-the-phone.mp4", "ai-data-center-power-final.mp4"];
  const vids = names.map((n, i) => send(l, c, video(n), NOON - (120 - i * 10) * MIN));
  const slides = send(l, c, carousel("voice clone safety slides"), NOON - 20 * MIN);
  const refused = send(l, c, refusedVideo(), NOON - 5 * MIN, "failed");
  return { c, l, vids, slides, refused };
}

describe("matchAbout: the user's words → the send", () => {
  test("parses kind, drafts, day, order and the naming words", () => {
    expect(parseAbout("did the voice clone carousel go thru yet")).toMatchObject({ words: ["voice", "clone"], kind: "photos", plural: false });
    expect(parseAbout("my last photo post")).toMatchObject({ words: [], kind: "photos", order: "latest" });
    expect(parseAbout("today's posts")).toMatchObject({ words: [], day: "today", plural: true });
    expect(parseAbout("the draft from last night")).toMatchObject({ words: [], drafts: true, day: "yesterday" });
    expect(parseAbout("the 11 photo one")).toMatchObject({ count: 11, kind: "photos", words: [] });
    expect(parseAbout("the one before that").order).toBe("previous");
  });

  test("'the voice clone carousel' is the carousel, not the voice video or the newer refused draft", () => {
    const { c, l, slides } = morning();
    const m = matchAbout("the voice clone carousel", l.list(), c.now());
    expect(m.entries.map((e) => e.task_id)).toEqual([slides.task_id]);
    // Without the kind word the folder's two words still beat the video's one.
    expect(matchAbout("voice clone", l.list(), c.now()).entries.map((e) => e.task_id)).toEqual([slides.task_id]);
    // A misremembered kind still finds it by name.
    expect(matchAbout("the voice clone video", l.list(), c.now()).entries.map((e) => e.task_id)).toEqual([slides.task_id]);
  });

  test("typos and word forms: 'the enigma recipie one', 'voice cloning slides', 'ep 5'", () => {
    const { c, l, vids, slides } = morning();
    expect(matchAbout("the enigma recipie one", l.list(), c.now()).entries.map((e) => e.task_id)).toEqual([vids[1].task_id]);
    expect(matchAbout("voice cloning slides", l.list(), c.now()).entries.map((e) => e.task_id)).toEqual([slides.task_id]);
    expect(matchAbout("ep 5", l.list(), c.now()).entries.map((e) => e.task_id)).toEqual([vids[1].task_id]);
    expect(matchAbout("the strawberry one", l.list(), c.now()).entries).toEqual([]);
  });

  test("'my last photo post', 'the latest video', 'the one before that', 'my first post today'", () => {
    const { c, l, vids, slides } = morning();
    expect(matchAbout("my last photo post", l.list(), c.now()).entries.map((e) => e.task_id)).toEqual([slides.task_id]);
    // The newest video is the refused attempt: the latest one that went is meant.
    expect(matchAbout("the latest video", l.list(), c.now()).entries.map((e) => e.task_id)).toEqual([vids[4].task_id]);
    expect(matchAbout("the video before that", l.list(), c.now()).entries.map((e) => e.task_id)).toEqual([vids[3].task_id]);
    expect(matchAbout("my first post today", l.list(), c.now()).entries.map((e) => e.task_id)).toEqual([vids[0].task_id]);
  });

  test("'today's posts' lists everything that went today; 'yesterday' with nothing then says so", () => {
    const { c, l, vids, slides } = morning();
    const today = matchAbout("today's posts", l.list(), c.now());
    expect(today.plural).toBe(true);
    expect(today.entries.map((e) => e.task_id)).toEqual([slides, ...vids].map((e) => e.task_id).sort((a, b) => (l.get(b)!.created_at > l.get(a)!.created_at ? 1 : -1)));
    expect(today.entries).toHaveLength(6); // the refused attempt is left out
    const y = matchAbout("what did I post yesterday", l.list(), c.now());
    expect(y).toMatchObject({ entries: [], empty_period: true });
  });

  test("the same video sent twice is a toss-up: both come back", () => {
    const c = clockAt();
    const l = new Ledger(c);
    const draft = send(l, c, video("ep05-enigma-recipe.mp4", { tool: "upload_video", mode: "drafts", details: {} }), NOON - 30 * MIN);
    const post = send(l, c, video("ep05-enigma-recipe.mp4"), NOON - 10 * MIN);
    expect(matchAbout("the enigma one", l.list(), c.now()).entries.map((e) => e.task_id)).toEqual([post.task_id, draft.task_id]);
    // "the enigma draft" narrows it.
    expect(matchAbout("the enigma draft", l.list(), c.now()).entries.map((e) => e.task_id)).toEqual([draft.task_id]);
  });
});

// ---------------------------------------------------------------------------
// fetch_publish_status
// ---------------------------------------------------------------------------

describe("fetch_publish_status from the user's words", () => {
  test("live repro: 'did the voice clone carousel go thru yet' answers about the carousel, asking TikTok with its publish_id", async () => {
    const { c, l, slides } = morning();
    const { call, execs } = fakeDeps(l, c);
    const { j, blocks } = await call(fetchPublishStatus, { about: "the voice clone carousel" });
    expect(execs).toEqual([{ slug: "TIKTOK_FETCH_PUBLISH_STATUS", args: { publish_id: slides.publish_id } }]);
    expect(j).toMatchObject({ state: "posted", kind: "photos", count: 11, folder: "voice clone safety slides", privacy_label: "Only me" });
    expect(j.summary).toContain('It\'s up, set to Only me. That\'s "voice clone safety slides".');
    expect(blocks).toHaveLength(1);
  });

  test("without words it answers about the newest send that reached TikTok, with one clause about the newer refusal", async () => {
    const { c, l, slides } = morning();
    const { call, execs } = fakeDeps(l, c);
    const { j } = await call(fetchPublishStatus, {});
    expect(execs.map((e) => e.args.publish_id)).toEqual([slides.publish_id]);
    expect(j).toMatchObject({ state: "posted", folder: "voice clone safety slides", newer_not_sent: { what: "video draft", error_code: "CONFIRMATION_REQUIRED" } });
    expect(j.summary).toContain("Also: a newer video draft attempt 5 min ago wasn't sent (it needs the card's button clicked, a yes in words sends nothing).");
    expect(j.summary.match(/Also:/g)).toHaveLength(1);
  });

  test("a send cut off by a restart is reported as not sent, in plain words, from the ledger alone", async () => {
    const file = stateFile();
    const c = clockAt();
    const a = new Ledger(c, { file });
    send(a, c, video("ai-data-center-power-final.mp4"), NOON - 2 * MIN, "staging");
    const { call, execs } = fakeDeps(new Ledger(c, { file }), c);
    const { j } = await call(fetchPublishStatus, { about: "the data center one" });
    expect(execs).toEqual([]);
    expect(j).toMatchObject({ state: "failed", stage: "failed" });
    expect(j.summary).toContain("restarted the TikTok tools while this was still uploading, so it never reached TikTok");
  });

  test("several sends fit: a short list card naming them, open ones refreshed (one status call each, at most four)", async () => {
    const c = clockAt();
    const l = new Ledger(c);
    const sends = Array.from({ length: 6 }, (_, i) => send(l, c, video(`take-${i}.mp4`), NOON - (60 - i) * MIN, "processing"));
    const card = spyOn(cards, "sendsCard");
    const { call, execs } = fakeDeps(l, c);
    const { j, blocks } = await call(fetchPublishStatus, { about: "today's videos" });
    expect(execs.filter((e) => e.slug === "TIKTOK_FETCH_PUBLISH_STATUS")).toHaveLength(REFRESH_MAX);
    expect(j.state).toBe("several");
    expect(j.count).toBe(6);
    expect(j.sends.map((s: any) => s.mark)).toEqual(["Only me", "Only me", "Only me", "Only me", "Processing", "Processing"]);
    expect(j.summary).toStartWith("Through VoiceOS today: 4 videos posted as Only me (“take-5”, “take-4”, “take-3” and 1 more); 2 videos still uploading or processing (“take-1” and “take-0”).");
    expect(blocks).toHaveLength(1);
    expect(card.mock.calls[0][0]).toHaveLength(6);
    expect(card.mock.calls[0][0][0]).toMatchObject({ title: "take-5", kind: "video", mark: "Only me", state: "posted" });
    expect(l.get(sends[5].task_id)!.stage).toBe("done");
    expect(JSON.stringify({ ...j, _voiceos_glance: undefined })).not.toContain("data:image");
  });

  test("a refresh waits for the status bucket and skips a send its own write is still watching", async () => {
    const c = clockAt();
    const l = new Ledger(c);
    const watched = send(l, c, video("watched.mp4"), NOON - 3 * MIN, "processing");
    send(l, c, video("other.mp4"), NOON - 2 * MIN, "processing");
    const { call, execs } = fakeDeps(l, c, { bucket: 0, running: [watched.task_id] });
    const { j } = await call(fetchPublishStatus, { about: "today's posts" });
    expect(execs).toEqual([]);
    expect(j.sends.map((s: any) => s.mark)).toEqual(["Processing", "Processing"]);
  });

  test("the same video drafted and posted: both named, newest first, and the summary asks which", async () => {
    const c = clockAt();
    const l = new Ledger(c);
    send(l, c, video("ep05-enigma-recipe.mp4", { tool: "upload_video", mode: "drafts", details: {} }), NOON - 30 * MIN);
    send(l, c, video("ep05-enigma-recipe.mp4"), NOON - 10 * MIN);
    const { call } = fakeDeps(l, c);
    const { j } = await call(fetchPublishStatus, { about: "the enigma one" });
    expect(j.state).toBe("several");
    expect(j.summary).toBe(
      "2 sends fit that: “ep05-enigma-recipe” (video post, Only me, 10 min ago); “ep05-enigma-recipe” (video draft, In drafts, 30 min ago). Ask which one if it matters.",
    );
  });

  test("nothing fits: says so and lists the latest sends (no TikTok call)", async () => {
    const { c, l } = morning();
    const { call, execs } = fakeDeps(l, c);
    const { j } = await call(fetchPublishStatus, { about: "the strawberry tokens one" });
    expect(execs).toEqual([]);
    expect(j.state).toBe("no_match");
    expect(j.summary).toStartWith("Nothing sent through VoiceOS in the last 30 days fits that. The latest: “voice clone safety slides” (carousel post, Only me, 20 min ago);");
    const y = await call(fetchPublishStatus, { about: "yesterday's post" });
    expect(y.j.summary).toStartWith("Nothing was sent through VoiceOS yesterday.");
  });

  test("survives a restart: a new server answers from the file", async () => {
    const file = stateFile();
    const { slides } = morning(file);
    const c = clockAt(NOON + 5 * MIN);
    const { call } = fakeDeps(new Ledger(c, { file }), c);
    const { j } = await call(fetchPublishStatus, { about: "voice clone carousel" });
    expect(j).toMatchObject({ state: "posted", publish_id: slides.publish_id, title: "Voice cloning: 5 safety rules" });
  });
});

// ---------------------------------------------------------------------------
// list_videos: "what did I post today?"
// ---------------------------------------------------------------------------

describe("list_videos via_voiceos", () => {
  test("live repro: no public posts, but nine Only me videos and the carousel went through VoiceOS today", async () => {
    const c = clockAt();
    const l = new Ledger(c);
    for (let i = 0; i < 9; i++) send(l, c, video(`short-${i + 1}.mp4`), NOON - (200 - i * 15) * MIN);
    send(l, c, carousel("voice clone safety slides"), NOON - 20 * MIN);
    send(l, c, refusedVideo(), NOON - 5 * MIN, "failed");
    const card = spyOn(cards, "videoListCard");
    const { call, execs } = fakeDeps(l, c);
    const { j, blocks } = await call(listVideos, {});
    expect(execs.map((e) => e.slug)).toEqual(["TIKTOK_LIST_VIDEOS"]);
    expect(j.count).toBe(0);
    expect(j.via_voiceos).toHaveLength(10);
    expect(j.via_voiceos[0]).toMatchObject({ name: "voice clone safety slides", what: "carousel post", mark: "Only me", state: "posted", count: 11 });
    expect(j.via_voiceos[1]).toMatchObject({ name: "short-9", what: "video post", mark: "Only me", names: ["short-9.mp4"], is_aigc: true });
    expect(j.summary).toBe(
      "No public posts on TikTok (its list shows public posts only). Through VoiceOS today: 9 videos and 1 carousel posted as Only me (“voice clone safety slides”, “short-9”, “short-8” and 7 more).",
    );
    expect(blocks).toHaveLength(1);
    const media = card.mock.calls[0][2]!;
    expect(media.sends).toHaveLength(10);
    expect(media.sends![0]).toMatchObject({ kind: "photos", mark: "Only me", thumb: "data:image/jpeg;base64,/9j/T0" });
    expect(blocks[0].height).toBeLessThanOrEqual(420);
    expect(JSON.stringify({ ...j, _voiceos_glance: undefined })).not.toContain("data:image");
  });

  test("drafts, processing and failures are marked; earlier days get their own sentence; processing ones are refreshed", async () => {
    const c = clockAt();
    const l = new Ledger(c);
    send(l, c, video("old-draft.mp4", { tool: "upload_video", mode: "drafts", details: {} }), NOON - 2 * DAY);
    const p = send(l, c, video("still-going.mp4"), NOON - 30 * MIN, "processing");
    send(l, c, video("rejected.mp4"), NOON - 20 * MIN, "failed", { error_code: "CAPTION_FLAGGED" });
    const { call, execs } = fakeDeps(l, c, { statuses: { [p.publish_id!]: "PROCESSING_UPLOAD" } });
    const { j } = await call(listVideos, {});
    expect(execs.map((e) => e.slug).sort()).toEqual(["TIKTOK_FETCH_PUBLISH_STATUS", "TIKTOK_LIST_VIDEOS"]);
    expect(j.via_voiceos.map((s: any) => s.mark)).toEqual(["Failed", "Processing", "In drafts"]);
    expect(j.summary).toContain("Through VoiceOS today: 1 video still uploading or processing (“still-going”); 1 video failed or not sent (“rejected”).");
    expect(j.summary).toContain("Earlier this week: 1 video waiting in your TikTok inbox as drafts (“old-draft”).");
  });

  test("with public posts the summary covers both; a later page leaves the section out", async () => {
    const c = clockAt();
    const l = new Ledger(c);
    send(l, c, video("private-one.mp4"), NOON - 10 * MIN);
    const pub = { id: "7431000000000000001", video_description: "hello #fyp", create_time: Math.floor((NOON - DAY) / 1000), duration: 23, view_count: 120, like_count: 4, comment_count: 1, share_count: 0 };
    const { call } = fakeDeps(l, c, { videos: [pub, { ...pub, id: "7431000000000000002" }, { ...pub, id: "7431000000000000003" }] });
    const { j, blocks } = await call(listVideos, {});
    expect(j.summary).toBe("Your last 3 public posts, newest first: the newest has 120 views. Through VoiceOS today: 1 video posted as Only me (“private-one”).");
    expect(blocks[0].height).toBeLessThanOrEqual(420);
    const page2 = await call(listVideos, { cursor: 1 });
    expect(page2.j.via_voiceos).toBeUndefined();
  });

  test("nothing sent through VoiceOS: the list is as before", async () => {
    const c = clockAt();
    const { call } = fakeDeps(new Ledger(c), c);
    const { j } = await call(listVideos, {});
    expect(j.via_voiceos).toBeUndefined();
    expect(j.summary).toBe("No public posts yet. Private (Only me) posts and drafts don't show up here.");
  });
});

describe("the sends cards", () => {
  test("stay inside the notch with long names and many rows, escape names, and show the state pills", () => {
    const rows = Array.from({ length: 9 }, (_, i) => ({
      title: `<b>${"very long file name ".repeat(6)}${i}</b>`, kind: i % 2 ? ("photos" as const) : ("video" as const), count: 11, duration_sec: 42,
      started_at: new Date(NOON - i * MIN).toISOString(), mark: i % 3 ? "Only me" : "Processing", state: i % 3 ? ("posted" as const) : ("processing" as const),
    }));
    const w = cards.sendsCard(rows, NOON, { headline: "9 sends today" });
    expect(w.height).toBeLessThanOrEqual(420);
    expect(w.html).not.toContain("<b>very");
    expect(w.html).toContain("Showing 4 of 9");
    expect(w.html).toContain("Only me");
    const empty = cards.videoListCard({ videos: [], has_more: false }, NOON, { sends: rows });
    expect(empty.height).toBeLessThanOrEqual(420);
    expect(empty.html).toContain("No public posts yet");
    expect(empty.html).toContain("Private and drafts");
    expect(empty.html).not.toContain("Sent through VoiceOS");
  });
});
