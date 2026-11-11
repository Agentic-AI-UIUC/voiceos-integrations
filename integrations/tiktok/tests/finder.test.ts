/**
 * Describing a video in the user's own words (src/finderParse.ts), its metadata (src/media.ts mp4Details,
 * src/spotlight.ts), ranking and confidence (src/finderMatch.ts), the search itself (src/files.ts), what the
 * user points at (src/finderApps.ts), focus memory (src/session.ts), the handler and the numbered card.
 * Every macOS tool is faked; "now" is a fixed local time, so day words don't depend on the clock or zone.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { videoCandidatesCard } from "../src/cards.ts";
import { loadConfig } from "../src/config.ts";
import { findRecentImages, findRecentVideos } from "../src/files.ts";
import { usableVideo } from "../src/finderApps.ts";
import { factsOf, whichQuestion, whenLabel, rank } from "../src/finderMatch.ts";
import { parseDescribe } from "../src/finderParse.ts";
import { createDeps, type Deps } from "../src/mcpServer.ts";
import { mp4DetailsFromBuffer } from "../src/media.ts";
import { parseResult } from "../src/results.ts";
import { Session, focusFromWrite, spokenTitle } from "../src/session.ts";
import { parsePlist, quarantineAgents, spotlightMeta } from "../src/spotlight.ts";
import { findRecentVideosTool, queryCreatorInfo } from "../src/tools/helpers.ts";
import { writeHandler } from "../src/tools/writes.ts";
import type { Clock, FileRef, RunOptions, RunResult, Runner } from "../src/types.ts";
import { box, concat, ftyp, fullBox, mdat, moov, mp4, mvhd, put, tkhd, trak } from "./fixtures/media/fixtures.ts";

/** Thursday, November 5, 2026, 2:30 PM, in whatever zone the tests run in. */
const NOW = new Date(2026, 10, 5, 14, 30).getTime();
const MIN = 60_000;
const H = 60 * MIN;
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();
const clock: Clock = { now: () => NOW, sleep: async () => {} };
const temps: string[] = [];
const tempDir = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A fake Mac: date added (JXA), mdls, xattr, Finder/QuickTime AppleScript, open -R
// ---------------------------------------------------------------------------

type Spot = Record<string, string | number | string[] | Date>;
interface MacOpts {
  added: Record<string, number>;
  spot?: Record<string, Spot>;
  agents?: Record<string, string>;
  finder?: string | { code: number; stderr: string };
  quicktime?: string;
  mdlsFails?: boolean;
}
interface MacRunner extends Runner {
  calls: string[][];
  count(tool: string): number;
}

function plistOf(paths: string[], spot: Record<string, Spot>): string {
  const val = (v: unknown): string =>
    v instanceof Date
      ? `<date>${v.toISOString().replace(/\.\d+Z$/, "Z")}</date>`
      : Array.isArray(v)
        ? `<array>${v.map(val).join("")}</array>`
        : typeof v === "number"
          ? `<real>${v}</real>`
          : `<string>${String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;")}</string>`;
  const dicts = paths.map((p) => {
    const d = spot[p];
    if (!d) return "<dict/>";
    return `<dict>${Object.entries(d).map(([k, v]) => `<key>${k}</key>${val(v)}`).join("")}</dict>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n<array>${dicts.join("")}</array>\n</plist>\n`;
}

function mac(o: MacOpts): MacRunner {
  const calls: string[][] = [];
  const done = (stdout: string, code = 0, stderr = ""): RunResult => ({ code, stdout, stderr, timedOut: false });
  const fn = (async (cmd: string[], _opts?: RunOptions): Promise<RunResult> => {
    calls.push([...cmd]);
    const tool = basename(cmd[0] ?? "");
    if (tool === "osascript") {
      if (cmd[1] === "-l") return done(JSON.stringify(cmd.slice(5).map((p) => o.added[p] ?? null)));
      const script = cmd[2] ?? "";
      if (script.includes('tell application "Finder"')) {
        if (typeof o.finder === "object") return done("", o.finder.code, o.finder.stderr);
        return done(o.finder ?? "");
      }
      if (script.includes("QuickTime Player")) return done(o.quicktime ?? "NOT_RUNNING");
      return done("", 1, "unexpected script");
    }
    if (tool === "mdls") {
      if (o.mdlsFails) return done("", 1, "could not find");
      const i = cmd.lastIndexOf("-name");
      return done(plistOf(cmd.slice(i + 2), o.spot ?? {}));
    }
    if (tool === "xattr") {
      const paths = cmd.slice(3);
      const lines = paths.filter((p) => o.agents?.[p]).map((p) => `${paths.length === 1 ? "" : `${p}: `}0083;6a66b1d7;${o.agents![p]};`);
      return done(lines.join("\n") + (lines.length ? "\n" : ""), lines.length === paths.length ? 0 : 1);
    }
    if (tool === "open") return done("");
    return done("", 127, "not faked");
  }) as MacRunner;
  fn.calls = calls;
  fn.count = (t) => calls.filter((c) => basename(c[0] ?? "") === t).length;
  return fn;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe("parseDescribe: the user's words → constraints", () => {
  const p = (s: string) => parseDescribe(s, NOW);

  test("days and parts of days, in local time", () => {
    expect(p("the vertical one from yesterday").time).toMatchObject({ from: at(4, 0), to: at(5, 0), label: "yesterday" });
    expect(p("the one I recorded this morning").time).toMatchObject({ from: at(5, 5), to: at(5, 12), label: "this morning" });
    expect(p("the one from last night").time).toMatchObject({ from: at(4, 17), to: at(5, 5) });
    expect(p("the clip from monday").time).toMatchObject({ from: at(2, 0), to: at(3, 0), label: "Monday" });
    expect(p("last thursday").time).toMatchObject({ from: new Date(2026, 9, 29).getTime(), to: new Date(2026, 9, 30).getTime() });
    expect(p("the one from 3 days ago").time).toMatchObject({ from: at(2, 0), to: at(3, 0) });
    expect(p("the clip from Nov 3").time).toMatchObject({ from: at(3, 0), to: at(4, 0) });
    expect(p("the 3rd of november").time).toMatchObject({ from: at(3, 0) });
    expect(p("the long landscape clip from last week").time).toMatchObject({ from: new Date(2026, 9, 26).getTime(), to: at(2, 0) });
    const lw = p("from last week").time!;
    expect(new Date(lw.from).getDay()).toBe(1); // Monday
    expect(lw.to - lw.from).toBeGreaterThanOrEqual(7 * 24 * H - H);
    expect(p("just now").time).toBeUndefined(); // the newest first, not a time limit
    expect(p("the one from 9 pm").time).toMatchObject({ label: "yesterday around 9 PM" }); // 9 PM today hasn't happened yet
    expect(p("around 9:07 am").time).toMatchObject({ from: at(5, 9, 7) - 15 * MIN, to: at(5, 9, 7) + 15 * MIN });
    expect(p("about 2 hours ago").time!.from).toBeLessThan(NOW - 2 * H);
  });

  test("lengths: exact-ish, about, under/over, m:ss, words", () => {
    expect(p("the 40-second one").duration).toMatchObject({ target: 40, min: 35.2, max: 44.8 });
    expect(p("about 40 seconds").duration).toMatchObject({ target: 40, min: 30, max: 50 });
    expect(p("forty five second clip").duration).toMatchObject({ target: 45 });
    expect(p("under 30 seconds").duration).toEqual({ max: 30, label: "under 30 seconds" });
    expect(p("over a minute").duration).toMatchObject({ min: 60 });
    expect(p("the 1:12 one").duration).toMatchObject({ target: 72 });
    expect(p("a minute and a half long").duration).toMatchObject({ target: 90 });
    expect(p("half a minute").duration).toMatchObject({ target: 30 });
    expect(p("2 min").duration).toMatchObject({ target: 120 });
    expect(p("the long landscape clip").lengthPref).toBe("long");
    expect(p("the short one").lengthPref).toBe("short");
    expect(p("a short about AI").lengthPref).toBeUndefined();
  });

  test("shape, quality, sound, size", () => {
    expect(p("the vertical one").orientation).toBe("vertical");
    expect(p("the portrait video").orientation).toBe("vertical");
    expect(p("the horizontal clip").orientation).toBe("landscape");
    expect(p("the square one").orientation).toBe("square");
    expect(p("the 4K one").quality).toBe("4k");
    expect(p("the 1080p export").quality).toBe("1080p");
    expect(p("the one with no sound").audio).toBe("silent");
    expect(p("the silent clip").audio).toBe("silent");
    expect(p("the big 4k one")).toMatchObject({ sizePref: "big", quality: "4k" });
  });

  test("sources, sites and apps", () => {
    expect(p("my screen recording").sources).toEqual(["screen_recording"]);
    expect(p("the video from my iPhone").sources).toEqual(["phone"]);
    expect(p("the one I AirDropped").sources).toEqual(["airdrop"]);
    expect(p("the one I downloaded from YouTube")).toMatchObject({ sources: ["downloaded"], sites: ["youtube"] });
    expect(p("the clip I got on whatsapp").sites).toEqual(["whatsapp"]);
    expect(p("the CapCut export")).toMatchObject({ apps: ["capcut"], boost: true });
    expect(p("the one I made in final cut").apps).toEqual(["finalcut"]);
    expect(p("rendered with remotion").apps).toEqual(["remotion"]);
    // Where it's going isn't where it came from.
    expect(p("upload the latest tiktok to drafts").sites).toEqual([]);
    // A folder isn't a download.
    expect(p("the oldest one in Downloads")).toMatchObject({ folders: ["Downloads"], sources: [], order: { by: "added", dir: "asc", index: 1 } });
  });

  test("order, positions and references", () => {
    expect(p("the second newest").order).toMatchObject({ by: "added", dir: "desc", index: 2 });
    expect(p("second to last").order).toMatchObject({ index: 2 });
    expect(p("the longest video").order).toMatchObject({ by: "duration", dir: "desc" });
    expect(p("the biggest file on my desktop")).toMatchObject({ order: { by: "size" }, folders: ["Desktop"] });
    expect(p("the first one I recorded today").order).toMatchObject({ dir: "asc" });
    expect(p("the second one").listRef).toBe(2);
    expect(p("number 3").listRef).toBe(3);
    expect(p("#2").listRef).toBe(2);
    expect(p("the one before that").relative).toBe("before");
    expect(p("the other one").relative).toBe("other");
    expect(p("a different one").relative).toBe("other");
    for (const s of ["it", "that video", "the same one", "the one we just sent to drafts", "actually i want it to be a post", "make it a post instead"]) {
      expect(p(s).current).toBe("strong");
    }
    expect(p("that video from yesterday").current).toBe("soft");
    expect(p("the one before that").current).toBeUndefined();
  });

  test("'I downloaded' (no site named) is the Downloads folder; a named site or browser is a web download", () => {
    expect(p("uplod that vid i downlaoded to tiktok")).toMatchObject({ folders: ["Downloads"], sources: [], keywords: [], current: "soft" });
    expect(p("the one i just downloaded")).toMatchObject({ folders: ["Downloads"], sources: [] });
    expect(p("the one i just downloaded").time).toBeUndefined();
    expect(p("the one I downloaded off safari")).toMatchObject({ sources: ["downloaded"], folders: [] });
    expect(p("the clip i downloaded from youtube")).toMatchObject({ sources: ["downloaded"], sites: ["youtube"], folders: [] });
    expect(p("something i got from the internet").sources).toEqual(["downloaded"]);
  });

  test("Finder, QuickTime and reveal", () => {
    expect(p("the one I have selected in Finder").finder).toBe(true);
    expect(p("the video open in QuickTime").quicktime).toBe(true);
    expect(p("the one I exported with QuickTime")).toMatchObject({ apps: ["quicktime"] });
    expect(p("the one I exported with QuickTime").quicktime).toBeUndefined();
    expect(p("show me that video in Finder")).toMatchObject({ reveal: true, current: "strong" });
    expect(p("show me that video in Finder").finder).toBeUndefined();
    expect(p("where is it saved")).toMatchObject({ reveal: true, current: "strong" });
  });

  test("typos and leftover keywords", () => {
    expect(p("the yesterady vertcal one")).toMatchObject({ orientation: "vertical", corrections: [["yesterady", "yesterday"], ["vertcal", "vertical"]] });
    expect(p("vid from yday").time?.label).toBe("yesterday");
    expect(p("strawbery tokens").keywords).toEqual(["strawbery", "tokens"]);
    expect(p("ai data centre power").keywords).toEqual(["ai", "data", "centre", "power"]);
    expect(p("upload the video from downloads about strawbery tokens")).toMatchObject({ folders: ["Downloads"], keywords: ["strawbery", "tokens"] });
    expect(p("the one in the Tiny AI Lab folder").keywords).toEqual(["tiny", "ai", "lab"]);
    expect(p("").keywords).toEqual([]);
    expect(p("x".repeat(500)).keywords[0].length).toBeLessThanOrEqual(160);
  });
});

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

describe("metadata", () => {
  const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
  const u32 = (n: number) => {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n);
    return b;
  };
  const dataBox = (text: string) => box("data", u32(1), u32(0), new TextEncoder().encode(text));

  test("mp4Details: iTunes tags (Remotion/ffmpeg), audio track, codec", () => {
    const ilst = box("ilst", box("©nam", dataBox("AI history speedrun")), box("©too", dataBox("Lavf63.1.101")), box("©cmt", dataBox("Made with Remotion 4.0.540")));
    const meta = fullBox("meta", 0, 0, fullBox("hdlr", 0, 0, u32(0), ascii("mdir"), new Uint8Array(12), ascii("\0")), ilst);
    const buf = concat(ftyp(), moov(mvhd(0, 600, 600 * 42), trak(tkhd({ width: 1080, height: 1920 })), trak(tkhd({ width: 0, height: 0, trackId: 2 }), "soun"), box("udta", meta)), mdat(16));
    expect(mp4DetailsFromBuffer(buf)).toMatchObject({ duration_sec: 42, width: 1080, height: 1920, has_audio: true, title: "AI history speedrun", encoder: "Lavf63.1.101", comment: "Made with Remotion 4.0.540" });
    expect(mp4DetailsFromBuffer(mp4({ audio: false }))).toMatchObject({ has_audio: false });
  });

  test("mp4Details: QuickTime mdta keys (iPhone make/model, creation date, screen recordings' author)", () => {
    const key = (name: string) => concat(u32(8 + name.length), ascii("mdta"), ascii(name));
    const keys = fullBox("keys", 0, 0, u32(4), key("com.apple.quicktime.make"), key("com.apple.quicktime.model"), key("com.apple.quicktime.creationdate"), key("com.apple.quicktime.location.ISO6709"));
    const item = (i: number, text: string) => concat(u32(8 + 16 + text.length), u32(i), dataBox(text));
    const ilst = box("ilst", item(1, "Apple"), item(2, "iPhone 15 Pro"), item(3, "2026-07-26T17:59:45-0700"), item(4, "+37.8066-122.4307/"));
    const meta = box("meta", fullBox("hdlr", 0, 0, u32(0), ascii("mdta"), new Uint8Array(12), ascii("\0")), keys, ilst);
    const buf = concat(ftyp("qt  "), moov(mvhd(0, 600, 600 * 45), trak(tkhd({ width: 1920, height: 1080 })), meta), mdat(16));
    const d = mp4DetailsFromBuffer(buf);
    expect(d).toMatchObject({ make: "Apple", model: "iPhone 15 Pro", created_ms: Date.parse("2026-07-26T17:59:45-07:00") });
    expect(JSON.stringify(d)).not.toContain("37.8066"); // location is never read
  });

  test("Spotlight: one mdls -plist call for many files; a vanished file → one retry with the rest", async () => {
    const dir = tempDir("tiktok-spot-");
    const a = put(dir, "a.mp4", "x");
    const b = put(dir, "b.mov", "y");
    const r = mac({ added: {}, spot: { [a]: { kMDItemWhereFroms: ["https://rr3---sn.googlevideo.com/x", "https://www.youtube.com/watch?v=abc"], kMDItemUserTags: ["Red"], kMDItemDurationSeconds: 37.5 } } });
    const m = await spotlightMeta([a, b], r);
    expect(r.count("mdls")).toBe(1);
    expect(m.get(a)).toMatchObject({ where_froms: ["https://rr3---sn.googlevideo.com/x", "https://www.youtube.com/watch?v=abc"], tags: ["Red"], duration_sec: 37.5 });
    expect(m.get(b)).toEqual({});
    const gone = await spotlightMeta([a, join(dir, "gone.mp4")], mac({ added: {}, mdlsFails: true }));
    expect(gone.size).toBe(0);
    expect(parsePlist("<plist><array><dict><key>k</key><string>a &amp; b</string></dict></array></plist>")).toEqual([{ k: "a & b" }]);
    expect(parsePlist("<plist><array><dict><key>k</key>")).toBeNull();
  });

  test("quarantine agents from one xattr call (AirDrop is sharingd)", async () => {
    const r = mac({ added: {}, agents: { "/x/a: b.mov": "sharingd", "/x/c.mp4": "Google Chrome" } });
    const m = await quarantineAgents(["/x/a: b.mov", "/x/c.mp4", "/x/none.mp4"], r);
    expect(r.count("xattr")).toBe(1);
    expect([...m.entries()]).toEqual([["/x/a: b.mov", "sharingd"], ["/x/c.mp4", "Google Chrome"]]);
    const one = await quarantineAgents(["/x/c.mp4"], r);
    expect(one.get("/x/c.mp4")).toBe("Google Chrome");
  });

  test("facts: sources, sites, apps and the descriptor", () => {
    const base = { name: "IMG_0840.MOV", folder: "Downloads", size: 10, addedMs: at(4, 21, 14) };
    const iphone = factsOf(base, { size: 10, width: 1080, height: 1920, duration_sec: 37, has_audio: true, make: "Apple", model: "iPhone 15 Pro" }, { agent: "sharingd" }, true);
    expect([...iphone.sources].sort()).toEqual(["airdrop", "phone"]);
    expect(iphone.sourceLabel).toBe("AirDropped from iPhone 15 Pro");
    expect(whenLabel(at(4, 21, 14), NOW)).toBe("yesterday 9:14 PM");
    const yt = factsOf({ ...base, name: "clip.mp4", folder: "Movies/Tiny AI Lab" }, { size: 10, width: 1080, height: 1920, duration_sec: 37, has_audio: true }, { spot: { where_froms: ["https://rr3---sn.googlevideo.com/x", "https://www.youtube.com/watch?v=1"] }, agent: "Safari" }, true);
    expect(yt.sites.has("youtube")).toBe(true);
    expect(yt.sourceLabel).toBe("downloaded from youtube.com");
    const fcp = factsOf({ ...base, name: "Demo - 4K.mov" }, { size: 10, width: 3840, height: 2160, duration_sec: 141, has_audio: false }, { agent: "Final Cut Pro" }, true);
    expect(fcp).toMatchObject({ quality: "4K", orientation: "landscape", sourceLabel: "made in Final Cut Pro" });
    const screen = factsOf({ ...base, name: "Screen Recording 2026-11-05 at 9.07.32 AM.mov" }, { size: 10, width: 3024, height: 1964, author: "ReplayKitRecording" }, undefined, false);
    expect(screen.sourceLabel).toBe("screen recording");
    const yesterdayYT = factsOf({ ...base, name: "clip.mp4", folder: "Movies/Tiny AI Lab" }, { size: 10, width: 1080, height: 1920, duration_sec: 37 }, { spot: { where_froms: ["https://www.youtube.com/watch?v=1"] } }, true);
    expect(yesterdayYT.sourceLabel).toBe("downloaded from youtube.com");
  });
});

// ---------------------------------------------------------------------------
// The search against a fixture home
// ---------------------------------------------------------------------------

describe("findRecentVideos with a description (fixture home, fake Mac)", () => {
  let home: string;
  const added: Record<string, number> = {};
  const spot: Record<string, Spot> = {};
  const agents: Record<string, string> = {};
  const p: Record<string, string> = {};
  const add = (rel: string, bytes: Uint8Array, addedMs: number) => {
    const path = put(home, rel, bytes, addedMs);
    added[path] = addedMs;
    p[basename(rel)] = path;
    return path;
  };
  beforeAll(() => {
    home = tempDir("tiktok-finder-home-");
    add("Downloads/ai history speedrun.mp4", mp4({ seconds: 42, width: 1080, height: 1920 }), at(5, 13, 0));
    add("Downloads/ai data center power final.mp4", mp4({ seconds: 43, width: 1080, height: 1920 }), at(5, 11, 0));
    add("Movies/Tiny AI Lab/ep01-strawberry-tokens.mp4", mp4({ seconds: 37, width: 1080, height: 1920 }), at(4, 21, 14));
    add("Movies/Tiny AI Lab/ep02-hallucinations.mp4", mp4({ seconds: 72, width: 1080, height: 1920 }), at(4, 15, 2));
    add("Desktop/Screen Recording 2026-11-03 at 9.07.32 PM.mov", mp4({ brand: "qt  ", seconds: 64, width: 3024, height: 1964, audio: false }), at(3, 21, 8));
    add("Downloads/IMG_0840.MOV", mp4({ brand: "qt  ", seconds: 45, width: 1920, height: 1080 }), at(2, 18, 0));
    add("Movies/The End of Oak Street.mp4", mp4({ seconds: 5984, width: 3840, height: 1600 }), at(1, 10, 0));
    add("Downloads/funny cat.mp4", mp4({ seconds: 15, width: 1080, height: 1080 }), at(5, 9, 30));
    spot[p["funny cat.mp4"]] = { kMDItemWhereFroms: ["https://rr1---sn.googlevideo.com/v", "https://www.youtube.com/watch?v=x"] };
    spot[p["IMG_0840.MOV"]] = { kMDItemAcquisitionMake: "Apple", kMDItemAcquisitionModel: "iPhone 15 Pro" };
    spot[p["ep01-strawberry-tokens.mp4"]] = { kMDItemUserTags: ["Purple"] };
    agents[p["IMG_0840.MOV"]] = "sharingd";
    agents[p["funny cat.mp4"]] = "Safari";
  });
  const find = (o: Partial<Parameters<typeof findRecentVideos>[0]> = {}) =>
    findRecentVideos({ home, limit: 5, runner: mac({ added, spot, agents, ...(o as any).mac }), clock, ...o });

  test("'the vertical one from yesterday': two fit → ambiguous, with one question naming the difference", async () => {
    const r = await find({ describe: "the vertical one from yesterday" });
    expect(r.confidence).toBe("ambiguous");
    expect(r.videos.map((v) => v.name)).toEqual(["ep01-strawberry-tokens.mp4", "ep02-hallucinations.mp4"]);
    expect(r.question).toBe("Which one: the 0:37 one from 9:14 PM, or the 1:12 one from 3:02 PM?");
    expect(r.videos.map((v) => v.rank)).toEqual([1, 2]);
    expect(r.videos[0].descriptor).toBe("vertical · 0:37 · added yesterday 9:14 PM · Movies › Tiny AI Lab");
  });

  test("'the 40-second one from yesterday' → exact", async () => {
    const r = await find({ describe: "the 40-second one from yesterday" });
    expect(r).toMatchObject({ confidence: "exact" });
    expect(r.videos.map((v) => v.name)).toEqual(["ep01-strawberry-tokens.mp4"]);
    expect(r.videos[0].why).toContain("0:37 long");
  });

  test("typos: 'strawbery tokens' and 'ai data centre power' each find one video", async () => {
    const s = await find({ describe: "upload the video from downloads about strawbery tokens" });
    expect(s.videos.map((v) => [v.name, v.folder])).toEqual([["ep01-strawberry-tokens.mp4", "Movies/Tiny AI Lab"]]);
    expect(s).toMatchObject({ found_elsewhere: true, query_fuzzy: true, confidence: "likely" });
    const c = await find({ describe: "ai data centre power" });
    expect(c.videos.map((v) => v.name)).toEqual(["ai data center power final.mp4"]);
    expect(c.confidence).toBe("likely"); // "centre" is a near spelling
  });

  test("a named folder doesn't hide the video; words that match nothing are set aside when more was said", async () => {
    const r = await find({ describe: "the vertical strawberry one from downloads" });
    expect(r.videos.map((v) => v.name)).toEqual(["ep01-strawberry-tokens.mp4"]);
    expect(r.found_elsewhere).toBe(true);
    const slip = await find({ describe: "the screen recordng pleez" });
    expect(slip.videos.map((v) => v.name)).toEqual(["Screen Recording 2026-11-03 at 9.07.32 PM.mov"]);
    const zebra = await find({ describe: "zebra crossing" });
    expect(zebra).toMatchObject({ confidence: "none", query_matched: false });
  });

  test("live repro: a name match is never hidden by source/folder (\"from downloads\" ≠ downloaded from the web)", async () => {
    const ep01 = ["ep01-strawberry-tokens.mp4"];
    // The owner's sentence.
    const owner = await find({ describe: "upload the video from downloads about strawbery tokens to tiktok" });
    expect(owner.videos.map((v) => v.name)).toEqual(ep01);
    expect(owner).toMatchObject({ confidence: "likely", found_elsewhere: true, requested_folders: ["Downloads"], query_matched: true });
    // 1. The model's source:"downloaded" with no folder: found by name, and says what didn't fit.
    const a = await find({ describe: "strawbery tokens", source: "downloaded" });
    expect(a.videos.map((v) => v.name)).toEqual(ep01);
    expect(a).toMatchObject({ confidence: "likely", by_name: true, unmet: ["downloaded from a website"] });
    // 2. source:"downloaded" next to the Downloads folder is the folder.
    const b = await find({ describe: "about strawbery tokens", folders: ["Downloads"], source: "downloaded" });
    expect(b.videos.map((v) => v.name)).toEqual(ep01);
    expect(b).toMatchObject({ confidence: "likely", found_elsewhere: true });
    // 3. The same with query.
    const c = await find({ query: "strawbery tokens", source: "downloaded", folders: ["Downloads"] });
    expect(c.videos.map((v) => v.name)).toEqual(ep01);
    expect(c).toMatchObject({ confidence: "likely", found_elsewhere: true, query_matched: true });
    // A real web-download constraint plus a folder: elsewhere and by name, with the miss reported.
    const d = await find({ describe: "strawbery tokens", folders: ["Downloads"], source: "web_download" });
    expect(d.videos.map((v) => v.name)).toEqual(ep01);
    expect(d).toMatchObject({ confidence: "likely", found_elsewhere: true, by_name: true, unmet: ["downloaded from a website"] });
    // Other constraints that don't fit re-rank, never hide: "the landscape strawberry one from monday".
    const e = await find({ describe: "the landscape strawberry one from monday" });
    expect(e.videos.map((v) => v.name)).toEqual(ep01);
    expect(e).toMatchObject({ confidence: "likely", by_name: true });
    expect(e.unmet).toEqual(["Monday", "landscape"]);
  });

  test("live repro #4: 'uplod that vid i downlaoded to tiktok' → the newest in Downloads, likely", async () => {
    const r = await find({ describe: "uplod that vid i downlaoded to tiktok" });
    expect(r).toMatchObject({ confidence: "likely", searched_folders: ["Downloads"] });
    expect(r.videos[0].name).toBe("ai history speedrun.mp4");
    const none = await find({ describe: "the one I downloaded from youtube", folders: ["Desktop"] });
    expect(JSON.stringify(none)).not.toMatch(/web.download/i);
  });

  test("copies that arrived together: ambiguous, one question naming them", async () => {
    const h = tempDir("tiktok-finder-batch-");
    const add: Record<string, number> = {};
    add[put(h, "Downloads/new hire sitcom final.mp4", mp4({ seconds: 41 }), at(5, 10))] = at(5, 10, 5);
    add[put(h, "Downloads/prompt glow up final.mp4", mp4({ seconds: 42 }), at(5, 10))] = at(5, 10, 5) - 3000;
    add[put(h, "Downloads/older.mp4", mp4({ seconds: 20 }), at(4, 10))] = at(4, 10);
    const r = await findRecentVideos({ home: h, limit: 5, runner: mac({ added: add }), clock, describe: "the video i just downloaded" });
    expect(r.confidence).toBe("ambiguous");
    expect(r.question).toBe("Which one: “new hire sitcom final”, or “prompt glow up final”?");
  });

  test("metadata sources: screen recording, iPhone/AirDrop, YouTube, 4K, no sound", async () => {
    expect((await find({ describe: "my screen recording" })).videos.map((v) => v.name)).toEqual(["Screen Recording 2026-11-03 at 9.07.32 PM.mov"]);
    const iphone = await find({ describe: "the video from my iPhone" });
    expect(iphone).toMatchObject({ confidence: "exact" });
    expect(iphone.videos[0]).toMatchObject({ name: "IMG_0840.MOV", source_label: "AirDropped from iPhone 15 Pro" });
    expect((await find({ describe: "the one I AirDropped" })).videos.map((v) => v.name)).toEqual(["IMG_0840.MOV"]);
    const yt = await find({ describe: "the one I downloaded from YouTube" });
    expect(yt.videos.map((v) => v.name)).toEqual(["funny cat.mp4"]);
    expect(yt.videos[0].descriptor).toContain("downloaded from youtube.com");
    expect((await find({ describe: "the 4K one" })).videos.map((v) => v.name)).toEqual(["The End of Oak Street.mp4"]);
    expect((await find({ describe: "the one with no sound" })).videos.map((v) => v.name)).toEqual(["Screen Recording 2026-11-03 at 9.07.32 PM.mov"]);
    // A Finder tag is a keyword too.
    expect((await find({ describe: "the purple one" })).videos.map((v) => v.name)).toEqual(["ep01-strawberry-tokens.mp4"]);
  });

  test("order: second newest, oldest in Downloads, longest; the long landscape clip from last week", async () => {
    expect((await find({ describe: "the second newest" })).videos.map((v) => v.name)).toEqual(["ai data center power final.mp4"]);
    const oldest = await find({ describe: "the oldest one in Downloads" });
    expect(oldest).toMatchObject({ confidence: "exact", searched_folders: ["Downloads"] });
    expect(oldest.videos[0].name).toBe("IMG_0840.MOV");
    expect((await find({ describe: "the longest video" })).videos[0].name).toBe("The End of Oak Street.mp4");
    const lw = await find({ describe: "the long landscape clip from last week" });
    expect(lw.videos[0].name).toBe("The End of Oak Street.mp4");
  });

  test("nothing fits: none, what's missing, the closest", async () => {
    const r = await find({ describe: "the vertical one from last month" });
    expect(r.confidence).toBe("none");
    expect(r.unmet).toEqual(["last month"]);
    expect(r.videos.length).toBeLessThanOrEqual(3);
  });

  test("structured fields: orientation, durations, dates and source", async () => {
    const r = await find({ orientation: "landscape", max_duration_sec: 100 });
    expect(r.videos.map((v) => v.name)).toEqual(["Screen Recording 2026-11-03 at 9.07.32 PM.mov", "IMG_0840.MOV"]);
    const d = await find({ added_after: at(5, 0), min_duration_sec: 40 });
    expect(d.videos.map((v) => v.name).sort()).toEqual(["ai data center power final.mp4", "ai history speedrun.mp4"]);
    expect((await find({ source: "downloaded" })).videos.map((v) => v.name)).toEqual(["funny cat.mp4"]);
  });

  test("Spotlight unavailable: name- and file-based facts still work; downloaded becomes unknown, not no", async () => {
    const r = await findRecentVideos({ home, limit: 5, runner: mac({ added, mdlsFails: true }), clock, describe: "my screen recording" });
    expect(r.videos[0].name).toBe("Screen Recording 2026-11-03 at 9.07.32 PM.mov");
    const dl = await findRecentVideos({ home, limit: 5, runner: mac({ added, mdlsFails: true }), clock, describe: "the one I downloaded" });
    expect(dl.confidence).not.toBe("exact");
  });

  test("Finder selection: a selected video outside the allowlist is accepted; folders and photos are skipped", async () => {
    const elsewhere = tempDir("tiktok-pointed-");
    const sel = put(elsewhere, "Projects/cut 3.mov", mp4({ brand: "qt  ", seconds: 12, width: 1080, height: 1920 }), NOW - H);
    const photo = put(elsewhere, "Projects/still.png", "png", NOW - H);
    const runner = mac({ added: { [sel]: NOW - H }, finder: `${sel}\n${photo}\n${elsewhere}/Projects/\n` });
    const r = await findRecentVideos({ home, limit: 5, runner, clock, describe: "the one I have selected in Finder" });
    expect(r).toMatchObject({ confidence: "exact", mode: "finder_selection", pointed: { app: "Finder", skipped: 2, count: 1 } });
    expect(r.videos[0]).toMatchObject({ name: "cut 3.mov", folder: "Projects" });
    const denied = await findRecentVideos({ home, limit: 5, runner: mac({ added, finder: { code: 1, stderr: "execution error: Not authorized to send Apple events to Finder. (-1743)" } }), clock, source: "finder_selection" });
    expect(denied).toMatchObject({ videos: [], confidence: "none", pointed: { failure: "automation_denied" } });
    const empty = await findRecentVideos({ home, limit: 5, runner: mac({ added, finder: "" }), clock, source: "finder_selection" });
    expect(empty).toMatchObject({ videos: [], pointed: { app: "Finder", count: 0 } });
    const qt = await findRecentVideos({ home, limit: 5, runner: mac({ added }), clock, describe: "the video open in QuickTime" });
    expect(qt).toMatchObject({ videos: [], pointed: { app: "QuickTime", failure: "not_running" } });
    expect(usableVideo(join(elsewhere, "Projects"))).toBe(false);
  });

  test("context: 'the second one' (card), 'it' (focus), 'the one before that', 'the other one'", async () => {
    const k = (name: string) => {
      const path = p[name];
      const st = statSync(path);
      return { path, name, folder: "Movies/Tiny AI Lab", size: st.size, mtimeMs: st.mtimeMs };
    };
    const shown = [k("ep01-strawberry-tokens.mp4"), k("ep02-hallucinations.mp4")];
    const second = await find({ describe: "the second one", context: { shown } });
    expect(second).toMatchObject({ confidence: "exact", mode: "list" });
    expect(second.videos[0].name).toBe("ep02-hallucinations.mp4");
    const it = await find({ pick: "current", context: { focus: shown[0] } });
    expect(it).toMatchObject({ confidence: "exact", mode: "current" });
    expect(it.videos[0]).toMatchObject({ name: "ep01-strawberry-tokens.mp4", in_progress: true });
    const before = await find({ describe: "the one before that", context: { focus: shown[0] } });
    expect(before.videos[0].name).toBe("ep02-hallucinations.mp4");
    const other = await find({ describe: "the other one", context: { focus: shown[0], shown } });
    expect(other.videos.map((v) => v.name)).toEqual(["ep02-hallucinations.mp4"]);
    const lost = await find({ describe: "that video" });
    expect(lost).toMatchObject({ confidence: "none", no_focus: true });
  });

  test("fast enough: a few batched calls, never one per file", async () => {
    const runner = mac({ added, spot, agents });
    const t = performance.now();
    await findRecentVideos({ home, limit: 5, runner, clock, describe: "the vertical one from yesterday" });
    expect(performance.now() - t).toBeLessThan(1500);
    expect(runner.calls.length).toBe(3); // date added, mdls, xattr
  });
});

// ---------------------------------------------------------------------------
// Ranking and the question
// ---------------------------------------------------------------------------

describe("ranking and the one question", () => {
  const f = (name: string, o: Partial<{ dur: number; w: number; h: number; added: number }>) =>
    factsOf({ name, folder: "Downloads", size: 1, addedMs: o.added ?? NOW - H }, { size: 1, duration_sec: o.dur, width: o.w, height: o.h }, undefined, false);

  test("the question names what differs: length and shape, else day, else names", () => {
    const a = f("a.mp4", { dur: 37, w: 1080, h: 1920, added: at(4, 21) });
    const b = f("b.mp4", { dur: 72, w: 1920, h: 1080, added: at(2, 15) });
    expect(whichQuestion([a, b], NOW)).toBe("Which one: the 0:37 vertical one from yesterday, or the 1:12 landscape one from Monday?");
    const c = f("intro take.mp4", { dur: 37, w: 1080, h: 1920, added: at(4, 21) });
    const d = f("intro take 2.mp4", { dur: 37, w: 1080, h: 1920, added: at(4, 21, 5) });
    expect(whichQuestion([c, d], NOW)).toBe("Which one: “intro take”, or “intro take 2”?");
    expect(whichQuestion([a], NOW)).toBe("");
  });

  test("a superlative picks one; a tie on it is ambiguous", () => {
    const d = parseDescribe("the longest one", NOW);
    const r = rank([{ item: 1, facts: f("x.mp4", { dur: 60 }) }, { item: 2, facts: f("y.mp4", { dur: 90 }) }], d, NOW);
    expect(r).toMatchObject({ confidence: "exact" });
    expect(r.ranked[0].item).toBe(2);
    const tie = rank([{ item: 1, facts: f("x.mp4", { dur: 60 }) }, { item: 2, facts: f("y.mp4", { dur: 60.2 }) }], d, NOW);
    expect(tie.confidence).toBe("ambiguous");
  });
});

// ---------------------------------------------------------------------------
// Focus memory and the handler
// ---------------------------------------------------------------------------

describe("focus memory", () => {
  const ref = (name: string): FileRef => ({ path: `/x/${name}`, name, folder: "Movies/Tiny AI Lab", size: 5, mtimeMs: 1, mime: "video/mp4", duration_sec: 37, width: 1080, height: 1920 });

  test("current(): a plain snapshot for the transcript hook (no path), expiring after 2 hours", () => {
    const s = new Session();
    s.setFocus(ref("ep01-strawberry_tokens.mp4"), "picked", NOW, { descriptor: "vertical · 0:37" });
    expect(s.current(NOW)).toEqual({ title: "ep01 strawberry tokens", folder: "Tiny AI Lab", duration_sec: 37, orientation: "vertical", descriptor: "vertical · 0:37", how: "picked", at: NOW });
    expect(JSON.stringify(s.current(NOW))).not.toContain("/x/");
    expect(s.current(NOW + 2 * H + 1)).toBeUndefined();
    expect(spokenTitle("Screen Recording 2026-11-03 at 9.07.32 PM.mov")).toBe("Screen Recording 2026-11-03 at 9.07.32 PM");
  });

  test("a write's intent sticks to the same file; a plain re-find keeps what happened to it", () => {
    const s = new Session();
    const deps = { session: s, tokens: { file: () => ref("a.mp4") }, clock };
    focusFromWrite(deps, "upload_video", { file_token: "ft1.x", caption: "  strawberry facts #ai " }, "refused");
    expect(s.current(NOW)).toMatchObject({ how: "draft_not_sent", mode: "draft", caption: "strawberry facts #ai" });
    s.setFocus(ref("a.mp4"), "picked", NOW + 1);
    expect(s.current(NOW + 1)).toMatchObject({ how: "draft_not_sent", caption: "strawberry facts #ai" });
    focusFromWrite(deps, "publish_video", { file_token: "ft1.x", privacy_level: "self_only", is_aigc: "true" }, "sent");
    expect(s.current(NOW)).toMatchObject({ how: "sent_post", mode: "post", privacy_level: "SELF_ONLY", is_aigc: true, caption: "strawberry facts #ai" });
    s.setFocus(ref("b.mp4"), "picked", NOW + 2);
    expect(s.current(NOW + 2)).toMatchObject({ title: "b", how: "picked" });
    expect(s.current(NOW + 2)?.caption).toBeUndefined();
    focusFromWrite({ ...deps, tokens: { file: () => { throw new Error("stale"); } } }, "upload_video", {}, "refused");
    expect(s.current(NOW + 2)?.title).toBe("b");
  });
});

describe("find_recent_videos handler: focus, reveal, card, errors", () => {
  let home: string;
  const added: Record<string, number> = {};
  beforeAll(() => {
    home = tempDir("tiktok-finder-tool-");
    for (const [rel, sec, w, h, t] of [
      ["Downloads/ai history speedrun.mp4", 42, 1080, 1920, at(5, 13)],
      ["Downloads/ai data center power final.mp4", 43, 1080, 1920, at(5, 11)],
      ["Movies/Tiny AI Lab/ep01-strawberry-tokens.mp4", 37, 1080, 1920, at(4, 21, 14)],
    ] as const) added[put(home, rel, mp4({ seconds: sec, width: w, height: h }), t)] = t;
  });
  const depsWith = (runner: Runner): Deps => {
    const cfg = loadConfig({ COMPOSIO_API_KEY: "k", COMPOSIO_CONNECTED_ACCOUNT_ID: "ca_test" }, ["--composio-base-url=http://127.0.0.1:9/api/v3.1", `--state-dir=${join(home, ".state")}`, `--home=${home}`]);
    return createDeps(cfg, { runner, clock, preview: async () => ({}) });
  };
  const call = async (deps: Deps, args: Record<string, unknown>) => parseResult(await findRecentVideosTool(args, deps, {}) as any);

  test("one clear match becomes the focus; pick 'current' brings it back with a fresh token", async () => {
    const deps = depsWith(mac({ added }));
    const a = await call(deps, { describe: "the speedrun one" });
    expect(a).toMatchObject({ confidence: "exact", count: 1 });
    expect(a.videos[0]).toMatchObject({ name: "ai history speedrun.mp4", best: true, rank: 1 });
    expect(a.next).toContain("show its card now");
    expect(a.next).toContain("ask which video only when confidence is ambiguous");
    expect(deps.session?.current?.(NOW)).toMatchObject({ title: "ai history speedrun", how: "picked" });
    const b = await call(deps, { pick: "current" });
    expect(b.videos[0]).toMatchObject({ name: "ai history speedrun.mp4", in_progress: true });
    expect(b.videos[0].file_token).not.toBe(a.videos[0].file_token);
    expect(b.summary).toContain("The video in progress: ai history speedrun.mp4");
    expect(JSON.stringify(b)).not.toContain(home);
  });

  test("'actually make it a post' after a refused draft: same video, last_intent carries the caption", async () => {
    const deps = depsWith(mac({ added }));
    const a = await call(deps, { describe: "ai data centre power" });
    const refused = parseResult(await writeHandler("upload_video")({ file_token: a.videos[0].file_token, caption: "AI eats power #ai" }, deps, {}) as any);
    expect(refused.outcome).toBe("refused");
    const b = await call(deps, { describe: "acctualli i want it to be apost" });
    expect(b).toMatchObject({ confidence: "exact", last_intent: { mode: "draft", outcome: "refused", caption: "AI eats power #ai" } });
    expect(b.videos[0].name).toBe("ai data center power final.mp4");
    expect(b.next).toContain("last_intent");
  });

  test("ambiguous: the question is in the data and on the card; 'the second one' then picks from that card", async () => {
    const deps = depsWith(mac({ added }));
    const a = await call(deps, { describe: "the vertical one from today" });
    expect(a.confidence).toBe("ambiguous");
    expect(a.question).toMatch(/^Which one: /);
    expect(a.next).toContain(a.question);
    const card = a._voiceos_glance.blocks[0];
    expect(card.html).toContain(a.question.replace(/'/g, "&#39;").slice(0, 20));
    expect(card.html).toContain('class="tt-pk-n">2<');
    expect(card.height).toBeLessThanOrEqual(420);
    const b = await call(deps, { describe: "the second one" });
    expect(b).toMatchObject({ confidence: "exact" });
    expect(b.videos[0].name).toBe(a.videos[1].name);
  });

  test("reveal: 'show me that video in Finder' opens Finder on the focus video", async () => {
    const runner = mac({ added });
    const deps = depsWith(runner);
    await call(deps, { describe: "the strawberry one" });
    const r = await call(deps, { describe: "show me that video in Finder" });
    expect(r).toMatchObject({ confidence: "exact", revealed: true });
    expect(r.summary).toContain(process.platform === "win32" ? "Showed it in File Explorer." : "Showed it in Finder.");
    const open = runner.calls.find((c) => basename(c[0]) === "open")!;
    expect(open.slice(0, 2)).toEqual(["/usr/bin/open", "-R"]);
    expect(basename(open[2])).toBe("ep01-strawberry-tokens.mp4");
  });

  test("by name with misfits: the summary and next say where it was found and what didn't fit", async () => {
    const deps = depsWith(mac({ added }));
    const r = await call(deps, { describe: "strawbery tokens", folders: ["Downloads"], source: "web_download" });
    expect(r).toMatchObject({ confidence: "likely", found_elsewhere: true });
    expect(r.summary).toContain("Found it by name: ep01-strawberry-tokens.mp4");
    expect(r.summary).toContain("Not in Downloads; it's in Movies › Tiny AI Lab, and it wasn't downloaded from a website.");
    expect(r.next).toContain("show its card now");
    expect(r.next).toContain("which video it is (not in Downloads; it's in Movies › Tiny AI Lab, and it wasn't downloaded from a website)");
    const legacy = await call(deps, { describe: "upload the video from downloads about strawbery tokens to tiktok", source: "downloaded" });
    expect(legacy.videos[0].name).toBe("ep01-strawberry-tokens.mp4");
    expect(legacy.confidence).toBe("likely");
  });

  test("live repro #3: 'no the other one' after the strawberry card excludes it and asks between the others by title", async () => {
    for (const other of [{ describe: "no the other one" }, { query: "the other one" }, { describe: "a different one" }, { describe: "no not that one" }]) {
      const deps = depsWith(mac({ added }));
      const a = await call(deps, { describe: "upload the strawberry video to tiktok drafts" });
      expect(a).toMatchObject({ confidence: "exact" });
      expect(a.videos[0].name).toBe("ep01-strawberry-tokens.mp4");
      const b = await call(deps, other);
      expect(b.videos.map((v: any) => v.name)).not.toContain("ep01-strawberry-tokens.mp4");
      expect(b.confidence).toBe("ambiguous");
      expect(b.question).toBe("Which one: “ai history speedrun”, or “ai data center power final”?");
      expect(b.summary).toBe("Other videos, not ep01 strawberry tokens: ai history speedrun, ai data center power final.");
      // "the second one" now means the second of these.
      const c = await call(deps, { describe: "the second one" });
      expect(c.videos[0].name).toBe("ai data center power final.mp4");
    }
  });

  test("'the other one' with exactly one other video fitting the earlier search → likely, go ahead", async () => {
    const deps = depsWith(mac({ added }));
    const a = await call(deps, { describe: "the newest vertical one from today" });
    expect(a.videos.map((v: any) => v.name)).toEqual(["ai history speedrun.mp4"]);
    const b = await call(deps, { describe: "the other one" });
    expect(b).toMatchObject({ confidence: "likely" });
    expect(b.videos.map((v: any) => v.name)).toEqual(["ai data center power final.mp4"]);
    expect(b.summary).toContain("Another one (not ai history speedrun): ai data center power final.mp4");
    expect(b.next).toContain("show its card now");
    expect(deps.session?.current?.(NOW)?.title).toBe("ai data center power final");
  });

  test("a card of two: 'the other one' is the one not picked", async () => {
    const deps = depsWith(mac({ added }));
    const a = await call(deps, { describe: "the vertical one from today" });
    expect(a.confidence).toBe("ambiguous");
    await call(deps, { describe: "the first one" });
    const b = await call(deps, { query: "not that one" });
    expect(b).toMatchObject({ confidence: "exact" });
    expect(b.videos[0].name).toBe(a.videos[1].name);
  });

  test("Automation denied → AUTOMATION_DENIED with plain words", async () => {
    const deps = depsWith(mac({ added, finder: { code: 1, stderr: "Not authorized to send Apple events to Finder. (-1743)" } }));
    const r = await findRecentVideosTool({ source: "finder_selection" }, deps, {});
    expect(r.isError).toBe(true);
    const j = parseResult(r as any);
    expect(j.error.code).toBe("AUTOMATION_DENIED");
    expect(j.error.detail).toContain("Privacy & Security → Automation");
  });

  test("query_creator_info marks the video as a post being prepared (before any TikTok call)", async () => {
    const deps = depsWith(mac({ added }));
    const a = await call(deps, { describe: "the strawberry one" });
    deps.limits.creatorInfo.tryTake = () => false; // stop before the network: the focus is already set
    await queryCreatorInfo({ file_token: a.videos[0].file_token }, deps, {});
    expect(deps.session?.current?.(NOW)).toMatchObject({ how: "post_prepared", mode: "post" });
  });
});

describe("videoCandidatesCard: the numbered layout", () => {
  const v = (name: string, o: Record<string, unknown> = {}) => ({ name, folder: "Downloads", duration_label: "0:37", size_label: "4 MB", added_label: "1 hour ago", width: 1080, height: 1920, chips: ["vertical", "yesterday 9:14 PM"], ...o });

  test("numbers, the question, the highlighted match, escaped text, inside the notch", () => {
    const amb = videoCandidatesCard({
      videos: [v("a.mp4", { number: 1 }), v("<b>x</b>.mp4", { number: 2 }), v("c.mp4", { number: 3 })],
      query_matched: true, denied_folders: [], confidence: "ambiguous", question: "Which one: the 0:37 one, or the 1:12 one?",
    });
    for (const n of [1, 2, 3]) expect(amb.html).toContain(`class="tt-pk-n">${n}<`);
    expect(amb.html).toContain("Which one: the 0:37 one, or the 1:12 one?");
    expect(amb.html).not.toContain("<b>x</b>");
    expect(amb.height).toBeGreaterThanOrEqual(60);
    expect(amb.height).toBeLessThanOrEqual(420);
    const likely = videoCandidatesCard({ videos: [v("a.mp4", { best: true }), v("b.mp4")], query_matched: true, denied_folders: [], confidence: "likely" });
    expect(likely.html).toContain("tt-pk-f is-best");
    const one = videoCandidatesCard({ videos: [v("a.mp4", { in_progress: true, best: true })], query_matched: true, denied_folders: [], confidence: "exact" });
    expect(one.html).toContain("In progress");
    expect(one.html).toContain("tt-m z-l");
    const six = videoCandidatesCard({ videos: Array.from({ length: 6 }, (_, i) => v(`v${i}.mp4`, { number: i + 1 })), query_matched: true, denied_folders: ["Movies"], confidence: "ambiguous", question: "Which one?" });
    expect(six.height).toBeLessThanOrEqual(420);
    const none = videoCandidatesCard({ videos: [], query_matched: true, denied_folders: [], confidence: "none", headline: "Nothing is selected in Finder" });
    expect(none.html).toContain("Nothing is selected in Finder");
  });
});

// ---------------------------------------------------------------------------
// Photos: a folder is the set (live bug: "the voice clone safety slides I just downloaded")
// ---------------------------------------------------------------------------

describe("find_recent_images: folders as sets", () => {
  let home: string;
  const added: Record<string, number> = {};
  const sets: Array<[string, number, number]> = [
    ["voice clone safety slides", 11, at(5, 13, 50)],
    ["AI words carousel", 10, at(5, 13, 40)],
    ["myth or fact quiz", 12, at(5, 13, 30)],
    ["what happens when you hit send slides", 10, at(5, 13, 20)],
    ["prompt cheat sheet slides", 8, at(5, 13, 10)],
    ["ai history trading cards", 12, at(5, 13, 0)],
    ["Tiny AI Lab BTS", 6, at(2, 10, 0)],
  ];
  beforeAll(() => {
    home = tempDir("tiktok-finder-photos-");
    for (const [folder, n, t] of sets) {
      // Arrival order scrambled on purpose: the set must come back in name order (01, 02 … 10, 11).
      for (let i = n; i >= 1; i--) added[put(home, `Downloads/${folder}/${String(i).padStart(2, "0")}.png`, "png", t - 3 * H)] = t - (n - i) * 1000;
    }
    added[put(home, "Downloads/loose photo.jpg", "jpg", NOW - 9 * H)] = at(5, 9, 0);
  });
  const sips = () => ({ width: 1080, height: 1350, format: "png", has_alpha: false });
  const runner = () => fakeImages(added, sips);
  const find = (o: Record<string, unknown>) => findRecentImages({ home, source: "any", limit: 10, runner: runner(), clock, ...o } as any);
  const names = (r: { images: { name: string }[] }) => r.images.map((i) => i.name);

  test("the owner's words match the folder: the whole folder, in name order, even past limit 10", async () => {
    for (const query of ["voice clone safety slides", "voice clone safety", "the voice clone safety slides i just downloaded", "voice clone safty slides", "voice cloning safety"]) {
      const r = await find({ query });
      expect(names(r)).toEqual(Array.from({ length: 11 }, (_, i) => `${String(i + 1).padStart(2, "0")}.png`));
      expect(r.group).toMatchObject({ name: "voice clone safety slides", folder: "Downloads/voice clone safety slides", count: 11 });
      expect(r.confidence).toBe(/safty|cloning/.test(query) ? "likely" : "exact");
      expect(r.batch_hint).toBe("11 images in the folder “voice clone safety slides”");
    }
  });

  test("'slides', 'carousel', 'pics' aren't required words; two equally good folders → one question naming them", async () => {
    expect((await find({ query: "AI words carousel" })).group?.name).toBe("AI words carousel");
    expect((await find({ query: "myth or fact quiz pics" })).group?.name).toBe("myth or fact quiz");
    const amb = await find({ query: "ai" });
    expect(amb.confidence).toBe("ambiguous");
    expect(amb.question).toMatch(/^Which set: “AI words carousel” \(10 images, .+\), “ai history trading cards” \(12 images, .+\)/);
  });

  test("'the slides I just downloaded' / recent_batch: one folder (the newest), never a mix", async () => {
    const r = await find({ query: "the slides i just downloaded" });
    expect(r.group?.name).toBe("voice clone safety slides");
    expect(new Set(r.images.map((i) => i.folder))).toEqual(new Set(["Downloads/voice clone safety slides"]));
    expect(r.confidence).toBe("likely"); // the next set arrived 10 minutes earlier
    expect(r.other_groups?.map((g) => g.name)).toEqual(["AI words carousel", "myth or fact quiz", "what happens when you hit send slides"]);
    const batch = await find({ source: "recent_batch" });
    expect(batch.group?.name).toBe("voice clone safety slides");
    expect(batch.images).toHaveLength(11);
  });

  test("the handler: go ahead with the set in order, or ask the one question", async () => {
    const cfg = loadConfig({ COMPOSIO_API_KEY: "k", COMPOSIO_CONNECTED_ACCOUNT_ID: "ca_test" }, ["--composio-base-url=http://127.0.0.1:9/api/v3.1", `--state-dir=${join(home, ".state")}`, `--home=${home}`, "--media-relay-base=http://127.0.0.1:9"]);
    const deps = createDeps(cfg, { runner: runner(), clock, photoPreview: async () => ({}) as any });
    const { findRecentImagesTool } = await import("../src/tools/helpers.ts");
    const j = parseResult((await findRecentImagesTool({ query: "voice clone safety slides" }, deps, {})) as any);
    expect(j).toMatchObject({ count: 11, folder: "voice clone safety slides", confidence: "exact" });
    expect(j.images.map((i: any) => i.name)[10]).toBe("11.png");
    expect(j.summary).toBe("The folder “voice clone safety slides” in Downloads: 11 images, in name order (01.png to 11.png).");
    expect(j.next).toContain("pass all 11 image_tokens to prepare_photo_post in this order");
    const amb = parseResult((await findRecentImagesTool({ query: "ai" }, deps, {})) as any);
    expect(amb.next).toContain(`Ask the user exactly this one short question: ${amb.question}`);
    expect(JSON.stringify(j)).not.toContain(home);
  });
});

/** A fake Mac for photos: date added (JXA) and sips. */
function fakeImages(added: Record<string, number>, sipsOf: (p: string) => { width: number; height: number; format: string; has_alpha: boolean }): Runner {
  return async (cmd: string[]): Promise<RunResult> => {
    const tool = basename(cmd[0] ?? "");
    if (tool === "osascript") return { code: 0, stdout: JSON.stringify(cmd.slice(5).map((p) => added[p] ?? null)), stderr: "", timedOut: false };
    if (tool === "sips") {
      const paths = cmd.slice(1).filter((x, i, a) => x !== "-g" && a[i - 1] !== "-g");
      const out = paths.map((p) => { const m = sipsOf(p); return `${p}\n  pixelWidth: ${m.width}\n  pixelHeight: ${m.height}\n  format: ${m.format}\n  hasAlpha: ${m.has_alpha ? "yes" : "no"}\n`; }).join("");
      return { code: 0, stdout: out, stderr: "", timedOut: false };
    }
    return { code: 1, stdout: "", stderr: "", timedOut: false };
  };
}
