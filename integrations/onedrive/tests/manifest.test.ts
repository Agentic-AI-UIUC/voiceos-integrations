import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dir, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "voiceos.integration.json"), "utf8"));
const serverSrc = fs.readFileSync(path.join(root, "server.ts"), "utf8");
const registered = [...serverSrc.matchAll(/^registerTool\(\s*"([^"]+)"/gm)].map((m) => m[1]).sort();

const READ_TOOLS = ["list_files", "search_files", "download_file", "read_file"];
const ACT_TOOLS = ["upload_file", "create_folder", "create_share_link", "delete_file"];

describe("voiceos.integration.json", () => {
  test("declares exactly the tools server.ts registers", () => {
    expect(manifest.tools.map((t: any) => t.name).sort()).toEqual(registered);
    expect(registered.sort()).toEqual([...READ_TOOLS, ...ACT_TOOLS].sort());
  });

  test("every description says when to use the tool", () => {
    for (const t of manifest.tools) expect(t.description).toMatch(/Use when/);
  });

  test("acting tools confirm first; read tools don't", () => {
    for (const t of manifest.tools) {
      if (ACT_TOOLS.includes(t.name)) expect(t.confirmation).toBeTruthy();
      else expect(t.confirmation).toBeFalsy();
    }
  });

  test("network permission lists only the hosts the code calls", () => {
    const domains = manifest.permissions.find((p: any) => p.kind === "network").domains;
    expect(domains).toEqual([
      "backend.composio.dev", // tool execution and account lookup
      "temp.4d4f16c61d89ec64e760039c4ec50717.r2.cloudflarestorage.com", // Composio's signed download URLs
      "my.microsoftpersonalcontent.com", // Graph's pre-authenticated download link (personal accounts), the fallback
    ]);
  });

  test("API key is a password preference with no default value", () => {
    const key = manifest.preferences.find((p: any) => p.name === "COMPOSIO_API_KEY");
    expect(key.type).toBe("password");
    expect(key.default).toBeUndefined();
  });

  test("server.ts imports no local module VoiceOS wouldn't publish", () => {
    // Publishing ships server.ts + widgetKit.ts only; any other local import breaks installs.
    const local = [...serverSrc.matchAll(/from "(\.\.?\/[^"]+)"/g)].map((m) => m[1]);
    expect(local).toEqual(["./widgetKit.ts"]);
  });

  test("no secrets or account IDs are committed", () => {
    for (const file of ["voiceos.integration.json", "server.ts", "studio-meta.json"]) {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      expect(text).not.toMatch(/\bak_[A-Za-z0-9_-]{8,}/);
      expect(text).not.toMatch(/\bca_[A-Za-z0-9_-]{8,}/);
    }
  });
});

describe("CARD_THEME preference", () => {
  test("is a select whose values the server understands", () => {
    const pref = manifest.preferences.find((p: any) => p.name === "CARD_THEME");
    expect(pref.type).toBe("select");
    expect(pref.default).toBe("auto");
    expect(pref.options.map((o: any) => o.value).sort()).toEqual(["auto", "dark", "light"]);
  });
});

describe("integration mark", () => {
  test("result cards, confirmation cards and icon.png show the same logo", () => {
    const kit = fs.readFileSync(path.join(root, "widgetKit.ts"), "utf8");
    const kitMark = kit.match(/^let INTEGRATION_MARK = "(data:image\/png;base64,[^"]+)";/m)?.[1];
    expect(kitMark).toBeTruthy();
    for (const t of manifest.tools.filter((t: any) => t.confirmation)) {
      const marks = [...t.confirmation.root.html.matchAll(/data:image\/png;base64,[A-Za-z0-9+\/=]+/g)].map((m) => m[0]);
      expect(marks.length).toBeGreaterThan(0);
      for (const mark of marks) expect(mark).toBe(kitMark);
    }
    // Both are RGBA PNGs (byte 25 is the colour type; 6 = RGBA). The old mark was opaque RGB.
    const png = (b64: string) => Buffer.from(b64.split(",")[1], "base64");
    expect(png(kitMark!)[25]).toBe(6);
    expect(fs.readFileSync(path.join(root, "icon.png"))[25]).toBe(6);
  });
});
