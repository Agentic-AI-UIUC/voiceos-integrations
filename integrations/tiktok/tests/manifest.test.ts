/**
 * The generated manifest (scripts/build.ts) against:
 *  - VoiceOS's own validation (manifestSchema + crossFieldChecks of the installed host, VoiceOS 0.1.40),
 *  - the share-review rules learned on 2026-10-28 (GitHub #16: no code from strings, no keys, no
 *    steering words, no shell runtime),
 *  - the running server (tools/list parity), and
 *  - the acceptance items of plan §10.5: nothing unapproved exposed, confirm cards only on the four
 *    writes, bindings ⊂ inputSchema, background writes with the background permission, receipts.
 * Runs on any OS (CI is ubuntu): no sips/osascript, no network.
 */
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildConfirmation, CARD_KEYS, RECEIPT_CORE_JS } from "../confirm-card/build.ts";
import { COMPOSIO_BASE, COMPOSIO_UPLOAD_HOST, INTEGRATION_ID, INTEGRATION_VERSION, MEDIA_RELAY_BASE, TIKTOK_IMAGE_HOSTS, loadConfig } from "../src/config.ts";
import { TRANSCRIPT_HOOK, isHookTool } from "../src/conversation.ts";
import { hostMatches } from "../src/covers.ts";
import { CAPABILITY_GUIDANCE, createDeps, createServer } from "../src/mcpServer.ts";
import { TOOL_META, photoToolsEnabled } from "../src/tools.ts";

const ROOT = join(import.meta.dir, "..");
const raw = readFileSync(join(ROOT, "voiceos.integration.json"), "utf8");
const manifest = JSON.parse(raw);
const tools: any[] = manifest.tools;
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));

// The approved list (contract table; plan §2.1 sign-off): name → [title, visibility, background duration].
const APPROVED: Record<string, [string, "user" | "agent", number | null]> = {
  get_user_stats: ["TikTok profile stats", "user", null],
  list_videos: ["My recent TikTok posts", "user", null],
  query_videos: ["TikTok post details", "user", null],
  fetch_publish_status: ["TikTok post status", "user", null],
  query_creator_info: ["TikTok creator posting options", "agent", null],
  find_recent_videos: ["Find recent videos on this computer", "agent", null],
  find_recent_images: ["Find recent photos and screenshots on this computer", "agent", null],
  prepare_photo_post: ["Prepare a TikTok photo carousel", "agent", null],
  upload_video: ["Send video to TikTok drafts", "user", 120_000],
  publish_video: ["Post video to TikTok", "user", 180_000],
  upload_photos: ["Send photo carousel to TikTok drafts", "user", 120_000],
  post_photos: ["Post photo carousel to TikTok", "user", 180_000],
};
const WRITES = ["upload_video", "publish_video", "upload_photos", "post_photos"];
const PHOTO_TOOLS = ["find_recent_images", "prepare_photo_post", "upload_photos", "post_photos"];
const PHOTO_DISABLED_REASON = "Photo carousels need the media relay, which isn't set up yet.";

async function serverTools() {
  const dir = mkdtempSync(join(tmpdir(), "tiktok-manifest-"));
  try {
    const cfg = loadConfig({}, ["--composio-base-url=http://127.0.0.1:9/api/v3.1", `--state-dir=${join(dir, "state")}`, `--home=${dir}`]);
    const [s, c] = InMemoryTransport.createLinkedPair();
    await createServer(createDeps(cfg)).connect(s);
    const client = new Client({ name: "t", version: "1" });
    await client.connect(c);
    const { tools: listed } = await client.listTools();
    await client.close();
    return listed;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

/** Enough of JSON Schema to ask what the card's string values do against an input. */
function accepts(schema: any, value: unknown): boolean {
  if (!schema || typeof schema !== "object") return false;
  if (Array.isArray(schema.anyOf)) return schema.anyOf.some((s: any) => accepts(s, value));
  if (Array.isArray(schema.enum)) return schema.enum.includes(value);
  switch (schema.type) {
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return Number.isInteger(value) && (schema.minimum === undefined || (value as number) >= schema.minimum);
    case "string":
      return typeof value === "string" && (schema.pattern === undefined || new RegExp(schema.pattern).test(value)) && (schema.maxLength === undefined || value.length <= schema.maxLength);
    case "array":
      return Array.isArray(value) && value.every((v) => accepts(schema.items, v));
    default:
      return false;
  }
}

describe("identity and runtime (must not drift from the installed integration)", () => {
  test("id, version, name and publisher; the runtime is VoiceOS's own bun launch, which sharing accepts", () => {
    expect(manifest.schemaVersion).toBe(1);
    // IMMUTABLE once installed: VoiceOS keys settings and secrets off it.
    expect(manifest.id).toBe("com.voiceos.generated.tiktok");
    expect(manifest.id).toBe(INTEGRATION_ID);
    expect(manifest.id).toMatch(/^[a-z0-9]+(\.[a-z0-9-]+)+$/);
    expect(manifest.version).toBe(INTEGRATION_VERSION);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.version).toBe(JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version);
    expect(manifest.name).toBe("TikTok");
    expect(manifest.summary).toBe("Check your TikTok stats and post details, and send videos and photo carousels from your computer to TikTok by voice.");
    expect(manifest.summary.length).toBeLessThanOrEqual(140);
    expect(manifest.publisher).toEqual({ id: "pub_user", name: "Made in VoiceOS" });
    // The share review rejects a runtime that spawns a shell; this one needs only the five shipped files.
    expect(manifest.runtime).toEqual({ kind: "local-mcp", command: "bun", args: ["server.ts"] });
    expect(manifest.icon).toBe("icon.png");
    expect(existsSync(join(ROOT, "icon.png"))).toBe(true);
    expect(manifest.supportedPlatforms).toEqual(["darwin", "win32"]);
    expect(manifest.categories).toEqual(["Social"]);
    for (const absent of ["auth", "intents"]) expect(manifest[absent]).toBeUndefined();
    // The transcript hook (src/conversation.ts) and nothing else: no dictation, no tool hooks.
    expect(manifest.hooks).toEqual({ transcript: {} });
  });
});

describe("permissions", () => {
  test("network to Composio, its upload host, TikTok's image CDN and the media relay only, plus background and notify for the writes", () => {
    expect(manifest.permissions).toEqual([
      {
        kind: "network",
        domains: [
          "backend.composio.dev", COMPOSIO_UPLOAD_HOST, "*.tiktokcdn-us.com", "*.tiktokcdn.com", "*.tiktokcdn-eu.com",
          ...(MEDIA_RELAY_BASE ? [new URL(MEDIA_RELAY_BASE).hostname] : []),
        ],
      },
      { kind: "background" },
      // The reminder when a write that outlived its 60 s tool call ends (src/reminders.ts).
      { kind: "notify" },
      // The transcript hook reads agent utterances only (scope agent: dictation is never read). VoiceOS requires
      // this permission for any hook (crossFieldChecks, 0.1.40).
      { kind: "transcript", scope: "agent" },
    ]);
    if (MEDIA_RELAY_BASE) expect(new URL(MEDIA_RELAY_BASE).protocol).toBe("https:");
    // TikTok's CDN families only, one label deep (src/covers.ts hostMatches): VoiceOS takes wildcard domains (its
    // bundled grokbot integration declares "*.cursorvm.com"), and src/covers.ts fetches only what these match.
    for (const h of TIKTOK_IMAGE_HOSTS) expect(h).toMatch(/^\*\.tiktokcdn(-us|-eu)?\.com$/);
    // Every other domain is an exact host.
    for (const d of manifest.permissions[0].domains.filter((x: string) => !TIKTOK_IMAGE_HOSTS.includes(x))) expect(d).not.toContain("*");
  });

  test("the network list is exactly the hosts src/config.ts calls", () => {
    const hosts = [
      new URL(COMPOSIO_BASE).hostname, COMPOSIO_UPLOAD_HOST, ...TIKTOK_IMAGE_HOSTS, ...(MEDIA_RELAY_BASE ? [new URL(MEDIA_RELAY_BASE).hostname] : []),
    ];
    expect(manifest.permissions.find((p: any) => p.kind === "network").domains).toEqual(hosts);
    // No fetch in src/ goes to a literal host the permission doesn't list (or match, for a wildcard).
    const strays = sourceFiles(join(ROOT, "src")).flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/\bfetch\w*\(\s*["'`](https?:\/\/[^"'`/$]+)/g)]
        .map((m) => new URL(m[1]).hostname)
        .filter((host) => !hosts.some((p) => hostMatches(host, p)))
        .map((host) => `${file.slice(ROOT.length + 1)} → ${host}`),
    );
    expect(strays).toEqual([]);
  });
});

describe("no secret in what's shared (VoiceOS share review, 2026-10-28)", () => {
  const KEYS = [/\b(ck|ak|uak)_[A-Za-z0-9]{12,}/, /\bca_[A-Za-z0-9]{8,}/, /\bact\.[A-Za-z0-9!*_-]{20,}/, /\bsk-[A-Za-z0-9]{20,}/, /\bBearer\s+[A-Za-z0-9._-]{16,}/];

  test("the manifest and the bundle carry no Composio key, account id or token", () => {
    const bundle = readFileSync(join(ROOT, "server.ts"), "utf8");
    for (const [file, text] of [["voiceos.integration.json", raw], ["server.ts", bundle]] as const) {
      for (const re of KEYS) expect({ file, hit: text.match(re)?.[0] ?? null }).toEqual({ file, hit: null });
    }
  });

  test("confirmation cards carry no key: a receipt is a keyless digest of the exact arguments on the card", () => {
    for (const t of tools.filter((x) => x.confirmation)) {
      expect(t.confirmation.root.html).not.toMatch(/["'][0-9a-f]{64}["']/);
      expect(t.confirmation.root.html).toContain('"voiceos-tiktok-receipt-v1\\n"');
    }
  });
});

describe("setup fields", () => {
  const prefs: any[] = manifest.preferences;
  const pref = Object.fromEntries(prefs.map((p) => [p.name, p]));

  test("each is valid by VoiceOS's rules and unique", () => {
    expect(new Set(prefs.map((p) => p.name)).size).toBe(prefs.length);
    for (const p of prefs) {
      expect(p.name).toMatch(/^[a-zA-Z][a-zA-Z0-9_]*$/);
      expect(["text", "password", "boolean", "select", "number"]).toContain(p.type);
      expect(p.title.length).toBeGreaterThan(0);
      expect(typeof p.description).toBe("string");
      if (p.type === "select") expect(p.options.length).toBeGreaterThan(0);
      if (p.default !== undefined) expect(["string", "number", "boolean"]).toContain(typeof p.default);
      if (p.type === "password") expect(p.default).toBeUndefined();
      // All four are temporary scaffolding until the managed-key migration (plan §4.2 notes).
      expect(`${p.title} ${p.description}`).toMatch(/temporary/i);
    }
  });

  test("exactly the four decided fields, in order; the 1.0.0 base-URL and relay-URL fields are gone", () => {
    expect(prefs.map((p) => p.name)).toEqual(["COMPOSIO_API_KEY", "COMPOSIO_USER_ID", "COMPOSIO_CONNECTED_ACCOUNT_ID", "MEDIA_RELAY_TOKEN"]);
    expect(pref.COMPOSIO_API_KEY).toEqual({
      name: "COMPOSIO_API_KEY",
      title: "Composio project API key (temporary, for testing)",
      description: "Temporary, remove before release. composio.dev → Settings → Project Settings → API Keys. Use a project key, not a ck_ or uak_ key.",
      type: "password",
      required: true,
      placeholder: "Paste your project API key",
    });
    expect(pref.COMPOSIO_USER_ID).toMatchObject({ type: "text", default: "default", title: "Composio user ID (temporary, for testing)" });
    expect(pref.COMPOSIO_USER_ID.required).toBeUndefined();
    expect(pref.COMPOSIO_CONNECTED_ACCOUNT_ID).toMatchObject({ type: "text", required: true, title: "TikTok connected account ID (ca_…)" });
    expect(pref.MEDIA_RELAY_TOKEN).toMatchObject({ type: "password", title: "Media relay token (photo carousels, temporary)" });
    expect(pref.MEDIA_RELAY_TOKEN.required).toBeUndefined();
    // A stored base URL could send the API key anywhere; test seams are loopback-only command-line flags.
    for (const gone of ["COMPOSIO_BASE_URL", "MEDIA_RELAY_URL"]) expect(pref[gone]).toBeUndefined();
  });

  test("every variable src/ reads is declared (an undeclared process.env.X is silently empty), and every field is read", () => {
    // Windows' own folders too (src/preview.ts looks for ffmpeg.exe where winget and Chocolatey put it).
    const OS_VARS = new Set(["HOME", "TMPDIR", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "USERPROFILE", "USER", "LOGNAME", "PATH", "SHELL", "TERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ"]);
    const source = sourceFiles(join(ROOT, "src")).map((f) => readFileSync(f, "utf8")).join("\n");
    // process.env.X, Bun.env.X, env?.X, env["X"] anywhere; config.ts also reads through its text("X") helper.
    const config = readFileSync(join(ROOT, "src/config.ts"), "utf8");
    const read = new Set(
      [...source.matchAll(/(?:\benv\??\.|\benv\[\s*["'`])([A-Z][A-Z0-9_]+)/g), ...config.matchAll(/\btext\(\s*["'`]([A-Z][A-Z0-9_]+)/g)]
        .map((m) => m[1])
        .filter((name) => !OS_VARS.has(name)),
    );
    expect([...read].sort()).toEqual(Object.keys(pref).sort());
  });
});

describe("tools", () => {
  test("exactly the twelve approved tools, in order: nothing unapproved is exposed", () => {
    expect(tools.map((t) => t.name)).toEqual(Object.keys(APPROVED));
    expect(Object.keys(TOOL_META)).toEqual(Object.keys(APPROVED));
    // Composio's URL-pull video tool and its batch uploader are out of scope: no tool wraps them, no code calls them.
    const bundle = readFileSync(join(ROOT, "server.ts"), "utf8");
    for (const text of [raw, bundle]) expect(text).not.toMatch(/["'`]TIKTOK_(PUBLISH_VIDEO|UPLOAD_VIDEOS)["'`]/);
  });

  test("they match the running server name for name, description for description and schema for schema", async () => {
    // The server also serves VoiceOS's hidden hook endpoint (voiceos_hook_transcript), which isn't a manifest tool.
    const live = (await serverTools()).filter((t) => !isHookTool(t.name));
    expect(live.map((t) => t.name).sort()).toEqual(tools.map((t) => t.name).sort());
    for (const t of tools) {
      const served = live.find((s) => s.name === t.name)!;
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(t.title).toBe(APPROVED[t.name][0]);
      expect(t.title).toBe((TOOL_META as any)[t.name].title);
      expect(t.description).toBe(served.description);
      const { $schema: _a, ...schema } = served.inputSchema as any;
      expect(t.inputSchema).toEqual(schema);
      expect(t.inputSchema.type).toBe("object");
    }
  });

  test("only query_videos is uiCallable (a list card's row opens a post's details); no write is", () => {
    expect(tools.filter((t) => t.uiCallable !== undefined).map((t) => [t.name, t.uiCallable])).toEqual([["query_videos", true]]);
    for (const name of WRITES) expect(byName[name].uiCallable).toBeUndefined();
  });

  test("agent-only helpers are hidden from the user's tool list; the rest use the default", () => {
    for (const t of tools) {
      if (APPROVED[t.name][1] === "agent") expect(t.visibility).toBe("agent");
      else expect(t.visibility).toBeUndefined();
    }
  });

  test("every description says what the tool does and when to use it, without steering the agent (share review)", () => {
    // Phrasings the share review rejected on October 28, 2026, and their kin.
    const steering = /\bnever\b|\bdon't\b|\bstop\b|\bverbatim\b|your reply|spoken yes|go straight/i;
    for (const t of tools) {
      // "Use when …": the exact phrase VoiceOS's tooling and #16's review checks look for.
      expect(t.description).toContain("Use when");
      // Our own cap: VoiceOS 0.1.40 doesn't cut descriptions (manifest schema: string min 1; the tool catalog sends
      // them whole). The four writes carry the conversation rules (VoiceOS doesn't pass MCP instructions to its
      // agent, so descriptions are where those rules can live), so they get up to 900. So does find_recent_videos:
      // it carries the references the agent loses between notch turns (it / that video / the other one / show it
      // in Finder), which otherwise send the agent to VoiceOS's own Finder tools (live, 2026-11-06).
      expect(t.description.length).toBeLessThanOrEqual(WRITES.includes(t.name) || t.name === "find_recent_videos" ? 900 : 600);
      expect({ tool: t.name, steering: t.description.match(steering)?.[0] ?? null }).toEqual({ tool: t.name, steering: null });
      if (APPROVED[t.name][1] === "agent") expect(t.description).toStartWith("Agent-only");
      if (WRITES.includes(t.name)) {
        expect(t.description).toContain("Runs in the background");
        expect(t.description).toMatch(/approval is by clicking/i);
      }
    }
  });

  test("read tools reject unknown arguments", () => {
    for (const name of ["get_user_stats", "list_videos", "query_videos", "fetch_publish_status", "query_creator_info"]) {
      expect({ name, additionalProperties: byName[name].inputSchema.additionalProperties }).toEqual({ name, additionalProperties: false });
    }
  });

  test("write schemas take what the card stages: the receipt, string toggles, digit-string cover times, TikTok's limits", () => {
    const required: Record<string, string[]> = {
      upload_video: ["file_token"],
      publish_video: ["file_token", "post_token"],
      upload_photos: ["bundle_token"],
      post_photos: ["bundle_token", "post_token"],
    };
    const toggles: Record<string, string[]> = {
      upload_video: ["copy_caption"],
      publish_video: ["allow_comment", "allow_duet", "allow_stitch", "commercial_disclosure", "brand_organic", "brand_content", "is_aigc"],
      upload_photos: [],
      post_photos: ["allow_comment", "auto_add_music", "commercial_disclosure", "brand_organic", "brand_content"],
    };
    const limits: Record<string, Record<string, number>> = {
      upload_video: { caption: 2200 },
      publish_video: { caption: 2200 },
      upload_photos: { title: 90, description: 4000 },
      post_photos: { title: 90, description: 4000 },
    };
    for (const name of WRITES) {
      const schema = byName[name].inputSchema;
      const props = schema.properties;
      expect({ name, required: [...(schema.required ?? [])].sort() }).toEqual({ name, required: required[name] });
      // Present but not required: a spoken yes arrives without one and must get the CONFIRMATION_REQUIRED refusal.
      expect(props.confirmation_receipt?.type).toBe("string");
      for (const key of toggles[name]) {
        const s = props[key];
        expect({ name, key, ok: [true, false, "true", "false"].every((v) => accepts(s, v)) && !accepts(s, "yes") && s.default === false }).toEqual({ name, key, ok: true });
      }
      for (const [key, max] of Object.entries(limits[name])) {
        expect({ name, key, ok: accepts(props[key], "x".repeat(max)) && !accepts(props[key], "x".repeat(max + 1)) }).toEqual({ name, key, ok: true });
      }
    }
    for (const name of ["publish_video", "post_photos"]) {
      const privacy = byName[name].inputSchema.properties.privacy_level;
      // A string, not an enum: the user's audience words work as well as TikTok's codes (the card and server map them).
      expect(privacy.enum).toBeUndefined();
      expect(["", "SELF_ONLY", "only me", "Friends", "everyone"].every((v) => accepts(privacy, v))).toBe(true);
      for (const code of ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"]) expect(privacy.description).toContain(code);
      // Nothing preselected: the user picks privacy on the card (TikTok's Content Sharing Guidelines).
      expect(privacy.default).toBe("");
    }
    // Cover times in words as well as milliseconds; a negative number is still out.
    const cover = byName.publish_video.inputSchema.properties.cover_ms;
    expect([0, 3000, "3000", "0:05", "5s", "5 seconds", "2.5"].every((v) => accepts(cover, v)) && !accepts(cover, -1)).toBe(true);
    for (const words of ["0:05", "5s", "2.5", "milliseconds"]) expect(cover.description).toContain(words);
  });

  test("hashtags and mentions: every write takes a list or one string, optional, and says where the card puts them", () => {
    const steering = /\bnever\b|\bdon't\b|\bstop\b|\bverbatim\b|spoken yes/i;
    for (const name of WRITES) {
      const props = byName[name].inputSchema.properties;
      const target = name.endsWith("video") ? "caption" : "description";
      for (const key of ["hashtags", "mentions"]) {
        const s = props[key];
        expect({ name, key, ok: [["ai", "tech"], "ai, tech", "#ai #tech", ""].every((v) => accepts(s, v)) }).toEqual({ name, key, ok: true });
        expect(byName[name].inputSchema.required ?? []).not.toContain(key);
        expect(s.description).toContain(`the card adds them to the end of the ${target}`);
        expect({ name, key, steering: s.description.match(steering)?.[0] ?? null }).toEqual({ name, key, steering: null });
      }
      expect(props.hashtags.description).toContain("add #ai and #tech");
      expect(props.mentions.description).toContain("tag @maya");
    }
    // The new words in the privacy and cover descriptions pass the same review.
    for (const text of [byName.publish_video.inputSchema.properties.privacy_level.description, byName.publish_video.inputSchema.properties.cover_ms.description]) {
      expect(text.match(steering)?.[0] ?? null).toBeNull();
    }
  });
});

describe("confirmations, background writes and the photo switch", () => {
  test("reads have no confirmation and run in the foreground", () => {
    for (const t of tools.filter((x) => !WRITES.includes(x.name))) {
      expect(t.confirmation).toBeUndefined();
      expect(t.hidePermissionToggle).toBeUndefined();
      expect(t.execution?.mode ?? "sync").toBe("sync");
    }
  });

  test("each write has one locked widget confirmation within VoiceOS's limits, as confirm-card/ builds it", () => {
    for (const name of WRITES) {
      const t = byName[name];
      expect(t.hidePermissionToggle).toBe(true);
      expect(t.confirmation).toEqual(buildConfirmation(name as any));
      expect(t.confirmation.schemaVersion).toBe(1);
      const root = t.confirmation.root;
      expect(root.type).toBe("widget");
      // One widget, nothing beside it: VoiceOS renders the floating confirm control itself.
      expect(root.children).toBeUndefined();
      expect(root.footer).toBeUndefined();
      expect(JSON.stringify(t.confirmation)).not.toMatch(/"type":"(button|actions|canvas)"|"role":"custom"/);
      expect(root.html.length).toBeGreaterThan(0);
      expect(root.html.length).toBeLessThanOrEqual(300_000);
      expect(Number.isInteger(root.height)).toBe(true);
      expect(root.height).toBeGreaterThanOrEqual(60);
      expect(root.height).toBeLessThanOrEqual(420);
      expect(root.confirmLabel.trim().length).toBeGreaterThan(0);
      expect(root.confirmLabel.length).toBeLessThanOrEqual(60);
      expect(root.label.trim().length).toBeGreaterThan(0);
      expect(root.label.length).toBeLessThanOrEqual(60);
      if (root.data !== undefined) expect(JSON.stringify(root.data).length).toBeLessThanOrEqual(16_384);
    }
  });

  test("every value a card reads or stages is an input of that tool, and every card stages the receipt", () => {
    for (const name of WRITES) {
      const t = byName[name];
      const props = Object.keys(t.inputSchema.properties);
      const html: string = t.confirmation.root.html;
      for (const m of html.matchAll(/data-tk-key="([^"]+)"/g)) expect({ name, key: m[1], declared: props.includes(m[1]) }).toEqual({ name, key: m[1], declared: true });
      for (const m of html.matchAll(/data-voiceos-key="([^"]+)"/g)) expect({ name, key: m[1], declared: props.includes(m[1]) }).toEqual({ name, key: m[1], declared: true });
      for (const m of JSON.stringify(t.confirmation).matchAll(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g)) expect(props).toContain(m[1]);
      for (const key of CARD_KEYS[name as keyof typeof CARD_KEYS]) expect({ name, key, declared: props.includes(key) }).toEqual({ name, key, declared: true });
      expect(props).toContain("confirmation_receipt");
      // The card's script mints the receipt with the shared core and stages it through the widget bridge.
      expect(CARD_KEYS[name as keyof typeof CARD_KEYS]).toContain("confirmation_receipt");
      expect(html).toMatch(/type:\s*"voiceos:updateInput",\s*key:\s*"confirmation_receipt",\s*value:\s*TKR\.mint\(/);
    }
  });

  test("the cards sign with the server's own receipt core, unchanged", () => {
    const script = readFileSync(join(ROOT, "src/receiptCoreScript.ts"), "utf8");
    const start = script.indexOf("var TKR = (function () {");
    const core = script.slice(start, script.indexOf("\nexport default TKR;"));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(RECEIPT_CORE_JS).toBe(core);
    for (const name of WRITES) expect(byName[name].confirmation.root.html).toContain(core);
  });

  test("writes are background tasks, which needs the background permission", () => {
    expect(manifest.permissions.some((p: any) => p.kind === "background")).toBe(true);
    for (const name of WRITES) expect(byName[name].execution).toEqual({ mode: "background", estimatedDurationMs: APPROVED[name][2] });
  });

  test("the four photo tools ship disabled while the media relay isn't set up; the other eight are on", () => {
    expect(photoToolsEnabled()).toBe(MEDIA_RELAY_BASE.trim() !== "");
    for (const t of tools) {
      if (PHOTO_TOOLS.includes(t.name) && !photoToolsEnabled()) {
        expect({ tool: t.name, disabled: t.disabled, reason: t.disabledReason }).toEqual({ tool: t.name, disabled: true, reason: PHOTO_DISABLED_REASON });
        expect(t.disabledReason.length).toBeLessThanOrEqual(200);
      } else {
        expect({ tool: t.name, disabled: t.disabled ?? false }).toEqual({ tool: t.name, disabled: false });
        expect(t.disabledReason).toBeUndefined();
      }
    }
  });
});

describe("conversation: the transcript hook and the rules the agent reads", () => {
  test("the server serves the hidden transcript hook, which VoiceOS keeps out of the agent's tool list", async () => {
    const live = await serverTools();
    const hooks = live.filter((t) => isHookTool(t.name));
    expect(hooks.map((t) => t.name)).toEqual([TRANSCRIPT_HOOK]);
    expect(TRANSCRIPT_HOOK).toBe("voiceos_hook_transcript");
    // VoiceOS calls it with { payload_json }; it isn't a manifest tool, so the agent's list stays the approved twelve.
    expect(Object.keys((hooks[0].inputSchema as any).properties)).toEqual(["payload_json"]);
    expect(tools.some((t) => isHookTool(t.name))).toBe(false);
    expect(Object.keys(manifest.hooks).map((h) => `voiceos_hook_${h}`)).toEqual([TRANSCRIPT_HOOK]);
  });

  test("the write descriptions carry the conversation contract: vocabulary, latest wins, the video in progress, one line naming it", () => {
    const up = byName.upload_video.description;
    const post = byName.publish_video.description;
    for (const words of ["draft", "send it to my phone", "I'll finish it in the app", "turns a post card back into drafts"]) expect(up).toContain(words);
    for (const words of ["post, publish, put it up, go live or share it on my profile", "make it a post", "actually post it", "query_creator_info"]) {
      expect(post).toContain(words);
    }
    for (const d of [up, post]) {
      expect(d).toContain("The latest instruction wins");
      expect(d).toContain("pick 'current'");
    }
    // Live 2026-11-06: "its ai generated btw" over a Post card got an acknowledgement and no card (VoiceOS drops a
    // card the moment the user speaks), and "make it public" got a question instead of the Only me card.
    for (const name of WRITES) {
      expect(byName[name].description).toContain("calling this again at once with it applied: the old card is gone once the user speaks");
      expect(byName[name].description).toContain("a yes in words sends nothing");
    }
    for (const name of ["publish_video", "post_photos"]) expect(byName[name].description).toMatch(/show the Only me card, which is the question/);
    expect(byName.query_creator_info.description).toContain("make it a post");
    expect(byName.fetch_publish_status.description).toMatch(/can't become a post.*offer to post the same video directly/);
    const privacy = byName.publish_video.inputSchema.properties.privacy_level.description;
    for (const [words, level] of [["just me", "SELF_ONLY"], ["Friends", "MUTUAL_FOLLOW_FRIENDS"], ["Followers", "FOLLOWER_OF_CREATOR"], ["everyone", "PUBLIC_TO_EVERYONE"]]) {
      expect(privacy).toContain(words);
      expect(privacy).toContain(level);
    }
    expect(privacy).toContain("audits");
    expect(byName.publish_video.inputSchema.properties.caption.description).toContain("no live trends");
  });

  test("the MCP instructions hold the same contract, for hosts that read them", () => {
    for (const words of ["The latest instruction wins", "send it to my phone", "share it on my profile", "SELF_ONLY", "MUTUAL_FOLLOW_FRIENDS", "no trends data", "plain title"]) {
      expect(CAPABILITY_GUIDANCE).toContain(words);
    }
  });
});

describe("detail page, setup guide and speech hints", () => {
  test("the detail page and the server's instructions describe the integration rather than steer the agent", () => {
    const steering = /\bsay so\b|instead of|before answering|\bnever\b|\bdon't\b|\bdo not\b/i;
    for (const [where, text] of [["manifest description", manifest.description], ["MCP instructions", CAPABILITY_GUIDANCE]] as const) {
      expect(typeof text).toBe("string");
      expect({ where, steering: text.match(steering)?.[0] ?? null }).toEqual({ where, steering: null });
    }
    for (const s of ["drafts", "Only me", "confirm first", "Photo carousels"]) expect(manifest.description).toContain(s);
  });

  test("setup steps sit in the setup guide above Configure, within VoiceOS's limits, ending with something to say", () => {
    const guide = manifest.setupGuide;
    expect(guide.title).toBe("Set up TikTok");
    expect(guide.title.length).toBeLessThanOrEqual(100);
    expect(guide.blocks.length).toBeGreaterThanOrEqual(1);
    expect(guide.blocks.length).toBeLessThanOrEqual(24);
    for (const b of guide.blocks) {
      expect(["heading", "text"]).toContain(b.type);
      expect(b.text.trim().length).toBeGreaterThan(0);
      expect(b.text.length).toBeLessThanOrEqual(b.type === "heading" ? 160 : 4000);
    }
    const text = guide.blocks.map((b: any) => b.text).join("\n");
    for (const s of [
      "Composio project API key",
      "connected account id",
      "clicking the button on the card",
      "Saying yes doesn't send a TikTok post yet",
      "Keep Ask before every action on. With it off, VoiceOS skips the confirmation cards, so TikTok uploads are refused and nothing is sent.",
      "Only me",
      "inbox notification",
      "Manage app permissions",
      "Say",
    ]) expect(text).toContain(s);
    expect(guide.blocks.at(-2)).toEqual({ type: "heading", text: "Try it" });
  });

  test("speech hints are within VoiceOS's limits, most-misheard first, since VoiceOS keeps only ten across all apps", () => {
    const terms: string[] = manifest.asr?.vocabulary ?? [];
    expect(terms).toEqual(["TikTok", "carousel", "drafts", "Only me", "Duet", "Stitch"]);
    expect(terms.length).toBeLessThanOrEqual(50);
    for (const t of terms) {
      expect(t.trim().length).toBeGreaterThan(0);
      expect(t.length).toBeLessThanOrEqual(80);
      expect(t).toMatch(/^[^,\u0000-\u001f\u007f]+$/u);
    }
  });
});

describe("what the share package runs", () => {
  test("no shipped file runs code built from a string (VoiceOS's share review rejects it)", () => {
    for (const file of ["server.ts", "widgetKit.ts"]) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const hit = text.match(/\bnew\s+Function\s*\(|(?<![\w.$])Function\s*\(|=\s*Function\b|(?<![\w.$])eval\s*\(|\bset(?:Timeout|Interval)\s*\(\s*["'`]/)?.[0] ?? null;
      expect({ file, hit }).toEqual({ file, hit: null });
    }
  });

  test("server.ts is the generated bundle and carries its dependencies: a shared install has no node_modules", () => {
    // Bun's automatic install takes the latest release for a bare import (zod 4.6.7 instead of the pinned
    // 3.25.76 on 2026-10-28) and fails outright on a version-pinned one.
    const bundle = readFileSync(join(ROOT, "server.ts"), "utf8");
    expect(bundle.split("\n").slice(0, 3).join("\n")).toContain("GENERATED by `bun run build`");
    // Member calls such as ObjC.import("Foundation") inside the JXA script text are data, not module imports.
    const specs = [...bundle.matchAll(/\bfrom\s*["']([^"']+)["']|(?<![\w.$])import\s*\(\s*["']([^"']+)["']\s*\)|(?<![\w.$])require\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm)].map(
      (m) => m[1] ?? m[2] ?? m[3] ?? m[4],
    );
    const builtins = new Set(["assert", "async_hooks", "buffer", "child_process", "crypto", "dns", "events", "fs", "http", "https", "net", "os", "path", "perf_hooks", "process", "querystring", "readline", "stream", "string_decoder", "timers", "tls", "url", "util", "worker_threads", "zlib", "bun"]);
    expect(specs.filter((s) => !/^(node|bun):/.test(s) && !s.startsWith(".") && !builtins.has(s.split("/")[0]))).toEqual([]);
    // Relative imports would need src/ or node_modules, which Publish doesn't ship.
    expect(specs.filter((s) => s.startsWith("."))).toEqual([]);
  });

  test("preview fixtures cover reads only: VoiceOS's previewer really runs every fixture", () => {
    const preview = JSON.parse(readFileSync(join(ROOT, "voiceos.integration.preview.json"), "utf8"));
    expect(preview.schemaVersion).toBe(1);
    const names = Object.keys(preview.tools);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(byName[name]).toBeDefined();
      expect(WRITES).not.toContain(name);
      expect(byName[name].disabled).toBeUndefined();
    }

  });
});
