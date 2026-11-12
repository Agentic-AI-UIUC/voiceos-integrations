import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { RecordedEvent, Scenario } from "./mock-composio";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(readFileSync(join(ROOT, "voiceos.integration.json"), "utf8"));
const TEST_KEY = "test-only-key-7c2bd731e9f54c099865";
const ACTIVE_STATE = { userId: "voiceos-test-user", accountId: "ca_test" };
const EXPECTED_BUSINESS_TOOLS = [
  "close_task", "create_label", "create_project", "create_section", "create_task", "delete_project",
  "delete_section", "delete_label", "get_active_tasks", "get_productivity_stats", "list_projects",
  "list_sections", "list_labels", "update_label", "update_task",
];
// Account/setup helpers are counted separately; this asserts the current
// catalog without treating the setup-tool exception as a business-tool approval.
const EXPECTED_SETUP_TOOLS = ["connect_account", "connection_status", "disconnect_account"];

type JsonObject = Record<string, any>;
type ParsedResult = { isError: boolean; body: JsonObject; text: string };
type FeedbackRequest = { message: string; speak: boolean };

const directory = mkdtempSync(join(tmpdir(), "voiceos-todoist-tests-"));
const statePath = join(directory, ".composio-auth.json");
const scenarioPath = join(directory, "scenario.json");
const eventsPath = join(directory, "events.jsonl");
let client: Client;
let transport: StdioClientTransport;
let stderr = "";
let protocolErrors: Error[] = [];
let notifications: FeedbackRequest[] = [];
let rejectNotification = false;

function setScenario(config: Scenario = {}) {
  writeFileSync(scenarioPath, JSON.stringify(config));
}
function setState(state: JsonObject = ACTIVE_STATE) {
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
}
function savedState(): JsonObject {
  return JSON.parse(readFileSync(statePath, "utf8"));
}
function events(): RecordedEvent[] {
  return readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}
function operations() {
  return events().filter(event => event.path?.includes("/tools/execute/"));
}
function browserEvents() {
  return events().filter(event => event.kind === "browser");
}
async function invoke(name: string, args: JsonObject = {}): Promise<ParsedResult> {
  const result = await client.callTool({ name, arguments: args }, CallToolResultSchema);
  const block = result.content.find(item => item.type === "text");
  if (!block || block.type !== "text") throw new Error("Missing text tool result");
  let body: JsonObject;
  try { body = JSON.parse(block.text); } catch { body = { error: block.text }; }
  return { isError: Boolean(result.isError), body, text: block.text };
}

beforeAll(async () => {
  // Never run against the installed integration or copy its OAuth state.
  const source = readFileSync(join(ROOT, "server.ts"), "utf8");
  const browserImport = 'from "node:child_process"';
  expect(source.split(browserImport)).toHaveLength(2);
  // Bun's built-in named exports cannot reliably be replaced with mock.module.
  // Replace this one dependency in the disposable copy, leaving all server
  // logic intact and making a real browser/process launch impossible.
  writeFileSync(join(directory, "server.ts"), source.replace(
    browserImport, `from ${JSON.stringify(join(ROOT, "tests", "mock-composio.ts"))}`,
  ));
  symlinkSync(join(ROOT, "node_modules"), join(directory, "node_modules"), "dir");
  setScenario();
  setState();
  writeFileSync(eventsPath, "");
  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--preload", join(ROOT, "tests", "mock-composio.ts"), join(directory, "server.ts")],
    cwd: directory,
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "",
      COMPOSIO_API_KEY: TEST_KEY,
      TODOIST_TEST_SCENARIO: scenarioPath,
      TODOIST_TEST_EVENTS: eventsPath,
    },
  });
  transport.stderr?.on("data", chunk => { stderr += String(chunk); });
  client = new Client({ name: "todoist-offline-tests", version: "1.0.0" });
  client.onerror = error => { protocolErrors.push(error); };
  // Emulate the VoiceOS notification request, including its failure mode.
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
  setScenario();
  setState();
  writeFileSync(eventsPath, "");
  notifications = [];
  protocolErrors = [];
  rejectNotification = false;
});

afterEach(() => {
  // Unexpected SDK requests must fail a test even if the server catches them.
  expect(events().filter(event => event.kind === "unexpected")).toEqual([]);
  expect(events().filter(event => event.kind === "version-check")).toEqual([]);
  expect(protocolErrors).toEqual([]);
});

afterAll(async () => {
  try { await client?.close(); } finally {
    await transport?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("manifest and MCP contract", () => {
  test("keeps MCP stdout clean when npm advertises a newer SDK", async () => {
    expect((await invoke("list_labels")).isError).toBe(false);
    expect((await invoke("list_projects")).isError).toBe(false);
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort())
      .toEqual([...EXPECTED_BUSINESS_TOOLS, ...EXPECTED_SETUP_TOOLS].sort());
    expect(protocolErrors).toEqual([]);
    expect(events().filter(event => event.kind === "version-check")).toEqual([]);
  });

  test("registers exactly the business tools and documented setup helpers", async () => {
    const expected = [...EXPECTED_BUSINESS_TOOLS, ...EXPECTED_SETUP_TOOLS].sort();
    const { tools } = await client.listTools();
    expect(tools.map(tool => tool.name).sort()).toEqual(expected);
    expect(manifest.tools.map((tool: JsonObject) => tool.name).sort()).toEqual(expected);
    for (const actual of tools) {
      const declared = manifest.tools.find((tool: JsonObject) => tool.name === actual.name);
      expect(actual.description?.length).toBeGreaterThan(0);
      expect(Object.keys(actual.inputSchema.properties ?? {}).sort()).toEqual(Object.keys(declared.inputSchema.properties).sort());
      expect([...(actual.inputSchema.required ?? [])].sort()).toEqual([...(declared.inputSchema.required ?? [])].sort());
    }
  });

  test("declares the required permissions and environment-based API key", () => {
    expect(manifest.permissions).toEqual([
      { kind: "network", domains: ["backend.composio.dev"] }, { kind: "background" }, { kind: "notify" },
    ]);
    expect(manifest.preferences).toContainEqual(expect.objectContaining({ name: "COMPOSIO_API_KEY", type: "password", required: true }));
    expect(manifest.summary.length).toBeLessThanOrEqual(140);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.tools.find((tool: JsonObject) => tool.name === "connect_account").execution.mode).toBe("sync");
  });

  test("documents each required secret without committing a value", () => {
    const example = readFileSync(join(ROOT, ".env.example"), "utf8");
    const entries = example.split("\n").filter(line => line && !line.startsWith("#"));
    const names = entries.map(line => line.split("=", 1)[0]);
    const required = manifest.preferences.filter((field: JsonObject) => field.type === "password")
      .map((field: JsonObject) => field.name);
    expect(names.sort()).toEqual(required.sort());
    for (const line of entries) expect(line.slice(line.indexOf("=") + 1)).toBe("");
  });

  test("declares complete confirmation cards for every action and none for reads", async () => {
    const { tools } = await client.listTools();
    const reads = tools.filter(tool => tool.annotations?.readOnlyHint).map(tool => tool.name);
    expect(reads.sort()).toEqual(["connection_status", "get_active_tasks", "get_productivity_stats", "list_labels", "list_projects", "list_sections"]);
    for (const tool of manifest.tools) expect(Boolean(tool.confirmation)).toBe(!reads.includes(tool.name));
    const confirmed = manifest.tools.filter((tool: JsonObject) => tool.confirmation);
    for (const tool of confirmed) {
      const actions = tool.confirmation.root.footer.flatMap((block: JsonObject) => block.items ?? []);
      expect(actions.map((action: JsonObject) => action.role).sort()).toEqual(["cancel", "confirm"]);
      for (const match of JSON.stringify(tool.confirmation).matchAll(/\{\{(\w+)\}\}/g)) {
        expect(tool.inputSchema.properties).toHaveProperty(match[1]);
      }
      if (tool.name.startsWith("delete_")) {
        const details = tool.confirmation.root.children[0].children.find((block: JsonObject) => block.type === "keyValue");
        expect(Array.isArray(details.rows)).toBe(true);
      }
    }
  });

  test("Delete Project confirms with the required project name", () => {
    const tool = manifest.tools.find((tool: JsonObject) => tool.name === "delete_project");
    expect(tool.inputSchema.required).toEqual(["project_id", "target_name"]);
    const details = tool.confirmation.root.children[0].children.find((block: JsonObject) => block.type === "keyValue");
    expect(details.rows).toEqual([{ label: "Name", value: "{{target_name}}" }]);
  });

  test("creation cards bind their editable name to the argument that executes", () => {
    for (const [name, argument] of [["create_task", "content"], ["create_project", "name"], ["create_section", "name"], ["create_label", "name"]]) {
      const tool = manifest.tools.find((tool: JsonObject) => tool.name === name);
      const nameField = tool.confirmation.root.children[0].children.find((block: JsonObject) => block.bind === `{{${argument}}}`);
      expect(nameField).toEqual({ type: "textField", bind: `{{${argument}}}`, label: "Name", required: true });
    }
  });

  test("creation color pickers match the colors accepted by the manifest and server", async () => {
    const { tools } = await client.listTools();
    for (const name of ["create_project", "create_label"]) {
      const tool = manifest.tools.find((tool: JsonObject) => tool.name === name);
      const picker = tool.confirmation.root.children[0].children.find((block: JsonObject) => block.bind === "{{color}}");
      const options = picker.options.map((option: JsonObject) => option.value);
      expect(tool.inputSchema.properties.color.enum).toEqual(options);
      expect(tools.find(tool => tool.name === name)?.inputSchema.properties?.color).toMatchObject({ enum: options });
    }
  });
});

const operationCases: [string, string, JsonObject, JsonObject][] = [
  ["create_task", "TODOIST_CREATE_TASK", { content: "Buy milk", due_date: "2026-11-02", priority: 3, project_id: "project_1", section_id: "section_1" }, { content: "Buy milk", due_date: "2026-11-02", priority: 3, project_id: "project_1", section_id: "section_1" }],
  ["update_task", "TODOIST_UPDATE_TASK", { task_id: "task_1", content: "Updated task", target_name: "Previous title" }, { task_id: "task_1", content: "Updated task" }],
  ["close_task", "TODOIST_CLOSE_TASK_V1", { task_id: "task_1", target_name: "Buy milk" }, { task_id: "task_1" }],
  ["get_active_tasks", "TODOIST_GET_ALL_TASKS", { filter: "today", limit: 2, cursor: "next_tasks" }, { filter: "today", limit: 2, cursor: "next_tasks" }],
  ["create_project", "TODOIST_CREATE_PROJECT2", { name: "Test project", is_favorite: false }, { name: "Test project", is_favorite: false }],
  ["delete_project", "TODOIST_DELETE_PROJECT2", { project_id: "project_1", target_name: "Home" }, { project_id: "project_1" }],
  ["create_section", "TODOIST_CREATE_SECTION_V1", { name: "Test section", project_id: "project_1" }, { name: "Test section", project_id: "project_1" }],
  ["delete_section", "TODOIST_DELETE_SECTION2", { section_id: "section_1", target_name: "Errands" }, { section_id: "section_1" }],
  ["list_projects", "TODOIST_GET_ALL_PROJECTS", {}, {}],
  ["list_sections", "TODOIST_LIST_SECTIONS", { project_id: "project_1" }, { project_id: "project_1" }],
  ["get_productivity_stats", "TODOIST_GET_PRODUCTIVITY_STATS", {}, {}],
  ["list_labels", "TODOIST_LIST_LABELS", { limit: 2, cursor: "next_labels" }, { limit: 2, cursor: "next_labels" }],
  ["create_label", "TODOIST_CREATE_LABEL_V1", { name: "test_label" }, { name: "test_label" }],
  ["update_label", "TODOIST_UPDATE_LABEL_V1_SECOND", { label_id: "label_1", target_name: "read", name: "renamed", is_favorite: false }, { label_id: "label_1", name: "renamed", is_favorite: false }],
  ["delete_label", "TODOIST_DELETE_LABEL_V1", { label_id: "label_1", target_name: "read" }, { label_id: "label_1" }],
];

describe("real server routing through the real Composio SDK", () => {
  test.each(operationCases)("%s uses %s with exact arguments", async (name, slug, args, expected) => {
    const result = await invoke(name, args);
    expect(result.body).toMatchObject({ success: true, operation: name });
    expect(result.isError).toBe(false);
    expect(result.body.operation).toBe(name);
    expect(operations()).toHaveLength(1);
    const call = operations()[0];
    expect(call.path).toEndWith("/" + slug);
    expect(call.body?.arguments).toEqual(expected);
    expect(call.body?.connected_account_id).toBe("ca_test");
    expect(call.body?.version).toBe("20260731_00");
    expect(browserEvents()).toHaveLength(0);
  });

  test("partial updates preserve labels and omit all unspecified fields", async () => {
    await invoke("update_task", { task_id: "task_1", labels: [] });
    expect(operations()[0].body?.arguments).toEqual({ task_id: "task_1", labels: [] });
  });

  test("passes typed color and favorites from edited confirmation fields", async () => {
    expect((await invoke("create_project", { name: "Launch", color: "red", is_favorite: "true" })).isError).toBe(false);
    expect((await invoke("create_label", { name: "Work", color: "blue", is_favorite: "false" })).isError).toBe(false);
    expect((await invoke("create_label", { name: "Personal", color: "" })).isError).toBe(false);
    expect(operations().map(call => call.body?.arguments)).toEqual([
      { name: "Launch", color: "red", is_favorite: true },
      { name: "Work", color: "blue", is_favorite: false },
      { name: "Personal" },
    ]);
  });

  test("saves edited descriptions and preserves label boundaries and explicit clearing", async () => {
    expect((await invoke("update_task", {
      task_id: "task_1", description: "Line one\nLine two", current_labels: ["Home, office"], labels: "Home, office\nWork",
    })).isError).toBe(false);
    expect((await invoke("update_task", { task_id: "task_1", labels: '["Home, office","Work"]' })).isError).toBe(false);
    expect((await invoke("update_task", { task_id: "task_1", labels: "[]" })).isError).toBe(false);
    expect((await invoke("update_task", {
      task_id: "task_1", due_date: "2026-11-13", clear_description: true,
    })).isError).toBe(false);
    expect((await invoke("update_task", { task_id: "task_1", description: "remove description" })).isError).toBe(false);
    expect((await invoke("update_task", { task_id: "task_1", description: "Only edit", labels: "" })).isError).toBe(false);
    expect((await invoke("update_task", { task_id: "task_1", labels: '["Work", 42]' })).isError).toBe(true);
    expect(operations().map(call => call.body?.arguments)).toEqual([
      { task_id: "task_1", description: "Line one\nLine two", labels: ["Home, office", "Work"] },
      { task_id: "task_1", labels: ["Home, office", "Work"] },
      { task_id: "task_1", labels: [] },
      { task_id: "task_1", due_date: "2026-11-13", description: "" },
      { task_id: "task_1", description: "remove description" },
      { task_id: "task_1", description: "Only edit" },
    ]);
  });

  test("label lookups need no arguments and send no write notification", async () => {
    const result = await invoke("list_labels");
    expect(result.isError).toBe(false);
    expect(result.body.labels).toEqual([{ id: "label_1", name: "read" }]);
    expect(operations()[0].body?.arguments).toEqual({});
    expect(notifications).toHaveLength(0);
  });

  test("label updates preserve false and zero without changing unspecified fields", async () => {
    const result = await invoke("update_label", { label_id: "label_1", is_favorite: false, order: 0 });
    expect(result.isError).toBe(false);
    expect(operations()[0].body?.arguments).toEqual({ label_id: "label_1", is_favorite: false, order: 0 });
    expect(notifications).toHaveLength(0);
  });
});

describe("validation before executing a Todoist operation", () => {
  test.each([
    ["create_task", { content: "   " }],
    ["create_task", { content: "Buy milk", priority: 5 }],
    ["create_task", { content: "Buy milk", due_date: "2026-11-02", due_string: "tomorrow" }],
    ["create_task", { content: "Buy milk", duration: 30 }],
    ["create_task", { content: "Buy milk", duration_unit: "minute" }],
    ["create_task", { content: "Buy milk", duration: 0, duration_unit: "minute" }],
    ["create_task", { content: "Buy milk", order: 0 }],
    ["update_task", { task_id: "task_1" }],
    ["update_task", { task_id: "task_1", target_name: "Display name only" }],
    ["update_task", { task_id: "task_1", clear_description: true, description: "Conflicting edit" }],
    ["update_task", { task_id: "task_1", due_date: "2026-11-13", description: "" }],
    ["update_task", { task_id: "task_1", description: "  " }],
    ["close_task", { task_id: " " }],
    ["create_project", { name: "" }],
    ["create_project", { name: "Launch", color: 41 }],
    ["delete_project", {}],
    ["delete_project", { project_id: "project_1" }],
    ["create_section", { name: "Section" }],
    ["delete_section", { section_id: " " }],
    ["list_labels", { action: "create" }],
    ["list_labels", { action: "update", label_id: "label_1" }],
    ["list_labels", { action: "create", name: "must not create" }],
    ["list_labels", { action: "update", label_id: "label_1", name: "must not update" }],
    ["create_label", {}],
    ["create_label", { name: " " }],
    ["create_label", { name: "Work", order: 2 }],
    ["create_label", { name: "Work", color: "Berry Red" }],
    ["update_label", { label_id: "label_1" }],
    ["update_label", { label_id: "label_1", target_name: "Display only" }],
    ["update_label", { label_id: " ", name: "renamed" }],
    ["list_labels", { action: "delete", label_id: "label_1" }],
    ["delete_label", {}],
    ["delete_label", { label_id: " " }],
    ["list_labels", { action: "list" }],
    ["list_labels", { name: "not a list parameter" }],
  ] satisfies [string, JsonObject][])("%s rejects invalid input %j", async (name, args) => {
    const result = await invoke(name, args);
    expect(result.isError).toBe(true);
    expect(operations()).toHaveLength(0);
    expect(browserEvents()).toHaveLength(0);
  });
});

describe("result data and native cards", () => {
  test.each([
    ["list_projects", "projects", "name"],
    ["list_sections", "sections", "name"],
    ["get_active_tasks", "tasks", "content"],
    ["list_labels", "labels", "name"],
  ])("%s retains full results and pagination while limiting the card", async (name, entity, titleField) => {
    const items = Array.from({ length: 8 }, (_, index) => ({ id: `id_${index}`, [titleField]: "x".repeat(80) }));
    setScenario({ responseData: { results: items, next_cursor: "page_two" } });
    const result = await invoke(name);
    expect(result.isError).toBe(false);
    expect(result.body[entity]).toEqual(items);
    expect(result.body.next_cursor).toBe("page_two");
    const blocks = result.body._voiceos_glance.blocks;
    expect(blocks).toHaveLength(3);
    expect(blocks.find((block: JsonObject) => block.type === "list").rows).toHaveLength(6);
    for (const row of blocks[1].rows) {
      expect(row.title.length).toBeLessThanOrEqual(60);
      expect(row).not.toHaveProperty("subtitle");
    }
    expect(notifications).toHaveLength(0);
  });

  test.each([
    ["list_projects", [{ id: "p_1", name: "Home", is_favorite: true }, { id: "p_2" }],
      [{ title: "Home", subtitle: "Favorite" }, { title: "Item" }]],
    ["list_labels", [{ id: "l_1", name: "Read", is_favorite: true }, { id: "l_2", name: "Work" }],
      [{ title: "Read", subtitle: "Favorite" }, { title: "Work" }]],
    ["get_active_tasks", [
      { id: "t_1", content: "Send notes", due: { date: "2026-11-13" } },
      { id: "t_2", content: "Start draft", due: null },
      { id: "t_3", content: "Review", due: { date: "2026-11-14T02:00:00Z", timezone: "America/Chicago" } },
    ], [
      { title: "Send notes", subtitle: "Due Fri, Nov 13, 2026" },
      { title: "Start draft" },
      { title: "Review", subtitle: "Due Fri, Nov 13, 2026" },
    ]],
  ] as [string, JsonObject[], JsonObject[]][])("%s shows useful details in the card", async (name, items, rows) => {
    setScenario({ responseData: { results: items } });
    const result = await invoke(name);
    expect(result.body._voiceos_glance.blocks[1].rows).toEqual(rows);
  });

  test("returns a successful empty list and an explicit empty card", async () => {
    setScenario({ responseData: { results: [] } });
    const result = await invoke("get_active_tasks");
    expect(result.isError).toBe(false);
    expect(result.body.tasks).toEqual([]);
    expect(result.body._voiceos_glance.blocks[1].pairs).toContainEqual(["Results", "No items returned"]);
  });

  test("unwraps nested list responses without dropping the outer cursor", async () => {
    setScenario({ responseData: { data: { projects: [{ id: "p", name: "Home" }] }, next_cursor: "outer_cursor" } });
    const result = await invoke("list_projects");
    expect(result.body.projects).toEqual([{ id: "p", name: "Home" }]);
    expect(result.body.next_cursor).toBe("outer_cursor");
  });

  test("rejects malformed lists instead of reporting no tasks", async () => {
    setScenario({ responseData: { unexpected: true } });
    const result = await invoke("get_active_tasks");
    expect(result.isError).toBe(true);
    expect(result.body.error).toContain("Unexpected list response");
    expect(result.body.tasks).toBeUndefined();
  });

  test("preserves zero productivity values", async () => {
    setScenario({ responseData: { karma: 0, completed_count: 0 } });
    const result = await invoke("get_productivity_stats");
    expect(result.body._voiceos_glance.blocks[1].items).toEqual([
      { label: "Karma", value: "0" }, { label: "Completed", value: "0" },
    ]);
  });
});

describe("failures, notifications, and credential redaction", () => {
  test("reports provider failure without per-write notification", async () => {
    setScenario({ operationError: "Todoist rejected this project name" });
    const result = await invoke("create_project", { name: "Test project" });
    expect(result.isError).toBe(true);
    expect(result.body.error).toContain("Todoist rejected");
    expect(result.body.success).toBeUndefined();
    expect(notifications).toHaveLength(0);
  });

  test("successful writes send no per-write notification", async () => {
    const result = await invoke("create_task", { content: "Buy milk" });
    expect(result.isError).toBe(false);
    expect(notifications).toHaveLength(0);
  });

  test("background watcher surfaces connect completion notification when browser approval finishes", async () => {
    setState({ userId: ACTIVE_STATE.userId });
    setScenario({ accountStatus: "INITIATED", activateAfterBrowser: true, watchBackgroundConnect: true, pollIntervalMs: 20 });
    const started = await invoke("connect_account");
    expect(started.body.connected).toBe(false);
    expect(started.body.status).toBe("Authorization pending");
    await Bun.sleep(100);
    expect(notifications).toEqual([{ message: "Todoist — Connected successfully. Your account is ready to use.", speak: false }]);
    expect(savedState()).toEqual({ userId: ACTIVE_STATE.userId, accountId: "ca_pending" });
  });

  test("notification failure preserves background connect completion", async () => {
    setState({ userId: ACTIVE_STATE.userId });
    setScenario({ accountStatus: "INITIATED", activateAfterBrowser: true, watchBackgroundConnect: true, pollIntervalMs: 20 });
    rejectNotification = true;
    const started = await invoke("connect_account");
    expect(started.body.connected).toBe(false);
    await Bun.sleep(100);
    expect(savedState()).toEqual({ userId: ACTIVE_STATE.userId, accountId: "ca_pending" });
  });

  test("background watcher surfaces failure notification when authorization fails", async () => {
    setState({ userId: ACTIVE_STATE.userId });
    setScenario({ accountStatus: "INITIATED", oauthStatuses: ["FAILED"], watchBackgroundConnect: true, pollIntervalMs: 20 });
    const started = await invoke("connect_account");
    expect(started.body.connected).toBe(false);
    await Bun.sleep(100);
    expect(notifications).toEqual([{ message: "Todoist — Authorization failed. Say \"connect me to Todoist\" to try again.", speak: false }]);
  });

  test("a timed-out write has an uncertain outcome and sends no per-write notification", async () => {
    setScenario({ operationTimeout: true });
    const result = await invoke("create_task", { content: "Buy milk" });
    expect(result.isError).toBe(true);
    expect(result.body.code).toBe("OUTCOME_UNKNOWN");
    expect(result.body.error).toContain("check Todoist before retrying");
    expect(operations()).toHaveLength(1);
    expect(notifications).toHaveLength(0);
    expect(browserEvents()).toHaveLength(0);
  });

  test("a timed-out read gives retry guidance without a write notification", async () => {
    setScenario({ operationTimeout: true });
    const result = await invoke("get_active_tasks");
    expect(result.isError).toBe(true);
    expect(result.body.error).toContain("Try the read request again");
    expect(notifications).toHaveLength(0);
  });

  test("redacts the configured API key and URLs from errors and notifications", async () => {
    setScenario({ operationError: `Provider failure: ${TEST_KEY} https://example.com/sensitive-link` });
    const result = await invoke("create_task", { content: "Buy milk" });
    const output = result.text + JSON.stringify(notifications) + stderr;
    expect(output).not.toContain(TEST_KEY);
    expect(output).not.toContain("https://example.com/sensitive-link");
    expect(result.body.error).toContain("[redacted]");
    expect(result.body.error).toContain("[link redacted]");
  });
});

describe("account state and explicit OAuth setup", () => {
  test.each([
    ["EXPIRED", "AUTH_EXPIRED"], ["REVOKED", "AUTH_REVOKED"],
    ["INITIATED", "AUTH_PENDING"], ["INITIALIZING", "AUTH_PENDING"], ["INACTIVE", "AUTH_INACTIVE"],
  ])("blocks task execution when account state is %s", async (status, code) => {
    setScenario({ accountStatus: status });
    const result = await invoke("get_active_tasks");
    expect(result.isError).toBe(true);
    expect(result.body.code).toBe(code);
    expect(operations()).toHaveLength(0);
    expect(browserEvents()).toHaveLength(0);
  });

  test("disabled and removed accounts have actionable errors", async () => {
    setScenario({ accountDisabled: true });
    expect((await invoke("get_active_tasks")).body.code).toBe("AUTH_DISABLED");
    setScenario({ accountHttpStatus: 404 });
    expect((await invoke("get_active_tasks")).body.code).toBe("NOT_CONNECTED");
    expect(operations()).toHaveLength(0);
  });

  test("distinguishes a rejected Composio key from expired Todoist authorization", async () => {
    setScenario({ accountHttpStatus: 401 });
    const result = await invoke("get_active_tasks");
    expect(result.body.code).toBe("API_KEY_REJECTED");
    expect(result.body.reconnectRequired).toBe(false);
    expect(browserEvents()).toHaveLength(0);
  });

  test("persists rejected OAuth state and blocks subsequent execution", async () => {
    setScenario({ operationError: "OAuth token expired" });
    expect((await invoke("get_active_tasks")).body.code).toBe("AUTH_EXPIRED");
    expect(savedState().needsReauthorization).toBe(true);
    setScenario();
    expect((await invoke("get_active_tasks")).body.code).toBe("AUTH_REJECTED");
    expect(operations()).toHaveLength(1);
    expect(browserEvents()).toHaveLength(0);
  });

  test("status is read-only and reports a disconnected account without starting OAuth", async () => {
    setState({ userId: ACTIVE_STATE.userId });
    const result = await invoke("connection_status");
    expect(result.isError).toBe(false);
    expect(result.body.connected).toBe(false);
    expect(events()).toEqual([]);
    expect(notifications).toHaveLength(0);
  });

  test("connect reuses an active account without opening a browser", async () => {
    const result = await invoke("connect_account");
    expect(result.body.connected).toBe(true);
    expect(savedState()).toEqual(ACTIVE_STATE);
    expect(browserEvents()).toHaveLength(0);
    expect(events().some(event => event.path?.includes("tool_router"))).toBe(false);
  });

  test("explicit connect completes mocked OAuth and stores only connection references", async () => {
    setState({ userId: ACTIVE_STATE.userId });
    setScenario({ accountStatus: "INITIATED" });
    const result = await invoke("connect_account");
    expect(result.body.connected).toBe(false);
    expect(result.body.status).toBe("Authorization pending");
    expect(result.body.authorizationUrl).toBe("https://example.invalid/authorize");
    expect(browserEvents()).toEqual([{ kind: "browser", url: "https://example.invalid/authorize" }]);
    expect(savedState()).toEqual({ userId: ACTIVE_STATE.userId, pending: { id: "ca_pending", url: "https://example.invalid/authorize" } });
    const link = events().find(event => event.path?.endsWith("/link"));
    expect(link?.body).toEqual({ toolkit: "todoist" });
  });

  test("verifies browser approval on the next Connect without reopening authorization", async () => {
    setState({ userId: ACTIVE_STATE.userId });
    setScenario({ accountStatus: "INITIATED", activateAfterBrowser: true });
    const started = await invoke("connect_account");
    expect(started.body.connected).toBe(false);
    expect(started.body.status).toBe("Authorization pending");
    const verified = await invoke("connect_account");
    expect(verified.isError).toBe(false);
    expect(verified.body.connected).toBe(true);
    expect(savedState()).toEqual({ userId: ACTIVE_STATE.userId, accountId: "ca_pending" });
    expect(browserEvents()).toHaveLength(1);
    expect(events().filter(event => event.path?.endsWith("/link"))).toHaveLength(1);
  });

  test("concurrent connects share one browser authorization attempt", async () => {
    setState({ userId: ACTIVE_STATE.userId });
    setScenario({ accountStatus: "INITIATED" });
    const results = await Promise.all([invoke("connect_account"), invoke("connect_account")]);
    expect(results.every(result => !result.isError && !result.body.connected && result.body.status === "Authorization pending")).toBe(true);
    expect(browserEvents()).toHaveLength(1);
    expect(events().filter(event => event.path?.endsWith("/link"))).toHaveLength(1);
  });

  test("creates a fresh authorization link if unapproved pending authorization is reconnected", async () => {
    setState({ userId: ACTIVE_STATE.userId, pending: { id: "ca_old", url: "https://example.invalid/old-consumed-consent" } });
    setScenario({ accountStatus: "INITIATED" });
    const result = await invoke("connect_account");
    expect(result.body.connected).toBe(false);
    expect(result.body.status).toBe("Authorization pending");
    expect(result.body.authorizationUrl).toBe("https://example.invalid/authorize");
    expect(browserEvents()[0].url).toBe("https://example.invalid/authorize");
    expect(savedState().pending?.id).toBe("ca_pending");
    expect(events().some(event => event.path?.endsWith("/link"))).toBe(true);
  });

  test.each(["FAILED", "EXPIRED", "REVOKED"])("starts a new authorization when pending state is %s", async status => {
    setState({ userId: ACTIVE_STATE.userId, pending: { id: "ca_old", url: "https://example.invalid/old" } });
    setScenario({ accountStatus: status });
    const result = await invoke("connect_account");
    expect(result.isError).toBe(false);
    expect(result.body.connected).toBe(false);
    expect(result.body.status).toBe("Authorization pending");
    expect(savedState().pending?.id).toBe("ca_pending");
    expect(events().some(event => event.path?.endsWith("/link"))).toBe(true);
  });

  test("new authorization returns an actionable pending result without waiting for browser approval", async () => {
    setState({ userId: ACTIVE_STATE.userId });
    setScenario({ accountStatus: "INITIATED" });
    const start = performance.now();
    const result = await invoke("connect_account");
    expect(performance.now() - start).toBeLessThan(1000);
    expect(result.isError).toBe(false);
    expect(result.body).toMatchObject({
      connected: false,
      status: "Authorization pending",
      authorizationUrl: "https://example.invalid/authorize",
    });
    expect(result.body.message).toContain("check connection status");
    expect(savedState().pending.id).toBe("ca_pending");
    expect(events().filter(event => /\/connected_accounts\//.test(event.path ?? ""))).toEqual([]);
    expect(manifest.tools.find((tool: JsonObject) => tool.name === "connect_account").execution.mode).toBe("sync");
  });

  test("a stalled pending lookup times out and preserves the connection for recovery", async () => {
    const state = { userId: ACTIVE_STATE.userId, pending: { id: "ca_pending", url: "https://example.invalid/saved-consent" } };
    setState(state);
    setScenario({ accountStatus: "INITIATED", stallPendingLookup: true });
    const result = await invoke("connect_account");
    expect(result.isError).toBe(true);
    expect(result.body.error).toMatch(/timeout|timed out|abort/i);
    expect(events().filter(event => event.kind === "lookup-aborted")).toHaveLength(1);
    expect(savedState()).toEqual(state);
    expect(browserEvents()).toHaveLength(0);
    expect(events().some(event => event.path?.includes("tool_router"))).toBe(false);
    expect(operations()).toHaveLength(0);
  }, 15000);

  test("a non-HTTPS authorization URL is rejected before opening a browser", async () => {
    setState({ userId: ACTIVE_STATE.userId });
    setScenario({ redirectUrl: "http://example.invalid/authorize" });
    const result = await invoke("connect_account");
    expect(result.isError).toBe(true);
    expect(browserEvents()).toHaveLength(0);
    expect(savedState().pending).toBeUndefined();
  });

  test("a browser failure preserves the pending connection for recovery", async () => {
    setState({ userId: ACTIVE_STATE.userId });
    setScenario({ browserError: true });
    const result = await invoke("connect_account");
    expect(result.isError).toBe(true);
    expect(savedState().pending.id).toBe("ca_pending");
    expect(savedState().accountId).toBeUndefined();
  });

  test("disconnect revokes only the saved connection and preserves installation identity", async () => {
    const result = await invoke("disconnect_account");
    expect(result.isError).toBe(false);
    expect(result.body.connected).toBe(false);
    expect(result.body.providerRevoked).toBe(true);
    expect(savedState()).toEqual({ userId: ACTIVE_STATE.userId });
    expect(events().filter(event => event.path?.endsWith("/revoke")).map(event => event.path)).toEqual(["/api/v3.1/connected_accounts/ca_test/revoke"]);
    expect(operations()).toHaveLength(0);
  });

  test("unsupported revocation disables the connection and explains provider consent", async () => {
    setScenario({ revokeHttpStatus: 400 });
    const result = await invoke("disconnect_account");
    expect(result.isError).toBe(false);
    expect(result.body.providerRevoked).toBe(false);
    expect(result.body.message).toContain("remove provider consent");
    expect(events().some(event => event.method === "PATCH")).toBe(true);
    expect(savedState()).toEqual({ userId: ACTIVE_STATE.userId });
  });

  test("failed disconnect preserves saved connection references", async () => {
    setScenario({ revokeHttpStatus: 403 });
    const result = await invoke("disconnect_account");
    expect(result.isError).toBe(true);
    expect(savedState()).toEqual(ACTIVE_STATE);
    expect(operations()).toHaveLength(0);
  });

  test("never accepts another provider's connection as Todoist", async () => {
    setScenario({ accountToolkit: "github" });
    expect((await invoke("get_active_tasks")).isError).toBe(true);
    expect((await invoke("disconnect_account")).isError).toBe(true);
    expect(events().some(event => event.path?.endsWith("/revoke"))).toBe(false);
    expect(operations()).toHaveLength(0);
  });
});
