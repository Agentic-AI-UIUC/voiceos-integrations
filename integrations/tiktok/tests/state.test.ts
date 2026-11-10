import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureDir, readJson, writeJsonAtomic } from "../src/state.ts";

/** Root ignores permission bits, so the "can't write" cases only mean something for a normal user. */
const isRoot = process.getuid?.() === 0;

const roots: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), "tiktok-state-"));
  roots.push(d);
  return d;
}
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

const modeOf = (p: string) => statSync(p).mode & 0o777;

describe("ensureDir", () => {
  test("creates missing folders, private to the user", () => {
    const root = freshDir();
    const dir = join(root, "integration-state", "com.voiceos.generated.tiktok");
    ensureDir(dir);
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(modeOf(dir)).toBe(0o700);
    expect(modeOf(join(root, "integration-state"))).toBe(0o700);
  });

  test("tightens an existing folder others can read, and is idempotent", () => {
    const dir = join(freshDir(), "state");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    ensureDir(dir);
    expect(modeOf(dir)).toBe(0o700);
    ensureDir(dir);
    expect(modeOf(dir)).toBe(0o700);
  });

  test("never loosens a folder: a read-only folder stays read-only", () => {
    const dir = join(freshDir(), "state");
    mkdirSync(dir);
    chmodSync(dir, 0o500);
    try {
      ensureDir(dir);
      expect(modeOf(dir)).toBe(0o500);
    } finally {
      chmodSync(dir, 0o700);
    }
  });

  test("throws when a file sits where the folder should be", () => {
    const path = join(freshDir(), "state");
    writeFileSync(path, "not a folder");
    expect(() => ensureDir(path)).toThrow();
  });
});

describe("readJson", () => {
  test("a missing file gives the fallback", () => {
    const fallback = { spent: [] as unknown[] };
    expect(readJson(join(freshDir(), "nope.json"), fallback)).toBe(fallback);
  });

  test("reads what's there", () => {
    const file = join(freshDir(), "s.json");
    writeFileSync(file, '{"version":1,"spent":[{"digest":"ab","tool":"upload_video","exp":5}]}');
    expect(readJson<unknown>(file, null)).toEqual({ version: 1, spent: [{ digest: "ab", tool: "upload_video", exp: 5 }] });
  });

  test("corrupt or empty JSON gives the fallback instead of throwing", () => {
    const dir = freshDir();
    writeFileSync(join(dir, "corrupt.json"), "{not json");
    writeFileSync(join(dir, "empty.json"), "");
    writeFileSync(join(dir, "cut.json"), '{"version":1,"spent":[{"dig');
    expect(readJson(join(dir, "corrupt.json"), "fallback")).toBe("fallback");
    expect(readJson(join(dir, "empty.json"), "fallback")).toBe("fallback");
    expect(readJson(join(dir, "cut.json"), "fallback")).toBe("fallback");
  });

  test("a folder where the file should be gives the fallback", () => {
    const dir = freshDir();
    mkdirSync(join(dir, "s.json"));
    expect(readJson(join(dir, "s.json"), 7)).toBe(7);
  });

  test.skipIf(isRoot)("an unreadable file gives the fallback", () => {
    const file = join(freshDir(), "s.json");
    writeFileSync(file, '{"a":1}');
    chmodSync(file, 0o000);
    try {
      expect(readJson(file, "fallback")).toBe("fallback");
    } finally {
      chmodSync(file, 0o600);
    }
  });
});

describe("writeJsonAtomic", () => {
  test("writes JSON that readJson reads back, mode 0600, leaving no temp files", () => {
    const dir = freshDir();
    const file = join(dir, "spent-receipts.json");
    writeJsonAtomic(file, { version: 1, spent: [{ digest: "a".repeat(64), tool: "post_photos", exp: 1 }] });
    expect(readJson<unknown>(file, null)).toEqual({ version: 1, spent: [{ digest: "a".repeat(64), tool: "post_photos", exp: 1 }] });
    expect(modeOf(file)).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["spent-receipts.json"]);
  });

  test("replaces the file in one step (a new file renamed over the old one)", () => {
    const dir = freshDir();
    const file = join(dir, "s.json");
    writeFileSync(file, JSON.stringify({ long: "x".repeat(5000) }));
    chmodSync(file, 0o644);
    const before = statSync(file).ino;
    writeJsonAtomic(file, { short: true });
    expect(statSync(file).ino).not.toBe(before);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ short: true });
    expect(modeOf(file)).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["s.json"]);
  });

  test("creates the parent folder, private to the user", () => {
    const root = freshDir();
    const file = join(root, "integration-state", "com.voiceos.generated.tiktok", "spent-receipts.json");
    writeJsonAtomic(file, []);
    expect(readJson<unknown>(file, null)).toEqual([]);
    expect(modeOf(join(root, "integration-state", "com.voiceos.generated.tiktok"))).toBe(0o700);
  });

  test("leaves an existing folder's permissions alone (it may be pointed anywhere)", () => {
    const dir = join(freshDir(), "Shared");
    mkdirSync(dir);
    chmodSync(dir, 0o755);
    writeJsonAtomic(join(dir, "s.json"), { a: 1 });
    expect(modeOf(dir)).toBe(0o755);
  });

  test("honours a custom mode", () => {
    const file = join(freshDir(), "s.json");
    writeJsonAtomic(file, { a: 1 }, 0o640);
    expect(modeOf(file)).toBe(0o640);
  });

  test("a value that can't be serialized throws before touching the disk", () => {
    const dir = freshDir();
    const file = join(dir, "s.json");
    writeFileSync(file, '{"old":true}');
    expect(() => writeJsonAtomic(file, { n: 1n })).toThrow();
    expect(() => writeJsonAtomic(file, undefined)).toThrow();
    expect(readFileSync(file, "utf8")).toBe('{"old":true}');
    expect(readdirSync(dir)).toEqual(["s.json"]);
  });

  test("a failed rename (a folder where the file should be) throws and removes its temp file", () => {
    const dir = freshDir();
    const target = join(dir, "s.json");
    mkdirSync(target);
    writeFileSync(join(target, "keep"), "x");
    expect(() => writeJsonAtomic(target, { a: 1 })).toThrow();
    expect(readdirSync(dir)).toEqual(["s.json"]);
    expect(readdirSync(target)).toEqual(["keep"]);
  });

  test.skipIf(isRoot)("throws when the folder isn't writable, keeping the old file and leaving no temp file", () => {
    const dir = join(freshDir(), "state");
    mkdirSync(dir, { mode: 0o700 });
    const file = join(dir, "s.json");
    writeJsonAtomic(file, { old: true });
    chmodSync(dir, 0o500);
    try {
      expect(() => writeJsonAtomic(file, { new: true })).toThrow();
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readJson<unknown>(file, null)).toEqual({ old: true });
    expect(readdirSync(dir)).toEqual(["s.json"]);
  });
});
