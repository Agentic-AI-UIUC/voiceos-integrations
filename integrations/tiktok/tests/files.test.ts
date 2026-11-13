import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { basename, join, resolve } from "node:path";
import { TikTokError } from "../src/errors.ts";
import { dateAdded, editDistance, findRecentImages, findRecentVideos, matchScore, normName, screenshotFolder } from "../src/files.ts";
import { run } from "../src/proc.ts";
import type { Clock } from "../src/types.ts";
import { fakeRunner, mp4, pngBytes, put } from "./fixtures/media/fixtures.ts";

const darwin = process.platform === "darwin";
const isRoot = process.platform === "win32" || (typeof process.getuid === "function" && process.getuid() === 0);
const NOW = Date.now();
const S = 1000;
const MIN = 60 * S;
const H = 60 * MIN;
const clockAt = (now: number): Clock => ({ now: () => now, sleep: async () => {} });
const clock = clockAt(NOW);
const temps: string[] = [];
const tempDir = (prefix: string) => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});
const hm = (ms: number) => {
  const d = new Date(ms);
  return `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
};

describe("normName / matchScore", () => {
  test("normName: NFKC plus U+00A0/U+2007/U+202F → space", () => {
    expect(normName("9.07 PM")).toBe("9.07 PM");
    expect(normName("a b c")).toBe("a b c");
    expect(normName("ｅｘｐｏｒｔ")).toBe("export");
    expect(normName("café")).toBe("café");
  });

  test("U+202F names match a typed '9.07 PM', and the reverse", () => {
    expect(matchScore("Screen Recording 2026-11-03 at 9.07 PM.mov", "9.07 PM")).toBeGreaterThan(0);
    expect(matchScore("Screen Recording 2026-11-03 at 9.07 PM.mov", "9.07 PM")).toBeGreaterThan(0);
    expect(matchScore("Screen Recording 2026-11-03 at 9.07 PM.mov", "9:07 pm")).toBeGreaterThan(0);
    expect(matchScore("Screen Recording 2026-11-03 at 9.08 PM.mov", "9.07 PM")).toBe(0);
  });

  test("stop words are ignored; a query without meaningful words scores everything 1", () => {
    expect(matchScore("anything.mov", "my latest video")).toBe(1);
    expect(matchScore("IMG_0001.HEIC", "the photos")).toBe(1);
    expect(matchScore("demo.mov", "the one called demo")).toBe(1);
    expect(matchScore("clip.mov", "the one called demo")).toBe(0);
    expect(matchScore("x.png", "")).toBe(1);
  });

  test("every remaining token must appear (case-, accent- and punctuation-insensitive)", () => {
    expect(matchScore("beach sunset.jpg", "sunset beach")).toBe(2);
    expect(matchScore("beach.jpg", "sunset beach")).toBe(0);
    expect(matchScore("DEMO.MOV", "demo")).toBe(1);
    expect(matchScore("demo_v2.mov", "demo v2")).toBe(2);
    expect(matchScore("Jordan's trip.mov", "jordans trip")).toBe(2);
    expect(matchScore("café tour.mp4", "café")).toBe(1);
  });

  test("typos: one edit for a word of 5+ letters, two for 9+; whole word > part of a word > near spelling", () => {
    expect(matchScore("ep01-strawberry-tokens.mp4", "strawbery tokens")).toBe(1.6);
    expect(matchScore("ep01-strawberry-tokens.mp4", "strawberry tokens")).toBe(2);
    expect(matchScore("ep01-strawberry-tokens.mp4", "strawbrery toknes")).toBe(1.2); // a swap counts as one edit
    expect(matchScore("ep01-strawberry-tokens.mp4", "strwbry tokens")).toBe(0); // three edits
    expect(matchScore("hallucinations.mp4", "halucinatons")).toBe(0.6);
    expect(matchScore("demo.mov", "dema")).toBe(0); // under 5 letters: exact only
    expect(matchScore("ep05-memory.mp4", "memry")).toBe(0.6);
    expect(matchScore("Screen Recording 2026-11-03 at 9.08 PM.mov", "2027")).toBe(0); // numbers: exact only
    const names = ["strawbery.mp4", "strawberryjam.mp4", "strawberry.mp4"];
    const ranked = [...names].sort((a, b) => matchScore(b, "strawberry") - matchScore(a, "strawberry"));
    expect(ranked).toEqual(["strawberry.mp4", "strawberryjam.mp4", "strawbery.mp4"]);
    expect(names.map((n) => matchScore(n, "strawberry"))).toEqual([0.6, 0.9, 1]);
  });

  test("editDistance is Damerau-Levenshtein (adjacent swaps are one edit) and stops past its limit", () => {
    expect(editDistance("tokens", "tokens")).toBe(0);
    expect(editDistance("toknes", "tokens")).toBe(1);
    expect(editDistance("strawbery", "strawberry")).toBe(1);
    expect(editDistance("kitten", "sitting", 5)).toBe(3);
    expect(editDistance("abc", "abcdefgh", 2)).toBe(3);
    expect(editDistance("café", "cafe")).toBe(1);
  });

  test("export/final/render boost names containing any of them", () => {
    expect(matchScore("final_export.mp4", "my latest export")).toBe(1.5);
    expect(matchScore("Timeline 1.mp4", "my latest export")).toBe(1);
    expect(matchScore("render_v2.mov", "my final render")).toBe(1.5);
    expect(matchScore("demo_final.mov", "demo final")).toBe(1.5);
    expect(matchScore("demo.mov", "demo final")).toBe(1);
    expect(matchScore("final_export.mp4", "demo")).toBe(0);
    expect(matchScore("final.mp4", "the beach clip")).toBe(0);
  });
});

describe("dateAdded (fake runner)", () => {
  const paths = ["/Users/x/Downloads/a \"quoted\" 🎉.mov", "/Users/x/Desktop/Screen Recording 2026-11-03 at 9.07 PM.mov", "/Users/x/gone.mp4"].map(p => resolve(p));

  test("ONE osascript -l JavaScript call; paths travel as argv (never inside the script); unknown → absent", async () => {
    const runner = fakeRunner({ added: { [paths[0]]: 1_700_000_000_123, [paths[1]]: 1_700_000_100_000 } });
    const out = await dateAdded([...paths, paths[0]], runner);
    expect(runner.calls.length).toBe(1);
    const { cmd, opts } = runner.calls[0];
    expect(cmd.slice(0, 4)).toEqual(["/usr/bin/osascript", "-l", "JavaScript", "-e"]);
    expect(cmd[4]).toContain("NSURLAddedToDirectoryDateKey");
    expect(cmd[4]).toContain("function run(argv)");
    for (const p of paths) expect(cmd[4]).not.toContain(p);
    expect(cmd.slice(5)).toEqual(paths);
    expect(opts?.timeoutMs).toBe(8000);
    expect(out.get(paths[0])).toBe(1_700_000_000_123);
    expect(out.get(paths[1])).toBe(1_700_000_100_000);
    expect(out.has(paths[2])).toBe(false);
  });

  test("failures leave every date unknown (callers fall back to birthtime, then mtime)", async () => {
    for (const osascript of [{ code: 1, stderr: "execution error" }, { code: 124, timedOut: true }, { stdout: "not json" }, { stdout: "[1,2]" }, { stdout: "{}" }]) {
      expect((await dateAdded(paths, fakeRunner({ osascript }))).size).toBe(0);
    }
    const throwing = async () => {
      throw new Error("spawn failed");
    };
    expect((await dateAdded(paths, throwing)).size).toBe(0);
    const runner = fakeRunner();
    expect((await dateAdded([], runner)).size).toBe(0);
    expect(runner.calls.length).toBe(0);
  });
});

describe("screenshotFolder (fake defaults)", () => {
  let home: string;
  beforeAll(() => {
    home = tempDir("tiktok-shots-");
    for (const d of ["Desktop", "Downloads", "Pictures/Screens"]) mkdirSync(join(home, d), { recursive: true });
  });

  test("literal '~/Downloads' is expanded against the given home", async () => {
    const runner = fakeRunner({ screenshotLocation: "~/Downloads" });
    expect(await screenshotFolder(home, runner)).toBe(join(home, "Downloads"));
    expect(runner.calls[0].cmd).toEqual(["/usr/bin/defaults", "read", "com.apple.screencapture", "location"]);
  });

  test("missing key (exit 1), empty, nonexistent folder or a failing runner → <home>/Desktop", async () => {
    expect(await screenshotFolder(home, fakeRunner())).toBe(join(home, "Desktop"));
    expect(await screenshotFolder(home, fakeRunner({ screenshotLocation: "  " }))).toBe(join(home, "Desktop"));
    expect(await screenshotFolder(home, fakeRunner({ screenshotLocation: "~/Nowhere" }))).toBe(join(home, "Desktop"));
    expect(await screenshotFolder(home, async () => Promise.reject(new Error("boom")))).toBe(join(home, "Desktop"));
  });

  test("absolute paths, trailing slashes, '~' and file:// URLs", async () => {
    const outside = tempDir("tiktok-outside-");
    expect(await screenshotFolder(home, fakeRunner({ screenshotLocation: `${outside}/` }))).toBe(outside);
    expect(await screenshotFolder(home, fakeRunner({ screenshotLocation: "~/Pictures/Screens/" }))).toBe(join(home, "Pictures", "Screens"));
    expect(await screenshotFolder(home, fakeRunner({ screenshotLocation: "~" }))).toBe(home);
    expect(await screenshotFolder(home, fakeRunner({ screenshotLocation: pathToFileURL(join(home, "Downloads")).href }))).toBe(join(home, "Downloads"));
  });
});

describe("findRecentVideos (fixture home, fake runner)", () => {
  let home: string;
  const added: Record<string, number> = {};
  const add = (rel: string, bytes: Uint8Array | string, mtimeMs: number, addedMs: number) => {
    const p = put(home, rel, bytes, mtimeMs);
    added[p] = addedMs;
    return p;
  };
  beforeAll(() => {
    home = tempDir("tiktok-home-v-");
    add("Downloads/old-mtime-new-arrival.mp4", mp4({ seconds: 14 }), Date.UTC(2020, 0, 1), NOW - 1 * MIN);
    add("Movies/Exports/final_export.mp4", mp4({ seconds: 6, width: 1080, height: 1920 }), NOW - 5 * MIN, NOW - 5 * MIN);
    add("Desktop/Screen Recording 2026-11-03 at 9.07 PM.mov", mp4({ brand: "qt  ", seconds: 31, width: 2940, height: 1912 }), NOW - 20 * MIN, NOW - 20 * MIN);
    add("Desktop/demo.mov", mp4({ brand: "qt  ", seconds: 12.5, width: 1920, height: 1080, rotation: 90 }), NOW - 30 * MIN, NOW - 30 * MIN);
    add("Desktop/new-mtime-old-arrival.mov", mp4({ brand: "qt  " }), NOW - 2 * MIN, NOW - 60 * MIN);
    add("Movies/archive.MP4", mp4({ seconds: 3 }), NOW - 72 * H, NOW - 72 * H);
    // Everything below must be skipped, even though it "arrived" most recently.
    const fresh = NOW - 10 * S;
    add("Downloads/big.mp4.part", "partial", NOW - H, fresh);
    add("Downloads/ff.mp4", "", NOW - H, fresh); // Firefox's empty placeholder…
    add("Downloads/ff.mp4.part", "partial", NOW - H, fresh); // …next to the real download
    add("Downloads/partial.mov", mp4(), NOW - H, fresh);
    add("Downloads/partial.mov.crdownload", "partial", NOW - H, fresh);
    add("Downloads/.hidden.mp4", mp4(), NOW - H, fresh);
    add("Downloads/notes.txt", "hi", NOW - H, fresh);
    add("Downloads/clip.webm", "webm", NOW - H, fresh);
    add("Movies/writing.mp4", mp4(), NOW - 2 * S, NOW - 1 * S); // still being written
    add("Movies/Exports/deeper/deepest/too-deep.mp4", mp4(), NOW - H, fresh); // three levels down
    add("Movies/Project.fcpbundle/inner.mp4", mp4(), NOW - H, fresh);
    add("Movies/iMovie Library.imovielibrary/x.mov", mp4(), NOW - H, fresh);
    add("Movies/.cache/x.mp4", mp4(), NOW - H, fresh);
    add("Desktop/IMG_0001.HEIC", "heic", NOW - H, fresh);
    symlinkSync(join(home, "Desktop", "demo.mov"), join(home, "Downloads", "link.mp4"));
  });
  const opts = (o: Partial<Parameters<typeof findRecentVideos>[0]> = {}) => ({ home, limit: 6, runner: fakeRunner({ added }), clock, ...o });

  test("newest by date added (arrival beats mtime); top level + two levels deep; skips partial, hidden, fresh, packages, symlinks", async () => {
    const runner = fakeRunner({ added });
    const r = await findRecentVideos(opts({ runner }));
    expect(r.videos.map((v) => v.name)).toEqual([
      "old-mtime-new-arrival.mp4",
      "final_export.mp4",
      "Screen Recording 2026-11-03 at 9.07 PM.mov",
      "demo.mov",
      "new-mtime-old-arrival.mov",
      "archive.MP4",
    ]);
    expect(r.videos.map((v) => v.folder)).toEqual(["Downloads", "Movies/Exports", "Desktop", "Desktop", "Desktop", "Movies"]);
    expect(r.query_matched).toBe(true);
    expect(r.denied_folders).toEqual([]);
    expect(r.searched_folders).toEqual(["Downloads", "Desktop", "Movies"]);
    // One date-added call, one batched Spotlight call and one batched quarantine call: never one per file.
    expect(runner.count("osascript")).toBe(1);
    expect(runner.count("mdls")).toBe(1);
    expect(runner.count("xattr")).toBe(1);
    expect(runner.calls.length).toBe(3);
    // Nothing described: the newest, offered as likely.
    expect(r.confidence).toBe("likely");
    expect(r.videos.map((v) => v.rank)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  test("each video carries size, mtime, arrival, mime, duration and display size", async () => {
    const r = await findRecentVideos(opts());
    const fin = r.videos.find((v) => v.name === "final_export.mp4")!;
    const st = statSync(fin.path);
    expect(fin).toMatchObject({ path: join(home, "Movies", "Exports", "final_export.mp4"), name: "final_export.mp4", folder: "Movies/Exports", size: st.size, mtimeMs: st.mtimeMs, addedMs: NOW - 5 * MIN, mime: "video/mp4", duration_sec: 6, width: 1080, height: 1920 });
    expect(fin).toMatchObject({ orientation: "vertical", has_audio: true, descriptor: "vertical · 0:06 · added 5 min ago · Movies › Exports" });
    expect(r.videos.find((v) => v.name === "demo.mov")).toMatchObject({ mime: "video/quicktime", duration_sec: 12.5, width: 1080, height: 1920 });
    expect(r.videos.find((v) => v.name === "archive.MP4")).toMatchObject({ mime: "video/mp4", duration_sec: 3 });
  });

  test("limit is applied after sorting", async () => {
    const r = await findRecentVideos(opts({ limit: 2 }));
    expect(r.videos.map((v) => v.name)).toEqual(["old-mtime-new-arrival.mp4", "final_export.mp4"]);
  });

  test("queries: name match, U+202F name, export boost, no match → newest with query_matched false", async () => {
    const demo = await findRecentVideos(opts({ query: "the one called demo" }));
    expect(demo.videos.map((v) => v.name)).toEqual(["demo.mov"]);
    expect(demo.query_matched).toBe(true);
    const rec = await findRecentVideos(opts({ query: "9.07 PM" }));
    expect(rec.videos.map((v) => v.name)).toEqual(["Screen Recording 2026-11-03 at 9.07 PM.mov"]);
    // "my latest export": the one export, and nothing else to choose from.
    const exp = await findRecentVideos(opts({ query: "my latest export", limit: 3 }));
    expect(exp.videos.map((v) => v.name)).toEqual(["final_export.mp4"]);
    expect(exp.confidence).toBe("exact");
    expect(exp.query_matched).toBe(true);
    const none = await findRecentVideos(opts({ query: "zebra", limit: 3 }));
    expect(none.videos.map((v) => v.name)).toEqual(["old-mtime-new-arrival.mp4", "final_export.mp4", "Screen Recording 2026-11-03 at 9.07 PM.mov"]);
    expect(none.query_matched).toBe(false);
  });

  test("folders narrows the search", async () => {
    const r = await findRecentVideos(opts({ folders: ["Movies"] }));
    expect(r.videos.map((v) => v.name)).toEqual(["final_export.mp4", "archive.MP4"]);
    expect(r.searched_folders).toEqual(["Movies"]);
  });

  test("the 5-second freshness rule uses the injected clock", async () => {
    const r = await findRecentVideos(opts({ clock: clockAt(NOW + 10 * S) }));
    expect(r.videos[0].name).toBe("writing.mp4");
  });

  test("osascript failing → birthtime, then mtime", async () => {
    const r = await findRecentVideos(opts({ runner: fakeRunner({ osascript: { code: 1 } }) }));
    const expected = r.videos
      .map((v) => {
        const st = statSync(v.path);
        return { name: v.name, t: st.birthtimeMs > 0 ? st.birthtimeMs : st.mtimeMs };
      })
      .sort((a, b) => b.t - a.t || (a.name < b.name ? -1 : 1));
    expect(r.videos.map((v) => v.name)).toEqual(expected.map((e) => e.name));
    expect(r.videos.map((v) => v.addedMs)).toEqual(expected.map((e) => e.t));
    expect(r.fits).toBe(6);
    expect(r.videos.length).toBeGreaterThanOrEqual(2);
  });

  test("a missing home is just empty", async () => {
    const r = await findRecentVideos(opts({ home: join(home, "nope") }));
    expect(r).toMatchObject({ videos: [], query_matched: true, denied_folders: [], searched_folders: [], confidence: "none" });
  });

  test.skipIf(isRoot)("a denied folder → partial results + denied_folders; every folder denied → FOLDER_PERMISSION_DENIED", async () => {
    const desk = join(home, "Desktop");
    chmodSync(desk, 0o000);
    try {
      const r = await findRecentVideos(opts());
      expect(r.denied_folders).toEqual(["Desktop"]);
      expect(r.searched_folders).toEqual(["Downloads", "Movies"]);
      expect(r.videos.map((v) => v.name)).toEqual(["old-mtime-new-arrival.mp4", "final_export.mp4", "archive.MP4"]);
      for (const d of ["Downloads", "Movies"]) chmodSync(join(home, d), 0o000);
      let err: unknown;
      try {
        await findRecentVideos(opts());
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(TikTokError);
      expect((err as TikTokError).code).toBe("FOLDER_PERMISSION_DENIED");
      expect((err as TikTokError).detail.folders).toEqual(["Downloads", "Desktop", "Movies"]);
    } finally {
      for (const d of ["Downloads", "Desktop", "Movies"]) chmodSync(join(home, d), 0o755);
    }
  });
});

describe("findRecentVideos: two folder levels deep", () => {
  test("a season subfolder (Movies/Show/Season 2) is found by name; a third level is not", async () => {
    const home = tempDir("tiktok-home-deep-");
    const added: Record<string, number> = {};
    const add = (rel: string, addedMs: number) => (added[put(home, rel, mp4({ seconds: 28, width: 1080, height: 1920 }), addedMs)] = addedMs);
    add("Movies/My Show/Season 2/Secret Heir of the Hotel.mp4", NOW - 40 * MIN);
    add("Movies/My Show/Season 2/old/Secret Heir of the Hotel (cut).mp4", NOW - 30 * MIN);
    add("Downloads/screen recording.mov", NOW - 5 * MIN);
    const r = await findRecentVideos({ home, limit: 6, runner: fakeRunner({ added }), clock, query: "hotel heir" });
    expect(r.videos[0]?.name).toBe("Secret Heir of the Hotel.mp4");
    expect(r.videos[0]?.folder).toBe("Movies/My Show/Season 2");
    expect(r.videos.map((v) => v.name)).not.toContain("Secret Heir of the Hotel (cut).mp4");
  });
});

describe("findRecentImages (fixture home, fake runner)", () => {
  let home: string;
  const added: Record<string, number> = {};
  const batch0 = NOW - 10 * MIN;
  const add = (rel: string, addedMs: number, bytes: Uint8Array | string = "img", mtimeMs = NOW - 400 * H) => {
    const p = put(home, rel, bytes, mtimeMs);
    added[p] = addedMs;
    return p;
  };
  const sips = (p: string) => (p.includes("unreadable") ? null : { width: 1080, height: 1350, format: p.toLowerCase().endsWith(".heic") ? "heic" : p.endsWith(".png") ? "png" : "jpeg", has_alpha: p.endsWith(".png") });
  beforeAll(() => {
    home = tempDir("tiktok-home-i-");
    for (let i = 0; i < 4; i++) add(`Downloads/IMG_000${i + 1}.HEIC`, batch0 + i * 5 * S);
    add("Downloads/beach.jpg", NOW - 3 * H);
    add("Downloads/anim.gif", NOW - 9 * MIN);
    add("Downloads/scan.tiff", NOW - 48 * H);
    add("Desktop/Screenshot 2026-11-03 at 9.07.32 PM.png", NOW - 1 * MIN);
    add("Desktop/Screen Shot 2020-01-01 at 10.00.00 AM.png", NOW - 120 * H);
    add("Desktop/sunset.webp", NOW - 30 * MIN);
    add("Desktop/demo.mov", NOW - 2 * MIN, mp4());
    add("Pictures/Trip/dinner.jpeg", NOW - 2 * H);
    add("Pictures/Photos Library.photoslibrary/originals/x.jpg", NOW - 5 * S);
    add("Pictures/Photo Booth Library/Pictures/y.jpg", NOW - 5 * S);
    add("Pictures/.hidden.png", NOW - 5 * S);
  });
  const opts = (o: Partial<Parameters<typeof findRecentImages>[0]> = {}) => ({
    home,
    source: "any" as const,
    limit: 10,
    runner: fakeRunner({ added, screenshotLocation: "~/Downloads", sips }),
    clock,
    ...o,
  });
  const names = (r: { images: { name: string }[] }) => r.images.map((i) => i.name);
  const SHOT = "Screenshot 2026-11-03 at 9.07.32 PM.png";
  const OLD_SHOT = "Screen Shot 2020-01-01 at 10.00.00 AM.png";

  test("any: newest by arrival across Downloads/Desktop/Pictures (+ screenshot folder, deduped); libraries and hidden files skipped", async () => {
    const runner = fakeRunner({ added, screenshotLocation: "~/Downloads", sips });
    const r = await findRecentImages(opts({ runner }));
    expect(names(r)).toEqual([SHOT, "IMG_0004.HEIC", "IMG_0003.HEIC", "IMG_0002.HEIC", "IMG_0001.HEIC", "sunset.webp", "dinner.jpeg", "beach.jpg", OLD_SHOT]);
    expect(r.searched_folders).toEqual(["Downloads", "Desktop", "Pictures"]);
    expect(r.query_matched).toBe(true);
    expect(r.unsupported_count).toBe(2); // anim.gif, scan.tiff
    expect(r.batch_hint).toBeUndefined(); // the newest arrival (the screenshot) came alone
    expect(runner.count("defaults")).toBe(1);
    expect(runner.count("osascript")).toBe(1);
    expect(runner.count("sips")).toBe(1);
    const dinner = r.images.find((i) => i.name === "dinner.jpeg")!;
    expect(dinner).toMatchObject({ folder: "Pictures/Trip", ext: "jpeg", is_screenshot: false, width: 1080, height: 1350, format: "jpeg", has_alpha: false, addedMs: NOW - 2 * H });
    expect(r.images[0]).toMatchObject({ folder: "Desktop", ext: "png", is_screenshot: true, format: "png", has_alpha: true });
    expect(r.images[1]).toMatchObject({ ext: "heic", format: "heic" });
  });

  test("limit applies after sorting; unsupported_count only counts files at least as new as the oldest returned", async () => {
    const r = await findRecentImages(opts({ limit: 3 }));
    expect(names(r)).toEqual([SHOT, "IMG_0004.HEIC", "IMG_0003.HEIC"]);
    expect(r.unsupported_count).toBe(1); // anim.gif
  });

  test("screenshots: names starting with Screenshot / Screen Shot", async () => {
    const r = await findRecentImages(opts({ source: "screenshots" }));
    expect(names(r)).toEqual([SHOT, OLD_SHOT]);
    expect(r.images.every((i) => i.is_screenshot)).toBe(true);
    expect(r.unsupported_count).toBe(0);
  });

  test("recent_batch: the newest cluster of arrivals ≤ 120 s apart (an AirDrop), with a batch hint", async () => {
    const r = await findRecentImages(opts({ source: "recent_batch" }));
    expect(names(r)).toEqual(["IMG_0004.HEIC", "IMG_0003.HEIC", "IMG_0002.HEIC", "IMG_0001.HEIC"]);
    expect(r.batch_hint).toMatch(new RegExp(`^4 images arrived together (at|yesterday at) ${hm(batch0 + 15 * S)}$`)); // midnight-safe
    expect(r.unsupported_count).toBe(1); // anim.gif arrived inside the batch window
  });

  test("since_hours filters by arrival time", async () => {
    const r = await findRecentImages(opts({ since_hours: 1 }));
    expect(names(r)).toEqual([SHOT, "IMG_0004.HEIC", "IMG_0003.HEIC", "IMG_0002.HEIC", "IMG_0001.HEIC", "sunset.webp"]);
    expect(r.unsupported_count).toBe(1);
  });

  test("query matching, and no match → newest with query_matched false", async () => {
    const r = await findRecentImages(opts({ query: "sunset" }));
    expect(names(r)).toEqual(["sunset.webp"]);
    expect(r.query_matched).toBe(true);
    const none = await findRecentImages(opts({ query: "zebra", limit: 2 }));
    expect(names(none)).toEqual([SHOT, "IMG_0004.HEIC"]);
    expect(none.query_matched).toBe(false);
    const gif = await findRecentImages(opts({ query: "anim" }));
    expect(gif.query_matched).toBe(false);
    expect(gif.unsupported_count).toBe(1); // the GIF the user named
  });

  test("screenshot folder: missing key → Desktop; nested and outside-home folders; folders: ['Screenshots']", async () => {
    const missing = await findRecentImages(opts({ runner: fakeRunner({ added, sips }) }));
    expect(missing.searched_folders).toEqual(["Downloads", "Desktop", "Pictures"]);
    added[put(home, "Pictures/Screens/Screenshot 2026-11-02 at 8.00.00 AM.png", "img")] = NOW - 6 * H;
    const nested = await findRecentImages(opts({ runner: fakeRunner({ added, sips, screenshotLocation: "~/Pictures/Screens" }), source: "screenshots" }));
    expect(nested.searched_folders).toEqual(["Downloads", "Desktop", "Pictures", "Pictures/Screens"]);
    expect(names(nested).filter((n) => n.startsWith("Screenshot 2026-11-02"))).toHaveLength(1);
    expect(nested.images.find((i) => i.name.startsWith("Screenshot 2026-11-02"))?.folder).toBe("Pictures/Screens");
    const outside = tempDir("tiktok-Shots-");
    const shot = put(outside, "Screenshot 2026-11-03 at 7.00.00 AM.png", "img");
    added[shot] = NOW - 30 * S;
    const out = await findRecentImages(opts({ runner: fakeRunner({ added, sips, screenshotLocation: outside }), folders: ["Screenshots"] }));
    expect(out.searched_folders).toEqual([basename(outside)]);
    expect(out.images.map((i) => [i.name, i.folder])).toEqual([["Screenshot 2026-11-03 at 7.00.00 AM.png", basename(outside)]]);
    const onlyShots = await findRecentImages(opts({ folders: ["Screenshots"] })); // location ~/Downloads
    expect(onlyShots.searched_folders).toEqual(["Downloads"]);
  });

  test("an image sips can't read keeps its place, without dimensions", async () => {
    const p = put(home, "Downloads/unreadable.png", "garbage");
    added[p] = NOW - 2 * MIN;
    try {
      const r = await findRecentImages(opts({ limit: 2 }));
      expect(r.images[1]).toMatchObject({ name: "unreadable.png", is_screenshot: false });
      expect(r.images[1].width).toBeUndefined();
      expect(r.images[1].format).toBeUndefined();
    } finally {
      rmSync(p);
    }
  });
});

describe.skipIf(!darwin)("darwin: real osascript, defaults and sips", () => {
  test("date added from JXA survives touch -t (mtime and birthtime moved back)", async () => {
    const d = tempDir("tiktok-real-added-");
    const p = put(d, "old \"stamp\" 🎉 9.07 PM.png", "x", Date.UTC(2020, 0, 1));
    expect(statSync(p).birthtimeMs).toBe(Date.UTC(2020, 0, 1));
    const out = await dateAdded([p, join(d, "missing.png")], run);
    const v = out.get(p)!;
    expect(Math.abs(v - Date.now())).toBeLessThan(5 * MIN);
    expect(out.has(join(d, "missing.png"))).toBe(false);
  });

  test("screenshotFolder reads the real setting", async () => {
    const home = homedir();
    const raw = await run(["/usr/bin/defaults", "read", "com.apple.screencapture", "location"]);
    const got = await screenshotFolder(home, run);
    expect(got.startsWith("/")).toBe(true);
    const v = raw.stdout.trim();
    if (raw.code !== 0 || !v) expect(got).toBe(join(home, "Desktop"));
    else expect([v.replace(/^~(?=\/|$)/, home).replace(/\/+$/, ""), join(home, "Desktop")]).toContain(got);
  });

  test("end to end: real date added orders files whose mtime says otherwise; real sips fills dimensions", async () => {
    const home = tempDir("tiktok-real-home-");
    put(home, "Downloads/older-arrival.png", pngBytes(6, 4, true), Date.UTC(2025, 0, 1));
    await Bun.sleep(1100);
    put(home, "Downloads/newer-arrival.png", pngBytes(5, 7, false), Date.UTC(2020, 0, 1));
    writeFileSync(join(home, "Downloads", "note.txt"), "x");
    const r = await findRecentImages({ home, source: "any", folders: ["Downloads"], limit: 5, runner: run, clock: { now: () => Date.now(), sleep: async () => {} } });
    expect(r.images.map((i) => i.name)).toEqual(["newer-arrival.png", "older-arrival.png"]);
    expect(r.images[0]).toMatchObject({ width: 5, height: 7, format: "png", has_alpha: false });
    expect(r.images[1]).toMatchObject({ width: 6, height: 4, format: "png", has_alpha: true });
    expect(r.batch_hint).toMatch(/^2 images arrived together at \d{1,2}:\d{2}$/);
  });
});

describe("findRecentVideos: a query that isn't in the folder asked for", () => {
  let home: string;
  const added: Record<string, number> = {};
  beforeAll(() => {
    home = tempDir("tiktok-files-elsewhere-");
    const at = (rel: string, ago: number) => {
      const p = put(home, rel, mp4({ seconds: 37, width: 1080, height: 1920 }), NOW - ago);
      added[p] = NOW - ago;
    };
    at("Downloads/receipt-scan.mp4", 10 * MIN);
    at("Downloads/ep02-hallucinations.mp4", 20 * MIN);
    at("Desktop/screen-test.mov", 30 * MIN);
    at("Movies/Tiny AI Lab/ep01-strawberry-tokens.mp4", 2 * H);
    at("Movies/Tiny AI Lab/ep03-context-window.mp4", 3 * H);
  });
  const opts = (o: Partial<Parameters<typeof findRecentVideos>[0]> = {}) => ({ home, limit: 5, runner: fakeRunner({ added }), clock, ...o });

  test("the owner's words: 'from downloads about strawbery tokens' finds it in Movies › Tiny AI Lab", async () => {
    const runner = fakeRunner({ added });
    const r = await findRecentVideos(opts({ runner, query: "strawbery tokens", folders: ["Downloads"] }));
    expect(r.videos.map((v) => [v.name, v.folder])).toEqual([["ep01-strawberry-tokens.mp4", "Movies/Tiny AI Lab"]]);
    expect(r).toMatchObject({ query_matched: true, query_fuzzy: true, found_elsewhere: true, requested_folders: ["Downloads"] });
    expect(r.searched_folders).toEqual(["Downloads", "Desktop", "Movies"]);
    expect(r.videos[0]).toMatchObject({ duration_sec: 37, width: 1080, height: 1920 });
    // One date-added lookup per pass.
    expect(runner.count("osascript")).toBe(2);
  });

  test("a match in the folder asked for stays there: no second pass, no found_elsewhere", async () => {
    const runner = fakeRunner({ added });
    const r = await findRecentVideos(opts({ runner, query: "halucinations", folders: ["Downloads"] }));
    expect(r.videos.map((v) => v.name)).toEqual(["ep02-hallucinations.mp4"]);
    expect(r).toMatchObject({ query_matched: true, query_fuzzy: true, searched_folders: ["Downloads"] });
    expect(r.found_elsewhere).toBeUndefined();
    expect(runner.count("osascript")).toBe(1);
    // Spelled right: not fuzzy.
    const exact = await findRecentVideos(opts({ query: "hallucinations", folders: ["Downloads"] }));
    expect(exact.query_fuzzy).toBeUndefined();
  });

  test("no match anywhere: the newest of the folder asked for, query_matched false, nothing claimed elsewhere", async () => {
    const r = await findRecentVideos(opts({ query: "zebra crossing", folders: ["Downloads"] }));
    expect(r.videos.map((v) => v.name)).toEqual(["receipt-scan.mp4", "ep02-hallucinations.mp4"]);
    expect(r.query_matched).toBe(false);
    expect(r.found_elsewhere).toBeUndefined();
    expect(r.searched_folders).toEqual(["Downloads"]);
  });

  test("without folders every video folder is already searched: no second pass", async () => {
    const runner = fakeRunner({ added });
    const r = await findRecentVideos(opts({ runner, query: "strawbery" }));
    expect(r.videos.map((v) => v.name)).toEqual(["ep01-strawberry-tokens.mp4"]);
    expect(r.found_elsewhere).toBeUndefined();
    expect(runner.count("osascript")).toBe(1);
  });
});
