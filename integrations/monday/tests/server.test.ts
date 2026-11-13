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
const TOOLS = ["connect_account", "connection_status", "disconnect_account", "get_boards", "get_items", "prepare_create_item", "create_item", "prepare_update_item", "update_item_values", "create_update", "prepare_create_board", "create_board"].sort();
const directory = mkdtempSync(join(tmpdir(), "voiceos-monday-tests-"));
const statePath = join(directory, ".composio-auth.json");
const scenarioPath = join(directory, "scenario.json");
const eventsPath = join(directory, "events.jsonl");
let client: Client;
let transport: StdioClientTransport;
let stderr = "";
let notifications: {
  message: string; speak: boolean; actions?: { id: string; label: string }[]; data?: { url: string };
}[] = [];
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
    params: z.object({
      message: z.string(), speak: z.boolean(),
      actions: z.array(z.object({ id: z.string(), label: z.string() })).optional(),
      data: z.object({ url: z.string() }).optional(),
    }),
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
  expect(executions.every(event => ["MONDAY_BOARDS", "MONDAY_GET_ITEMS", "MONDAY_ITEMS_PAGE", "MONDAY_LIST_GROUPS", "MONDAY_COLUMNS", "MONDAY_LIST_USERS", "MONDAY_GET_TEAMS", "MONDAY_GET_WORKSPACES", "MONDAY_CREATE_ITEM", "proxy", "MONDAY_CREATE_UPDATE", "MONDAY_CREATE_BOARD"].includes(event.path!.split("/").at(-1)!))).toBe(true);
});
afterAll(async () => {
  try { await client?.close(); } finally {
    await transport?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("account tools contract", () => {
  test("exposes account, read, preparation, and write tools matching manifest inputs and confirmations", async () => {
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(TOOLS);
    expect(manifest.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(tools.map(tool => tool.name).sort());
    for (const actual of tools) {
      const declared = manifest.tools.find((tool: { name: string }) => tool.name === actual.name);
      expect(actual.description).toBe(declared.description);
      expect(actual.inputSchema.properties).toEqual(declared.inputSchema.properties);
      expect(actual.inputSchema.additionalProperties).toBe(false);
      if (["connection_status", "get_boards", "get_items", "prepare_create_item", "prepare_create_board", "prepare_update_item"].includes(actual.name)) {
        expect(declared.confirmation).toBeUndefined();
        expect(declared.uiCallable).toBe(true);
        expect(actual.annotations?.readOnlyHint).toBe(true);
      } else if (["create_item", "update_item_values", "create_update", "create_board"].includes(actual.name)) {
        if (actual.name === "create_item" || actual.name === "create_board") {
          const item = actual.name === "create_item";
          const root = declared.confirmation.root;
          const fields = root.children.filter((block: { type: string }) => block.type === "textField");
          expect(fields).toEqual([
            { type: "textField", bind: item ? "{{item_name}}" : "{{board_name}}", label: item ? "Item name" : "Board name", required: true },
            ...(!item ? [{ type: "textField", bind: "{{description}}", label: "Description", multiline: true }] : []),
          ]);
          const widget = root.children.find((block: { type: string }) => block.type === "widget");
          expect(widget.confirmLabel).toBe(item ? "Create item" : "Create board");
          expect(widget.visibleIf).toBeUndefined();
          expect(root.children.at(-1).children).toEqual([{ type: "button", label: "Cancel", role: "cancel" }]);
          expect(declared.visibility).toBeUndefined();
          if (!item) expect(root.children[0]).toMatchObject({
            type: "text", text: "{{submission_error}}", visibleIf: "{{submission_error}}", color: "danger",
          });
        } else if (actual.name === "update_item_values") {
          expect(declared.confirmation.root.children.find((block: { type: string }) => block.type === "widget").confirmLabel).toBe("Save changes");
          expect(declared.confirmation.root.children.at(-1).children).toEqual([{ type: "button", label: "Cancel", role: "cancel" }]);
        } else {
          expect(declared.confirmation).toBeUndefined();
        }
        expect(actual.annotations?.readOnlyHint).toBe(false);
        expect(actual.annotations?.idempotentHint).toBe(false);
        expect(actual.inputSchema.required).toEqual(declared.inputSchema.required);
      } else {
        expect(declared.confirmation.root.footer[0].items.map((item: { role: string }) => item.role).sort()).toEqual(["cancel", "confirm"]);
        expect(declared.execution.mode).toBe(actual.name === "connect_account" ? "sync" : "background");
      }
    }
  });
  test("rejects unknown tools and unexpected account arguments", async () => {
    expect((await invoke("delete_board", { board_id: 1 })).isError).toBe(true);
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
    const board = { id: "123", name: "Roadmap", workspace: { id: "45", name: "Product" }, owners: [{ id: "67" }] };
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
    expect(body.message).toBe("Found 1 board.");
    expect(body._voiceos_glance.blocks).toEqual([
      { type: "header", title: "Monday.com boards" },
      { type: "list", rows: [{ title: "Roadmap", subtitle: "Product" }] },
    ]);
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
    expect(result.body._voiceos_glance.blocks).toEqual([
      { type: "header", title: "Monday.com boards" },
      { type: "keyValue", pairs: [["Results", "No matching boards found."]] },
    ]);
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
    expect(boards.body.message).toBe("Found 1 board.");
    expect(boards.body._voiceos_glance.blocks).toEqual([
      { type: "header", title: "Monday.com boards" },
      { type: "list", rows: [{ title: "Voiceos test" }] },
    ]);
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
  ])("%s caps the list without displaying IDs and retains full records for follow-up calls", async (name, args) => {
    const entries = Array.from({ length: 7 }, (_, i) => ({ id: `internal-id-${i + 1}`, name: `Task ${i + 1}` }));
    const toolData = name === "get_boards" ? { boards: entries } : { items: entries, cursor: null };
    scenario({ toolData });
    const result = await invoke(name as string, args as Record<string, unknown>);
    expect(result.isError).toBe(false);
    const isBoards = name === "get_boards";
    expect(result.body.message).toBe(isBoards ? "Here are the first few boards." : "Here are the first few items.");
    expect(result.body.resultType).toBe(name === "get_boards" ? "boards" : "tasks");
    expect(result.body.records).toEqual(entries);
    expect(result.body._voiceos_glance.blocks).toEqual([
      { type: "header", title: isBoards ? "Monday.com boards" : "Monday.com items" },
      { type: "list", rows: [
        ...entries.slice(0, 5).map(entry => ({ title: entry.name })),
        { title: "and 2 more" },
      ] },
    ]);
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


const createBoardMetadata = {
  MONDAY_BOARDS: { boards: [{ id: "123", name: "Roadmap" }] },
  MONDAY_LIST_GROUPS: { boards: [{ groups: [{ id: "incoming", title: "Incoming" }, { id: "planned", title: "Planned" }] }] },
  MONDAY_COLUMNS: { boards: [{ id: "123", columns: [
    { id: "status", title: "Stage", type: "status", settings: { labels: [{ id: 1, label: "Done" }] } },
    { id: "date_1", title: "Ship date", type: "date" },
    { id: "owner", title: "Owner", type: "people" },
    { id: "text", title: "Notes", type: "text" },
    { id: "score", title: "Score", type: "numbers" },
  ] }] },
};

async function createArguments(input: Record<string, unknown> = {}) {
  const result = await invoke("prepare_create_item", { board_id: 123, item_name: "Test item", ...input });
  expect(result.isError).toBe(false);
  return result.body.create_item_arguments;
}

async function preparedWrite(input?: Record<string, unknown>) {
  scenario({ toolDataByAction: createBoardMetadata });
  const args = await createArguments(input);
  writeFileSync(eventsPath, "");
  return args;
}

describe("Monday create item confirmation", () => {
  const providerActions = () => events()
    .filter(event => event.path?.includes("/tools/execute/"))
    .map(event => event.path!.split("/").at(-1));

  test("renames a pending item without changing the board, group, or column values", async () => {
    scenario({ toolDataByAction: {
      ...createBoardMetadata,
      MONDAY_CREATE_ITEM: { create_item: { id: "456" } },
    } });
    const original = await createArguments({ item_name: "hello", group_id: "planned", column_values: { text: "Keep this" } });
    const result = await invoke("prepare_create_item", { replaces_draft_id: original.draft_id, item_name: "study" });
    expect(result.isError).toBe(false);
    const renamed = result.body.create_item_arguments;
    expect(renamed).toMatchObject({ item_name: "study", group_id: "planned", preview: original.preview });
    expect((await invoke("create_item", original)).isError).toBe(true);
    expect((await invoke("create_item", renamed)).body.id).toBe("456");
    expect(providerActions()).not.toContain("MONDAY_CREATE_BOARD");
    expect(events().find(event => event.path?.endsWith("/execute/MONDAY_CREATE_ITEM"))?.body?.arguments)
      .toEqual({ board_id: "123", group_id: "planned", item_name: "study", column_values: '{"text":"Keep this"}' });
  });

  test("asks for a board in one result card and keeps the item pending", async () => {
    scenario({ toolDataByAction: {
      MONDAY_BOARDS: { boards: [{ id: "123", name: "Roadmap" }, { id: "777", name: "Operations" }] },
    } });
    const result = await invoke("prepare_create_item", { item_name: "goodbye" });
    expect(result.isError).toBe(false);
    expect(result.body.resultType).toBe("board_choices");
    expect(result.body.create_item_arguments).toBeUndefined();
    expect(result.body.pending_item).toEqual({ item_name: "goodbye", draft_id: expect.any(String) });
    expect(result.body._voiceos_glance.blocks).toEqual([
      { type: "header", title: "Choose a board for “goodbye”" },
      { type: "keyValue", pairs: [["Next", "Say or type the board name."]] },
      { type: "list", rows: [{ title: "Roadmap" }, { title: "Operations" }] },
    ]);
    expect(providerActions()).toEqual(["MONDAY_BOARDS"]);
  });

  test("a board-name reply resumes the pending item and uses the first active group", async () => {
    scenario({ toolDataByAction: {
      ...createBoardMetadata,
      MONDAY_BOARDS: { boards: [
        { id: "123", name: "Thesis", groups: [{ id: "other", title: "Other group" }] },
        { id: "777", name: "Voiceos test", groups: [
          { id: "archived", title: "Archived", position: "0", archived: true },
          { id: "later", title: "Later", position: "200" },
          { id: "first", title: "First group", position: "100" },
        ] },
      ] },
      MONDAY_CREATE_ITEM: { create_item: { id: "456" } },
    } });
    const question = await invoke("prepare_create_item", { item_name: "task 3" });
    const selected = { board_name: "voiceos test", replaces_draft_id: question.body.pending_item.draft_id };
    const prepared = await invoke("prepare_create_item", selected);
    const args = prepared.body.create_item_arguments;
    expect(args).toEqual({
      draft_id: expect.any(String), item_name: "task 3", group_id: "first",
      preview: {
        board: "Voiceos test",
        groups: [{ id: "first", label: "First group" }, { id: "later", label: "Later" }],
        columns: [],
      },
    });
    expect((await invoke("prepare_create_item", selected)).isError).toBe(true);
    expect((await invoke("create_item", { ...args, selected_board_id: "123" })).isError).toBe(true);
    expect((await invoke("create_item", { ...args, group_id: "archived" })).isError).toBe(true);
    expect((await invoke("create_item", { ...args, group_id: "other" })).isError).toBe(true);
    expect(providerActions()).toEqual(["MONDAY_BOARDS", "MONDAY_BOARDS"]);
    expect((await invoke("create_item", args)).body.id).toBe("456");
    expect(providerActions().filter(action => action === "MONDAY_CREATE_ITEM")).toHaveLength(1);
    expect(events().find(event => event.path?.endsWith("/execute/MONDAY_CREATE_ITEM"))?.body?.arguments)
      .toMatchObject({ board_id: "777", group_id: "first" });
  });

  test("recovers a named pending item and remaps its requested values to the new board", async () => {
    scenario({ toolDataByAction: {
      ...createBoardMetadata,
      MONDAY_BOARDS: { boards: [
        { id: "123", name: "Thesis", groups: [{ id: "old", title: "Old group" }] },
        { id: "777", name: "Voiceos test", groups: [{ id: "new", title: "New group" }] },
      ] },
      MONDAY_COLUMNS: { boards: [
        { id: "123", columns: [{ id: "old_status", title: "Stage", type: "status", settings: { labels: [{ id: 1, label: "Done" }] } }] },
        { id: "777", columns: [{ id: "new_status", title: "Stage", type: "status", settings: { labels: [{ id: 2, label: "Done" }] } }] },
      ] },
      MONDAY_CREATE_ITEM: { create_item: { id: "456" } },
    } });
    const old = await createArguments({ item_name: "Carry my status", column_values: { old_status: "Done" } });
    const result = await invoke("prepare_create_item", { board_name: "voiceos", revises_item_name: "Carry my status" });
    const updated = result.body.create_item_arguments;
    expect(updated).toMatchObject({
      item_name: "Carry my status", preview: { board: "Voiceos test", columns: [{ label: "Stage", value: "Done" }] },
    });
    expect((await invoke("create_item", old)).isError).toBe(true);
    expect((await invoke("create_item", updated)).body.id).toBe("456");
    expect(events().find(event => event.path?.endsWith("/execute/MONDAY_CREATE_ITEM"))?.body?.arguments)
      .toMatchObject({ board_id: "777", column_values: '{"new_status":{"label":"Done"}}' });
  });

  test("resolves a supplied board name and asks when a partial match is ambiguous", async () => {
    scenario({ toolDataByAction: {
      ...createBoardMetadata,
      MONDAY_BOARDS: { boards: [
        { id: "123", name: "Roadmap", groups: [{ id: "incoming", title: "Incoming" }] },
        { id: "777", name: "Roadmap West" },
      ] },
    } });
    const ask = await invoke("prepare_create_item", { item_name: "goodbye", board_name: "road" });
    expect(ask.body.resultType).toBe("board_choices");
    expect(ask.body.create_item_arguments).toBeUndefined();
    const prepare = await invoke("prepare_create_item", { item_name: "goodbye", board_name: "roadmap" });
    expect(prepare.body.create_item_arguments).toMatchObject({
      group_id: "incoming",
      preview: { board: "Roadmap", groups: [{ id: "incoming", label: "Incoming" }], columns: [] },
    });
    expect(providerActions()).toEqual(["MONDAY_BOARDS", "MONDAY_BOARDS"]);
  });

  test("shows a preparation error when the board lookup fails without attempting a write", async () => {
    scenario({ toolHttpStatus: 500 });
    const result = await invoke("prepare_create_item", { item_name: "goodbye" });
    expect(result.isError).toBe(true);
    expect(result.body.create_item_arguments).toBeUndefined();
    expect(result.body._voiceos_glance.blocks[0]).toEqual({
      type: "header", title: "Couldn’t prepare Monday item", trailing: "Error",
    });
    expect(providerActions()).toEqual(["MONDAY_BOARDS"]);
  });

  test("writes to the group selected at confirmation with the edited name and reviewed column values", async () => {
    scenario({
      toolDataByAction: { ...createBoardMetadata, MONDAY_CREATE_ITEM: { create_item: { id: "456" } } },
      userPages: { 1: [{ id: "8", name: "Sam Rivera" }], 2: [{ id: "99", name: "Samira Roe" }] },
    });
    const args = await createArguments({
      group_id: "Planned",
      column_values: { Stage: { label: "Done" }, date_1: { date: "2025-09-17" }, owner: "Sam Rivera", text: " ", score: 0 },
    });
    expect(args.group_id).toBe("planned");
    expect(args.preview).toEqual({ board: "Roadmap", groups: [
      { id: "incoming", label: "Incoming" }, { id: "planned", label: "Planned" },
    ], columns: [
      { label: "Stage", value: "Done" }, { label: "Ship date", value: "Sep 17, 2025" },
      { label: "Owner", value: "Sam Rivera" }, { label: "Score", value: "0" },
    ] });
    const writes = () => events().filter(event => event.path?.endsWith("/execute/MONDAY_CREATE_ITEM"));
    expect(writes()).toHaveLength(0);
    expect((await invoke("create_item", { ...args, preview: { ...args.preview, columns: [] } })).isError).toBe(true);
    expect((await invoke("create_item", { ...args, item_name: " " })).isError).toBe(true);
    expect(writes()).toHaveLength(0);
    expect((await invoke("create_item", { ...args, item_name: "Edited name", group_id: "incoming" })).body.id).toBe("456");
    expect((await invoke("create_item", args)).isError).toBe(true);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].body?.arguments).toEqual({
      board_id: "123", group_id: "incoming", item_name: "Edited name",
      column_values: JSON.stringify({ status: { label: "Done" }, date_1: { date: "2025-09-17" },
        owner: { personsAndTeams: [{ id: 8, kind: "person" }] }, score: 0 }),
    });
    expect(notifications).toEqual([]);
  });

  test("retires a draft on a board change and reports unmatched columns before proposing another card", async () => {
    scenario({ toolDataByAction: createBoardMetadata });
    const args = await createArguments({ column_values: { status: { label: "Done" } } });
    scenario({ toolDataByAction: {
      MONDAY_BOARDS: { boards: [{ id: "777", name: "Operations", groups: [{ id: "intake", title: "Intake" }] }] },
      MONDAY_COLUMNS: { boards: [{ id: "777", columns: [{ id: "deadline", title: "Deadline", type: "date" }] }] },
      MONDAY_CREATE_ITEM: { create_item: { id: "456" } },
    } });
    const revision = await invoke("prepare_create_item", {
      board_id: 777, item_name: "Test item", replaces_draft_id: args.draft_id,
      column_values: { Stage: { label: "Done" } },
    });
    expect(revision.body.error).toContain('Could not match column "Stage"');
    expect((await invoke("create_item", args)).isError).toBe(true);
    expect(events().filter(event => event.path?.endsWith("/execute/MONDAY_CREATE_ITEM"))).toHaveLength(0);
    const revised = await createArguments({
      board_id: 777, replaces_draft_id: args.draft_id, column_values: { deadline: "2025-09-18" },
    });
    expect(revised).toMatchObject({
      group_id: "intake",
      preview: {
        board: "Operations", groups: [{ id: "intake", label: "Intake" }],
        columns: [{ label: "Deadline", value: "Sep 18, 2025" }],
      },
    });
    expect((await invoke("create_item", revised)).body.id).toBe("456");
  });

  test("uses the board's top group and asks about invalid labels and ambiguous people", async () => {
    scenario({
      toolDataByAction: createBoardMetadata,
      userPages: { 1: [{ id: "8", name: "Sam Rivera" }, { id: "9", name: "Sam Roe" }] },
    });
    const args = await createArguments({ column_values: { text: null } });
    expect(args).toMatchObject({ group_id: "incoming", preview: { board: "Roadmap", columns: [] } });
    const status = await invoke("prepare_create_item", { board_id: 123, item_name: "Test", column_values: { Stage: "done" } });
    expect(status.body.error).toContain("Available labels: Done");
    const owner = await invoke("prepare_create_item", { board_id: 123, item_name: "Test", column_values: { Owner: "Sam" } });
    expect(owner.body.error).toContain('Which Monday.com user did you mean by "Sam"');
    expect(events().filter(event => event.path?.endsWith("/execute/MONDAY_CREATE_ITEM"))).toHaveLength(0);
  });
});

async function prepareBoardArguments(input: Record<string, unknown> = {}) {
  const result = await invoke("prepare_create_board", { board_name: "Test board", ...input });
  expect(result.isError).toBe(false);
  return result.body.create_board_arguments;
}

describe("Monday create board confirmation", () => {
  const boardWrites = () => events().filter(event => event.path?.endsWith("/execute/MONDAY_CREATE_BOARD"));

  test("a fresh board request asks for a name and uses defaults even with another named draft pending", async () => {
    scenario({ workspacePages: { 1: [{ id: "123", name: "Design" }] } });
    await prepareBoardArguments({ board_name: "voiceos", description: "integrations", board_kind: "private", workspace: "Design" });
    const fresh = await invoke("prepare_create_board", { item_follow_up: "prepare_confirmation" });
    expect(fresh.body.message).toBe("What should the board be named?");
    expect(fresh.body.pending_board).toEqual({ draft_id: expect.any(String), item_follow_up: "prepare_confirmation" });
    expect(fresh.body.create_board_arguments).toBeUndefined();
    const named = await invoke("prepare_create_board", {
      replaces_draft_id: fresh.body.pending_board.draft_id, board_name: "New board",
    });
    expect(named.body.create_board_arguments).toMatchObject({
      board_name: "New board", board_kind: "public", description: "", workspace_choice: "default",
    });
    expect(boardWrites()).toHaveLength(0);
  });

  test("keeps description and visibility across follow-ups until the user supplies the name", async () => {
    const description = await invoke("prepare_create_board", { description: "integrations" });
    expect(description.body.message).toBe("What should the board be named?");
    expect(description.body.create_board_arguments).toBeUndefined();
    const visibility = await invoke("prepare_create_board", {
      replaces_draft_id: description.body.pending_board.draft_id, board_kind: "private",
    });
    expect(visibility.body.pending_board).toMatchObject({ description: "integrations", board_kind: "private" });
    expect(events()).toEqual([]);
    const named = await invoke("prepare_create_board", {
      replaces_draft_id: visibility.body.pending_board.draft_id, board_name: "Integrations roadmap",
    });
    expect(named.body.create_board_arguments).toMatchObject({
      board_name: "Integrations roadmap", description: "integrations", board_kind: "private", workspace_choice: "default",
    });
    expect(boardWrites()).toHaveLength(0);
  });

  test("revises a named confirmation without asking for the name again and retires earlier confirmations", async () => {
    scenario({ toolDataByAction: { MONDAY_CREATE_BOARD: { create_board: { id: "987" } } } });
    const original = await prepareBoardArguments({ board_name: "Integrations roadmap" });
    const description = await invoke("prepare_create_board", {
      replaces_draft_id: original.draft_id, description: "integrations",
    });
    const edited = description.body.create_board_arguments;
    const visibility = await invoke("prepare_create_board", { replaces_draft_id: edited.draft_id, board_kind: "private" });
    const latest = visibility.body.create_board_arguments;
    expect(latest).toMatchObject({ board_name: "Integrations roadmap", description: "integrations", board_kind: "private" });
    expect((await invoke("create_board", original)).isError).toBe(true);
    expect((await invoke("create_board", edited)).isError).toBe(true);
    expect(boardWrites()).toHaveLength(0);
    expect((await invoke("create_board", latest)).body.id).toBe("987");
    expect(boardWrites()[0].body?.arguments).toEqual({
      board_name: "Integrations roadmap", description: "integrations", board_kind: "private",
    });
  });

  test("uses the latest board settings when a voice edit refers to an older confirmation", async () => {
    scenario({ toolDataByAction: { MONDAY_CREATE_BOARD: { create_board: { id: "987" } } } });
    const original = await prepareBoardArguments({ board_name: "Original" });
    const updated = await invoke("prepare_create_board", {
      replaces_draft_id: original.draft_id, description: "Keep this", board_kind: "private",
    });
    const latest = await invoke("prepare_create_board", { replaces_draft_id: original.draft_id, board_name: "cs173" });
    expect(latest.isError).toBe(false);
    const args = latest.body.create_board_arguments;
    expect(args).toMatchObject({ board_name: "cs173", description: "Keep this", board_kind: "private" });
    expect((await invoke("create_board", original)).isError).toBe(true);
    expect((await invoke("create_board", updated.body.create_board_arguments)).isError).toBe(true);
    expect(boardWrites()).toHaveLength(0);
    expect((await invoke("create_board", args)).body.id).toBe("987");
    const used = await invoke("prepare_create_board", { replaces_draft_id: original.draft_id, board_name: "Another name" });
    expect(used.isError).toBe(false);
    expect(used.body.board_draft_status).toBe("created");
    expect(used.body._voiceos_glance).toBeUndefined();
    expect(used.body.create_board_arguments).toBeUndefined();
    expect(boardWrites()).toHaveLength(1);
  });

  test("returns a quiet recovery status for a missing draft reference", async () => {
    const result = await invoke("prepare_create_board", {
      replaces_draft_id: "da3d9451-474f-4e6b-b9ae-016a4ecb46b7", board_name: "cs173",
    });
    expect(result.isError).toBe(false);
    expect(result.body.board_draft_status).toBe("unavailable");
    expect(result.body._voiceos_glance).toBeUndefined();
    expect(events()).toEqual([]);
  });

  test("prepares a name-only draft without writing and creates a public board in the default workspace after approval", async () => {
    scenario({ toolDataByAction: { MONDAY_CREATE_BOARD: { create_board: { id: "987" } } } });
    const args = await prepareBoardArguments();
    expect(args).toMatchObject({
      board_name: "Test board", board_kind: "public", description: "", workspace_choice: "default",
      workspace_choices: [{ value: "default", label: "Default workspace" }],
    });
    expect(boardWrites()).toHaveLength(0);
    const results = await Promise.all([invoke("create_board", args), invoke("create_board", args)]);
    expect(results.filter(result => !result.isError).map(result => result.body.id)).toEqual(["987"]);
    expect(boardWrites()).toHaveLength(1);
    expect(boardWrites()[0].body?.arguments).toEqual({ board_name: "Test board", board_kind: "public" });
  });

  test("resolves workspaces by name across pages and applies changes made on the confirmation", async () => {
    scenario({
      workspacePages: {
        1: Array.from({ length: 100 }, (_, index) => ({ id: String(index + 1), name: `Workspace ${index + 1}` })),
        2: [{ id: "123", name: "Design" }, { id: "456", name: "Engineering" }, { id: "789", name: "Old", state: "archived" }],
      },
      toolDataByAction: { MONDAY_CREATE_BOARD: { create_board: { id: "987" } } },
    });
    const args = await prepareBoardArguments({ workspace: "design", board_kind: "private", description: "Initial" });
    expect(args.board_kind).toBe("private");
    expect(args.workspace_choices.find((choice: { value: string }) => choice.value === args.workspace_choice)?.label).toBe("Design");
    expect(args.workspace_choices.some((choice: { label: string }) => choice.label === "Old")).toBe(false);
    const engineering = args.workspace_choices.find((choice: { label: string }) => choice.label === "Engineering");
    expect((await invoke("create_board", { ...args, workspace_choice: "456" })).isError).toBe(true);
    expect((await invoke("create_board", { ...args, workspace_choices: [] })).isError).toBe(true);
    expect(boardWrites()).toHaveLength(0);
    const result = await invoke("create_board", {
      ...args, board_name: "Updated board", board_kind: "share", description: "Updated description", workspace_choice: engineering.value,
    });
    expect(result.body.id).toBe("987");
    expect(boardWrites()[0].body?.arguments).toEqual({
      board_name: "Updated board", board_kind: "share", description: "Updated description", workspace_id: 456,
    });
  });

  test.each([
    ["Unknown", "No workspace matches"],
    ["Design", "Multiple workspaces match"],
  ])("requires clarification for workspace %s", async (workspace, message) => {
    scenario({ workspacePages: { 1: [
      { id: "123", name: "Design" }, { id: "456", name: "Design" }, { id: "789", name: "Engineering" },
    ] } });
    const original = await prepareBoardArguments({ board_kind: "private", workspace: "Engineering" });
    const result = await invoke("prepare_create_board", { replaces_draft_id: original.draft_id, workspace });
    expect(result.isError).toBe(false);
    expect(result.body.message).toContain(message);
    expect(result.body.create_board_arguments).toBeUndefined();
    expect((await invoke("create_board", original)).isError).toBe(true);
    const resolved = await invoke("prepare_create_board", {
      replaces_draft_id: result.body.pending_board.draft_id, workspace: null,
    });
    expect(resolved.body.create_board_arguments).toMatchObject({
      board_name: "Test board", board_kind: "private", workspace_choice: "default",
    });
    expect(boardWrites()).toHaveLength(0);
  });

  test("can use the default workspace without workspace read permission", async () => {
    scenario({ toolDataByAction: {
      MONDAY_GET_WORKSPACES: { errors: [{ message: "Missing workspaces:read scope" }] },
      MONDAY_CREATE_BOARD: { create_board: { id: "987" } },
    } });
    const args = await prepareBoardArguments();
    expect(args.workspace_choice).toBe("default");
    expect(args.workspace_notice).toContain("unavailable");
    expect((await invoke("prepare_create_board", { board_name: "Test board", workspace: "Design" })).isError).toBe(true);
    expect((await invoke("create_board", args)).body.id).toBe("987");
    expect(boardWrites()[0].body?.arguments).not.toHaveProperty("workspace_id");
  });

  test("reopens a visibility rejection with the submitted edits and requires approval of the corrected draft", async () => {
    scenario({ workspacePages: { 1: [{ id: "123", name: "Design" }] } });
    const args = await prepareBoardArguments({ workspace: "Design" });
    scenario({ toolDataByAction: { MONDAY_CREATE_BOARD: { errors: [{ message: "Private boards are unavailable on this plan" }] } } });
    const result = await invoke("create_board", { ...args, board_name: "Edited board", board_kind: "private", description: "Edited description" });
    expect(result.isError).toBe(true);
    expect(result.body.error).toContain("Private boards are unavailable");
    const retry = result.body.retry_create_board_arguments;
    expect(retry).toMatchObject({
      board_name: "Edited board", board_kind: "private", description: "Edited description",
      workspace_choice: args.workspace_choice, workspace_choices: args.workspace_choices,
      submission_error: result.body.error,
    });
    expect(retry.draft_id).not.toBe(args.draft_id);
    expect((await invoke("create_board", args)).isError).toBe(true);
    expect(boardWrites()).toHaveLength(1);
    expect(notifications).toEqual([]);
    scenario({ toolDataByAction: { MONDAY_CREATE_BOARD: { create_board: { id: "987" } } } });
    expect((await invoke("create_board", { ...retry, board_kind: "public" })).body.id).toBe("987");
    expect(boardWrites().map(event => event.body?.arguments)).toEqual([
      { board_name: "Edited board", board_kind: "private", description: "Edited description", workspace_id: 123 },
      { board_name: "Edited board", board_kind: "public", description: "Edited description", workspace_id: 123 },
    ]);
  });

  test.each([
    { toolError: "Private board creation timed out while checking the plan" },
    { toolData: { data: { create_board: { id: "987" } }, errors: [{ message: "Private boards require an upgraded plan" }] } },
  ])("does not offer another approval when the board write outcome is uncertain", async failure => {
    const args = await prepareBoardArguments({ board_kind: "private" });
    scenario(failure);
    const result = await invoke("create_board", args);
    expect(result.isError).toBe(true);
    expect(result.body.retry_create_board_arguments).toBeUndefined();
    expect(boardWrites()).toHaveLength(1);
  });

  test("uses the created board ID and top group after a targeted metadata read and retries only the item", async () => {
    const url = "https://example.monday.com/boards/987";
    scenario({ toolDataByAction: {
      MONDAY_CREATE_BOARD: { create_board: { id: "987" } },
      MONDAY_BOARDS: { boards: [{ id: "987", name: "Integrations", url, workspace: { name: "Main workspace" },
        groups: [{ id: "other", title: "Later", position: "200" }, { id: "topics", title: "New items", position: "100" }] }] },
      MONDAY_CREATE_ITEM: { create_item: { id: "654" } },
    } });
    const initial = await prepareBoardArguments({
      board_name: "Integrations", item_follow_up: "prepare_confirmation", follow_up_item_name: "hello",
    });
    const revised = await invoke("prepare_create_board", {
      replaces_draft_id: initial.draft_id, follow_up_item_name: "study",
    });
    const args = revised.body.create_board_arguments;
    expect(args).toMatchObject({ board_name: "Integrations", board_kind: "public", description: "", workspace_choice: "default" });
    expect((await invoke("create_board", initial)).isError).toBe(true);
    const board = await invoke("create_board", args);
    const followUp = "Preparing the item confirmation…";
    expect(board.body).toMatchObject({
      id: "987", name: "Integrations", url, item_destination: { board_id: 987, item_name: "study" },
      item_follow_up: followUp, notificationQueued: true,
    });
    expect(notifications[0]).toMatchObject({ message: `Created public board “Integrations” in Main workspace. ${followUp}`,
      actions: [{ id: "open_board", label: "Open board" }], data: { url } });
    expect(board.body._voiceos_glance.blocks[1].pairs).toContainEqual(["Next", followUp]);
    expect(board.body._voiceos_glance.blocks.at(-1)).toMatchObject({ type: "widget", label: "Open board", data: { url } });
    const open = await client.request({ method: "voiceos/reminders/action", params: {
      notificationId: "notification_test", actionId: "open_board", data: { url },
    } }, z.object({ ok: z.boolean() }));
    expect(open.ok).toBe(true);
    expect(browsers().at(-1)?.url).toBe(url);
    const prep = board.body.item_destination;
    const first = await invoke("prepare_create_item", prep);
    expect(first.body.create_item_arguments).toMatchObject({ item_name: "study", group_id: "topics", preview: { board: "Integrations" } });
    // Canceling the first confirmation leaves the item write uncalled.
    expect(events().filter(event => event.path?.endsWith("/execute/MONDAY_CREATE_ITEM"))).toHaveLength(0);
    const retried = await invoke("prepare_create_item", { ...prep, replaces_draft_id: first.body.create_item_arguments.draft_id });
    expect((await invoke("create_item", retried.body.create_item_arguments)).body.id).toBe("654");
    expect(boardWrites()).toHaveLength(1);
    const reads = events().filter(event => event.path?.endsWith("/execute/MONDAY_BOARDS"));
    expect(reads.map(event => event.body?.arguments)).toEqual([{ ids: [987], state: "active", limit: 1, page: 1 }]);
    expect(events().find(event => event.path?.endsWith("/execute/MONDAY_CREATE_ITEM"))?.body?.arguments)
      .toEqual({ board_id: "987", group_id: "topics", item_name: "study" });
  });

  test("keeps a confirmed board when link lookup fails", async () => {
    scenario({ toolDataByAction: {
      MONDAY_CREATE_BOARD: { create_board: { id: "987", url: "https://example.invalid/boards/987" } },
      MONDAY_BOARDS: { errors: [{ message: "Metadata unavailable" }] },
    } });
    const result = await invoke("create_board", await prepareBoardArguments());
    expect(result.isError).toBe(false);
    expect(result.body).toMatchObject({ id: "987", url: null, item_destination: { board_id: 987 } });
    expect(notifications[0].actions).toBeUndefined();
    expect(boardWrites()).toHaveLength(1);
  });

  test.each([
    ["ask_name", "Next, choose a name for the item."],
    ["none", undefined],
    [undefined, undefined],
  ])("shows the appropriate handoff for %s without preparing the item automatically", async (item_follow_up, expected) => {
    scenario({ toolDataByAction: {
      MONDAY_CREATE_BOARD: { create_board: { id: "987", name: "Integrations", url: "https://example.monday.com/boards/987",
        groups: [{ id: "topics", title: "New items" }] } },
    } });
    const args = await prepareBoardArguments(item_follow_up ? { item_follow_up } : {});
    const board = await invoke("create_board", args);
    expect(board.body.item_follow_up).toBe(expected);
    const next = board.body._voiceos_glance.blocks[1].pairs.find(([label]: [string]) => label === "Next");
    expect(next?.[1]).toBe(expected);
    expect(events().filter(event => event.path?.includes("/tools/execute/")).map(event => event.path?.split("/").at(-1)))
      .toEqual(["MONDAY_GET_WORKSPACES", "MONDAY_CREATE_BOARD"]);
  });

  test("keeps the board when the approved item write fails", async () => {
    scenario({ toolDataByAction: {
      MONDAY_CREATE_BOARD: { create_board: { id: "987", name: "Integrations", url: "https://example.monday.com/boards/987",
        groups: [{ id: "topics", title: "New items" }] } },
      MONDAY_CREATE_ITEM: { errors: [{ message: "Item permission denied" }] },
    } });
    const board = await invoke("create_board", await prepareBoardArguments());
    expect(board.isError).toBe(false);
    const item = await invoke("prepare_create_item", { ...board.body.item_destination, item_name: "item3" });
    expect((await invoke("create_item", item.body.create_item_arguments)).isError).toBe(true);
    expect(events().filter(event => event.path?.includes("/tools/execute/")).map(event => event.path?.split("/").at(-1)))
      .toEqual(["MONDAY_GET_WORKSPACES", "MONDAY_CREATE_BOARD", "MONDAY_CREATE_ITEM"]);
  });

  test("a draft cannot be used after switching the connected account", async () => {
    const args = await prepareBoardArguments();
    state({ ...IDENTITY, accountId: "ca_other" });
    expect((await invoke("create_board", args)).body.error).toContain("account changed");
    expect(boardWrites()).toHaveLength(0);
  });
});

describe("Monday write tools", () => {
  test("reads the created ID from Composio's live response envelope", async () => {
    const args = await preparedWrite();
    scenario({
      toolData: {
        raw_response: {
          data: { create_item: { id: "456" } },
          extensions: { request_id: "fixture" },
        },
      },
    });
    const result = await invoke("create_item", args);
    expect(result.isError).toBe(false);
    expect(result.body.id).toBe("456");
    expect(result.body._voiceos_glance.blocks[0].trailing).toBe("Success");
    expect(notifications).toEqual([]);
  });

  test("reports GraphQL errors inside raw_response even when partial data includes an ID", async () => {
    const args = await preparedWrite();
    scenario({
      toolData: {
        raw_response: {
          data: { create_item: { id: "456" } },
          errors: [{ message: "Access denied" }],
        },
      },
    });
    const result = await invoke("create_item", args);
    expect(result.isError).toBe(true);
    expect(result.body.error).toContain("Access denied");
    expect(result.body.id).toBeUndefined();
    expect(notifications).toEqual([]);
  });

  const cases = [
    { name: "create_item", args: { board_id: 123, item_name: "New task", column_values: '{"status":{"label":"Done"}}' }, action: "MONDAY_CREATE_ITEM", response: { create_item: { id: "456" } }, routed: { board_id: "123", group_id: "incoming", item_name: "New task", column_values: '{"status":{"label":"Done"}}' } },
    { name: "create_update", args: { item_id: 456, body: "A comment" }, action: "MONDAY_CREATE_UPDATE", response: { create_update: { id: "789" } }, routed: { item_id: 456, body: "A comment" } },
    { name: "create_board", args: { board_name: "Test board", board_kind: "private" }, action: "MONDAY_CREATE_BOARD", response: { create_board: { id: "987", url: "https://example.monday.com/boards/987", groups: [{ id: "topics", title: "New items" }] } }, routed: { board_name: "Test board", board_kind: "private" } },
  ];
  async function writeArguments(c: (typeof cases)[number]) {
    if (c.name === "create_item") return preparedWrite(c.args);
    if (c.name !== "create_board") return c.args;
    const args = await prepareBoardArguments(c.args);
    writeFileSync(eventsPath, "");
    return args;
  }
  for (const c of cases) {
    test(`${c.name} returns a confirmed ID and result card`, async () => {
      const args = await writeArguments(c);
      scenario({ toolData: { data: c.response } });
      const result = await invoke(c.name, args);
      expect(result.isError).toBe(false);
      expect(result.body.id).toBeTruthy();
      expect(result.body.notificationQueued).toBe(c.name === "create_board");
      expect(result.body._voiceos_glance.blocks[0].trailing).toBe("Success");
      const calls = events().filter(e => e.path?.includes("/tools/execute/"));
      expect(calls[0]).toMatchObject({ path: `/api/v3.1/tools/execute/${c.action}`, body: {
        connected_account_id: "ca_test", user_id: IDENTITY.userId, version: "20261101_00", arguments: c.routed,
      } });
      // Compare actual HTTP arguments to the independently retrieved catalog contract.
      const catalog = JSON.parse(readFileSync(join(ROOT, "tests/catalog", `${c.action}.json`), "utf8"));
      expect(catalog.version).toBe("20261101_00");
      for (const call of calls) {
        const args = call.body!.arguments as Record<string, unknown>;
        for (const key of catalog.inputSchema.required) expect(args[key]).toBeDefined();
        for (const [key, value] of Object.entries(args)) {
          const property = catalog.inputSchema.properties[key];
          expect(property).toBeDefined();
          if (property.type === "string") expect(typeof value).toBe("string");
          if (property.type === "integer") expect(Number.isSafeInteger(value)).toBe(true);
          if (property.enum) expect(property.enum).toContain(value);
        }
      }
      expect(calls).toHaveLength(1);
      expect(notifications).toHaveLength(c.name === "create_board" ? 1 : 0);
    });
    for (const failure of [
      { toolHttpStatus: 500 }, { toolHttpStatus: 403 },
      { toolSuccessful: false, toolError: "Missing target" },
      { toolData: { errors: [{ message: "Permission denied" }] } },
      { toolData: {} }, { accountStatus: "EXPIRED" },
    ]) test(`${c.name} reports failure without retry: ${JSON.stringify(failure)}`, async () => {
      const args = await writeArguments(c);
      scenario(failure);
      const result = await invoke(c.name, args);
      expect(result.isError).toBe(true);
      expect(result.body.error).toBeTruthy();
      expect(notifications).toEqual([]);
      expect(events().filter(e => e.path?.includes("/tools/execute/")).length).toBeLessThanOrEqual(1);
    });
  }
  test.each(["bad JSON", "[]", "null", '{"":1}'])("rejects malformed column values %s before writes", async columns => {
    for (const name of ["prepare_create_item", "prepare_update_item"]) {
      const args = name === "prepare_create_item" ? { board_id: 123, item_name: "Task", column_values: columns } : { board_id: 123, item_id: 456, column_values: columns };
      expect((await invoke(name, args)).isError).toBe(true);
    }
    expect(events()).toEqual([]);
    expect(notifications).toEqual([]);
  });
  test.each([
    ["create_item", {}], ["create_item", { board_id: 1, item_name: " " }],
    ["create_update", { body: "Missing target" }], ["create_update", { item_id: 1, body: " " }],
    ["update_item_values", { item_id: 1, column_values: { text: "Missing board" } }],
    ["create_board", { board_name: "Board" }],
    ["create_board", { board_name: "Board", board_kind: "public", board_owner_ids: [1] }],
    ["prepare_create_board", { board_name: "Board", workspace_id: 123 }],
    ["prepare_create_board", { board_name: "Board", folder_id: 123 }],
  ])("rejects missing/invalid write inputs for %s", async (name, args) => {
    expect((await invoke(name as string, args as Record<string, unknown>)).isError).toBe(true);
    expect(events()).toEqual([]);
  });
});



describe("reviewed Monday item updates", () => {
  const columns = [
    { id: "status_1", title: "Status", type: "status", settings: { labels: [{ id: 1, label: "Done", index: 0 }] } },
    { id: "people_1", title: "Owner", type: "people" },
    { id: "priority", title: "Priority", type: "dropdown", settings: { labels: [{ id: 5, label: "High" }] } },
    { id: "date", title: "Due date", type: "date" },
    { id: "timeline", title: "Timeline", type: "timeline" },
    { id: "text", title: "Text", type: "text" },
    { id: "notes", title: "Notes", type: "long_text" },
    { id: "estimate", title: "Estimate", type: "numbers" },
    { id: "ready", title: "Ready", type: "checkbox" },
    { id: "formula", title: "Total", type: "formula" },
  ];
  const original = {
    id: "456", name: "Review the draft", state: "active",
    board: { id: "123", name: "Test board", state: "active", columns },
    column_values: columns.map(column => column.id === "people_1"
      ? { id: column.id, text: "Maya", value: JSON.stringify({ personsAndTeams: [{ id: 7, kind: "person" }] }) }
      : { id: column.id, text: null, value: null, ...(column.id === "date" ? { dateIsLeaf: false } : {}) }),
  };
  const userPages = { 1: [{ id: "7", name: "Maya" }, { id: "8", name: "Jordan" }] };
  const writes = () => events().filter(e => String((e.body?.body as Record<string, unknown>)?.query).startsWith("mutation SaveItem"));
  async function prepare(column_values: Record<string, unknown>) {
    const result = await invoke("prepare_update_item", { board_id: 123, item_id: 456, column_values });
    expect(result.isError).toBe(false);
    expect(result.body.update_item_arguments?.draft_id).toBeTruthy();
    return result.body.update_item_arguments;
  }

  test("previews only requested fields and writes them in one mutation after confirmation", async () => {
    const values = {
      name: "Review final copy", status_1: { index: 1 },
      people_1: { personsAndTeams: [{ id: 8, kind: "person" }, { id: 7, kind: "person" }] },
      priority: { ids: [5] }, date: { date: "2026-11-16" },
      timeline: { from: "2026-11-16", to: "2026-11-20" },
      text: "Ready", notes: { text: "For review" }, estimate: "4", ready: { checked: "true" },
    };
    const updated = {
      ...original, name: values.name,
      column_values: original.column_values.map(cell => ({
        ...cell, value: Object.hasOwn(values, cell.id) ? JSON.stringify(values[cell.id as keyof typeof values]) : cell.value,
      })),
    };
    scenario({ proxyItem: original, proxyUpdatedItem: updated, userPages });
    const args = await prepare({
      name: values.name, Status: "Done", Owner: { operation: "add", names: ["Jordan"] },
      Priority: "High", "Due date": "2026-11-16", Timeline: values.timeline, Text: "Ready",
      Notes: "For review", Estimate: 4, Ready: true,
    });
    expect(args.preview).toMatchObject({ board: "Test board", item: original.name, changes: [
      { label: "Name", before: original.name, after: values.name },
      { label: "Status", before: "Empty", after: "Done" },
      { label: "Owner", before: "Maya", after: "Jordan, Maya" },
      { label: "Priority", before: "Empty", after: "High" },
      { label: "Due date", before: "Empty", after: "Nov 16, 2026" },
      { label: "Timeline", before: "Empty", after: "Nov 16, 2026 – Nov 20, 2026" },
      { label: "Text", before: "Empty", after: "Ready" },
      { label: "Notes", before: "Empty", after: "For review" },
      { label: "Estimate", before: "Empty", after: "4" },
      { label: "Ready", before: "Unchecked", after: "Checked" },
    ] });
    expect(writes()).toEqual([]);
    expect((await invoke("update_item_values", { ...args, preview: { ...args.preview, item: "Different item" } })).isError).toBe(true);
    expect(writes()).toEqual([]);
    const [result, duplicate] = await Promise.all([
      invoke("update_item_values", args), invoke("update_item_values", args),
    ]);
    expect([result, duplicate].map(value => value.isError).sort()).toEqual([false, true]);
    const success = result.isError ? duplicate : result;
    expect(success.body.completedColumns).toEqual(Object.keys(values));
    expect(writes()).toHaveLength(1);
    expect(writes()[0].body).toMatchObject({
      endpoint: "https://api.monday.com/v2", connected_account_id: "ca_test", user_id: IDENTITY.userId,
      body: { variables: { boardId: "123", itemId: "456", values: JSON.stringify(values) } },
    });
    expect(notifications).toEqual([]);
  });

  test("revises the proposal and prevents saving a stale or changed item", async () => {
    scenario({ proxyItem: original });
    const args = await prepare({ Text: "First draft" });
    const revision = await invoke("prepare_update_item", {
      replaces_draft_id: args.draft_id, column_values: { Text: "Revised text", Ready: true },
    });
    expect(revision.body.update_item_arguments.preview.changes.map((change: { after: string }) => change.after)).toEqual(["Revised text", "Checked"]);
    expect((await invoke("update_item_values", args)).isError).toBe(true);
    scenario({ proxyItem: { ...original, name: "Renamed by someone else" } });
    const result = await invoke("update_item_values", revision.body.update_item_arguments);
    expect(result.body.error).toContain("changed since the preview");
    expect(writes()).toEqual([]);
  });

  test("rejects unsupported fields and mismatched boards before offering a save", async () => {
    scenario({ proxyItem: original });
    const details = await invoke("prepare_update_item", { item_id: 456 });
    expect(details.body.update_item_details.columns.map((column: { id: string }) => column.id)).not.toContain("formula");
    for (const [board_id, column_values] of [[123, { Text: "Valid", Total: 4 }], [124, { Text: "Wrong board" }]]) {
      const result = await invoke("prepare_update_item", { board_id, item_id: 456, column_values });
      expect(result.isError).toBe(true);
      expect(result.body.update_item_arguments).toBeUndefined();
    }
    expect(writes()).toEqual([]);
  });

  test("rejects a date calculated from child items", async () => {
    const calculated = columns.map(column => column.id === "date"
      ? { ...column, capabilities: { calculated: { function: "MIN" } } }
      : column);
    scenario({ proxyItem: { ...original, board: { ...original.board, columns: calculated } } });
    const result = await invoke("prepare_update_item", {
      item_id: 456, column_values: { "Due date": "2026-11-20" },
    });
    expect(result.isError).toBe(true);
    expect(result.body.update_item_arguments).toBeUndefined();
    expect(writes()).toEqual([]);
  });

  test("reports what readback could confirm after an uncertain write, with one attempt", async () => {
    const updated = { ...original, name: "New title" };
    scenario({ proxyItem: original, proxyUpdatedItem: updated, proxyMutationHttpStatus: 500 });
    const args = await prepare({ name: updated.name, Text: "New text" });
    const result = await invoke("update_item_values", args);
    expect(result.isError).toBe(true);
    expect(result.body.error).toContain("Verified changes: Name. Could not verify: Text.");
    expect(writes()).toHaveLength(1);
  });
});
