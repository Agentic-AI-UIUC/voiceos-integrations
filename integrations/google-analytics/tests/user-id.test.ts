import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveUserId } from "../server.ts";

const stateFile = () => join(mkdtempSync(join(tmpdir(), "ga-user-")), ".composio-user.json");

test("COMPOSIO_USER_ID from .env wins and nothing is written", () => {
  const file = stateFile();
  expect(resolveUserId("default", file)).toBe("default");
  expect(() => readFileSync(file)).toThrow();
});

test("without one, each install gets its own voiceos-<id>, kept across restarts (installs never share a Google account)", () => {
  const file = stateFile();
  const first = resolveUserId(undefined, file);
  expect(first).toMatch(/^voiceos-[0-9a-f-]{36}$/);
  expect(resolveUserId("  ", file)).toBe(first);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ userId: first });
});

test("a damaged state file is an error, not a silent new identity (which would orphan the connection)", () => {
  const file = stateFile();
  writeFileSync(file, '{"userId":"someone-else"}');
  expect(() => resolveUserId(undefined, file)).toThrow(/\.composio-user\.json/);
});

test("the file goes in a folder that may not exist yet (~/.voiceos on a fresh machine)", () => {
  const file = join(mkdtempSync(join(tmpdir(), "ga-user-")), "new-dir", "user.json");
  const id = resolveUserId(undefined, file);
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ userId: id });
});

test("an id saved by 1.0.0 next to server.ts is carried over, so the existing connection keeps working", () => {
  const legacy = stateFile();
  writeFileSync(legacy, JSON.stringify({ userId: "voiceos-00000000-0000-0000-0000-000000000001" }));
  const file = stateFile();
  expect(resolveUserId(undefined, file, legacy)).toBe("voiceos-00000000-0000-0000-0000-000000000001");
  expect(JSON.parse(readFileSync(file, "utf8")).userId).toBe("voiceos-00000000-0000-0000-0000-000000000001");
});

test("the new file wins over the old one", () => {
  const legacy = stateFile();
  writeFileSync(legacy, JSON.stringify({ userId: "voiceos-00000000-0000-0000-0000-000000000001" }));
  const file = stateFile();
  writeFileSync(file, JSON.stringify({ userId: "voiceos-00000000-0000-0000-0000-000000000002" }));
  expect(resolveUserId(undefined, file, legacy)).toBe("voiceos-00000000-0000-0000-0000-000000000002");
});
