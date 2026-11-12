// Offline tests: runs the real server over MCP against tests/mock-composio.ts. No keys or network needed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { IDS } from "./mock-composio.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MOCK = join(ROOT, "tests", "mock-composio.ts");
const manifest = JSON.parse(readFileSync(join(ROOT, "voiceos.integration.json"), "utf8"));
const source = readFileSync(join(ROOT, "server.ts"), "utf8");

const APPROVED_TOOLS = ["list_recent_meetings", "get_meeting_notes", "get_transcript", "search_meetings"];
const ACCOUNT_TOOLS = ["connect_account", "connection_status", "disconnect_account"];
const CONFIRMED_TOOLS = ["connect_account", "disconnect_account"];
const APPROVED_SLUGS = [
  "GRANOLA_MCP_GET_MEETINGS",
  "GRANOLA_MCP_GET_MEETING_TRANSCRIPT",
  "GRANOLA_MCP_LIST_MEETINGS",
  "GRANOLA_MCP_QUERY_GRANOLA_MEETINGS",
];
const SETUP_ENV = { COMPOSIO_API_KEY: "test", COMPOSIO_AUTH_CONFIG_ID: "ac_test" };
const SIGN_IN_OPENED = "Connect Granola in your browser, then try again.";
const SIGN_IN_EXPIRED = "Your Granola connection expired or was revoked. Reconnect in your browser, then try again.";

type Server = { client: Client; log: string[]; userFile: string };

// PATH points nowhere so the server's `open` call fails instead of opening a real browser.
// Runs from an empty folder, because Bun loads a .env from the working directory.
async function startServer(env: Record<string, string>): Promise<Server> {
  const log: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "granola-test-"));
  const userFile = join(home, "composio-user.json");
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--preload", MOCK, join(ROOT, "server.ts")],
    cwd: home,
    stderr: "pipe",
    env: { PATH: "/nonexistent", HOME: home, GRANOLA_USER_FILE: userFile, ...env },
  });
  transport.stderr?.on("data", (chunk: Buffer) => log.push(...String(chunk).split("\n").filter(Boolean)));
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return { client, log, userFile };
}

const mockCalls = (server: Server) =>
  server.log.filter((line) => line.startsWith("MOCKCALL ")).map((line) => JSON.parse(line.slice(9)));
const executed = (server: Server) =>
  mockCalls(server).filter((c) => c.path.endsWith("/execute")).map((c) => c.body as { tool_slug: string; arguments: any });
const lastArguments = (server: Server, slug: string) => executed(server).filter((c) => c.tool_slug === slug).at(-1)?.arguments;
const linkRequests = (server: Server) => mockCalls(server).filter((c) => c.path.endsWith("/link"));
const accountRequests = (server: Server, method: string, suffix = "") =>
  mockCalls(server).filter((c) => c.method === method && /^\/connected_accounts\/[^/]+/.test(c.path) && c.path.endsWith(suffix));
const savedUserId = (server: Server) => JSON.parse(readFileSync(server.userFile, "utf8")).userId as string;

async function run(server: Server, name: string, args: Record<string, unknown>) {
  const progress: { message?: string }[] = [];
  const result: any = await server.client.callTool({ name, arguments: args }, undefined, {
    onprogress: (p) => progress.push(p),
  });
  const text: string = result.content[0].text;
  let body: any = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text };
  }
  const block = body._voiceos_glance?.blocks?.[0];
  return { isError: Boolean(result.isError), text, body, block, html: String(block?.html ?? ""), progress };
}

describe("manifest", () => {
  test("follows VoiceOS's limits", () => {
    expect(manifest.id).toBe("com.voiceos.generated.granola-composio");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.summary.length).toBeLessThanOrEqual(140);
  });

  test("supports Mac and Windows, with a launcher for each", () => {
    expect(manifest.supportedPlatforms).toEqual(["darwin", "win32"]);
    expect(manifest.runtime).toEqual({ kind: "local-mcp", command: "/bin/zsh", args: ["run.sh"] });
    expect(readFileSync(join(ROOT, "run.cmd"), "utf8")).toContain("server.ts");
  });

  test("declares exactly the four approved tools plus the three account tools", () => {
    expect(manifest.tools.map((t: any) => t.name)).toEqual([...APPROVED_TOOLS, ...ACCOUNT_TOOLS]);
  });

  test("allows only the Composio domain, plus the background and notify permissions connecting needs", () => {
    expect(manifest.permissions).toEqual([
      { kind: "network", domains: ["backend.composio.dev"] },
      { kind: "background" },
      { kind: "notify" },
    ]);
    expect(manifest.tools.find((t: any) => t.name === "connect_account").execution.mode).toBe("background");
  });

  test("only the account tools can be called from a card", () => {
    const callable = manifest.tools.filter((t: any) => t.uiCallable).map((t: any) => t.name);
    expect(callable).toEqual(ACCOUNT_TOOLS);
  });

  // Widget cards, like Teams' send and reply cards. VoiceOS showed its generic "{}" box for the
  // declarative card type.
  test("only connect and disconnect confirm, each with a widget card and a confirm label", () => {
    const labels: Record<string, string> = { connect_account: "Continue", disconnect_account: "Disconnect" };
    for (const tool of manifest.tools) {
      expect(Boolean(tool.confirmation)).toBe(CONFIRMED_TOOLS.includes(tool.name));
      if (!tool.confirmation) continue;
      const root = tool.confirmation.root;
      expect(root.type).toBe("widget");
      expect(root.confirmLabel).toBe(labels[tool.name]);
      expect(root.html).toContain(tool.title);
      expect(root.html).toContain("k-confirm");
    }
  });

  test("declares every setup field the server reads", () => {
    // GRANOLA_USER_FILE is only for tests, to keep the user file out of the folder.
    const read = [...new Set([...source.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]))]
      .filter((name) => name !== "GRANOLA_USER_FILE")
      .sort();
    const declared = manifest.preferences.map((p: any) => p.name).sort();
    expect(read).toEqual(declared);
    for (const pref of manifest.preferences) expect(pref.required).toBe(true);
    expect(manifest.preferences.find((p: any) => p.name === "COMPOSIO_API_KEY").type).toBe("password");
  });

  test("names only the four approved Composio tools", () => {
    const slugs = [...new Set([...source.matchAll(/"(GRANOLA_MCP_[A-Z_]+)"/g)].map((m) => m[1]))].sort();
    expect(slugs).toEqual(APPROVED_SLUGS);
  });
});

describe("connected account", () => {
  let server: Server;

  beforeAll(async () => {
    server = await startServer({ ...SETUP_ENV, MOCK_CONNECTION: "active" });
  });

  afterAll(async () => {
    await server.client.close();
  });

  test("the server exposes the same tools, descriptions and inputs as the manifest", async () => {
    const { tools } = await server.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...APPROVED_TOOLS, ...ACCOUNT_TOOLS].sort());
    for (const tool of tools) {
      const declared = manifest.tools.find((t: any) => t.name === tool.name);
      expect(tool.description).toBe(declared.description);
      expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(Object.keys(declared.inputSchema.properties).sort());
    }
  });

  test("list_recent_meetings lists the last 30 days newest first and limits the session to the approved tools", async () => {
    const r = await run(server, "list_recent_meetings", {});
    expect(r.isError).toBe(false);
    expect(lastArguments(server, "GRANOLA_MCP_LIST_MEETINGS")).toEqual({ time_range: "last_30_days" });
    expect(r.body.meetings.map((m: any) => m.id)).toEqual([IDS.standup, IDS.planning, IDS.retro]);
    expect(r.body).toMatchObject({ count: 3, total: 3, has_more: false });
    expect(r.body.meetings[1]).toMatchObject({
      title: "Q4 Planning & Budget",
      participants: "Shah, Priya (note creator) from Acme (priya@example.com), Sam Lee (sam@example.com)",
      url: `https://notes.granola.ai/d/${IDS.planning}`,
    });
    expect(r.block.type).toBe("widget");
    expect(r.html).toContain("Daily standup");
    expect(r.html).toContain("Q4 Planning &amp; Budget");

    const create = mockCalls(server).find((c) => c.path === "/tool_router/session");
    expect(create.body.user_id).toBe(savedUserId(server));
    expect(create.body.user_id).toMatch(/^voiceos-[0-9a-f-]{36}$/);
    expect(create.body.auth_configs).toEqual({ granola_mcp: "ac_test" });
    expect(create.body.toolkits).toEqual({ enable: ["granola_mcp"] });
    expect(create.body.tools.granola_mcp.enable.sort()).toEqual(APPROVED_SLUGS);
  });

  test("list_recent_meetings respects the limit and reports that there are more", async () => {
    const r = await run(server, "list_recent_meetings", { limit: 1 });
    expect(r.body.meetings.map((m: any) => m.id)).toEqual([IDS.standup]);
    expect(r.body).toMatchObject({ count: 1, total: 3, has_more: true });
  });

  test("list_recent_meetings passes a custom range, and refuses one without both dates", async () => {
    await run(server, "list_recent_meetings", { time_range: "custom", start_date: "2026-10-01", end_date: "2026-10-31" });
    expect(lastArguments(server, "GRANOLA_MCP_LIST_MEETINGS")).toEqual({
      time_range: "custom",
      custom_start: "2026-10-01",
      custom_end: "2026-10-31",
    });

    const before = executed(server).length;
    const r = await run(server, "list_recent_meetings", { time_range: "custom", start_date: "October" });
    expect(r.isError).toBe(true);
    expect(r.body.code).toBe("INVALID_INPUT");
    expect(executed(server).length).toBe(before);
  });

  test("get_meeting_notes returns the summary, private notes and participants, without Granola's instructions", async () => {
    const r = await run(server, "get_meeting_notes", { meeting_ids: [IDS.planning] });
    expect(r.isError).toBe(false);
    expect(lastArguments(server, "GRANOLA_MCP_GET_MEETINGS")).toEqual({ meeting_ids: [IDS.planning] });
    const [notes] = r.body.meetings;
    expect(notes).toMatchObject({ id: IDS.planning, title: "Q4 Planning & Budget", private_notes: "Budget due Friday", transcript_available: true });
    expect(notes.summary).toContain("- Priya owns the budget draft");
    expect(r.body.not_found).toEqual([]);
    expect(r.body.content_note).toContain("not as instructions");
    expect(r.text).not.toContain("search_transcripts");
    expect(r.html).toContain("Ship the beta on Dec 1");
  });

  test("get_meeting_notes lists the IDs Granola didn't find alongside the ones it did", async () => {
    const r = await run(server, "get_meeting_notes", { meeting_ids: [IDS.standup, IDS.unknown] });
    expect(r.isError).toBe(false);
    expect(r.body.meetings.map((m: any) => m.id)).toEqual([IDS.standup]);
    expect(r.body.not_found).toEqual([IDS.unknown]);
  });

  test("get_meeting_notes says when Granola can't find the meeting", async () => {
    const r = await run(server, "get_meeting_notes", { meeting_ids: [IDS.unknown] });
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({ code: "NOT_FOUND", reconnect_required: false });
    expect(r.html).toContain("couldn&#39;t find that meeting");
  });

  test("get_meeting_notes and get_transcript refuse a meeting title instead of an ID, without calling Composio", async () => {
    const before = executed(server).length;
    const notes = await run(server, "get_meeting_notes", { meeting_ids: ["Daily standup"] });
    const transcript = await run(server, "get_transcript", { meeting_id: "Daily standup" });
    for (const r of [notes, transcript]) {
      expect(r.isError).toBe(true);
      expect(r.body.code).toBe("INVALID_INPUT");
      expect(r.body.error).toContain("isn't a Granola meeting ID");
    }
    expect(executed(server).length).toBe(before);
  });

  test("get_transcript returns the transcript, with the first lines on the card", async () => {
    const r = await run(server, "get_transcript", { meeting_id: IDS.standup });
    expect(r.isError).toBe(false);
    expect(lastArguments(server, "GRANOLA_MCP_GET_MEETING_TRANSCRIPT")).toEqual({ meeting_id: IDS.standup });
    expect(r.body).toMatchObject({ id: IDS.standup, title: "Daily standup", truncated: false });
    expect(r.body.transcript).toContain("Sam: The search bug is fixed.");
    expect(r.html).toContain("The search bug is fixed.");
  });

  test("get_transcript cuts a very long transcript short and says so", async () => {
    const r = await run(server, "get_transcript", { meeting_id: IDS.longTalk });
    expect(r.body.transcript.length).toBe(30_000);
    expect(r.body.truncated).toBe(true);
    expect(r.body.total_chars).toBeGreaterThan(30_000);
    expect(r.body.note).toContain("first 30,000");
  });

  test("an error that mentions a meeting ID with 401 in it is reported, not treated as a sign-in problem", async () => {
    const links = linkRequests(server).length;
    const r = await run(server, "get_transcript", { meeting_id: IDS.noTranscript });
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({ code: "GRANOLA_ERROR", reconnect_required: false });
    expect(r.body.error).toContain("has no transcript yet");
    expect(linkRequests(server).length).toBe(links);
  });

  test("a token Granola rejects during a call asks the user to reconnect", async () => {
    const links = linkRequests(server).length;
    const r = await run(server, "get_transcript", { meeting_id: IDS.revoked });
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({ error: SIGN_IN_EXPIRED, code: "CONNECTION_EXPIRED", reconnect_required: true });
    expect(linkRequests(server).length).toBe(links + 1);
  });

  test("search_meetings returns Granola's answer with its cited meetings, minus the note for other assistants", async () => {
    const r = await run(server, "search_meetings", { query: "What did we decide about the beta?" });
    expect(r.isError).toBe(false);
    expect(lastArguments(server, "GRANOLA_MCP_QUERY_GRANOLA_MEETINGS")).toEqual({ query: "What did we decide about the beta?" });
    expect(r.body.answer.startsWith("The team agreed to ship the beta on Dec 1.")).toBe(true);
    expect(r.body.answer).toContain(`[[1]](https://notes.granola.ai/d/${IDS.planning})`);
    expect(r.text).not.toContain("search_transcripts");
    expect(r.body.sources).toEqual([
      { citation: 1, meeting_id: IDS.planning, url: `https://notes.granola.ai/d/${IDS.planning}` },
      { citation: 2, meeting_id: IDS.standup, url: `https://notes.granola.ai/d/${IDS.standup}` },
    ]);
    expect(r.html).toContain("2 sources");
    expect(r.html).not.toContain("[[1]]");
  });

  test("search_meetings can be limited to given meetings", async () => {
    await run(server, "search_meetings", { query: "Any blockers?", meeting_ids: [IDS.standup] });
    expect(lastArguments(server, "GRANOLA_MCP_QUERY_GRANOLA_MEETINGS")).toEqual({
      query: "Any blockers?",
      document_ids: [IDS.standup],
    });
  });

  test("every tool shows a loading message while it works", async () => {
    const calls: [string, Record<string, unknown>, string][] = [
      ["list_recent_meetings", {}, "Getting your Granola meetings…"],
      ["get_meeting_notes", { meeting_ids: [IDS.standup] }, "Getting your meeting notes…"],
      ["get_transcript", { meeting_id: IDS.standup }, "Getting the transcript…"],
      ["search_meetings", { query: "blockers" }, "Searching your Granola meetings…"],
      ["connection_status", {}, "Checking your Granola connection…"],
    ];
    for (const [name, args, message] of calls) {
      const r = await run(server, name, args);
      expect(r.progress.map((p) => p.message)).toEqual([message]);
    }
  });

  test("keeps one Composio user ID for this install", async () => {
    await run(server, "list_recent_meetings", {});
    const users = new Set(mockCalls(server).filter((c) => c.path === "/tool_router/session").map((c) => c.body.user_id));
    expect([...users]).toEqual([savedUserId(server)]);
  });

  test("only approved Composio tools were called", () => {
    for (const call of executed(server)) expect(APPROVED_SLUGS).toContain(call.tool_slug);
  });

  test("talks only to Composio's API, with no version check or telemetry", () => {
    expect([...new Set(mockCalls(server).map((c) => c.host))]).toEqual(["backend.composio.dev"]);
  });
});

describe("no connected account", () => {
  let server: Server;

  beforeAll(async () => {
    server = await startServer({ ...SETUP_ENV, MOCK_CONNECTION: "none" });
  });

  afterAll(async () => {
    await server.client.close();
  });

  test("asks the user to connect, opens the sign-in, and runs nothing", async () => {
    const r = await run(server, "search_meetings", { query: "anything" });
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({ error: SIGN_IN_OPENED, code: "NOT_CONNECTED", reconnect_required: true });
    expect(r.block.type).toBe("widget");
    expect(linkRequests(server)[0].body).toEqual({ toolkit: "granola_mcp" });
    expect(executed(server)).toHaveLength(0);
  });
});

describe("install user ID", () => {
  test("is saved in the home folder, never in the integration folder that Publish zips", async () => {
    const server = await startServer({ ...SETUP_ENV, GRANOLA_USER_FILE: "" });
    try {
      await run(server, "list_recent_meetings", {});
      const home = server.userFile.slice(0, server.userFile.lastIndexOf("/"));
      const saved = JSON.parse(readFileSync(join(home, ".voiceos", "granola-composio-user.json"), "utf8"));
      expect(saved.userId).toMatch(/^voiceos-[0-9a-f-]{36}$/);
      expect(existsSync(join(ROOT, ".composio-user.json"))).toBe(false);
    } finally {
      await server.client.close();
    }
  });
});

describe("opening the sign-in", () => {
  // Fake `open` and `rundll32` commands on PATH record exactly how the server launched them.
  async function launchedFor(platform: string): Promise<string[]> {
    const bin = mkdtempSync(join(tmpdir(), "granola-bin-"));
    const record = join(bin, "launched.txt");
    for (const name of ["open", "rundll32"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "\${0##*/}" "$@" >> "${record}"\n`, { mode: 0o755 });
    }
    const server = await startServer({ ...SETUP_ENV, MOCK_CONNECTION: "none", MOCK_PLATFORM: platform, PATH: bin });
    try {
      await run(server, "list_recent_meetings", {});
      for (let i = 0; i < 40 && !existsSync(record); i++) await Bun.sleep(50);
      return readFileSync(record, "utf8").trim().split("\n");
    } finally {
      await server.client.close();
    }
  }

  test("uses open on macOS", async () => {
    expect(await launchedFor("darwin")).toEqual(["open", "https://connect.composio.dev/link/test"]);
  });

  test("uses rundll32 on Windows, which has no open command", async () => {
    expect(await launchedFor("win32")).toEqual(["rundll32", "url.dll,FileProtocolHandler", "https://connect.composio.dev/link/test"]);
  });
});

describe("expired connection", () => {
  let server: Server;

  beforeAll(async () => {
    server = await startServer({ ...SETUP_ENV, MOCK_CONNECTION: "expired" });
  });

  afterAll(async () => {
    await server.client.close();
  });

  test("asks the user to reconnect and runs nothing", async () => {
    const r = await run(server, "list_recent_meetings", {});
    expect(r.isError).toBe(true);
    expect(r.body).toMatchObject({ error: SIGN_IN_EXPIRED, code: "CONNECTION_EXPIRED", reconnect_required: true });
    expect(linkRequests(server)).toHaveLength(1);
    expect(executed(server)).toHaveLength(0);
  });
});

describe("missing setup", () => {
  let server: Server;

  beforeAll(async () => {
    server = await startServer({});
  });

  afterAll(async () => {
    await server.client.close();
  });

  test("every tool says the setup fields are missing", async () => {
    for (const name of [...APPROVED_TOOLS, ...ACCOUNT_TOOLS]) {
      const args = name === "get_transcript" ? { meeting_id: IDS.standup } : name === "get_meeting_notes" ? { meeting_ids: [IDS.standup] } : name === "search_meetings" ? { query: "x" } : {};
      const r = await run(server, name, args);
      expect(r.isError).toBe(true);
      expect(r.body.code).toBe("SETUP_MISSING");
      expect(r.body.error).toContain("Composio API key and auth config ID");
    }
    expect(mockCalls(server)).toHaveLength(0);
  });
});

describe("account tools", () => {
  const started: Server[] = [];
  const startWith = async (mock: Record<string, string>) => {
    const server = await startServer({ ...SETUP_ENV, ...mock });
    started.push(server);
    return server;
  };

  afterAll(async () => {
    await Promise.all(started.map((server) => server.client.close()));
  });

  test("connection_status shows a connected account with Disconnect and Refresh controls", async () => {
    const server = await startWith({ MOCK_CONNECTION: "active" });
    const r = await run(server, "connection_status", {});
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ connected: true, status: "Connected" });
    expect(r.block.type).toBe("widget");
    expect(r.html).toContain("Granola account");
    for (const name of ACCOUNT_TOOLS) expect(r.html).toContain(`"${name}"`);
    expect(linkRequests(server)).toHaveLength(0);
  });

  test("connection_status never starts a sign-in", async () => {
    const server = await startWith({ MOCK_CONNECTION: "none" });
    const r = await run(server, "connection_status", {});
    expect(r.body).toMatchObject({ connected: false, status: "Not connected" });
    expect(linkRequests(server)).toHaveLength(0);
  });

  test("connection_status tells the user an expired sign-in needs connecting again", async () => {
    const server = await startWith({ MOCK_CONNECTION: "expired" });
    const r = await run(server, "connection_status", {});
    expect(r.body).toMatchObject({ connected: false, status: "Expired" });
    expect(r.body.message).toContain("Connect again");
    expect(linkRequests(server)).toHaveLength(0);
  });

  test("connect_account doesn't start a sign-in when Granola is already connected", async () => {
    const server = await startWith({ MOCK_CONNECTION: "active" });
    const r = await run(server, "connect_account", {});
    expect(r.body).toMatchObject({ connected: true, status: "Connected" });
    expect(linkRequests(server)).toHaveLength(0);
  });

  test("connect_account signs in, waits for it to finish, and the tools then work", async () => {
    const server = await startWith({ MOCK_CONNECTION: "none" });
    const r = await run(server, "connect_account", {});
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ connected: true, status: "Connected" });
    expect(linkRequests(server)).toHaveLength(1);

    const meetings = await run(server, "list_recent_meetings", {});
    expect(meetings.isError).toBe(false);
    expect(linkRequests(server)).toHaveLength(1);
  });

  test("connect_account fixes an expired connection", async () => {
    const server = await startWith({ MOCK_CONNECTION: "expired" });
    const r = await run(server, "connect_account", {});
    expect(r.body).toMatchObject({ connected: true, status: "Connected" });
    expect((await run(server, "connection_status", {})).body.connected).toBe(true);
  });

  test("two connects at once share one sign-in", async () => {
    const server = await startWith({ MOCK_CONNECTION: "none" });
    const [first, second] = await Promise.all([run(server, "connect_account", {}), run(server, "connect_account", {})]);
    expect(first.body.connected).toBe(true);
    expect(second.body.connected).toBe(true);
    expect(linkRequests(server)).toHaveLength(1);
  });

  test("connect_account says to refresh when the sign-in hasn't finished in time", async () => {
    const server = await startWith({ MOCK_CONNECTION: "none", MOCK_SIGN_IN: "pending" });
    const r = await run(server, "connect_account", {});
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ connected: false, status: "Waiting for sign-in" });
    expect(r.body.message).toContain("then refresh");
  });

  test("connect_account reports a failed sign-in", async () => {
    const server = await startWith({ MOCK_CONNECTION: "none", MOCK_SIGN_IN: "failed" });
    const r = await run(server, "connect_account", {});
    expect(r.isError).toBe(true);
    expect(r.body.error).toBe("Granola sign-in didn't complete. Try connecting again.");
  });

  test("disconnect_account revokes and removes only this install's Granola connections", async () => {
    const server = await startWith({ MOCK_CONNECTION: "active" });
    const r = await run(server, "disconnect_account", {});
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ connected: false, status: "Not connected" });
    expect(r.body.message).toBe("Granola is disconnected. Nothing in Granola was changed.");

    const list = mockCalls(server).find((c) => c.path === "/connected_accounts");
    const query = new URLSearchParams(list.query);
    expect(query.getAll("user_ids")).toEqual([savedUserId(server)]);
    expect(query.getAll("auth_config_ids")).toEqual(["ac_test"]);
    expect(query.getAll("toolkit_slugs")).toEqual(["granola_mcp"]);

    const removed = accountRequests(server, "DELETE").map((c) => c.path);
    expect(removed).toEqual(["/connected_accounts/ca_test", "/connected_accounts/ca_duplicate"]);
    expect(accountRequests(server, "POST", "/revoke")).toHaveLength(2);
    expect((await run(server, "connection_status", {})).body.connected).toBe(false);
  });

  test("disconnect_account still removes the connection when Composio can't revoke at Granola", async () => {
    const server = await startWith({ MOCK_CONNECTION: "active", MOCK_REVOKE: "unsupported" });
    const r = await run(server, "disconnect_account", {});
    expect(r.isError).toBe(false);
    expect(r.body.connected).toBe(false);
    expect(r.body.message).toContain("within 6 hours");
    expect(accountRequests(server, "DELETE")).toHaveLength(2);
  });

  test("disconnect_account explains when the API key can't change connections", async () => {
    const server = await startWith({ MOCK_CONNECTION: "active", MOCK_DELETE: "denied" });
    const r = await run(server, "disconnect_account", {});
    expect(r.isError).toBe(true);
    expect(r.body.error).toContain("write access to Connected accounts");
    expect((await run(server, "connection_status", {})).body.connected).toBe(true);
  });

  test("disconnect_account doesn't claim success if Composio still shows Granola connected", async () => {
    const server = await startWith({ MOCK_CONNECTION: "active", MOCK_DELETE: "ignored" });
    const r = await run(server, "disconnect_account", {});
    expect(r.isError).toBe(true);
    expect(r.body.error).toBe("Composio still shows Granola as connected. Refresh and try again.");
  });

  test("disconnect_account does nothing when Granola isn't connected", async () => {
    const server = await startWith({ MOCK_CONNECTION: "none" });
    const r = await run(server, "disconnect_account", {});
    expect(r.body.message).toBe("Granola is already disconnected.");
    expect(accountRequests(server, "DELETE")).toHaveLength(0);
    expect(accountRequests(server, "POST", "/revoke")).toHaveLength(0);
  });

  test("after a disconnect, a Granola tool falls back to opening the sign-in", async () => {
    const server = await startWith({ MOCK_CONNECTION: "active" });
    await run(server, "disconnect_account", {});
    const r = await run(server, "list_recent_meetings", {});
    expect(r.isError).toBe(true);
    expect(r.body.error).toBe(SIGN_IN_OPENED);
    expect(linkRequests(server)).toHaveLength(1);
  });
});
