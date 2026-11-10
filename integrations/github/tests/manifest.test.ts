/**
 * The generated manifest against VoiceOS's own validation rules (mirrored from
 * the installed host's validateManifest) and against the running server.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FACADES, TOOL_META, WRITE_TOOLS } from "../src/catalog.ts";
import { Gateway } from "../src/gateway.ts";
import { createServer } from "../src/mcpServer.ts";

const ROOT = join(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(join(ROOT, "voiceos.integration.json"), "utf8"));
const raw = readFileSync(join(ROOT, "voiceos.integration.json"), "utf8");

async function serverTools() {
  const dir = mkdtempSync(join(tmpdir(), "gh-man-"));
  const gateway = new Gateway({
    baseUrl: "http://127.0.0.1:9", connectionEnabled: true, stateDir: dir, poll: false, auditFile: false,
  });
  const [s, c] = InMemoryTransport.createLinkedPair();
  await createServer(gateway).connect(s);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(c);
  const { tools } = await client.listTools();
  await client.close();
  rmSync(dir, { recursive: true, force: true });
  return tools;
}

describe("identity and runtime (must not drift from the installed integration)", () => {
  test("id and publisher are as generated; the runtime is VoiceOS's own bun launch, which sharing accepts", () => {
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.id).toBe("com.voiceos.generated.github-composio");
    expect(manifest.id).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+)+$/);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.publisher).toEqual({ id: "pub_user", name: "Made in VoiceOS" });
    // The share review rejects a runtime that spawns a shell; VoiceOS's bundled integrations use exactly this.
    expect(manifest.runtime).toEqual({ kind: "local-mcp", command: "bun", args: ["server.ts"] });
    // VoiceOS ships for Mac and Windows x64 (issue #35).
    expect(manifest.supportedPlatforms).toEqual(["darwin", "win32"]);
    expect(manifest.icon).toBe("icon.png");
    expect(manifest.name).toBe("GitHub");
    expect(manifest.summary.length).toBeGreaterThan(0);
    expect(manifest.summary.length).toBeLessThanOrEqual(140);
  });

  test("network access is Composio only", () => {
    expect(manifest.permissions).toEqual([{ kind: "network", domains: ["backend.composio.dev"] }]);
  });

  test("no credentials are shipped in the manifest", () => {
    expect(raw).not.toMatch(/\b(ck|ak|uak)_[A-Za-z0-9]{12,}/);
    expect(raw).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{20,}/);
  });
});

describe("setup fields", () => {
  const prefs: any[] = manifest.preferences;
  const byName = Object.fromEntries(prefs.map((p) => [p.name, p]));

  test("each is valid, unique, and says where its value comes from", () => {
    expect(new Set(prefs.map((p) => p.name)).size).toBe(prefs.length);
    for (const p of prefs) {
      expect(p.name).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
      expect(["text", "password", "boolean", "select", "number"]).toContain(p.type);
      expect(p.title.length).toBeGreaterThan(0);
      expect(typeof p.description).toBe("string");
      if (p.type === "select") expect(p.options.length).toBeGreaterThan(0);
    }
  });

  test("the Composio project key is a required secret with no default; old fields are gone", () => {
    expect(byName.COMPOSIO_PROJECT_API_KEY).toMatchObject({ type: "password", required: true });
    expect("default" in byName.COMPOSIO_PROJECT_API_KEY).toBe(false);
    for (const gone of ["COMPOSIO_API_KEY", "COMPOSIO_ENTITY_ID", "GITHUB_TOKEN"]) expect(byName[gone]).toBeUndefined();
    expect(manifest.auth).toBeUndefined();
  });

  test("every variable the server reads is declared, with safe defaults", () => {
    // The kill switch duplicated VoiceOS's own on/off switch, and a user ID override had no use (user, 2026-10-28).
    expect(Object.keys(byName).sort()).toEqual(["COMPOSIO_GITHUB_AUTH_CONFIG_ID", "COMPOSIO_PROJECT_API_KEY", "GITHUB_CONNECTION"]);
    expect(byName.GITHUB_CONNECTION).toMatchObject({ type: "boolean", default: true });
    expect(byName.COMPOSIO_GITHUB_AUTH_CONFIG_ID).toMatchObject({ title: "Your own GitHub OAuth app (optional)" });
    expect(byName.COMPOSIO_GITHUB_AUTH_CONFIG_ID.description).toStartWith("Leave blank to sign in through Composio's GitHub app.");
    const source = ["src/config.ts", "src/gateway.ts", "src/connection.ts", "src/composio.ts", "src/main.ts"]
      .map((f) => readFileSync(join(ROOT, f), "utf8"))
      .join("\n");
    const read = new Set([...source.matchAll(/(?:env\.|text\(")([A-Z][A-Z0-9_]+)/g)].map((m) => m[1]));
    for (const name of read) expect(Object.keys(byName)).toContain(name);
  });
});

describe("tools", () => {
  test("exactly the eight facades, matching the running server name for name and schema for schema", async () => {
    const live = await serverTools();
    expect(manifest.tools.map((t: any) => t.name)).toEqual([...FACADES]);
    for (const t of manifest.tools) {
      const server = live.find((s) => s.name === t.name)!;
      expect(t.title).toBe(TOOL_META[t.name as keyof typeof TOOL_META].title);
      expect(t.description).toBe(server.description);
      const { $schema: _a, ...serverSchema } = server.inputSchema as any;
      expect(t.inputSchema).toEqual(serverSchema);
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  test("every description describes the tool and when to use it, without steering the agent (VoiceOS's share review)", () => {
    // Phrasings the share review rejected on October 28, 2026, and their kin.
    const steering = /\bnever\b|\bdon't\b|\bstop\b|\bverbatim\b|your reply|list_integrations|web search|read(ing)? (this )?out|spoken yes|go straight/i;
    for (const t of manifest.tools) {
      expect(t.description).toContain("Use when");
      expect(t.description.length).toBeLessThanOrEqual(600);
      expect({ tool: t.name, steering: t.description.match(steering)?.[0] ?? null }).toEqual({ tool: t.name, steering: null });
      // Examples are things people say, not owner/repo commands.
      expect(t.description).not.toContain("acme/");
      // Plain results: Agent Mode writes the answer from the data (Dario, 2026-10-28).
      expect(t.description).toMatch(/GitHub link/);
      expect(t.description).not.toContain("spoken");
      expect(t.description).toContain("If GitHub isn't connected, the result is a Connect GitHub card.");
      if (t.name === "search_code") expect(t.description).toContain("private ones included");
      if (WRITE_TOOLS.has(t.name)) expect(t.description).toContain("VoiceOS shows a confirmation card");
    }
  });

  test("the detail page and the server's instructions describe the integration rather than steer the agent", async () => {
    const { CAPABILITY_GUIDANCE } = await import("../src/mcpServer.ts");
    const steering = /\bsay so\b|instead of|before answering|explain only|\bnever\b|\bdon't\b|\bdo not\b|use this connected/i;
    for (const [where, text] of [["manifest description", manifest.description], ["MCP instructions", CAPABILITY_GUIDANCE]] as const) {
      expect({ where, steering: text.match(steering)?.[0] ?? null }).toEqual({ where, steering: null });
    }
    expect(manifest.description).toContain("where behavior is implemented");
  });

  test("reads have no confirmation; writes have a locked widget confirmation", () => {
    for (const t of manifest.tools) {
      if (!WRITE_TOOLS.has(t.name)) {
        expect(t.confirmation).toBeUndefined();
        expect(t.hidePermissionToggle).toBeUndefined();
        continue;
      }
      expect(t.hidePermissionToggle).toBe(true);
      const root = t.confirmation.root;
      expect(t.confirmation.schemaVersion).toBe(1);
      expect(root.type).toBe("widget");
      expect(root.children).toBeUndefined();
      expect(root.footer).toBeUndefined();
      expect(root.html.length).toBeLessThanOrEqual(300_000);
      expect(root.height).toBeGreaterThanOrEqual(60);
      expect(root.height).toBeLessThanOrEqual(420);
      expect(root.confirmLabel.trim().length).toBeGreaterThan(0);
      expect(root.confirmLabel.length).toBeLessThanOrEqual(60);
      expect(root.label.length).toBeLessThanOrEqual(60);
      if (root.data !== undefined) expect(JSON.stringify(root.data).length).toBeLessThanOrEqual(16_384);
      const props = Object.keys(t.inputSchema.properties);
      for (const m of root.html.matchAll(/data-gh-key="([^"]+)"/g)) expect(props).toContain(m[1]);
      expect(props).toContain("confirmation_receipt");
    }
  });

  test("all four cards share one receipt key", () => {
  });
});

describe("detail page", () => {
  test("states the real scope, the eight actions, how to disconnect, and the pending production review", () => {
    const d: string = manifest.description;
    for (const s of [
      "`repo` scope",
      "Get an issue", "Create an issue", "Update an issue", "Comment on an issue or pull request",
      "List pull requests", "Review a pull request", "Search repositories", "Search code",
      "Use my GitHub connection",
    ]) expect(d).toContain(s);
    expect(d).not.toContain("**Set up**");
    expect(d).toStartWith("**⚠️ SOC 2 review pending");
    expect(d).toContain("VoiceOS approval is required before production release");
    expect(d).not.toContain("production is blocked");
    expect(raw).not.toMatch(/test repositor|release channel/i);
  });

  test("setup steps sit in the setup guide above Configure, ending with something to say", () => {
    const guide = manifest.setupGuide;
    expect(guide.title.length).toBeLessThanOrEqual(100);
    expect(guide.blocks.length).toBeLessThanOrEqual(24);
    for (const b of guide.blocks) {
      expect(["heading", "text"]).toContain(b.type);
      expect(b.text.trim().length).toBeGreaterThan(0);
      expect(b.text.length).toBeLessThanOrEqual(b.type === "heading" ? 160 : 4000);
    }
    const text = guide.blocks.map((b: any) => b.text).join("\n");
    for (const s of ["Composio project API key", "Connect GitHub", "Ask before every action", "click", "Say"]) expect(text).toContain(s);
    expect(text).toContain("saying yes won't send");
    expect(manifest.categories).toEqual(["Developer Tools", "Productivity"]);
  });

  test("speech hints are within VoiceOS limits, most-misheard first, since VoiceOS keeps only ten across all apps", () => {
    const terms: string[] = manifest.asr?.vocabulary ?? [];
    expect(terms).toEqual(["GitHub", "PR", "repo", "pull request"]);
    expect(terms.length).toBeLessThanOrEqual(50);
    for (const t of terms) {
      expect(t.trim().length).toBeGreaterThan(0);
      expect(t.length).toBeLessThanOrEqual(80);
      expect(t).not.toContain(",");
    }
  });
});

describe("what the share package runs", () => {
  test("no shipped file runs code built from a string (VoiceOS's share review rejects it)", () => {
    for (const file of ["server.ts", "widgetKit.ts"]) {
      const text = readFileSync(join(ROOT, file), "utf8");
      expect({ file, hit: text.match(/\bnew\s+Function\s*\(|(?<![\w.$])Function\s*\(|=\s*Function\b|(?<![\w.$])eval\s*\(|\bsetTimeout\s*\(\s*["'`]/)?.[0] ?? null }).toEqual({ file, hit: null });
    }
  });
});

describe("a teammate's first launch", () => {
  test("server.ts carries its dependencies: a shared install has no node_modules to load them from", () => {
    // Bun's automatic install takes the latest release for a bare import (zod 4.6.7 instead of the pinned
    // 3.25.76 on 2026-10-28) and fails outright on a version-pinned one when the SDK needs a second zod.
    const bundle = readFileSync(join(ROOT, "server.ts"), "utf8");
    const specs = [...bundle.matchAll(/\bfrom\s+"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)|\brequire\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
    const builtins = new Set(["crypto", "fs", "path", "url", "os", "child_process", "events", "stream", "util", "http", "https", "net", "tls", "zlib", "buffer", "process", "assert", "string_decoder", "querystring", "readline", "worker_threads", "perf_hooks", "async_hooks", "timers", "dns"]);
    const packages = specs.filter((s) => !s.startsWith("node:") && !s.startsWith(".") && !builtins.has(s.split("/")[0]));
    expect(packages).toEqual([]);
  });
});

describe("no secret in what's shared (VoiceOS share review, 2026-10-28)", () => {
  test("confirmation cards carry no key: a receipt is a keyless digest of the exact arguments on the card", () => {
    expect(raw).not.toContain("GH_KEY");
    for (const t of manifest.tools.filter((x: any) => x.confirmation)) {
      expect(t.confirmation.root.html).not.toMatch(/["'][0-9a-f]{64}["']/);
      expect(t.confirmation.root.html).toContain('"voiceos-github-receipt-v2\\n"');
    }
  });
});
