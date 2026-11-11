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
