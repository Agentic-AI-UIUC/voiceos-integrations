/**
 * Build the integration from src/ (plan §4.1–4.2; adapted from GitHub #16's scripts/build.ts):
 *  - server.ts: a self-contained bundle of src/. It is what VoiceOS runs, and one of the five files
 *    Publish ships (with widgetKit.ts, voiceos.integration.json, package.json and icon.png).
 *  - voiceos.integration.json: names, descriptions and input schemas from the running server's
 *    tools/list; titles, visibility and execution from TOOL_META; the four confirmation widgets from
 *    confirm-card/build.ts, embedded unchanged.
 *  - voiceos.integration.preview.json and the preview block of studio-meta.json: READ tools only.
 *
 *   bun run build
 *
 * Then Reload TikTok in Integration Studio → My Integrations.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfirmation } from "../confirm-card/build.ts";
import { COMPOSIO_BASE, COMPOSIO_UPLOAD_HOST, INTEGRATION_ID, INTEGRATION_VERSION, MEDIA_RELAY_BASE, TIKTOK_IMAGE_HOSTS, loadConfig } from "../src/config.ts";
import { isHookTool } from "../src/conversation.ts";
import { createDeps, createServer } from "../src/mcpServer.ts";
import { TOOL_META, photoToolsEnabled } from "../src/tools.ts";
import type { WriteTool } from "../src/types.ts";
import { BUILD_BUN_VERSION, VOICEOS_BUN, sourceDigest, stampLine } from "./sources.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// 0. The pinned Bun ---------------------------------------------------------
// Bun versions bundle the same source differently (renamed variables), so server.ts is built with one Bun: the one
// VoiceOS bundles. On another Bun, the build runs itself again on VoiceOS's when it's there; otherwise it warns, and
// tests/manifest.test.ts fails until the bundle is rebuilt with BUILD_BUN_VERSION.
if (Bun.version !== BUILD_BUN_VERSION) {
  const pinned = !process.env.TIKTOK_BUILD_ON_PINNED_BUN && existsSync(VOICEOS_BUN)
    ? Bun.spawnSync([VOICEOS_BUN, "--version"]).stdout.toString().trim() === BUILD_BUN_VERSION
    : false;
  if (pinned) {
    console.log(`Bun ${Bun.version} isn't the pinned ${BUILD_BUN_VERSION}: building on VoiceOS's bundled Bun instead.`);
    const again = Bun.spawnSync([VOICEOS_BUN, ...process.argv.slice(1)], {
      stdio: ["inherit", "inherit", "inherit"],
      env: { ...process.env, TIKTOK_BUILD_ON_PINNED_BUN: "1" },
    });
    process.exit(again.exitCode ?? 1);
  }
  console.warn(`warning: building with Bun ${Bun.version}, not the pinned ${BUILD_BUN_VERSION}; bun test will flag server.ts until it's rebuilt with ${BUILD_BUN_VERSION}.`);
}
const manifestPath = join(root, "voiceos.integration.json");
const existing = JSON.parse(readFileSync(manifestPath, "utf8"));

/** The four acting tools (src/types.ts WriteTool): each gets a widget confirmation and a locked Asks-first toggle. */
const WRITE_TOOLS: ReadonlySet<string> = new Set<WriteTool>(["upload_video", "publish_video", "upload_photos", "post_photos"]);
const PHOTO_DISABLED_REASON = "Photo carousels need the media relay, which isn't set up yet.";

// 1. server.ts bundle -------------------------------------------------------
// One self-contained file. A shared install is just the five packaged files, with no node_modules, and
// Bun's automatic install takes the latest release for a bare import (zod 4.6.7, not the pinned 3.25.76,
// on 2026-10-28) and fails on version-pinned ones. Inlining the dependencies brings in code that compiles
// JavaScript from strings, which VoiceOS's share review rejects, so the build switches it off:
//  - zod 4 (used inside the MCP SDK) generates fast object parsers with `new Function` when it can;
//    told it can't, it parses normally.
//  - The SDK's JSON Schema validator is ajv, a code generator. It only runs for tool output schemas (none
//    here) and elicitation (unused), so it becomes a validator that refuses if it is ever reached.
//    `server/index.js` imports it statically, so swapping the module is the only way to keep ajv out.
const PATCHES: Array<{ file: RegExp; from: string; to: string }> = [
  {
    file: /node_modules[\\/]zod[\\/]v4[\\/]core[\\/]util\.js$/,
    from: '    try {\n        const F = Function;\n        new F("");\n        return true;\n    }\n    catch (_) {\n        return false;\n    }',
    to: "    return false;",
  },
  {
    file: /node_modules[\\/]zod[\\/]v4[\\/]core[\\/]doc\.js$/,
    from: "        const F = Function;\n        const args = this?.args;\n        const content = this?.content ?? [``];\n        const lines = [...content.map((x) => `  ${x}`)];\n        // console.log(lines.join(\"\\n\"));\n        return new F(...args, lines.join(\"\\n\"));",
    to: '        throw new Error("zod code generation is disabled in this build");',
  },
];
const NO_AJV = `export class AjvJsonSchemaValidator {
  getValidator() {
    return () => ({ valid: false, data: undefined, errorMessage: "JSON Schema validation isn't available in this build." });
  }
}
`;

/** What the share review rejects: code compiled from a string (tests/manifest.test.ts checks the same). */
const CODE_FROM_STRINGS =
  /\bnew\s+Function\s*\(|=\s*Function\b|(?<![\w.$])Function\s*\(|(?<![\w.$])eval\s*\(|\bset(?:Timeout|Interval)\s*\(\s*["'`]/;
const BUILTINS = new Set([
  "assert", "async_hooks", "buffer", "child_process", "crypto", "dns", "events", "fs", "http", "https", "net", "os", "path",
  "perf_hooks", "process", "querystring", "readline", "stream", "string_decoder", "timers", "tls", "url", "util", "worker_threads", "zlib",
  "bun",
]);
/** Module specifiers a bundle still imports that aren't node:/bun: built-ins: each would be fetched from npm on a shared install. */
function bareImports(code: string): string[] {
  // Member calls such as ObjC.import("Foundation") inside the JXA script text are data, not module imports.
  const specs = [...code.matchAll(/\bfrom\s*["']([^"']+)["']|(?<![\w.$])import\s*\(\s*["']([^"']+)["']\s*\)|(?<![\w.$])require\s*\(\s*["']([^"']+)["']\s*\)|^\s*import\s*["']([^"']+)["']/gm)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? m[4]);
  return specs.filter((s) => !/^(node|bun):/.test(s) && !s.startsWith(".") && !BUILTINS.has(s.split("/")[0]));
}

async function bundleServer(): Promise<string> {
  const bundle = await Bun.build({
    entrypoints: [join(root, "src/main.ts")],
    target: "bun",
    format: "esm",
    minify: false,
    plugins: [
      {
        name: "no-code-from-strings",
        setup(build) {
          build.onLoad({ filter: /@modelcontextprotocol[\\/]sdk[\\/]dist[\\/]esm[\\/]validation[\\/]ajv-provider\.js$/ }, () => ({ contents: NO_AJV, loader: "js" }));
          for (const p of PATCHES) {
            build.onLoad({ filter: p.file }, async (args) => {
              const source = await Bun.file(args.path).text();
              if (source.split(p.from).length !== 2) throw new Error(`${args.path} changed; review the build's patch for it.`);
              return { contents: source.replace(p.from, p.to), loader: "js" };
            });
          }
        },
      },
    ],
  });
  if (!bundle.success) {
    for (const message of bundle.logs) console.error(message);
    throw new Error("bundling src/main.ts failed");
  }
  const code = await bundle.outputs[0].text();
  const hit = code.match(CODE_FROM_STRINGS);
  if (hit) throw new Error(`server.ts would compile code from a string (${JSON.stringify(hit[0])}); VoiceOS's share review rejects that.`);
  const bare = bareImports(code);
  if (bare.length) throw new Error(`server.ts still imports ${bare.join(", ")}; a shared install has no node_modules.`);
  if (!code.includes("JSON Schema validation isn't available in this build.")) throw new Error("the ajv-provider stub didn't apply; check the SDK path in the build plugin.");
  const header =
    "// GENERATED by `bun run build` from src/ — edit src/ and rebuild; don't edit this file.\n" +
    "// TikTok for VoiceOS, through Composio's TikTok toolkit (REST v3.1). Source of truth: src/main.ts.\n" +
    `${stampLine(Bun.version, sourceDigest(root))}\n`;
  // Bun's "// @bun" pragma only counts on the first line, so the header goes after it.
  const pragma = code.startsWith("// @bun") ? code.slice(0, code.indexOf("\n") + 1) : "";
  return pragma + header + code.slice(pragma.length);
}

// 2. tools/list from the real server ----------------------------------------
async function liveTools() {
  const scratch = mkdtempSync(join(tmpdir(), "tiktok-build-"));
  try {
    // Unreachable loopback base and a throwaway home/state: listing tools never touches the network or the user's files.
    const cfg = loadConfig({}, [`--composio-base-url=http://127.0.0.1:9/api/v3.1`, `--state-dir=${join(scratch, "state")}`, `--home=${scratch}`]);
    const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
    await createServer(createDeps(cfg)).connect(serverSide);
    const client = new Client({ name: "voiceos-build", version: "1.0.0" });
    await client.connect(clientSide);
    const { tools } = await client.listTools();
    await client.close();
    return tools;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * Hosts the code calls, and only those (least privilege): Composio, its presigned-upload host, TikTok's image
 * CDN for avatars and covers (wildcard patterns, one label deep; src/covers.ts fetches only what they match), the
 * relay once deployed.
 */
function networkDomains(): string[] {
  const hosts = [new URL(COMPOSIO_BASE).hostname, COMPOSIO_UPLOAD_HOST, ...TIKTOK_IMAGE_HOSTS];
  if (MEDIA_RELAY_BASE.trim()) hosts.push(new URL(MEDIA_RELAY_BASE).hostname);
  return [...new Set(hosts)];
}

// 3. Manifest -------------------------------------------------------------
const description =
  "Reads your TikTok profile stats and public post details, checks post status, and sends videos from your computer to your TikTok drafts. Direct posting is available when you ask for it and is private (Only me) until TikTok audits the app. Every upload asks you to confirm first. " +
  (photoToolsEnabled()
    ? "Photo carousels (up to 35 photos) go through a short-lived media relay and need the relay token in settings."
    : "Photo carousels (up to 35 photos) switch on once the media relay is set up.") +
  // The transcript permission (src/conversation.ts), said plainly on the detail page.
  " To keep track of the video you're working on across turns (\"make it a post\", \"the other one\"), it reads what you say to the VoiceOS agent as you say it and adds a short note about that video; the words it reads aren't kept, and the note goes only to the VoiceOS agent." +
  // What stays on the computer (src/ledger.ts), so "did it go up?" works after a restart (QA, PR 47).
  " On this computer it keeps a record of your recent sends for 30 days, with file names and the captions, titles and descriptions you approved.";

// Shown right above the Configure fields, where setup happens (Studio brief "Manifest" → setupGuide).
const setupGuide = {
  title: "Set up TikTok",
  blocks: [
    { type: "heading", text: "1. Add your Composio key and TikTok connection" },
    {
      type: "text",
      text: "Paste your Composio project API key and your TikTok connected account id (Composio → Connected accounts) below. The connection must be ACTIVE and use your own TikTok developer app with the scopes user.info.basic, user.info.profile, user.info.stats, video.list, video.upload and video.publish.",
    },
    { type: "heading", text: "2. Approve posts with a click" },
    {
      type: "text",
      text: "Approve posts by clicking the button on the card. Saying yes doesn't send a TikTok post yet, because VoiceOS doesn't pass the card's approval along when you answer by voice.",
    },
    { type: "heading", text: "3. Keep Ask before every action on" },
    {
      type: "text",
      text: "Keep Ask before every action on. With it off, VoiceOS skips the confirmation cards, so TikTok uploads are refused and nothing is sent.",
    },
    { type: "heading", text: "4. Direct posts are private for now" },
    {
      type: "text",
      text: "While this app is unaudited, direct posts need your TikTok account set to Private, and they stay Only me. Drafts work either way.",
    },
    { type: "heading", text: "5. Finish drafts in TikTok" },
    { type: "text", text: "Drafts finish in the TikTok app: tap the inbox notification." },
    { type: "heading", text: "6. Disconnect" },
    {
      type: "text",
      text: "To disconnect, remove the TikTok connection in Composio and clear the connected-account field. You can also remove the app in TikTok: Settings and privacy → Security and login → Manage app permissions.",
    },
    { type: "heading", text: "Try it" },
    { type: "text", text: 'Say "How\'s my TikTok doing?", "How did my last TikToks do?" or "Send my latest export to my TikTok drafts".' },
  ],
};

// VoiceOS injects each one as process.env.<name>; an undeclared variable is silently empty (src/config.ts reads exactly these).
const preferences = [
  {
    name: "COMPOSIO_API_KEY",
    title: "Composio project API key (temporary, for testing)",
    description: "Temporary, remove before release. composio.dev → Settings → Project Settings → API Keys. Use a project key, not a ck_ or uak_ key.",
    type: "password",
    required: true,
    placeholder: "Paste your project API key",
  },
  {
    name: "COMPOSIO_USER_ID",
    title: "Composio user ID (temporary, for testing)",
    description: "Temporary. Leave as default to use whichever Composio user owns the connection; set it only to pin one user_id.",
    type: "text",
    default: "default",
  },
  {
    name: "COMPOSIO_CONNECTED_ACCOUNT_ID",
    title: "TikTok connected account ID (ca_…)",
    description: "Temporary: copy the ACTIVE TikTok connection id from Composio → Connected accounts.",
    type: "text",
    required: true,
  },
  {
    name: "MEDIA_RELAY_TOKEN",
    title: "Media relay token (photo carousels, temporary)",
    description: photoToolsEnabled()
      ? "Temporary: the media relay token for photo carousels. Videos work without it."
      : "Leave empty until photo carousels are live. Videos work without it.",
    type: "password",
  },
];

type Meta = { title: string; visibility?: string; execution?: { mode: string; estimatedDurationMs?: number }; photo?: boolean; uiCallable?: boolean };

function manifestTools(live: Awaited<ReturnType<typeof liveTools>>) {
  const meta = TOOL_META as unknown as Record<string, Meta>;
  const names = Object.keys(meta);
  // VoiceOS hook tools (voiceos_hook_*) are hidden endpoints, not manifest tools: the manifest lists the agent's twelve.
  const served = live.map((t) => t.name).filter((n) => !isHookTool(n));
  const unlisted = served.filter((n) => !names.includes(n));
  const missing = names.filter((n) => !served.includes(n));
  if (unlisted.length || missing.length) {
    throw new Error(`server and TOOL_META disagree: served but not in TOOL_META [${unlisted.join(", ")}], in TOOL_META but not served [${missing.join(", ")}]`);
  }
  const photosOff = !photoToolsEnabled();
  return names.map((name) => {
    const m = meta[name];
    const tool = live.find((t) => t.name === name)!;
    if (tool.title !== undefined && tool.title !== m.title) throw new Error(`${name}: server title ${JSON.stringify(tool.title)} isn't TOOL_META's ${JSON.stringify(m.title)}`);
    const { $schema: _schema, ...inputSchema } = tool.inputSchema as Record<string, unknown>;
    const write = WRITE_TOOLS.has(name);
    const background = m.execution?.mode === "background";
    if (write !== background) throw new Error(`${name}: writes run in the background and reads don't (TOOL_META says ${m.execution?.mode ?? "sync"})`);
    // A card's button may call a read; a write is approved on its confirmation card only.
    if (m.uiCallable && write) throw new Error(`${name}: only read tools can be uiCallable`);
    return {
      name,
      title: m.title,
      description: tool.description,
      ...(m.visibility === "agent" ? { visibility: "agent" } : {}),
      ...(background ? { execution: { mode: "background", ...(m.execution?.estimatedDurationMs ? { estimatedDurationMs: m.execution.estimatedDurationMs } : {}) } } : {}),
      ...(m.photo && photosOff ? { disabled: true, disabledReason: PHOTO_DISABLED_REASON } : {}),
      ...(m.uiCallable ? { uiCallable: true } : {}),
      inputSchema,
      ...(write ? { hidePermissionToggle: true, confirmation: buildConfirmation(name as WriteTool) } : {}),
    };
  });
}

// 4. Preview fixtures ------------------------------------------------------
// Reads only (plan §10.1): VoiceOS's previewer really runs every fixture, so no write gets one. verify.ts
// runs the writes itself, against its loopback fake Composio only. query_creator_info needs a file_token
// that only find_recent_videos mints, so verify.ts calls it in its write flow instead. The photo tools ship
// disabled while the media relay isn't set up.
const PREVIEW_FIXTURES: Record<string, Record<string, unknown>> = {
  get_user_stats: { include_profile: true },
  list_videos: { max_count: 5 },
  query_videos: { video_ids: ["7438291034572910101"] },
  fetch_publish_status: {},
  find_recent_videos: { limit: 5 },
};
/** The previews a person sees in the Studio: the user-facing reads. */
const STUDIO_PREVIEW_TOOLS = ["get_user_stats", "list_videos", "query_videos", "fetch_publish_status"];

// ---------------------------------------------------------------------------
const server = await bundleServer();
const tools = manifestTools(await liveTools());
for (const name of Object.keys(PREVIEW_FIXTURES)) {
  if (WRITE_TOOLS.has(name) || !tools.some((t) => t.name === name)) throw new Error(`preview fixture ${name} isn't a read tool the server serves`);
}

const manifest = {
  schemaVersion: 1,
  id: INTEGRATION_ID,
  version: INTEGRATION_VERSION,
  name: "TikTok",
  summary: "Check your TikTok stats and post details, and send videos and photo carousels from your computer to TikTok by voice.",
  description,
  setupGuide,
  categories: ["Social"],
  icon: existing.icon ?? "icon.png",
  supportedPlatforms: ["darwin", "win32"],
  publisher: existing.publisher ?? { id: "pub_user", name: "Made in VoiceOS" },
  // VoiceOS's own integrations launch this way, and it needs only the five shipped files; the share review
  // rejects a runtime that spawns a shell (/bin/zsh run.sh). run.sh/run.cmd stay on disk, unused.
  runtime: { kind: "local-mcp", command: "bun", args: ["server.ts"] },
  // notify: the reminder when a write that outlived its tool call ends (src/reminders.ts).
  // transcript (scope agent): the transcript hook below, which reads each agent utterance in memory to add one note
  // about the TikTok video in progress (src/conversation.ts). Dictation is never read.
  permissions: [{ kind: "network", domains: networkDomains() }, { kind: "background" }, { kind: "notify" }, { kind: "transcript", scope: "agent" }],
  preferences,
  tools,
  // VoiceOS calls the hidden voiceos_hook_transcript tool before each agent turn (src/conversation.ts).
  hooks: { transcript: {} },
  // VoiceOS keeps ten terms across all enabled apps, taking one from each in turn: most-misheard first.
  asr: { vocabulary: ["TikTok", "carousel", "drafts", "Only me", "Duet", "Stitch"] },
};
if (manifest.id !== existing.id) throw new Error(`the manifest id is immutable once installed (${existing.id} → ${manifest.id})`);

writeFileSync(join(root, "server.ts"), server);
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(
  join(root, "voiceos.integration.preview.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      description: "Development-only sample inputs for bun verify.ts and Studio previews. Read tools only: no write has a fixture, and verify.ts runs the writes against its local fake Composio.",
      tools: Object.fromEntries(Object.entries(PREVIEW_FIXTURES).map(([name, args]) => [name, { args, expectedGlanceBlocks: 1 }])),
    },
    null,
    2,
  )}\n`,
);

// The Studio's own copy of the previews. Only the preview block is ours; originalPrompt (and the rest) stay as they are.
const studioPath = join(root, "studio-meta.json");
if (existsSync(studioPath)) {
  const text = readFileSync(studioPath, "utf8");
  const studio = JSON.parse(text);
  studio.preview = {
    utterances: ["How's my TikTok doing?", "How did my last TikToks do?", "Did my last TikTok upload go up?"],
    toolPreviews: STUDIO_PREVIEW_TOOLS.map((name) => ({ tool: name, sampleArgs: PREVIEW_FIXTURES[name] })),
  };
  const next = JSON.stringify(studio, null, 2) + (text.endsWith("\n") ? "\n" : "");
  if (next !== text) writeFileSync(studioPath, next);
}

const kb = (Buffer.byteLength(server) / 1024).toFixed(0);
console.log(`built server.ts (${kb} KB), voiceos.integration.json (${tools.length} tools), preview fixtures (${Object.keys(PREVIEW_FIXTURES).length} reads)`);
// The in-memory server may hold timers (ledger, sweeps); the build is done.
process.exit(0);
