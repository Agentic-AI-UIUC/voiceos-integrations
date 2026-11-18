import { describe, expect, test } from "bun:test";
import { LEDGER_SIZE, Ledger, WriteQueue, type NewLedgerEntry } from "../src/ledger.ts";
import type { Clock } from "../src/types.ts";

function clock(start = Date.UTC(2026, 10, 3, 18, 0, 0)): Clock & { advance(ms: number): void } {
  let t = start;
  return { now: () => t, sleep: async (ms) => void (t += ms), advance: (ms) => void (t += ms) };
}

const video = (name = "final_export.mp4"): NewLedgerEntry => ({
  tool: "upload_video",
  kind: "video",
  mode: "drafts",
  media: { names: [name], count: 1, duration_sec: 23 },
  details: { caption: "day 3 #buildinpublic" },
});

describe("Ledger", () => {
  test("start records a staging entry with our task id and timestamps", () => {
    const c = clock();
    const l = new Ledger(c);
    const e = l.start(video());
    expect(e.task_id).toMatch(/^t_[0-9a-f]{12}$/);
    expect(e.stage).toBe("staging");
    expect(e.created_at).toBe(new Date(c.now()).toISOString());
    expect(e.updated_at).toBe(e.created_at);
    expect(e.publish_id).toBeUndefined();
    expect(l.latest()).toEqual(e);
  });

  test("update moves the stage along, sets the publish_id and the caption_copied detail; unknown ids are ignored", () => {
    const c = clock();
    const l = new Ledger(c);
    const e = l.start(video());
    c.advance(5_000);
    l.update(e.task_id, { stage: "uploading" });
    l.update(e.task_id, { stage: "processing", publish_id: "v_inbox_file~v2.1", caption_copied: true });
    const after = l.update(e.task_id, { last_status: "SEND_TO_USER_INBOX", stage: "done" })!;
    expect(after).toMatchObject({ stage: "done", publish_id: "v_inbox_file~v2.1", last_status: "SEND_TO_USER_INBOX" });
    expect(after.details.caption_copied).toBe(true);
    expect(after.updated_at).toBe(new Date(c.now()).toISOString());
    expect(l.update("t_nope", { stage: "failed" })).toBeUndefined();
    // Undefined patch values don't erase what's there.
    expect(l.update(e.task_id, { publish_id: undefined })!.publish_id).toBe("v_inbox_file~v2.1");
  });

  test("hands out copies: callers can't change the record", () => {
    const l = new Ledger(clock());
    const e = l.start(video());
    e.stage = "failed";
    e.media.names.push("/Users/me/secret.mov");
    expect(l.get(e.task_id)!.stage).toBe("staging");
    expect(l.get(e.task_id)!.media.names).toEqual(["final_export.mp4"]);
  });

  test("byPublishId finds the newest entry with that id; list is newest first", () => {
    const l = new Ledger(clock());
    const a = l.start(video("a.mp4"));
    const b = l.start(video("b.mp4"));
    l.update(a.task_id, { publish_id: "v_1" });
    l.update(b.task_id, { publish_id: "v_2" });
    expect(l.byPublishId(" v_1 ")!.media.names).toEqual(["a.mp4"]);
    expect(l.byPublishId("v_3")).toBeUndefined();
    expect(l.list().map((e) => e.media.names[0])).toEqual(["b.mp4", "a.mp4"]);
  });

  test(`a ring of the last ${LEDGER_SIZE} writes`, () => {
    const l = new Ledger(clock());
    const ids = Array.from({ length: LEDGER_SIZE + 3 }, (_, i) => l.start(video(`clip${i}.mp4`)).task_id);
    expect(l.size).toBe(LEDGER_SIZE);
    expect(l.get(ids[0])).toBeUndefined();
    expect(l.get(ids[3])).toBeDefined();
    expect(l.latest()!.media.names).toEqual([`clip${LEDGER_SIZE + 2}.mp4`]);
  });
});

describe("WriteQueue: one write at a time per account", () => {
  const tick = () => new Promise((r) => setTimeout(r, 5));

  test("a second write waits until the first releases; slots go in arrival order", async () => {
    const q = new WriteQueue();
    const order: string[] = [];
    const r1 = await q.acquire("ca_1");
    const p2 = q.acquire("ca_1").then((release) => (order.push("2"), release));
    const p3 = q.acquire("ca_1").then((release) => (order.push("3"), release));
    await tick();
    expect(order).toEqual([]);
    expect(q.depth("ca_1")).toBe(3);
    r1();
    const r2 = await p2;
    await tick();
    expect(order).toEqual(["2"]);
    r2();
    (await p3)();
    expect(order).toEqual(["2", "3"]);
    expect(q.depth("ca_1")).toBe(0);
  });

  test("release is idempotent, and other accounts don't wait", async () => {
    const q = new WriteQueue();
    const r1 = await q.acquire("ca_1");
    const other = await Promise.race([q.acquire("ca_2").then(() => "ran"), tick().then(() => "waited")]);
    expect(other).toBe("ran");
    r1();
    r1();
    const r2 = await Promise.race([q.acquire("ca_1").then((r) => r), tick().then(() => undefined)]);
    expect(r2).toBeDefined();
    r2!();
    const r3 = await q.acquire("ca_1");
    r3();
    expect(q.depth("ca_1")).toBe(0);
  });
});
