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
  "close_task", "create_project", "create_section", "create_task", "delete_project",
  "delete_section", "delete_label", "get_active_tasks", "get_productivity_stats", "list_projects",
  "list_sections", "manage_labels", "update_task",
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
  rejectNotification = false;
});

afterEach(() => {
  // Unexpected SDK requests must fail a test even if the server catches them.
  expect(events().filter(event => event.kind === "unexpected")).toEqual([]);
});

afterAll(async () => {
  try { await client?.close(); } finally {
    await transport?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("manifest and MCP contract", () => {
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
    expect(manifest.tools.find((tool: JsonObject) => tool.name === "connect_account").execution.mode).toBe("background");
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

  test("declares complete confirmation cards for project, section, and label deletion", () => {
    const confirmed = manifest.tools.filter((tool: JsonObject) => tool.confirmation);
    expect(confirmed.map((tool: JsonObject) => tool.name).sort()).toEqual(["delete_label", "delete_project", "delete_section"]);
    for (const tool of confirmed) {
      const actions = tool.confirmation.root.footer.flatMap((block: JsonObject) => block.items ?? []);
      expect(actions.map((action: JsonObject) => action.role).sort()).toEqual(["cancel", "confirm"]);
      for (const match of JSON.stringify(tool.confirmation).matchAll(/\{\{(\w+)\}\}/g)) {
        expect(tool.inputSchema.properties).toHaveProperty(match[1]);
      }
      const details = tool.confirmation.root.children.find((block: JsonObject) => block.type === "keyValue");
      expect(Array.isArray(details.rows)).toBe(true);
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
  ["manage_labels", "TODOIST_LIST_LABELS", { action: "list" }, {}],
  ["manage_labels", "TODOIST_CREATE_LABEL_V1", { action: "create", name: "test_label" }, { name: "test_label" }],
  ["manage_labels", "TODOIST_UPDATE_LABEL_V1_SECOND", { action: "update", label_id: "label_1", name: "renamed", is_favorite: false }, { label_id: "label_1", name: "renamed", is_favorite: false }],
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
    ["close_task", { task_id: " " }],
    ["create_project", { name: "" }],
    ["delete_project", {}],
    ["create_section", { name: "Section" }],
    ["delete_section", { section_id: " " }],
    ["manage_labels", { action: "create" }],
    ["manage_labels", { action: "update", label_id: "label_1" }],
    ["manage_labels", { action: "delete", label_id: "label_1" }],
    ["delete_label", {}],
    ["delete_label", { label_id: " " }],
    ["manage_labels", { action: "list", name: "not a list parameter" }],
    ["manage_labels", { action: "unsupported" }],
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
    ["manage_labels", "labels", "name"],
  ])("%s retains full results and pagination while limiting the card", async (name, entity, titleField) => {
    const items = Array.from({ length: 8 }, (_, index) => ({ id: `id_${index}`, [titleField]: "x".repeat(80) }));
    setScenario({ responseData: { results: items, next_cursor: "page_two" } });
    const result = await invoke(name, name === "manage_labels" ? { action: "list" } : {});
    expect(result.isError).toBe(false);
    expect(result.body[entity]).toEqual(items);
    expect(result.body.next_cursor).toBe("page_two");
    const blocks = result.body._voiceos_glance.blocks;
    expect(blocks).toHaveLength(3);
    expect(blocks.find((block: JsonObject) => block.type === "list").rows).toHaveLength(6);
    for (const row of blocks[1].rows) expect(row.title.length).toBeLessThanOrEqual(60);
    expect(notifications).toHaveLength(0);
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
  test("reports provider failure and sends an error notification", async () => {
    setScenario({ operationError: "Todoist rejected this project name" });
    const result = await invoke("create_project", { name: "Test project" });
    expect(result.isError).toBe(true);
    expect(result.body.error).toContain("Todoist rejected");
    expect(result.body.success).toBeUndefined();
    expect(notifications).toHaveLength(1);
    expect(notifications[0].message).toContain("failed");
    expect(result.body.notificationQueued).toBe(true);
  });

  test("successful writes send one success notification", async () => {
    const result = await invoke("create_task", { content: "Buy milk" });
    expect(result.isError).toBe(false);
    expect(notifications).toEqual([{ message: "Todoist — Create task completed.", speak: false }]);
    expect(result.body.notificationQueued).toBe(true);
  });

  test("notification failure preserves a successful write", async () => {
    rejectNotification = true;
    const result = await invoke("create_task", { content: "Buy milk" });
    expect(result.isError).toBe(false);
    expect(result.body.success).toBe(true);
    expect(result.body.notificationQueued).toBe(false);
    expect(operations()).toHaveLength(1);
  });

  test("a timed-out write has an uncertain outcome and is never replayed", async () => {
    setScenario({ operationTimeout: true });
    const result = await invoke("create_task", { content: "Buy milk" });
    expect(result.isError).toBe(true);
    expect(result.body.code).toBe("OUTCOME_UNKNOWN");
    expect(result.body.error).toContain("check Todoist before retrying");
    expect(operations()).toHaveLength(1);
    expect(notifications[0].message).toContain("outcome unconfirmed");
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
    setScenario({ accountStatus: "INITIATED", activateAfterBrowser: true });
    const result = await invoke("connect_account");
    expect(result.body).toMatchObject({ connected: true });
    expect(result.body.connected).toBe(true);
    expect(browserEvents()).toEqual([{ kind: "browser", url: "https://example.invalid/authorize" }]);
    expect(savedState()).toEqual({ userId: ACTIVE_STATE.userId, accountId: "ca_pending" });
    const link = events().find(event => event.path?.endsWith("/link"));
    expect(link?.body).toEqual({ toolkit: "todoist" });
  });

  test("concurrent connects share one browser authorization attempt", async () => {
    setState({ userId: ACTIVE_STATE.userId });
    setScenario({ accountStatus: "INITIATED", activateAfterBrowser: true });
    const results = await Promise.all([invoke("connect_account"), invoke("connect_account")]);
    expect(results.every(result => !result.isError && result.body.connected)).toBe(true);
    expect(browserEvents()).toHaveLength(1);
    expect(events().filter(event => event.path?.endsWith("/link"))).toHaveLength(1);
  });

  test("pending authorization is reused instead of creating another session", async () => {
    setState({ userId: ACTIVE_STATE.userId, pending: { id: "ca_pending", url: "https://example.invalid/saved-consent" } });
    setScenario({ accountStatus: "INITIATED", activateAfterBrowser: true });
    const result = await invoke("connect_account");
    expect(result.body).toMatchObject({ connected: true });
    expect(browserEvents()[0].url).toBe("https://example.invalid/saved-consent");
    expect(events().some(event => event.path?.includes("tool_router"))).toBe(false);
  });

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
