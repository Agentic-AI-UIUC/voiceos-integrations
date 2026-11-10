// Offline tests: runs the real server over MCP against tests/mock-composio.ts. No keys or network needed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MOCK = join(ROOT, "tests", "mock-composio.ts");
const manifest = JSON.parse(readFileSync(join(ROOT, "voiceos.integration.json"), "utf8"));
const source = readFileSync(join(ROOT, "server.ts"), "utf8");

const APPROVED_TOOLS = [
  "get_all_chats",
  "get_chat_messages",
  "send_chat_message",
  "reply_to_message",
  "create_online_meeting",
  "create_channel",
];
const ACCOUNT_TOOLS = ["connect_account", "connection_status", "disconnect_account"];
const WRITE_TOOLS = [
  "send_chat_message",
  "reply_to_message",
  "create_online_meeting",
  "create_channel",
  "connect_account",
  "disconnect_account",
];
const APPROVED_SLUGS = [
  "MICROSOFT_TEAMS_CHATS_GET_ALL_CHATS",
  "MICROSOFT_TEAMS_CREATE_CHANNEL",
  "MICROSOFT_TEAMS_GET_MY_PROFILE",
  "MICROSOFT_TEAMS_LIST_USER_CHAT_MESSAGES",
  "MICROSOFT_TEAMS_POST_MESSAGE_REPLY",
  "MICROSOFT_TEAMS_TEAMS_POST_CHAT_MESSAGE",
];
const SETUP_ENV = { COMPOSIO_API_KEY: "test", COMPOSIO_AUTH_CONFIG_ID: "ac_test", VOICEOS_USER_ID: "tester" };

type Server = { client: Client; log: string[] };

// PATH points nowhere so the server's `open` call fails instead of opening a real browser.
async function startServer(env: Record<string, string>): Promise<Server> {
  const log: string[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--preload", MOCK, join(ROOT, "server.ts")],
    stderr: "pipe",
    env: { PATH: "/nonexistent", HOME: mkdtempSync(join(tmpdir(), "teams-test-")), ...env },
  });
  transport.stderr?.on("data", (chunk: Buffer) => log.push(...String(chunk).split("\n").filter(Boolean)));
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return { client, log };
}

const mockCalls = (server: Server) =>
  server.log.filter((line) => line.startsWith("MOCKCALL ")).map((line) => JSON.parse(line.slice(9)));
const executed = (server: Server) =>
  mockCalls(server).filter((c) => c.path.endsWith("/execute")).map((c) => c.body as { tool_slug: string; arguments: any });
const lastArguments = (server: Server, slug: string) => executed(server).filter((c) => c.tool_slug === slug).at(-1)?.arguments;
const proxyRequests = (server: Server) => mockCalls(server).filter((c) => c.path.endsWith("/proxy_execute"));
const linkRequests = (server: Server) => mockCalls(server).filter((c) => c.path.endsWith("/link"));
const accountRequests = (server: Server, method: string, suffix = "") =>
  mockCalls(server).filter((c) => c.method === method && /^\/connected_accounts\/[^/]+/.test(c.path) && c.path.endsWith(suffix));

async function run(server: Server, name: string, args: Record<string, unknown>) {
  const result: any = await server.client.callTool({ name, arguments: args });
  const text: string = result.content[0].text;
  let body: any = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text };
  }
  const block = body._voiceos_glance?.blocks?.[0];
  return { isError: Boolean(result.isError), text, body, block, html: String(block?.html ?? "") };
}

describe("manifest", () => {
  test("follows VoiceOS's limits", () => {
    expect(manifest.id).toBe("com.voiceos.generated.microsoft-teams");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.summary.length).toBeLessThanOrEqual(140);
  });

  test("supports macOS and Windows, with a launcher for each", () => {
    expect(manifest.supportedPlatforms).toEqual(["darwin", "win32"]);
    expect(existsSync(join(ROOT, "run.sh"))).toBe(true);
    expect(existsSync(join(ROOT, "run.cmd"))).toBe(true);
  });

  test("declares exactly the six approved tools plus the three account tools", () => {
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

  test("connect and disconnect confirm with exactly one confirm and one cancel", () => {
    for (const name of ["connect_account", "disconnect_account"]) {
      const { root } = manifest.tools.find((t: any) => t.name === name).confirmation;
      const roles = root.footer[0].items.map((item: any) => item.role).sort();
      expect(roles).toEqual(["cancel", "confirm"]);
    }
  });

  test("puts a confirmation card on every write and on no read", () => {
    for (const tool of manifest.tools) {
      expect(Boolean(tool.confirmation)).toBe(WRITE_TOOLS.includes(tool.name));
    }
  });

  test("binds every confirmation field to a real tool input", () => {
    for (const tool of manifest.tools.filter((t: any) => t.confirmation?.root.type === "widget")) {
      const bound = [...String(tool.confirmation.root.html).matchAll(/data-voiceos-key="([a-z_]+)"/g)].map((m) => m[1]);
      expect(bound.length).toBeGreaterThan(0);
      for (const key of bound) expect(Object.keys(tool.inputSchema.properties)).toContain(key);
    }
  });

  test("declares every environment variable the server reads", () => {
    const read = [...new Set([...source.matchAll(/process\.env\.([A-Z_]+)/g)].map((m) => m[1]))].sort();
    const declared = manifest.preferences.map((p: any) => p.name).sort();
    expect(read).toEqual(declared);
    for (const pref of manifest.preferences) expect(pref.required).toBe(true);
  });

  test("calls only approved Composio tools", () => {
    const slugs = [...new Set([...source.matchAll(/"(MICROSOFT_TEAMS_[A-Z_]+)"/g)].map((m) => m[1]))].sort();
    expect(slugs).toEqual(APPROVED_SLUGS);
  });
});

describe("meeting confirmation card", () => {
  const html: string = manifest.tools.find((t: any) => t.name === "create_online_meeting").confirmation.root.html;
  const script = html.match(/<script>(function readableMeetingTime[\s\S]*?)<\/script>/)?.[1] ?? "";
  const readableMeetingTime: (start: string, end: string, timeZone?: string) => string | null =
    new Function(`${script}; return readableMeetingTime;`)();
  const year = new Date().getFullYear();
  const inChicago = (start: string, end: string, onYear = year) =>
    readableMeetingTime(`${onYear}-${start}`, `${onYear}-${end}`, "America/Chicago");

  test("shows the date, times and time zone in one line", () => {
    expect(inChicago("12-04T17:00:00-06:00", "12-04T17:30:00-06:00")).toBe("Dec 4, 5:00–5:30 PM CST");
    expect(inChicago("07-04T17:00:00-05:00", "07-04T17:30:00-05:00")).toBe("Jul 4, 5:00–5:30 PM CDT");
  });

  test("keeps AM and PM across noon, and both dates across midnight", () => {
    expect(inChicago("12-04T11:30:00-06:00", "12-04T12:30:00-06:00")).toBe("Dec 4, 11:30 AM–12:30 PM CST");
    expect(inChicago("12-04T23:30:00-06:00", "12-05T00:30:00-06:00")).toBe("Dec 4, 11:30 PM – Dec 5, 12:30 AM CST");
  });

  test("shows the user's own time when the agent sends a different offset", () => {
    expect(inChicago("12-04T18:00:00-05:00", "12-04T18:30:00-05:00")).toBe("Dec 4, 5:00–5:30 PM CST");
  });

  test("adds the year only for a meeting in another year", () => {
    expect(inChicago("12-04T17:00:00-06:00", "12-04T17:30:00-06:00", year + 1)).toBe(`Dec 4, ${year + 1}, 5:00–5:30 PM CST`);
  });

  test("doesn't guess at a time it can't read", () => {
    expect(readableMeetingTime("next Tuesday", "2026-12-04T17:30:00-06:00")).toBeNull();
  });

  test("keeps the exact times bound for sending, without showing them", () => {
    expect(html).toContain('<input type="hidden" id="mc-start" data-voiceos-key="start_date_time">');
    expect(html).toContain('<input type="hidden" id="mc-end" data-voiceos-key="end_date_time">');
    expect(html).not.toContain('placeholder="2025-03-20T15');
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

  test("the server exposes the same tools and inputs as the manifest", async () => {
    const { tools } = await server.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...APPROVED_TOOLS, ...ACCOUNT_TOOLS].sort());
    for (const tool of tools) {
      const declared = manifest.tools.find((t: any) => t.name === tool.name);
      expect(Object.keys(tool.inputSchema.properties ?? {}).sort()).toEqual(Object.keys(declared.inputSchema.properties).sort());
    }
  });

  test("get_all_chats skips hidden chats, lists the rest newest first, and scopes the session to Teams", async () => {
    const r = await run(server, "get_all_chats", {});
    expect(r.isError).toBe(false);
    expect(r.body.chats.map((c: any) => c.id)).toEqual(["19:newest", "19:middle", "19:old"]);
    expect(lastArguments(server, "MICROSOFT_TEAMS_CHATS_GET_ALL_CHATS")).toEqual({ user_id: "me", top: 50 });
    expect(r.block.type).toBe("widget");
    expect(r.html).toContain("Teams Chats");

    const create = mockCalls(server).find((c) => c.path === "/tool_router/session");
    expect(create.body.user_id).toBe("tester");
    expect(create.body.auth_configs).toEqual({ microsoft_teams: "ac_test" });
    expect(create.body.toolkits).toEqual({ enable: ["microsoft_teams"] });
  });

  test("get_all_chats respects the limit", async () => {
    const r = await run(server, "get_all_chats", { limit: 1 });
    expect(r.body.chats.map((c: any) => c.id)).toEqual(["19:newest"]);
  });

  test("get_chat_messages passes the signed-in user's ID and skips system events", async () => {
    const r = await run(server, "get_chat_messages", { chat_id: "19:newest", top: 3 });
    expect(r.isError).toBe(false);
    expect(lastArguments(server, "MICROSOFT_TEAMS_LIST_USER_CHAT_MESSAGES")).toEqual({
      user_id: "8ea0e38b-efb3-4757-924a-5f94061cf8c2",
      chat_id: "19:newest",
      top: 18,
    });
    expect(r.body.messages.map((m: any) => m.id)).toEqual(["m1", "m3", "m4"]);
    expect(r.body.messages[0]).toMatchObject({ sender: "Priya", text: "See you at 3" });
    expect(r.body.messages[1].text).toBe("(attachment or image)");
    expect(r.body.messages[2].time).toBe("Dec 1, 2025");
  });

  test("the user's ID is looked up once and reused", async () => {
    await run(server, "get_chat_messages", { chat_id: "19:middle", top: 1 });
    const lookups = executed(server).filter((c) => c.tool_slug === "MICROSOFT_TEAMS_GET_MY_PROFILE");
    expect(lookups).toHaveLength(1);
    expect(lookups[0].arguments).toEqual({ user_id: "me", select: "id" });
  });

  test("send_chat_message sends only the chat and text, not the display name", async () => {
    const r = await run(server, "send_chat_message", { chat_id: "19:newest", content: "On my way", recipient_name: "Priya" });
    expect(r.isError).toBe(false);
    expect(lastArguments(server, "MICROSOFT_TEAMS_TEAMS_POST_CHAT_MESSAGE")).toEqual({ chat_id: "19:newest", content: "On my way" });
    expect(r.body).toMatchObject({ success: true, recipient_name: "Priya", content: "On my way" });
    expect(r.html).toContain("Message Sent");
    expect(r.html).toContain("Priya");
  });

  test("reply_to_message passes the team, channel and message IDs", async () => {
    const args = { team_id: "team-1", channel_id: "19:channel@thread.tacv2", message_id: "1616990032035", content: "Thanks" };
    const r = await run(server, "reply_to_message", args);
    expect(r.isError).toBe(false);
    expect(lastArguments(server, "MICROSOFT_TEAMS_POST_MESSAGE_REPLY")).toEqual(args);
    expect(r.html).toContain("Reply Sent");
  });

  test("reply_to_message reads the team, channel and post IDs from a post's link", async () => {
    const link =
      "https://teams.microsoft.com/l/message/19%3A4a95f7d8db4c4e7fae857bcebe0623e6%40thread.tacv2/1616990032035" +
      "?groupId=fbe2bf47-16c8-47cf-b4a5-4b9b187c508b&tenantId=2432b57b-0abd-43db-aa7b-16eadd115d34&createdTime=1616990032035";
    const r = await run(server, "reply_to_message", { message_link: link, content: "Sounds good" });
    expect(r.isError).toBe(false);
    expect(lastArguments(server, "MICROSOFT_TEAMS_POST_MESSAGE_REPLY")).toEqual({
      team_id: "fbe2bf47-16c8-47cf-b4a5-4b9b187c508b",
      channel_id: "19:4a95f7d8db4c4e7fae857bcebe0623e6@thread.tacv2",
      message_id: "1616990032035",
      content: "Sounds good",
    });
  });

  test("reply_to_message replies to the root post when the link points at a reply in the thread", async () => {
    const link =
      "https://teams.microsoft.com/l/message/19%3A4a95f7d8db4c4e7fae857bcebe0623e6%40thread.tacv2/1616990171266" +
      "?groupId=fbe2bf47-16c8-47cf-b4a5-4b9b187c508b&parentMessageId=1616990032035&createdTime=1616990171266";
    await run(server, "reply_to_message", { message_link: link, content: "Same here" });
    expect(lastArguments(server, "MICROSOFT_TEAMS_POST_MESSAGE_REPLY").message_id).toBe("1616990032035");
  });

  test("reply_to_message refuses chat links and missing targets without calling Composio", async () => {
    const before = executed(server).length;

    const chatLink = "https://teams.microsoft.com/l/message/19:abc@thread.v2/1616990032035?context=%7B%22contextType%22%3A%22chat%22%7D";
    const chat = await run(server, "reply_to_message", { message_link: chatLink, content: "hi" });
    expect(chat.isError).toBe(true);
    expect(chat.text).toContain("isn't to a team channel post");

    const notALink = await run(server, "reply_to_message", { message_link: "general channel", content: "hi" });
    expect(notALink.isError).toBe(true);
    expect(notALink.text).toContain("isn't a valid Teams link");

    const nothing = await run(server, "reply_to_message", { content: "hi" });
    expect(nothing.isError).toBe(true);
    expect(nothing.text).toContain("Copy link");

    expect(executed(server).length).toBe(before);
  });

  test("create_online_meeting creates a Teams calendar event with no attendees and returns the join link", async () => {
    const args = { subject: "Sync", start_date_time: "2026-11-02T15:00:00-06:00", end_date_time: "2026-11-02T15:30:00-06:00" };
    const before = executed(server).length;
    const r = await run(server, "create_online_meeting", args);
    expect(r.isError).toBe(false);
    expect(proxyRequests(server).at(-1).body).toEqual({
      toolkit_slug: "microsoft_teams",
      endpoint: "https://graph.microsoft.com/v1.0/me/events",
      method: "POST",
      body: {
        subject: "Sync",
        start: { dateTime: "2026-11-02T21:00:00", timeZone: "UTC" },
        end: { dateTime: "2026-11-02T21:30:00", timeZone: "UTC" },
        isOnlineMeeting: true,
        onlineMeetingProvider: "teamsForBusiness",
      },
    });
    expect(executed(server).length).toBe(before);
    expect(r.body).toMatchObject({
      success: true,
      id: "evt-1",
      subject: "Sync",
      joinWebUrl: "https://teams.microsoft.com/l/meetup-join/test",
      webLink: "https://outlook.office365.com/owa/?itemid=evt-1",
      start_date_time: args.start_date_time,
      end_date_time: args.end_date_time,
    });
    expect(r.body.message).toBeUndefined();
    expect(r.html).toContain("Meeting Created");
    expect(r.html).toContain("On calendar");
    expect(r.html).toContain('href="https://teams.microsoft.com/l/meetup-join/test"');
  });

  test("create_online_meeting converts any offset to the same moment in UTC", async () => {
    await run(server, "create_online_meeting", {
      subject: "Across midnight",
      start_date_time: "2026-07-04T23:30:00-05:00",
      end_date_time: "2026-07-05T00:15:00-05:00",
    });
    const { start, end } = proxyRequests(server).at(-1).body.body;
    expect(start).toEqual({ dateTime: "2026-07-05T04:30:00", timeZone: "UTC" });
    expect(end).toEqual({ dateTime: "2026-07-05T05:15:00", timeZone: "UTC" });
  });

  test("create_online_meeting refuses times it can't read, or that end first, without calling Composio", async () => {
    const before = mockCalls(server).length;

    const unreadable = await run(server, "create_online_meeting", {
      subject: "Sync",
      start_date_time: "next Tuesday",
      end_date_time: "2026-11-02T15:30:00-06:00",
    });
    expect(unreadable.isError).toBe(true);
    expect(unreadable.text).toContain("couldn't read the meeting time");

    const backwards = await run(server, "create_online_meeting", {
      subject: "Sync",
      start_date_time: "2026-11-02T15:30:00-06:00",
      end_date_time: "2026-11-02T15:00:00-06:00",
    });
    expect(backwards.isError).toBe(true);
    expect(backwards.text).toBe("The meeting's end time has to be after its start time.");

    expect(mockCalls(server).length).toBe(before);
  });

  test("create_channel explains that it needs admin approval", async () => {
    const r = await run(server, "create_channel", { team_id: "team-1", name: "voiceos-test" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Creating channels needs admin approval in your organization's Microsoft 365.");
  });

  test("a revoked token during a call asks the user to reconnect", async () => {
    const before = linkRequests(server).length;
    const r = await run(server, "send_chat_message", { chat_id: "19:revoked", content: "hi" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Your Teams connection expired or was revoked. Reconnect in your browser, then try again.");
    expect(linkRequests(server).length).toBe(before + 1);
  });

  test("only approved Composio tools were called", () => {
    for (const call of executed(server)) expect(APPROVED_SLUGS).toContain(call.tool_slug);
  });

  // The SDK prints its "Upgrade available" notice to stdout, which is the MCP channel.
  test("never runs the SDK's npm version check", () => {
    expect(mockCalls(server).filter((c) => c.host === "registry.npmjs.org")).toEqual([]);
  });
});

describe("scheduling a meeting", () => {
  const MEETING = { subject: "Sync", start_date_time: "2026-11-02T15:00:00-06:00", end_date_time: "2026-11-02T15:30:00-06:00" };
  const started: Server[] = [];
  const scheduleWith = async (mock: Record<string, string>, args: Record<string, unknown> = MEETING) => {
    const server = await startServer({ ...SETUP_ENV, ...mock });
    started.push(server);
    return { server, r: await run(server, "create_online_meeting", args) };
  };

  afterAll(async () => {
    await Promise.all(started.map((server) => server.client.close()));
  });

  test("a time with no offset is read as local time, the same way the confirmation card reads it", async () => {
    const { server, r } = await scheduleWith(
      { TZ: "America/Chicago" },
      { subject: "Sync", start_date_time: "2026-12-04T17:00:00", end_date_time: "2026-12-04T17:30:00" }
    );
    expect(proxyRequests(server)[0].body.body.start).toEqual({ dateTime: "2026-12-04T23:00:00", timeZone: "UTC" });
    expect(r.html.replace(/\s+/g, " ")).toContain("Dec 4 · 5:00 PM – 5:30 PM");
  });

  test("goes through Composio and never calls Microsoft directly, so no new network permission is needed", async () => {
    const { server } = await scheduleWith({});
    expect(proxyRequests(server).map((c) => c.host)).toEqual(["backend.composio.dev"]);
    expect(mockCalls(server).filter((c) => c.host.endsWith("microsoft.com"))).toEqual([]);
  });

  test("still tells the truth when Microsoft creates the event but returns no join link", async () => {
    const { r } = await scheduleWith({ MOCK_CALENDAR: "no_join_link" });
    expect(r.isError).toBe(false);
    expect(r.body.joinWebUrl).toBe("");
    expect(r.body.message).toContain("didn't return a join link");
    expect(r.html).toContain('href="https://outlook.office365.com/owa/?itemid=evt-1"');
    expect(r.html).toContain("Open in calendar");
    expect(r.html).not.toContain("Join Teams meeting");
  });

  test("a sign-in without calendar access says how to replace it, and doesn't open another sign-in", async () => {
    const { server, r } = await scheduleWith({ MOCK_CALENDAR: "no_scope" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Your Teams sign-in doesn\'t include calendar access yet. Say "disconnect Teams", then "connect me to Teams", and try again.');
    expect(linkRequests(server)).toHaveLength(0);
  });

  test("a token Microsoft rejects asks the user to reconnect and opens one sign-in", async () => {
    const { server, r } = await scheduleWith({ MOCK_CALENDAR: "expired" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Your Teams connection expired or was revoked. Reconnect in your browser, then try again.");
    expect(linkRequests(server)).toHaveLength(1);
  });

  test("a key without Proxy execute is reported as a key problem, not a Teams sign-in problem", async () => {
    const { server, r } = await scheduleWith({ MOCK_CALENDAR: "key_denied" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Proxy execute");
    expect(linkRequests(server)).toHaveLength(0);
  });

  test("a request Composio refuses passes on its reason", async () => {
    const { r } = await scheduleWith({ MOCK_CALENDAR: "rejected" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("Composio couldn't schedule the meeting");
    expect(r.text).toContain("Endpoint isn't allowed");
  });

  test("any other Microsoft error is passed on, not reported as success", async () => {
    const { r } = await scheduleWith({ MOCK_CALENDAR: "graph_error" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Microsoft couldn't create the meeting: Your request can't be completed.");
  });

  test("a lost answer says to check the calendar, and isn't retried, so it can't make a duplicate", async () => {
    const { server, r } = await scheduleWith({ MOCK_CALENDAR: "network" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("I couldn't confirm the meeting was created. Check your calendar before trying again.");
    expect(proxyRequests(server)).toHaveLength(1);
  });

  test("runs nothing when Teams isn't connected", async () => {
    const { server, r } = await scheduleWith({ MOCK_CONNECTION: "none" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Connect Microsoft Teams in your browser, then try again.");
    expect(proxyRequests(server)).toHaveLength(0);
  });
});

describe("opening the sign-in in the browser", () => {
  // Fake `open` and `rundll32` commands on PATH record exactly how the server launched them.
  async function launchedFor(platform: string): Promise<string[]> {
    const bin = mkdtempSync(join(tmpdir(), "teams-bin-"));
    const record = join(bin, "launched.txt");
    for (const name of ["open", "rundll32"]) {
      writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "\${0##*/}" "$@" >> "${record}"\n`, { mode: 0o755 });
    }
    const server = await startServer({ ...SETUP_ENV, MOCK_CONNECTION: "none", MOCK_PLATFORM: platform, PATH: bin });
    try {
      await run(server, "get_all_chats", {});
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

describe("no connected account", () => {
  let server: Server;

  beforeAll(async () => {
    server = await startServer({ ...SETUP_ENV, MOCK_CONNECTION: "none" });
  });

  afterAll(async () => {
    await server.client.close();
  });

  test("asks the user to connect, starts sign-in, and runs nothing", async () => {
    const r = await run(server, "get_all_chats", {});
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Connect Microsoft Teams in your browser, then try again.");
    expect(linkRequests(server)).toHaveLength(1);
    expect(linkRequests(server)[0].body).toEqual({ toolkit: "microsoft_teams" });
    expect(executed(server)).toHaveLength(0);
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
    const r = await run(server, "send_chat_message", { chat_id: "19:newest", content: "hi" });
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Your Teams connection expired or was revoked. Reconnect in your browser, then try again.");
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

  test("says which settings are missing", async () => {
    const r = await run(server, "get_all_chats", {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("COMPOSIO_API_KEY, COMPOSIO_AUTH_CONFIG_ID, and VOICEOS_USER_ID");
    expect(mockCalls(server)).toHaveLength(0);
  });

  test("the account tools say which settings are missing too", async () => {
    for (const name of ACCOUNT_TOOLS) {
      const r = await run(server, name, {});
      expect(r.isError).toBe(true);
      expect(r.text).toContain("COMPOSIO_API_KEY, COMPOSIO_AUTH_CONFIG_ID, and VOICEOS_USER_ID");
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
    expect(r.html).toContain("Teams account");
    for (const name of ACCOUNT_TOOLS) expect(r.html).toContain(`"${name}"`);
    expect(linkRequests(server)).toHaveLength(0);
  });

  test("connection_status never starts a sign-in", async () => {
    const server = await startWith({ MOCK_CONNECTION: "none" });
    const r = await run(server, "connection_status", {});
    expect(r.isError).toBe(false);
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

  test("connect_account doesn't start a sign-in when Teams is already connected", async () => {
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
    expect(linkRequests(server)[0].body).toEqual({ toolkit: "microsoft_teams" });

    const chats = await run(server, "get_all_chats", {});
    expect(chats.isError).toBe(false);
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
    expect(r.text).toBe("Microsoft sign-in didn't complete. Try connecting again.");
  });

  test("disconnect_account revokes and removes only this user's Teams connections", async () => {
    const server = await startWith({ MOCK_CONNECTION: "active" });
    const r = await run(server, "disconnect_account", {});
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ connected: false, status: "Not connected" });
    expect(r.body.message).toBe("Microsoft Teams is disconnected. No chats or messages were deleted.");

    const list = mockCalls(server).find((c) => c.path === "/connected_accounts");
    const query = new URLSearchParams(list.query);
    expect(query.getAll("user_ids")).toEqual(["tester"]);
    expect(query.getAll("auth_config_ids")).toEqual(["ac_test"]);
    expect(query.getAll("toolkit_slugs")).toEqual(["microsoft_teams"]);

    const removed = accountRequests(server, "DELETE").map((c) => c.path);
    expect(removed).toEqual(["/connected_accounts/ca_test", "/connected_accounts/ca_duplicate"]);
    expect(accountRequests(server, "POST", "/revoke")).toHaveLength(2);
    expect((await run(server, "connection_status", {})).body.connected).toBe(false);
  });

  test("disconnect_account still removes the connection when Composio can't revoke at Microsoft", async () => {
    const server = await startWith({ MOCK_CONNECTION: "active", MOCK_REVOKE: "unsupported" });
    const r = await run(server, "disconnect_account", {});
    expect(r.isError).toBe(false);
    expect(r.body.connected).toBe(false);
    expect(r.body.message).toContain("revoke the app in your Microsoft account");
    expect(accountRequests(server, "DELETE")).toHaveLength(2);
  });

  test("disconnect_account explains when the API key can't change connections", async () => {
    const server = await startWith({ MOCK_CONNECTION: "active", MOCK_DELETE: "denied" });
    const r = await run(server, "disconnect_account", {});
    expect(r.isError).toBe(true);
    expect(r.text).toContain("write access to Connected accounts");
    expect((await run(server, "connection_status", {})).body.connected).toBe(true);
  });

  test("disconnect_account doesn't claim success if Composio still shows Teams connected", async () => {
    const server = await startWith({ MOCK_CONNECTION: "active", MOCK_DELETE: "ignored" });
    const r = await run(server, "disconnect_account", {});
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Composio still shows Teams as connected. Refresh and try again.");
  });

  test("disconnect_account does nothing when Teams isn't connected", async () => {
    const server = await startWith({ MOCK_CONNECTION: "none" });
    const r = await run(server, "disconnect_account", {});
    expect(r.body.message).toBe("Microsoft Teams is already disconnected.");
    expect(accountRequests(server, "DELETE")).toHaveLength(0);
    expect(accountRequests(server, "POST", "/revoke")).toHaveLength(0);
  });

  test("after a disconnect, a Teams tool falls back to opening the sign-in", async () => {
    const server = await startWith({ MOCK_CONNECTION: "active" });
    await run(server, "disconnect_account", {});
    const r = await run(server, "get_all_chats", {});
    expect(r.isError).toBe(true);
    expect(r.text).toBe("Connect Microsoft Teams in your browser, then try again.");
    expect(linkRequests(server)).toHaveLength(1);
  });

  test("reconnecting looks up the signed-in user's ID again, in case the account changed", async () => {
    const server = await startWith({ MOCK_CONNECTION: "active" });
    await run(server, "get_chat_messages", { chat_id: "19:newest" });
    await run(server, "disconnect_account", {});
    await run(server, "connect_account", {});
    await run(server, "get_chat_messages", { chat_id: "19:newest" });
    const lookups = executed(server).filter((c) => c.tool_slug === "MICROSOFT_TEAMS_GET_MY_PROFILE");
    expect(lookups).toHaveLength(2);
  });
});
