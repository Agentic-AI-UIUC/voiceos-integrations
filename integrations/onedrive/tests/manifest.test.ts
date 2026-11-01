import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const root = path.join(import.meta.dir, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "voiceos.integration.json"), "utf8"));
const serverSrc = fs.readFileSync(path.join(root, "server.ts"), "utf8");
const registered = [...serverSrc.matchAll(/server\.registerTool\(\s*"([^"]+)"/g)].map((m) => m[1]).sort();

const READ_TOOLS = ["list_files", "search_files", "download_file"];
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

  test("network permission lists only the host the code calls", () => {
    const domains = manifest.permissions.find((p: any) => p.kind === "network").domains;
    expect(domains).toEqual(["backend.composio.dev"]);
  });

  test("API key is a password preference with no default value", () => {
    const key = manifest.preferences.find((p: any) => p.name === "COMPOSIO_API_KEY");
    expect(key.type).toBe("password");
    expect(key.default).toBeUndefined();
  });

  test("no secrets or account IDs are committed", () => {
    for (const file of ["voiceos.integration.json", "server.ts", "onedrive.ts", "studio-meta.json"]) {
      const text = fs.readFileSync(path.join(root, file), "utf8");
      expect(text).not.toMatch(/\bak_[A-Za-z0-9_-]{8,}/);
      expect(text).not.toMatch(/\bca_[A-Za-z0-9_-]{8,}/);
    }
  });
});
