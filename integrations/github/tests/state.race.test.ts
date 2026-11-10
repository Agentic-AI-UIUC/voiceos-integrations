/**
 * The state store against a write that lands while another process is in the
 * middle of reading. node:fs is wrapped so the interleaving is exact rather
 * than left to timing; the rest of the suite uses the real module.
 */
import { afterEach, expect, mock, test } from "bun:test";
import * as realFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The originals, captured before the module binding is replaced.
const fs = { ...realFs };
let interleave: (() => void) | undefined;
mock.module("node:fs", () => ({
  ...fs,
  readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
    const out = fs.readFileSync(...args);
    const readsState = typeof args[0] === "number" || String(args[0]).endsWith("state.json");
    const hook = interleave;
    if (hook && readsState) {
      interleave = undefined;
      hook();
    }
    return out;
  },
}));
const { OperationLedger, StateStore } = await import("../src/state.ts");

const dirs: string[] = [];
afterEach(() => {
  interleave = undefined;
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

// Windows can't replace a file while it's open, so there a write can't land
// mid-read: the writer waits until the read is done (whenFree in state.ts).
test.if(process.platform !== "win32")("a write that lands while another process is reading the state is never written over", () => {
  const dir = fs.mkdtempSync(join(tmpdir(), "gh-race-"));
  dirs.push(dir);
  const until = Date.now() + 60_000;
  const voiceos = new OperationLedger(new StateStore(dir));
  expect(voiceos.consumeReceipt("first", until)).toBe(true);
  // A second server opens the folder; while it reads, the first one writes again.
  interleave = () => {
    expect(voiceos.consumeReceipt("second", until)).toBe(true);
  };
  const studio = new OperationLedger(new StateStore(dir));
  expect(interleave).toBeUndefined();
  expect(studio.consumeReceipt("third", until)).toBe(true);
  expect(studio.consumeReceipt("second", until)).toBe(false);
  expect(Object.keys(new StateStore(dir).snapshot().usedReceipts).sort()).toEqual(["first", "second", "third"]);
});
