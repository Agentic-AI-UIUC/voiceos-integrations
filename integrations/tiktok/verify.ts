/**
 * bun verify.ts — the VoiceOS smoke test (plan §10.1; adapted from GitHub #16's verify.ts).
 *
 * Launches server.ts exactly the way VoiceOS does: its bundled Bun, the manifest's runtime, and the
 * environment VoiceOS builds. Composio is a loopback fake (tests/mock-composio.ts); state goes to a
 * throwaway folder; the "home" is a fixture folder whose Downloads holds one tiny .mp4. Then it speaks
 * real MCP over stdio:
 *  - handshake; tools/list equals the manifest both ways (names, descriptions, schemas); every
 *    description says when to use it
 *  - every READ preview fixture returns text and 1–3 glance blocks without an error
 *  - a full video-drafts write: find_recent_videos → upload_video carrying the receipt its card would
 *    stage (minted by the same receipt core the card inlines) → staged upload, one TIKTOK_UPLOAD_VIDEO,
 *    status walked PROCESSING_UPLOAD → SEND_TO_USER_INBOX → completion card
 *  - the same write with no receipt (a spoken yes, or Ask before every action off) and with a spent one:
 *    CONFIRMATION_REQUIRED, and nothing reaches Composio
 *  - the server's stderr never carries the key, the account id, a path or a presigned URL
 * `--package` launches only the five files Publish ships, from an empty folder with an empty Bun cache
 * (a teammate's first launch), and checks that nothing was downloaded.
 *
 * Nothing here can reach real Composio or TikTok: the server honours --composio-base-url only for
 * loopback, and no write has a preview fixture. Exits non-zero on any failure.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, utimesSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { TIKTOK_TOOLKIT_VERSION } from "./src/config.ts";
import { randomNonce, receiptCore } from "./src/receipts.ts";
import { startMockComposio } from "./tests/mock-composio.ts";

const root = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, "voiceos.integration.json"), "utf8"));
const preview = JSON.parse(readFileSync(join(root, "voiceos.integration.preview.json"), "utf8"));
const WRITES = new Set(["upload_video", "publish_video", "upload_photos", "post_photos"]);

let failures = 0;
const check = (ok: unknown, label: string) => {
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) failures++;
};

check(manifest.schemaVersion === 1, "manifest schema version is v1");
check(preview.schemaVersion === 1, "preview fixture schema version is v1");
check(JSON.stringify(manifest.runtime) === JSON.stringify({ kind: "local-mcp", command: "bun", args: ["server.ts"] }), "runtime is VoiceOS's own `bun server.ts` launch");
const writeFixtures = Object.keys(preview.tools ?? {}).filter((name) => WRITES.has(name));
check(writeFixtures.length === 0, `no write tool has a preview fixture (VoiceOS's previewer really runs them)${writeFixtures.length ? `: ${writeFixtures.join(", ")}` : ""}`);

// The fixture home: what find_recent_videos sees instead of the real ~/Downloads, ~/Desktop and ~/Movies.
const VIDEO_NAME = "verify_export.mp4";
const home = mkdtempSync(join(tmpdir(), "voiceos-tiktok-home-"));
const homeReal = realpathSync(home); // /var/… is /private/var/… on macOS
for (const folder of ["Downloads", "Desktop", "Movies", "Pictures"]) mkdirSync(join(home, folder));
const videoPath = join(home, "Downloads", VIDEO_NAME);
// A tiny real video (ffmpeg, moov first), the same one tests/media.test.ts reads.
copyFileSync(join(root, "tests/fixtures/media/ffmpeg-faststart.mp4"), videoPath);
// Files modified in the last 5 s are skipped as still downloading; this one finished 10 minutes ago.
const finished = new Date(Date.now() - 10 * 60_000);
utimesSync(videoPath, finished, finished);

const mock = startMockComposio();

// The environment VoiceOS gives the process (its main process's buildMcpProcessEnv): the MCP SDK's default
// inherited variables, the JIT turned off, its bundled Bun as VOICEOS_BUN, the stored setup values, and
// Homebrew/Bun bins in front of a Dock-launched app's PATH (launchd's, not the user's shell PATH).
const VOICEOS_BUN = "/Applications/VoiceOS.app/Contents/Resources/bun-runtime/bun";
/**
 * The Bun VoiceOS actually runs for `"command": "bun"`: the first `bun` on the PATH it builds (Homebrew, then
 * /usr/local, ~/.bun/bin, ~/.local/bin, the inherited PATH, and its own bundled Bun last). On a Mac with its own
 * Bun that's the user's version, not the bundled one (found 2026-11-06: Bun 1.3.13 in ~/.bun/bin ended the
 * server's stdin after every upload). Launch the same one.
 */
const HOST_BUN = process.platform === "win32" ? process.execPath : [
  "/opt/homebrew/bin/bun", "/usr/local/bin/bun", join(homedir(), ".bun", "bin", "bun"), join(homedir(), ".local", "bin", "bun"), VOICEOS_BUN,
].find((p) => existsSync(p));
function hostEnvironment(setupValues: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ["HOME", "LOGNAME", "SHELL", "TERM", "USER", "SystemRoot", "WINDIR", "COMSPEC", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP", "PATHEXT"]) {
    const value = process.env[name];
    if (value !== undefined && !value.startsWith("()")) env[name] = value;
  }
  const bun = existsSync(VOICEOS_BUN) ? VOICEOS_BUN : undefined;
  const path = process.platform === "win32" ? [dirname(process.execPath), ...(process.env.PATH ?? "").split(delimiter)] : ["/opt/homebrew/bin", "/usr/local/bin", join(homedir(), ".bun", "bin"), join(homedir(), ".local", "bin"), "/usr/bin", "/bin", "/usr/sbin", "/sbin", ...(bun ? [dirname(bun)] : [])];
  return { ...env, BUN_JSC_useJIT: "false", ...setupValues, ...(bun ? { VOICEOS_BUN: bun } : {}), PATH: [...new Set(path)].join(delimiter) };
}

// --package: a teammate's first launch. Only the five files the share service packages, in an empty folder,
// with an empty Bun cache: anything server.ts still imported from npm would be downloaded there.
const asPackage = process.argv.includes("--package");
const SHARED_FILES = ["icon.png", "package.json", "server.ts", "voiceos.integration.json", "widgetKit.ts"];
const launchDir = asPackage ? mkdtempSync(join(tmpdir(), "voiceos-tiktok-package-")) : root;
const bunCache = asPackage ? mkdtempSync(join(tmpdir(), "voiceos-tiktok-bun-cache-")) : undefined;
if (asPackage) for (const f of SHARED_FILES) copyFileSync(join(root, f), join(launchDir, f));
console.log(
  asPackage
    ? "· launching the shared package alone, with an empty Bun cache (a teammate's first launch)"
    : HOST_BUN
      ? `· launching on the Bun VoiceOS picks from its PATH (${HOST_BUN === VOICEOS_BUN ? "its bundled one" : HOST_BUN.replace(homedir(), "~")}), JIT off, as VoiceOS does`
      : "· VoiceOS isn't installed here; launching on this machine's Bun",
);

const state = mkdtempSync(join(tmpdir(), "voiceos-tiktok-verify-"));
const transport = new StdioClientTransport({
  command: HOST_BUN ?? "bun",
  args: ["server.ts", `--composio-base-url=${mock.baseUrl}`, `--state-dir=${state}`, `--home=${home}`, "--poll-schedule=50,50,50"],
  cwd: launchDir,
  env: hostEnvironment({
    COMPOSIO_API_KEY: mock.apiKey,
    COMPOSIO_USER_ID: mock.userId,
    COMPOSIO_CONNECTED_ACCOUNT_ID: mock.connectedAccountId,
    // Reload keeps values stored for fields an earlier manifest declared (1.0.0 had these two) and still
    // passes them. They must be ignored; an unroutable address proves it without risking a real call.
    COMPOSIO_BASE_URL: "http://192.0.2.1:9/api/v3.1",
    MEDIA_RELAY_URL: "http://192.0.2.1:9",
    ...(bunCache ? { BUN_INSTALL_CACHE_DIR: bunCache } : {}),
  }),
  stderr: "pipe",
});
let serverLog = "";
transport.stderr?.on("data", (chunk: Buffer) => {
  serverLog += chunk.toString("utf8");
});
const client = new Client({ name: "voiceos-verify", version: "1.0.0" });

const glanceBlocks = (res: any, json: any): any[] => json?._voiceos_glance?.blocks ?? res?.structuredContent?._voiceos_glance?.blocks ?? [];

// VoiceOS gives every tool call the MCP SDK's default 60 s. Against a local fake Composio, anything near that is a bug.
let slowest = { name: "", ms: 0 };
try {
  const started = Date.now();
  await client.connect(transport);
  check(true, `initialize handshake (${Date.now() - started} ms)`);

  const { tools: listed } = await client.listTools();
  // voiceos_hook_* tools are VoiceOS hook endpoints: VoiceOS keeps them out of the agent's tool list, and they
  // aren't manifest tools. The manifest declares them under `hooks` instead.
  const hookTools = listed.filter((t) => t.name.startsWith("voiceos_hook_"));
  const tools = listed.filter((t) => !t.name.startsWith("voiceos_hook_"));
  check(
    JSON.stringify(hookTools.map((t) => t.name)) === JSON.stringify(Object.keys(manifest.hooks ?? {}).map((h) => `voiceos_hook_${h}`)) &&
      (manifest.permissions ?? []).some((p: any) => p.kind === "transcript" && p.scope === "agent"),
    `hook tools served match the manifest's hooks (${hookTools.map((t) => t.name).join(", ") || "none"}), with the transcript permission (scope agent)`,
  );
  const served = tools.map((t) => t.name).sort();
  const declared = manifest.tools.map((t: any) => t.name).sort();
  check(JSON.stringify(served) === JSON.stringify(declared), `tools match voiceos.integration.json both ways — ${served.join(", ")}`);
  for (const t of tools) {
    const entry = manifest.tools.find((m: any) => m.name === t.name);
    const { $schema: _s, ...schema } = t.inputSchema as Record<string, unknown>;
    check(entry && entry.description === t.description && JSON.stringify(entry.inputSchema) === JSON.stringify(schema), `${t.name}: the manifest carries the server's description and schema`);
    check((t.description ?? "").length > 40 && (t.description ?? "").includes("Use when"), `${t.name} has a model-facing description that says when to use it`);
  }

  const call = async (name: string, args: Record<string, unknown>) => {
    const t0 = Date.now();
    const res: any = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
    const ms = Date.now() - t0;
    if (ms > slowest.ms) slowest = { name, ms };
    // A failed write's text is plain words; its JSON is in structuredContent (results.ts leadWithWords).
    const texts: string[] = (res.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text ?? "");
    const structured = res.structuredContent && typeof res.structuredContent === "object" ? res.structuredContent : undefined;
    const text: string = [...texts, structured ? JSON.stringify(structured) : ""].filter(Boolean).join("\n");
    let json: any = structured;
    if (!json) {
      try {
        json = JSON.parse(texts.find((t) => t.trimStart().startsWith("{")) ?? texts[0] ?? "");
      } catch {}
    }
    return { res, text, json, blocks: glanceBlocks(res, json) };
  };

  // Every read fixture, the way VoiceOS's previewer runs them.
  let firstVideoId: string | undefined;
  let listedIds: string[] = [];
  for (const [name, fixture] of Object.entries(preview.tools ?? {}) as Array<[string, any]>) {
    const args = { ...fixture.args };
    // Post ids differ per account: ask the same way the agent would, from list_videos.
    if (name === "query_videos" && firstVideoId && !listedIds.includes(String(args.video_ids?.[0]))) args.video_ids = [firstVideoId];
    const { res, text, json, blocks } = await call(name, args);
    if (name === "list_videos") {
      listedIds = (json?.videos ?? []).map((v: any) => String(v?.id));
      firstVideoId = listedIds[0];
    }
    check(text.length > 0 && json, `${name} preview call returns JSON text`);
    check(blocks.length >= 1 && blocks.length <= 3 && (fixture.expectedGlanceBlocks ?? blocks.length) === blocks.length, `${name} preview call returns 1-3 glance blocks (${blocks.length})`);
    check(!res.isError, `${name} preview call succeeds${res.isError ? ` (${json?.error?.code ?? ""} ${json?.error?.message ?? text.slice(0, 160)})` : ""}`);
  }

  // A video to drafts, start to finish, the way a user approves it on the card.
  const found = await call("find_recent_videos", {});
  const video = found.json?.videos?.find((v: any) => typeof v?.file_token === "string");
  check(!found.res.isError && video && video.name === VIDEO_NAME, `find_recent_videos lists the fixture video with a file_token${video ? "" : ` (${found.text.slice(0, 160)})`}`);
  check(!found.text.includes(home) && !found.text.includes(homeReal), "find_recent_videos shows no path to the model");

  const creator = await call("query_creator_info", { file_token: video?.file_token });
  check(!creator.res.isError && typeof creator.json?.post_token === "string" && Array.isArray(creator.json?.privacy_options), `query_creator_info returns posting options and a post_token${creator.res.isError ? ` (${creator.text.slice(0, 160)})` : ""}`);

  // The mock's own answer to the init (it checks the arguments), with the status walk this run expects.
  let publishId: string | undefined;
  mock.on("TIKTOK_UPLOAD_VIDEO", (a, c) => {
    const answer: any = mock.defaultReply("TIKTOK_UPLOAD_VIDEO", a, c);
    publishId = answer?.json?.data?.data?.publish_id;
    if (publishId) mock.setStatusSequence(publishId, [{ status: "PROCESSING_UPLOAD" }, { status: "SEND_TO_USER_INBOX" }]);
    return answer;
  });

  // What the card stages: the agent's arguments as the bridge passes them (strings), plus the receipt the
  // card's script mints from them with the same receipt core (src/receiptCoreScript.ts, inlined in the card;
  // src/receipts.ts exports it as receiptCore).
  const approved: Record<string, unknown> = {
    file_token: video?.file_token,
    file_name: video?.name,
    ...(video?.duration_label ? { duration_label: video.duration_label } : {}),
    ...(video?.size_label ? { size_label: video.size_label } : {}),
    caption: "",
    copy_caption: "false",
  };
  const receipt = receiptCore.mint("upload_video", approved, Date.now(), randomNonce());
  const before = { inits: mock.executes("TIKTOK_UPLOAD_VIDEO").length, polls: mock.executes("TIKTOK_FETCH_PUBLISH_STATUS").length, puts: mock.presigned.puts.length };
  const sent = await call("upload_video", { ...approved, confirmation_receipt: receipt });
  const inits = mock.executes("TIKTOK_UPLOAD_VIDEO").slice(before.inits);
  const polls = mock.executes("TIKTOK_FETCH_PUBLISH_STATUS").slice(before.polls);
  check(!sent.res.isError, `upload_video with the card's receipt succeeds${sent.res.isError ? ` (${sent.text.slice(0, 200)})` : ""}`);
  check(sent.blocks.length >= 1 && sent.blocks.length <= 3 && sent.blocks.some((b: any) => b?.type === "widget"), `upload_video returns a completion card (${sent.blocks.length} glance block(s))`);
  check(/SEND_TO_USER_INBOX|inbox/i.test(sent.text), "upload_video reports the video waiting in the TikTok inbox");
  check(mock.presigned.puts.length === before.puts + 1 && !Object.keys(mock.presigned.puts.at(-1)?.headers ?? {}).some((h) => h.toLowerCase() === "x-api-key"), "the video was staged with one presigned PUT, without the API key");
  check(inits.length === 1, `exactly one TIKTOK_UPLOAD_VIDEO was sent (${inits.length})`);
  check(inits[0]?.body?.version === TIKTOK_TOOLKIT_VERSION && inits[0]?.body?.arguments?.publish === false && typeof inits[0]?.body?.arguments?.file_to_upload?.s3key === "string", `it pins version ${TIKTOK_TOOLKIT_VERSION}, sends to drafts (publish:false) and carries the staged file`);
  check(publishId !== undefined && polls.length >= 2 && polls.every((p) => p.body?.arguments?.publish_id === publishId), `the status of that publish_id was polled to SEND_TO_USER_INBOX (${polls.length} checks)`);

  const status = await call("fetch_publish_status", {});
  check(!status.res.isError && /SEND_TO_USER_INBOX|inbox/i.test(status.text), "fetch_publish_status with no id reports that upload from the ledger");

  // The transcript hook, the way VoiceOS calls it before a turn: a TikTok-shaped utterance gets one note about that
  // video (no path); an unrelated one gets nothing. Both well inside VoiceOS's 500 ms budget.
  const hook = async (transcript: string) => {
    const t0 = Date.now();
    const res: any = await client.callTool({ name: "voiceos_hook_transcript", arguments: { payload_json: JSON.stringify({ hookApiVersion: 1, event: "transcript", transcript, source: "voice" }) } });
    return { ms: Date.now() - t0, json: JSON.parse(res.content?.[0]?.text ?? "{}") };
  };
  const onTopic = await hook("actually make it a post");
  const note = String(onTopic.json.additionalContext ?? "");
  check(
    onTopic.json.decision === "continue" && note.startsWith("TikTok:") && note.toLowerCase().includes(String(approved.file_name).replace(/\.(mp4|mov)$/i, "").replace(/[-_]+/g, " ").toLowerCase()) && !/(^|[\s"(])\//.test(note) && note.length <= 450 && onTopic.ms < 250,
    `transcript hook adds a note about the video in progress for "actually make it a post" (${note.length} chars, ${onTopic.ms} ms)${note.startsWith("TikTok:") ? "" : `: ${JSON.stringify(onTopic.json).slice(0, 200)}`}`,
  );
  const offTopic = await hook("what's the weather tomorrow");
  check(offTopic.json.decision === "continue" && offTopic.json.additionalContext === undefined, "transcript hook stays quiet for an unrelated utterance");

  // A spoken "yes" (or Ask before every action off) arrives with no receipt; a replayed one is spent.
  const quiet = { executes: mock.executes().length, uploads: mock.calls.filter((c) => c.path.includes("/files/upload")).length, puts: mock.presigned.puts.length };
  const bare = await call("upload_video", approved);
  check(/CONFIRMATION_REQUIRED/.test(bare.text), `upload_video without a receipt is refused with CONFIRMATION_REQUIRED${/CONFIRMATION_REQUIRED/.test(bare.text) ? "" : ` (${bare.text.slice(0, 160)})`}`);
  check(bare.blocks.length >= 1 && bare.blocks.length <= 3, "the refusal comes back as a card");
  const replay = await call("upload_video", { ...approved, confirmation_receipt: receipt });
  check(/CONFIRMATION_REQUIRED/.test(replay.text), "a spent receipt is refused with CONFIRMATION_REQUIRED");
  const after = { executes: mock.executes().length, uploads: mock.calls.filter((c) => c.path.includes("/files/upload")).length, puts: mock.presigned.puts.length };
  check(JSON.stringify(after) === JSON.stringify(quiet), `refused writes sent nothing to Composio (${after.executes - quiet.executes} executes, ${after.uploads - quiet.uploads} upload requests, ${after.puts - quiet.puts} PUTs)`);

  check(mock.calls.length > 0, "every Composio request went to the loopback fake (the stale base-URL setting was ignored)");
  check(slowest.ms < 10_000, `every call finished well inside VoiceOS's 60 s limit (slowest: ${slowest.name}, ${slowest.ms} ms)`);
  if (bunCache) {
    const fetched = readdirSync(bunCache);
    check(fetched.length === 0, `first launch downloaded nothing; server.ts carries its dependencies${fetched.length ? ` (fetched: ${fetched.join(", ")})` : ""}`);
    check(!existsSync(join(launchDir, "node_modules")), "the shared package ran without node_modules");
  }
} catch (error) {
  check(false, `verification crashed: ${(error as Error).message}`);
} finally {
  await client.close().catch(() => {});
  mock.stop();
  // stderr is what VoiceOS keeps in its logs (hard rule 2).
  const leaks = [
    ["the API key", mock.apiKey],
    ["the connected account id", mock.connectedAccountId],
    ["a file path", home],
    ["a file path", homeReal],
    ["a presigned URL", "/presigned/"],
  ].filter(([, secret]) => secret && serverLog.includes(secret));
  check(leaks.length === 0, `the server's stderr carries no key, account id, path or presigned URL${leaks.length ? ` (found ${leaks.map(([what]) => what).join(", ")})` : ""}`);
  rmSync(state, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  if (asPackage) rmSync(launchDir, { recursive: true, force: true });
  if (bunCache) rmSync(bunCache, { recursive: true, force: true });
}

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nall checks passed");
process.exit(0);
