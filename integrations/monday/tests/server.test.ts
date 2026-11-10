import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Event, Scenario } from "./mock-composio";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(ROOT, "voiceos.integration.json"), "utf8"));
const KEY = "offline-monday-key-only";
const IDENTITY = { userId: "voiceos-monday-test" };
const ACTIVE = { ...IDENTITY, accountId: "ca_test" };
const TOOLS = ["connect_account", "connection_status", "disconnect_account", "get_boards", "get_items"];
const directory = mkdtempSync(join(tmpdir(), "voiceos-monday-tests-"));
const statePath = join(directory, ".composio-auth.json");
const scenarioPath = join(directory, "scenario.json");
const eventsPath = join(directory, "events.jsonl");
let client: Client;
let transport: StdioClientTransport;
let stderr = "";
let notifications: { message: string; speak: boolean }[] = [];
let rejectNotification = false;

function scenario(value: Scenario = {}) { writeFileSync(scenarioPath, JSON.stringify(value)); }
function state(value: object = ACTIVE) { writeFileSync(statePath, JSON.stringify(value), { mode: 0o600 }); }
function saved() { return JSON.parse(readFileSync(statePath, "utf8")); }
function events(): Event[] { return readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)); }
function browsers() { return events().filter(event => event.kind === "browser"); }
async function invoke(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args }, CallToolResultSchema);
  const block = result.content.find(block => block.type === "text");
  if (!block || block.type !== "text") throw new Error("Missing text result");
  let body;
  try { body = JSON.parse(block.text); } catch { body = { error: block.text }; }
  return { isError: Boolean(result.isError), body, text: block.text };
}

beforeAll(async () => {
  // Only the browser import changes. The real MCP server and Composio SDK execute in a disposable directory.
  const source = readFileSync(join(ROOT, "server.ts"), "utf8");
  expect(source.split('from "node:child_process"')).toHaveLength(2);
  writeFileSync(join(directory, "server.ts"), source.replace('from "node:child_process"', `from ${JSON.stringify(join(ROOT, "tests/mock-composio.ts"))}`));
  symlinkSync(join(ROOT, "node_modules"), join(directory, "node_modules"), "dir");
  scenario();
  state();
  writeFileSync(eventsPath, "");
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--preload", join(ROOT, "tests/mock-composio.ts"), join(directory, "server.ts")],
    cwd: directory, stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", COMPOSIO_API_KEY: KEY, MONDAY_TEST_SCENARIO: scenarioPath, MONDAY_TEST_EVENTS: eventsPath },
  });
  transport.stderr?.on("data", chunk => { stderr += String(chunk); });
  client = new Client({ name: "monday-offline-tests", version: "1.0.0" });
  client.setRequestHandler(z.object({
    method: z.literal("voiceos/reminders/trigger"),
    params: z.object({ message: z.string(), speak: z.boolean() }),
  }), async request => {
    notifications.push(request.params);
    if (rejectNotification) throw new Error("Test notification unavailable");
    return { notificationId: "notification_test" };
  });
  await client.connect(transport);
});

beforeEach(() => {
  scenario(); state(); writeFileSync(eventsPath, ""); notifications = []; rejectNotification = false;
});
afterEach(() => {
  expect(events().filter(event => event.kind === "unexpected")).toEqual([]);
  const executions = events().filter(event => event.path?.includes("/tools/execute/"));
  expect(executions.every(event => ["MONDAY_BOARDS", "MONDAY_GET_ITEMS", "MONDAY_ITEMS_PAGE"].includes(event.path!.split("/").at(-1)!))).toBe(true);
});
afterAll(async () => {
  try { await client?.close(); } finally {
    await transport?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("account tools contract", () => {
  test("exposes exactly three account tools and two reads, matching manifest inputs and confirmations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(TOOLS);
    expect(manifest.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(tools.map(tool => tool.name).sort());
    for (const actual of tools) {
      const declared = manifest.tools.find((tool: { name: string }) => tool.name === actual.name);
      expect(actual.description).toBe(declared.description);
      expect(actual.inputSchema.properties).toEqual(declared.inputSchema.properties);
      expect(actual.inputSchema.additionalProperties).toBe(false);
      if (["connection_status", "get_boards", "get_items"].includes(actual.name)) {
        expect(declared.confirmation).toBeUndefined();
        expect(declared.uiCallable).toBe(true);
        expect(actual.annotations?.readOnlyHint).toBe(true);
      } else {
        expect(declared.confirmation.root.footer[0].items.map((item: { role: string }) => item.role).sort()).toEqual(["cancel", "confirm"]);
        expect(declared.execution.mode).toBe(actual.name === "connect_account" ? "sync" : "background");
      }
    }
  });
  test("rejects unknown tools and unexpected account arguments", async () => {
    expect((await invoke("create_item")).isError).toBe(true);
    expect((await invoke("connect_account", { accountId: "someone-else" })).isError).toBe(true);
    expect((await invoke("connection_status", { extra: true })).isError).toBe(true);
    expect(events()).toEqual([]);
  });
  test("keeps MCP stdout clean when npm advertises a newer SDK", async () => {
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(TOOLS);
    expect(stderr).not.toContain("A new version of");
  });
});

describe("Monday read tools", () => {
  const executions = () => events().filter(event => event.path?.includes("/tools/execute/"));

  test("lists boards with filters, saved identity, pinned version, metadata, and progress", async () => {
    const board = { id: "123", name: "Roadmap", workspace: { id: "45" }, owners: [{ id: "67" }] };
    scenario({ toolData: { data: { boards: [board] } } });
    const progress: number[] = [];
    const result = await client.callTool({ name: "get_boards", arguments: {
      workspace_ids: [45], state: "active", board_kind: "private", limit: 1,
    } }, CallToolResultSchema, { onprogress: value => { progress.push(value.progress); } });
    expect(result.isError).not.toBe(true);
    const block = result.content.find(block => block.type === "text");
    if (!block || block.type !== "text") throw new Error("Missing read result");
    const body = JSON.parse(block.text);
    expect(body.records).toEqual([board]);
    expect(body.pagination).toEqual({ page: 1, limit: 1, nextPage: 2 });
    expect(progress).toEqual([0, 100]);
    expect(executions()[0]).toMatchObject({
      path: "/api/v3.1/tools/execute/MONDAY_BOARDS",
      body: { connected_account_id: "ca_test", user_id: IDENTITY.userId, version: "20261101_00",
        arguments: { page: 1, limit: 1, workspace_ids: [45], state: "active", board_kind: "private" } },
    });
    expect(events().find(event => event.method === "GET" && event.path?.includes("/tools/"))?.version).toBe("20261101_00");
    expect(saved()).toEqual(ACTIVE);
    expect(notifications).toEqual([]);
    expect(browsers()).toEqual([]);
  });

  test("retrieves boards by IDs and preserves requested pagination", async () => {
    const result = await invoke("get_boards", { ids: [123], page: 2, limit: 10, state: "all" });
    expect(result.isError).toBe(false);
    expect(result.body.records).toEqual([]);
    expect(result.body.pagination).toEqual({ page: 2, limit: 10, nextPage: null });
    expect(executions()[0].body?.arguments).toEqual({ ids: [123], page: 2, limit: 10, state: "all" });
  });

  test("retrieves items by IDs with metadata and ID-specific options", async () => {
    const item = { id: "456", name: "Ship", board: { id: "123" }, group: { id: "topics" }, state: "active" };
    scenario({ toolData: { items: [item] } });
    const result = await invoke("get_items", { ids: [456], page: 2, limit: 1, newest_first: true, exclude_nonactive: true });
    expect(result.isError).toBe(false);
    expect(result.body.records).toEqual([item]);
    expect(result.body.pagination).toEqual({ page: 2, limit: 1, nextPage: 3 });
    expect(executions()[0]).toMatchObject({ path: "/api/v3.1/tools/execute/MONDAY_GET_ITEMS",
      body: { arguments: { ids: [456], page: 2, limit: 1, newest_first: true, exclude_nonactive: true } } });
  });

  test("reads board items with column values and continues using the returned cursor", async () => {
    const item = { id: "456", name: "Ship", column_values: [{ id: "status", text: "Done", value: '{"index":1}' }] };
    scenario({ toolData: { data: { boards: [{ items_page: { items: [item], cursor: "next-page" } }] } } });
    const first = await invoke("get_items", { board_id: 123, limit: 1 });
    expect(first.isError).toBe(false);
    expect(first.body.records).toEqual([item]);
    expect(first.body.pagination.nextCursor).toBe("next-page");
    expect(first.body._voiceos_glance.blocks).toEqual([
      { type: "header", title: "Monday.com items" },
      { type: "list", rows: [{ title: "Ship", subtitle: "Done" }] },
    ]);
    expect(executions()[0].body?.arguments).toEqual({ board_id: 123, limit: 1, include_column_values: true });
    scenario({ toolData: { data: { next_items_page: { items: [], cursor: null } } } });
    const next = await invoke("get_items", { cursor: first.body.pagination.nextCursor, limit: 1 });
    expect(next.isError).toBe(false);
    expect(next.body.records).toEqual([]);
    expect(next.body.pagination.nextCursor).toBeNull();
    expect(next.body._voiceos_glance.blocks).toEqual([
      { type: "header", title: "Monday.com items" },
      { type: "keyValue", pairs: [["Results", "No matching items found."]] },
    ]);
    expect(executions()[1].body?.arguments).toEqual({ cursor: "next-page", limit: 1, include_column_values: true });
    expect(notifications).toEqual([]);
  });

  test("supports group-scoped and unwrapped board item pages", async () => {
    scenario({ toolData: { boards: [{ groups: [{ items_page: { items: [], cursor: null } }] }] } });
    expect((await invoke("get_items", { board_id: 123, group_id: "topics" })).isError).toBe(false);
    expect(executions()[0].body?.arguments).toEqual({ board_id: 123, group_id: "topics", limit: 25, include_column_values: true });
    scenario({ toolData: { items: [], cursor: null } });
    expect((await invoke("get_items", { board_id: 123 })).isError).toBe(false);
  });

  test("returns an empty result when the requested board is not accessible", async () => {
    scenario({ toolData: { data: { boards: [] } } });
    const result = await invoke("get_items", { board_id: 123 });
    expect(result.isError).toBe(false);
    expect(result.body.records).toEqual([]);
    expect(result.body.message).toContain("No matching accessible board");
    expect(result.body.pagination.nextCursor).toBeNull();
  });

  test("distinguishes intermediate board discovery from tasks on the resolved board", async () => {
    scenario({ toolData: { boards: [{ id: "123", name: "Voiceos test" }] } });
    const boards = await invoke("get_boards");
    expect(boards.isError).toBe(false);
    expect(boards.body.resultType).toBe("boards");
    expect(boards.body.message).toBe("Boards found: Voiceos test.");
    expect(boards.body._voiceos_glance.blocks[0].trailing).toBe("Boards found");
    expect(boards.body._voiceos_glance.blocks[1].pairs).toEqual([["Boards", "Voiceos test."]]);
    expect(boards.body.records[0].id).toBe("123");

    const tasks = Array.from({ length: 25 }, (_, i) => ({
      id: String(i + 10),
      name: `Task ${i + 1}`,
      group: { id: "internal-group", title: "Launch" },
    }));
    scenario({ toolData: { items: tasks, cursor: "next-page" } });
    const result = await invoke("get_items", { board_id: 123, board_name: boards.body.records[0].name });
    expect(result.isError).toBe(false);
    expect(result.body.resultType).toBe("tasks");
    expect(result.body.boardName).toBe("Voiceos test");
    expect(result.body.message).toBe('Here are the first few items on "Voiceos test".');
    expect(result.body._voiceos_glance.blocks).toEqual([
      { type: "header", title: "Voiceos test" },
      { type: "list", rows: [
        ...tasks.slice(0, 5).map(task => ({ title: task.name, subtitle: "Launch" })),
        { title: "and 20 more" },
      ] },
    ]);
    expect(result.body.records).toEqual(tasks);
    expect(executions()[1].body?.arguments).toEqual({ board_id: 123, limit: 25, include_column_values: true });
    scenario({ toolSuccessful: false, toolError: "Board access denied" });
    const failure = await invoke("get_items", { board_id: 123, board_name: "Voiceos test" });
    expect(failure.isError).toBe(true);
    expect(failure.body.records).toBeUndefined();
    expect(failure.body.message).toBeUndefined();
    expect(failure.body.error).toContain("Board access denied");
  });

  test("uses provider board names in preference to display context and carries context through cursor reads", async () => {
    scenario({ toolData: { boards: [{ name: "Actual board", items_page: { items: [], cursor: "next" } }] } });
    const first = await invoke("get_items", { board_id: 123, board_name: "Old board name" });
    expect(first.isError).toBe(false);
    expect(first.body.boardName).toBe("Actual board");
    expect(first.body.message).toBe('No matching items found on "Actual board".');
    scenario({ toolData: { items: [{ id: "456", name: "Ship" }], cursor: null } });
    const next = await invoke("get_items", { cursor: "next", board_name: first.body.boardName });
    expect(next.isError).toBe(false);
    expect(next.body.message).toBe('Found 1 item on "Actual board".');
    expect(executions()[1].body?.arguments).toEqual({ cursor: "next", limit: 25, include_column_values: true });
  });

  test.each([
    ["get_boards", {}],
    ["get_items", { ids: [1, 2, 3, 4, 5, 6, 7] }],
    ["get_items", { board_id: 123 }],
  ])("%s summarizes names without displaying IDs and retains full records for follow-up calls", async (name, args) => {
    const entries = Array.from({ length: 7 }, (_, i) => ({ id: `internal-id-${i + 1}`, name: `Task ${i + 1}` }));
    const toolData = name === "get_boards" ? { boards: entries } : { items: entries, cursor: null };
    scenario({ toolData });
    const result = await invoke(name as string, args as Record<string, unknown>);
    expect(result.isError).toBe(false);
    const isBoards = name === "get_boards";
    expect(result.body.message).toBe(isBoards ? "Boards found: Task 1, Task 2, Task 3, and 4 more." : "Here are the first few items.");
    expect(result.body.resultType).toBe(name === "get_boards" ? "boards" : "tasks");
    expect(result.body.records).toEqual(entries);
    const displayed = JSON.stringify(result.body._voiceos_glance);
    expect(displayed).toContain(isBoards ? "Task 1, Task 2, Task 3, and 4 more." : "and 2 more");
    expect(displayed).not.toContain("internal-id");
    expect(displayed).not.toContain(isBoards ? "Task 4" : "Task 6");
    expect(displayed).not.toContain("Ask for the next page");
    expect(result.body._voiceos_glance.blocks.length).toBeLessThanOrEqual(3);
  });

  test.each([
    [0, "No matching items found."],
    [1, "Found 1 item."],
    [2, "Found 2 items."],
    [3, "Found 3 items."],
    [6, "Found 6 items."],
  ])("summarizes %i returned items by count", async (count, expected) => {
    scenario({ toolData: { items: Array.from({ length: count as number }, (_, i) => ({ id: String(i + 1), name: `Task ${i + 1}` })), cursor: null } });
    const result = await invoke("get_items", { board_id: 123 });
    expect(result.isError).toBe(false);
    expect(result.body.message).toBe(expected);
    if (count) expect(result.body._voiceos_glance.blocks[1].rows).toEqual(
      result.body.records.map((item: { name: string }) => ({ title: item.name })),
    );
  });

  test("labels a partial preview with the returned page count", async () => {
    scenario({ toolData: { items: Array.from({ length: 7 }, (_, i) => ({ id: String(i + 1), name: `Task ${i + 1}` })), cursor: "next-page" } });
    const result = await invoke("get_items", { board_id: 123 });
    expect(result.isError).toBe(false);
    expect(result.body.message).toBe("Here are the first few items.");
    expect(result.body._voiceos_glance.blocks[1].rows.at(-1)).toEqual({ title: "and 2 more" });
    expect(result.body.pagination.nextCursor).toBe("next-page");
  });

  test.each([
    ["get_boards", { ids: [] }], ["get_boards", { ids: [-1] }],
    ["get_boards", { page: 0 }], ["get_boards", { limit: 101 }],
    ["get_boards", { state: "invented" }], ["get_boards", { accountId: "other" }],
    ["get_items", {}], ["get_items", { ids: [1], board_id: 2 }],
    ["get_items", { board_id: 2, cursor: "next" }], ["get_items", { board_id: 1.5 }],
    ["get_items", { cursor: "  " }], ["get_items", { ids: [1], group_id: "group" }],
    ["get_items", { board_id: 2, page: 1 }], ["get_items", { cursor: "next", group_id: "group" }],
    ["get_items", { board_id: 2, newest_first: true }], ["get_items", { ids: [Number.MAX_SAFE_INTEGER + 1] }],
    ["get_items", { ids: Array.from({ length: 101 }, (_, i) => i + 1) }],
    ["get_items", { board_id: 2, query: "mutation { delete_board }" }],
    ["get_items", { ids: [1], board_name: "Not necessarily their board" }],
    ["get_items", { board_id: 2, board_name: "  " }],
    ["get_items", { board_name: "Cannot substitute for an ID" }],
  ])("rejects invalid %s arguments %j before network access", async (name, args) => {
    expect((await invoke(name as string, args as Record<string, unknown>)).isError).toBe(true);
    expect(events()).toEqual([]);
  });

  test.each(["EXPIRED", "REVOKED", "INITIATED", "FAILED"])("blocks reads on a %s connection", async status => {
    scenario({ accountStatus: status });
    const result = await invoke("get_boards");
    expect(result.isError).toBe(true);
    expect(result.body.error).toContain("Connect Monday.com");
    expect(executions()).toEqual([]);
    expect(saved()).toEqual(ACTIVE);
    expect(browsers()).toEqual([]);
  });

  test("blocks disconnected, pending, disabled, removed, wrong-provider, and invalid-key connections", async () => {
    for (const local of [IDENTITY, { ...IDENTITY, pending: { id: "ca_pending", url: "https://example.invalid/oauth" } }]) {
      state(local);
      expect((await invoke("get_items", { board_id: 123 })).isError).toBe(true);
    }
    state();
    for (const config of [{ accountDisabled: true }, { accountHttpStatus: 404 }, { accountToolkit: "github" }, { accountHttpStatus: 401 }]) {
      scenario(config);
      const result = await invoke("get_boards");
      expect(result.isError).toBe(true);
      if (config.accountHttpStatus === 401) expect(result.body.error).toContain("API key");
    }
    expect(executions()).toEqual([]);
    expect(browsers()).toEqual([]);
    expect(notifications).toEqual([]);
  });

  test.each([
    { toolSuccessful: false, toolError: "Missing board permission" },
    { toolError: "Permission denied" },
    { toolData: { errors: [{ message: "Access denied" }], data: { boards: [] } } },
    { toolData: { data: { errors: [{ message: "Access denied" }], boards: [] } } },
    { toolData: { error_message: "Missing scope" } },
    { toolHttpStatus: 403 },
    { toolHttpStatus: 500 },
  ])("does not report provider errors as empty successful reads: %j", async config => {
    scenario(config);
    const result = await invoke("get_boards");
    expect(result.isError).toBe(true);
    expect(result.body.records).toBeUndefined();
    expect(notifications).toEqual([]);
    expect(executions()).toHaveLength(1);
  });

  test("handles authorization invalidated during execution and redacts sensitive errors", async () => {
    scenario({ toolData: { errors: [{ message: "Token expired", extensions: { code: "NOT_AUTHENTICATED" } }] } });
    expect((await invoke("get_boards")).body.error).toContain("Connect Monday.com");
    scenario({ toolError: `Failure ${KEY} https://example.invalid/secret` });
    const result = await invoke("get_items", { ids: [456] });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(KEY);
    expect(result.text).not.toContain("https://example.invalid/secret");
  });

  test("distinguishes Composio key rejection from provider permission failures", async () => {
    scenario({ toolHttpStatus: 401 });
    const keyFailure = await invoke("get_boards");
    expect(keyFailure.isError).toBe(true);
    expect(keyFailure.body.error).toContain("Update it in Monday.com settings");
    scenario({ toolHttpStatus: 403 });
    const denied = await invoke("get_items", { ids: [456] });
    expect(denied.isError).toBe(true);
    expect(denied.body.error).toContain("board permissions");
    expect(notifications).toEqual([]);
  });

  test.each([
    ["get_boards", {}, { boards: null }],
    ["get_boards", {}, { boards: [{ name: "Missing ID" }] }],
    ["get_items", { ids: [1] }, { items: "not an array" }],
    ["get_items", { board_id: 1 }, { items: [] }],
  ])("rejects malformed %s results", async (name, args, data) => {
    scenario({ toolData: data as Record<string, unknown> });
    const result = await invoke(name as string, args as Record<string, unknown>);
    expect(result.isError).toBe(true);
    expect(result.body.error).toContain("unexpected");
  });
});

describe("connection status", () => {
  test("status is read-only and reports a disconnected account without starting OAuth", async () => {
    state(IDENTITY);
    const result = await invoke("connection_status");
    expect(result.isError).toBe(false);
    expect(result.body.connected).toBe(false);
    expect(result.body.status).toBe("Disconnected");
    expect(result.body.message).toContain("Monday.com is disconnected");
    expect(events()).toEqual([]);
    expect(notifications).toHaveLength(0);
  });

  test("status reports an active connection without opening a browser or sending notifications", async () => {
    state(ACTIVE);
    const result = await invoke("connection_status");
    expect(result.isError).toBe(false);
    expect(result.body.connected).toBe(true);
    expect(result.body.status).toBe("Connected");
    expect(result.body.message).toContain("ready to use");
    expect(browsers()).toEqual([]);
    expect(notifications).toHaveLength(0);
  });

  test.each([
    ["EXPIRED", "Your Monday.com authorization expired. Connect again to authorize."],
    ["REVOKED", "Your Monday.com authorization was revoked. Connect again to authorize."],
    ["INITIATED", "Finish authorizing Monday.com in your browser, then refresh."],
  ])("reports %s status accurately without notifications", async (status, message) => {
    state({ ...IDENTITY, accountId: "ca_test" });
    scenario({ accountStatus: status });
    const result = await invoke("connection_status");
    expect(result.isError).toBe(false);
    expect(result.body.connected).toBe(false);
    expect(result.body.message).toBe(message);
    expect(browsers()).toEqual([]);
    expect(notifications).toHaveLength(0);
  });
});

describe("OAuth connection", () => {
  test("reuses a verified active saved connection without browser authorization", async () => {
    const result = await invoke("connect_account");
    expect(result.isError).toBe(false);
    expect(result.body.connected).toBe(true);
    expect(saved()).toEqual(ACTIVE);
    expect(browsers()).toEqual([]);
    expect(events().some(event => event.path?.includes("tool_router"))).toBe(false);
  });
  test("starts OAuth, allows only Monday, disables business tools, and saves references with private permissions", async () => {
    rmSync(statePath);
    scenario({ accountStatus: "INITIATED", activateAfterBrowser: true });
    const result = await invoke("connect_account");
    expect(result.isError).toBe(false);
    expect(result.body.connected).toBe(false);
    expect(saved()).toEqual({ userId: expect.stringMatching(/^voiceos-monday-/), pending: { id: "ca_pending", url: "https://example.invalid/monday-consent" } });
    expect(statSync(statePath).mode & 0o777).toBe(0o600);
    expect(browsers()).toEqual([{ kind: "browser", url: "https://example.invalid/monday-consent" }]);
    const session = events().find(event => event.path?.endsWith("/session"));
    expect(session?.body).toMatchObject({ toolkits: { enable: ["monday"] }, tools: { monday: { enable: [] } }, workbench: { enable: false } });
    expect(events().find(event => event.path?.endsWith("/link"))?.body).toEqual({ toolkit: "monday" });
  });
  test("verifies browser approval on the next Connect without reopening authorization", async () => {
    state(IDENTITY);
    scenario({ accountStatus: "INITIATED", activateAfterBrowser: true });
    const started = await invoke("connect_account");
    expect(started.body.connected).toBe(false);
    expect(started.body.status).toBe("Authorization pending");
    const verified = await invoke("connect_account");
    expect(verified.isError).toBe(false);
    expect(verified.body.connected).toBe(true);
    expect(saved()).toEqual({ ...IDENTITY, accountId: "ca_pending" });
    expect(browsers()).toHaveLength(1);
    expect(events().filter(event => event.path?.endsWith("/link"))).toHaveLength(1);
  });
  test("concurrent connects share one pending connection and browser attempt", async () => {
    state(IDENTITY);
    scenario({ accountStatus: "INITIATED", activateAfterBrowser: true });
    const results = await Promise.all([invoke("connect_account"), invoke("connect_account")]);
    expect(results.every(result => !result.isError && !result.body.connected && result.body.status === "Authorization pending")).toBe(true);
    expect(browsers()).toHaveLength(1);
    expect(events().filter(event => event.path?.endsWith("/link"))).toHaveLength(1);
  });
  test("disconnect cannot clear state while a connect is running", async () => {
    const [connected, disconnected] = await Promise.all([invoke("connect_account"), invoke("disconnect_account")]);
    expect(connected.body.connected).toBe(true);
    expect(disconnected.isError).toBe(true);
    expect(disconnected.body.error).toContain("authorization is still running");
    expect(saved()).toEqual(ACTIVE);
    expect(events().some(event => event.path?.endsWith("/revoke"))).toBe(false);
  });
  test.each(["FAILED", "EXPIRED", "REVOKED", "INITIATED"])("starts a new authorization when pending state is %s", async status => {
    state({ ...IDENTITY, pending: { id: "ca_old", url: "https://example.invalid/old" } });
    scenario({ accountStatus: status });
    const result = await invoke("connect_account");
    expect(result.isError).toBe(false);
    expect(result.body.connected).toBe(false);
    expect(result.body.status).toBe("Authorization pending");
    expect(saved().pending?.id).toBe("ca_pending");
    expect(events().some(event => event.path?.endsWith("/link"))).toBe(true);
  });
  test.each(["EXPIRED", "REVOKED", "FAILED", "INACTIVE"])("replaces a %s saved connection through explicit OAuth", async status => {
    scenario({ accountStatus: status, activateAfterBrowser: true });
    const result = await invoke("connect_account");
    expect(result.isError).toBe(false);
    expect(result.body.connected).toBe(false);
    expect(saved().pending.id).toBe("ca_pending");
    expect(browsers()).toHaveLength(1);
  });
  test("starts replacement authorization when the saved connection was removed", async () => {
    scenario({ accountHttpStatus: 404, browserError: true });
    expect((await invoke("connect_account")).isError).toBe(true);
    expect(saved().pending.id).toBe("ca_pending");
    expect(browsers()).toHaveLength(1);
  });
  test("a rejected Composio key does not open OAuth or clear saved state", async () => {
    scenario({ accountHttpStatus: 401 });
    const result = await invoke("connect_account");
    expect(result.isError).toBe(true);
    expect(result.body.error).toContain("Update it in Monday.com settings");
    expect(saved()).toEqual(ACTIVE);
    expect(browsers()).toEqual([]);
  });
  test("rejects non-HTTPS new and saved authorization links before opening a browser", async () => {
    state(IDENTITY);
    scenario({ redirectUrl: "http://example.invalid/authorize" });
    expect((await invoke("connect_account")).isError).toBe(true);
    expect(saved().pending).toBeUndefined();
    state({ ...IDENTITY, pending: { id: "ca_pending", url: "file:///tmp/not-oauth" } });
    expect((await invoke("connect_account")).isError).toBe(true);
    expect(browsers()).toEqual([]);
  });
  test("browser failures retain the pending reference for recovery", async () => {
    state(IDENTITY);
    scenario({ accountStatus: "INITIATED", browserError: true });
    expect((await invoke("connect_account")).isError).toBe(true);
    expect(saved().pending.id).toBe("ca_pending");
    scenario({ accountStatus: "INITIATED" });
    expect((await invoke("connect_account")).body.status).toBe("Authorization pending");
    expect(browsers()).toHaveLength(2);
    expect(events().filter(event => event.path?.endsWith("/link"))).toHaveLength(2);
    scenario({ accountStatus: "ACTIVE" });
    expect((await invoke("connect_account")).body.connected).toBe(true);
    expect(browsers()).toHaveLength(2);
  });
  test("never accepts another provider's connection", async () => {
    scenario({ accountToolkit: "github" });
    expect((await invoke("connect_account")).isError).toBe(true);
    expect((await invoke("disconnect_account")).isError).toBe(true);
    expect(browsers()).toEqual([]);
    expect(events().some(event => event.path?.endsWith("/revoke"))).toBe(false);
    expect(saved()).toEqual(ACTIVE);
  });
  test("background connect watcher updates state and emits VoiceOS notification on active", async () => {
    state(IDENTITY);
    scenario({ accountStatus: "ACTIVE", watchBackgroundConnect: true, pollIntervalMs: 20 });
    const result = await invoke("connect_account");
    expect(result.body.status).toBe("Authorization pending");
    let attempts = 0;
    while (attempts++ < 30 && saved().accountId !== "ca_pending") {
      await new Promise(r => setTimeout(r, 50));
    }
    expect(saved().accountId).toBe("ca_pending");
    expect(saved().pending).toBeUndefined();
    expect(notifications.some(n => n.message.includes("Connected successfully"))).toBe(true);
  });
  test("disconnect cleanly stops background connect watcher", async () => {
    state(IDENTITY);
    scenario({ accountStatus: "INITIATED", watchBackgroundConnect: true, pollIntervalMs: 20 });
    await invoke("connect_account");
    const dis = await invoke("disconnect_account");
    expect(dis.isError).toBe(false);
    expect(saved().pending).toBeUndefined();
    expect(saved().accountId).toBeUndefined();
  });
});

describe("disconnect and feedback", () => {
  test("concurrent disconnects revoke only once", async () => {
    const results = await Promise.all([invoke("disconnect_account"), invoke("disconnect_account")]);
    expect(results.every(result => !result.isError && !result.body.connected)).toBe(true);
    expect(events().filter(event => event.path?.endsWith("/revoke"))).toHaveLength(1);
  });
  test("revokes saved and pending references only and retains the installation identity", async () => {
    state({ ...ACTIVE, pending: { id: "ca_pending", url: "https://example.invalid/saved" } });
    const result = await invoke("disconnect_account");
    expect(result.isError).toBe(false);
    expect(result.body).toMatchObject({ connected: false, providerRevoked: true });
    expect(saved()).toEqual(IDENTITY);
    expect(events().filter(event => event.path?.endsWith("/revoke")).map(event => event.path)).toEqual([
      "/api/v3.1/connected_accounts/ca_test/revoke", "/api/v3.1/connected_accounts/ca_pending/revoke",
    ]);
  });
  test("disconnecting twice is idempotent", async () => {
    state(IDENTITY);
    expect((await invoke("disconnect_account")).isError).toBe(false);
    expect((await invoke("disconnect_account")).isError).toBe(false);
    expect(events()).toEqual([]);
  });
  test.each([400, 409])("unsupported provider revocation (%s) disables Composio access and explains consent", async status => {
    scenario({ revokeHttpStatus: status });
    const result = await invoke("disconnect_account");
    expect(result.isError).toBe(false);
    expect(result.body.providerRevoked).toBe(false);
    expect(result.body.message).toContain("uninstall the Composio app");
    expect(events().find(event => event.method === "PATCH")?.body).toEqual({ enabled: false });
    expect(saved()).toEqual(IDENTITY);
  });
  test("failed revocation or disabling preserves references for retry", async () => {
    scenario({ revokeHttpStatus: 403 });
    expect((await invoke("disconnect_account")).isError).toBe(true);
    expect(saved()).toEqual(ACTIVE);
    scenario({ revokeHttpStatus: 400, disableHttpStatus: 403 });
    expect((await invoke("disconnect_account")).isError).toBe(true);
    expect(saved()).toEqual(ACTIVE);
  });
  test("unconfirmed revocation is not reported as success", async () => {
    scenario({ revokeStatus: "ACTIVE" });
    expect((await invoke("disconnect_account")).isError).toBe(true);
    expect(saved()).toEqual(ACTIVE);
  });
  test("success and failure emit notifications; display failure does not change success", async () => {
    expect((await invoke("connect_account")).body.notificationQueued).toBe(true);
    scenario({ revokeHttpStatus: 403 });
    expect((await invoke("disconnect_account")).isError).toBe(true);
    expect(notifications).toHaveLength(2);
    expect(notifications[1].message).toContain("Test revocation unavailable");
    expect(notifications.every(notification => !notification.speak)).toBe(true);
    rejectNotification = true;
    const result = await invoke("connect_account");
    expect(result.isError).toBe(false);
    expect(result.body.notificationQueued).toBe(false);
  });
  test("credentials and sensitive URLs are redacted from failure output and notifications", async () => {
    scenario({ revokeHttpStatus: 403, errorMessage: `Failed ${KEY} https://example.invalid/secret` });
    const result = await invoke("disconnect_account");
    expect(result.isError).toBe(true);
    expect(result.text + JSON.stringify(notifications) + stderr).not.toContain(KEY);
    expect(result.text + JSON.stringify(notifications)).not.toContain("https://example.invalid/secret");
  });
});

test("new authorization returns an actionable pending result without waiting for browser approval", async () => {
  state(IDENTITY);
  scenario({ accountStatus: "INITIATED" });
  const result = await client.callTool({ name: "connect_account", arguments: {} }, CallToolResultSchema, { timeout: 1000 });
  expect(result.isError).not.toBe(true);
  const block = result.content.find(block => block.type === "text");
  if (!block || block.type !== "text") throw new Error("Missing text result");
  const body = JSON.parse(block.text);
  expect(body).toMatchObject({ connected: false, status: "Authorization pending", authorizationUrl: "https://example.invalid/monday-consent" });
  expect(body.message).toContain("Connect again");
  expect(saved().pending.id).toBe("ca_pending");
  expect(events().filter(event => /\/connected_accounts\//.test(event.path ?? ""))).toEqual([]);
  expect(manifest.tools.find((tool: { name: string }) => tool.name === "connect_account").execution.mode).toBe("sync");
});
