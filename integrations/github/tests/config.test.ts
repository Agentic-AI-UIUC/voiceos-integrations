import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function folder(manifest: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "gh-cfg-"));
  dirs.push(dir);
  writeFileSync(join(dir, "voiceos.integration.json"), JSON.stringify(manifest));
  return dir;
}

const widget = () => ({ schemaVersion: 1, root: { type: "widget", html: `<script>var GH_TOOL = "x";</script>`, confirmLabel: "Go" } });
const manifest = () => ({
  id: "com.voiceos.generated.github-composio",
  version: "2.0.0",
  tools: [
    { name: "get_issue", inputSchema: { type: "object" } },
    { name: "create_issue", inputSchema: { type: "object" }, confirmation: widget() },
    { name: "update_issue", inputSchema: { type: "object" }, confirmation: widget() },
    { name: "create_issue_comment", inputSchema: { type: "object" }, confirmation: widget() },
    { name: "create_pull_request_review", inputSchema: { type: "object" }, confirmation: widget() },
  ],
});

describe("loadConfig", () => {
  test("reads setup fields as VoiceOS injects them (strings)", () => {
    const dir = folder(manifest());
    const cfg = loadConfig(
      {
        COMPOSIO_PROJECT_API_KEY: "  ak_live  ",
        GITHUB_CONNECTION: "false",
        COMPOSIO_GITHUB_AUTH_CONFIG_ID: "ac_1",
        // Removed settings: values VoiceOS still stores for them are ignored.
        GITHUB_KILL_SWITCH: "true",
        COMPOSIO_USER_ID: " me ",
      },
      dir,
    );
    expect(cfg).toEqual({
      apiKey: "ak_live",
      baseUrl: "https://backend.composio.dev",
      connectionEnabled: false,
      authConfigPin: "ac_1",
      stateDir: join(dir, ".state"),
    });
  });

  test("defaults: connected, no key", () => {
    const cfg = loadConfig({}, folder(manifest()));
    expect(cfg).toMatchObject({ connectionEnabled: true });
    expect(cfg.apiKey).toBeUndefined();
  });

  test("values left over from fields earlier versions declared change nothing", () => {
    const dir = folder(manifest());
    const stale = loadConfig({ GITHUB_ENVIRONMENT: "production", GITHUB_TEST_REPOSITORIES: "acme/desktop" }, dir);
    expect(stale).toEqual(loadConfig({}, dir));
  });

  test("test seams come from command-line arguments, never from undeclared env vars", () => {
    const dir = folder(manifest());
    const cfg = loadConfig({}, dir, ["--composio-base-url=http://127.0.0.1:5555", "--state-dir=/tmp/x"]);
    expect(cfg.baseUrl).toBe("http://127.0.0.1:5555");
    expect(cfg.stateDir).toBe("/tmp/x");
    expect(loadConfig({}, dir, ["--composio-base-url=https://attacker.example"]).baseUrl).toBe("https://backend.composio.dev");
    expect(loadConfig({ COMPOSIO_BASE_URL: "http://127.0.0.1:5555", GITHUB_STATE_DIR: "/tmp/y" }, dir).baseUrl).toBe("https://backend.composio.dev");
    expect(loadConfig({ GITHUB_STATE_DIR: "/tmp/y" }, dir).stateDir).toBe(join(dir, ".state"));
  });
});
