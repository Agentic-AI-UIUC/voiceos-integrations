import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEDGER_FILE, Ledger, PICTURES_FILE, PICTURES_SAVED, type NewLedgerEntry } from "../src/ledger.ts";
import type { Clock } from "../src/types.ts";

let t = Date.UTC(2026, 10, 11, 23, 0, 0);
const clock = (): Clock => ({ now: () => (t += 1000), sleep: async () => {} });
const video = (name: string): NewLedgerEntry => ({
  tool: "publish_video",
  kind: "video",
  mode: "direct",
  media: { names: [name], count: 1, duration_sec: 28 },
  details: { caption: "fruit drama", privacy_level: "SELF_ONLY", is_aigc: true },
});
const still = (n: number) => `data:image/jpeg;base64,${Buffer.from(`poster ${n}`).toString("base64")}`;
const loop = `data:image/avif;base64,${Buffer.from("a loop").toString("base64")}`;

const dirs: string[] = [];
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), "ledger-pics-"));
  dirs.push(d);
  return join(d, LEDGER_FILE);
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("Ledger: send stills survive a restart", () => {
  test("a new server on the same file gets the poster and photo thumbnails back; loops stay in memory", () => {
    const file = scratch();
    const first = new Ledger(clock(), { file, account: "ca_ACCOUNT0001" });
    const v = first.start(video("Secret Heir of the Hotel.mp4"));
    first.update(v.task_id, { poster: still(1), motion: { src: loop }, stage: "done" });
    const p = first.start({ ...video("cast"), tool: "post_photos", kind: "photos", thumbs: [still(2), still(3)] });

    const pics = join(file, "..", PICTURES_FILE);
    expect(existsSync(pics)).toBe(true);
    if (process.platform !== "win32") expect(statSync(pics).mode & 0o777).toBe(0o600);
    const onDisk = readFileSync(pics, "utf8");
    expect(onDisk).not.toContain(loop.slice(-12));
    expect(readFileSync(file, "utf8")).not.toContain("data:image");

    const restarted = new Ledger(clock(), { file, account: "ca_ACCOUNT0001" });
    expect(restarted.get(v.task_id)?.poster).toBe(still(1));
    expect(restarted.get(v.task_id)?.motion).toBeUndefined();
    expect(restarted.get(p.task_id)?.thumbs).toEqual([still(2), still(3)]);
  });

  test(`only the newest ${PICTURES_SAVED} sends keep their stills on disk; junk in the file is ignored`, () => {
    const file = scratch();
    const l = new Ledger(clock(), { file, account: "ca_ACCOUNT0001" });
    const ids: string[] = [];
    for (let i = 0; i < PICTURES_SAVED + 3; i++) {
      const e = l.start(video(`ep${i}.mp4`));
      l.update(e.task_id, { poster: still(i) });
      ids.push(e.task_id);
    }
    const saved = JSON.parse(readFileSync(join(file, "..", PICTURES_FILE), "utf8")).pictures;
    expect(Object.keys(saved)).toEqual(ids.slice(-PICTURES_SAVED));

    const restarted = new Ledger(clock(), { file, account: "ca_ACCOUNT0001" });
    expect(restarted.get(ids[0])?.poster).toBeUndefined();
    expect(restarted.get(ids.at(-1)!)?.poster).toBe(still(PICTURES_SAVED + 2));
  });
});
