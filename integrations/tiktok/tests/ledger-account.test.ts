import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEDGER_FILE, Ledger, accountTag, type NewLedgerEntry } from "../src/ledger.ts";
import type { Clock } from "../src/types.ts";

const clock = (): Clock => ({ now: () => Date.UTC(2026, 10, 10, 21, 0, 0), sleep: async () => {} });
const video = (name: string): NewLedgerEntry => ({
  tool: "publish_video",
  kind: "video",
  mode: "direct",
  media: { names: [name], count: 1, duration_sec: 62 },
  details: { caption: "fruit drama ep 1", privacy_level: "SELF_ONLY", is_aigc: true },
});

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "ledger-acct-"));
  dirs.push(d);
  return join(d, LEDGER_FILE);
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Ledger: one history per TikTok connection", () => {
  test("a newly connected account starts empty; switching back shows the old account's sends again", () => {
    const file = scratch();
    const old = new Ledger(clock(), { file, account: "ca_OLDACCOUNT01" });
    const sent = old.start(video("ep01-strawberry-tokens.mp4"));
    old.update(sent.task_id, { publish_id: "v_pub_old", stage: "done" });

    const fresh = new Ledger(clock(), { file, account: "ca_NEWACCOUNT02" });
    expect(fresh.list()).toEqual([]);
    expect(fresh.latest()).toBeUndefined();
    expect(fresh.byPublishId("v_pub_old")).toBeUndefined();
    expect(fresh.get(sent.task_id)).toBeUndefined();
    expect(fresh.size).toBe(0);

    const mine = fresh.start(video("ep01-strawberry-never-paid.mp4"));
    expect(fresh.list().map((e) => e.media.names[0])).toEqual(["ep01-strawberry-never-paid.mp4"]);

    const back = new Ledger(clock(), { file, account: "ca_OLDACCOUNT01" });
    expect(back.list().map((e) => e.media.names[0])).toEqual(["ep01-strawberry-tokens.mp4"]);
    expect(back.get(mine.task_id)).toBeUndefined();
  });

  test("the disk keeps a hash of the connection, never the connected account id", () => {
    const file = scratch();
    new Ledger(clock(), { file, account: "ca_TESTACCOUNT03" }).start(video("ep02.mp4"));
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("ca_TESTACCOUNT03");
    expect(JSON.parse(raw).entries[0].account).toBe(accountTag("ca_TESTACCOUNT03"));
    expect(accountTag("ca_TESTACCOUNT03")).toMatch(/^[0-9a-f]{16}$/);
  });

  test("entries from before tagging are hidden once a connection is set, and still read without one", () => {
    const file = scratch();
    writeFileSync(file, JSON.stringify({
      version: 1,
      entries: [{
        task_id: "t_0123456789ab", rev: 1, tool: "upload_video", kind: "video", mode: "drafts", stage: "done",
        created_at: "2026-11-06T10:00:00.000Z", updated_at: "2026-11-06T10:01:00.000Z",
        media: { names: ["ep01-strawberry-tokens.mp4"], count: 1 }, details: {},
      }],
    }));
    expect(new Ledger(clock(), { file, account: "ca_NEWACCOUNT02" }).list()).toEqual([]);
    expect(new Ledger(clock(), { file }).list().map((e) => e.task_id)).toEqual(["t_0123456789ab"]);
  });

  test("a malformed tag on disk is dropped, not trusted", () => {
    const file = scratch();
    writeFileSync(file, JSON.stringify({
      version: 1,
      entries: [{
        task_id: "t_0123456789ac", rev: 1, account: "ca_NEWACCOUNT02", tool: "upload_video", kind: "video",
        mode: "drafts", stage: "done", created_at: "2026-11-06T10:00:00.000Z", updated_at: "2026-11-06T10:01:00.000Z",
        media: { names: ["x.mp4"], count: 1 }, details: {},
      }],
    }));
    const l = new Ledger(clock(), { file });
    expect(l.list()[0].account).toBeUndefined();
    expect(new Ledger(clock(), { file, account: "ca_NEWACCOUNT02" }).list()).toEqual([]);
  });
});

describe("send rows: a send TikTok never finished", () => {
  test("processing for hours reads 'Didn't finish' (neutral), not 'Processing'", async () => {
    const { sendRow, sendsInWords, STALLED_AFTER_MS } = await import("../src/tools/reads.ts");
    const now = Date.UTC(2026, 10, 10, 21, 0, 0);
    const at = (msAgo: number) => new Date(now - msAgo).toISOString();
    const base = {
      task_id: "t_0123456789ad", tool: "post_photos" as const, kind: "photos" as const, mode: "direct" as const,
      media: { names: ["a.jpg", "b.jpg"], count: 2, folder: "meet the cast" }, details: {}, publish_id: "p_1",
    };
    const fresh = { ...base, stage: "processing" as const, created_at: at(60_000), updated_at: at(60_000) };
    const old = { ...base, stage: "processing" as const, created_at: at(STALLED_AFTER_MS + 60_000), updated_at: at(STALLED_AFTER_MS) };
    expect(sendRow(fresh, now)).toMatchObject({ mark: "Processing", state: "processing" });
    expect(sendRow(old, now)).toMatchObject({ mark: "Didn't finish", state: "stalled" });
    expect(sendsInWords([old], now)).toContain("that TikTok never finished");
    expect(sendsInWords([old], now)).not.toContain("processing");
  });
});

describe("send rows: titles", () => {
  test("a photo post's row shows its own title, falling back to the folder", async () => {
    const { sendRow } = await import("../src/tools/reads.ts");
    const now = Date.UTC(2026, 10, 10, 21, 0, 0);
    const base = {
      task_id: "t_0123456789ae", tool: "post_photos" as const, kind: "photos" as const, mode: "direct" as const, stage: "done" as const,
      created_at: new Date(now - 60_000).toISOString(), updated_at: new Date(now).toISOString(), last_status: "PUBLISH_COMPLETE" as const,
      media: { names: ["01.jpg", "02.jpg"], count: 2, folder: "Juicy Drama cast" },
    };
    expect(sendRow({ ...base, details: { title: "Meet the Juicy Drama cast" } }, now).title).toBe("Meet the Juicy Drama cast");
    expect(sendRow({ ...base, details: {} }, now).title).toBe("Juicy Drama cast");
  });
});
