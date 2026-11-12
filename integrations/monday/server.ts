import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Composio } from "@composio/core";
import { z } from "zod";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

const server = new McpServer({ name: "composio-monday", version: "0.1.3" });
const stateFile = new URL("./.composio-auth.json", import.meta.url);
const stateSchema = z
  .object({
    userId: z.string().startsWith("voiceos-monday-"),
    accountId: z.string().min(1).optional(),
    pending: z
      .object({
        id: z.string().min(1),
        url: z.string().url().startsWith("https://"),
      })
      .optional(),
  })
  .strict();
type State = z.infer<typeof stateSchema>;
type Output = {
  connected: boolean;
  status: string;
  message: string;
  authorizationUrl?: string;
  providerRevoked?: boolean;
};
type ReadOutput = {
  resultType: "boards" | "tasks" | "board_choices";
  boardName?: string;
  groupName?: string;
  itemName?: string;
  pending_item?: { draft_id: string; item_name: string };
  status: string;
  message: string;
  records: Record<string, unknown>[];
  pagination: Record<string, unknown>;
};
const mondayVersion = "20261101_00";
const readActions = [
  "MONDAY_BOARDS",
  "MONDAY_GET_ITEMS",
  "MONDAY_ITEMS_PAGE",
  "MONDAY_LIST_GROUPS",
  "MONDAY_COLUMNS",
  "MONDAY_LIST_USERS",
  "MONDAY_GET_TEAMS",
] as const;
const writeActions = ["MONDAY_CREATE_ITEM", "MONDAY_UPDATE_ITEM", "MONDAY_CREATE_UPDATE", "MONDAY_CREATE_BOARD"] as const;
const approvedActions = [...readActions, ...writeActions];
type Action = (typeof approvedActions)[number];
type WriteOutput = { status: string; message: string; id: string; completedColumns?: string[] };
const id = () => z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ids = () => z.array(id()).min(1).max(100);
const nonempty = () => z.string().trim().min(1);
const columnValues = () => z.union([z.string(), z.record(z.unknown())]);
const itemName = () => nonempty().max(256);
const draftId = () => z.string().uuid();
const prepareCreateItemSchema = z.object({
  board_id: id().optional(),
  board_name: nonempty().max(256).optional(),
  item_name: itemName().optional(),
  group_id: nonempty().optional(),
  column_values: columnValues().optional(),
  replaces_draft_id: draftId().optional(),
  revises_item_name: itemName().optional(),
}).strict();
const createItemPreview = z.object({
  board: z.string(),
  groups: z.array(z.object({ id: z.string(), label: z.string() }).strict()),
  columns: z.array(z.object({ label: z.string(), value: z.string() }).strict()),
}).strict();
const createItemSchema = z.object({
  draft_id: draftId(),
  item_name: itemName(),
  group_id: nonempty(),
  preview: createItemPreview,
}).strict();
type CreateItemPreview = z.infer<typeof createItemPreview>;
type CreateItemInput = z.infer<typeof prepareCreateItemSchema>;
type CreateItemDraft = {
  preview?: CreateItemPreview;
  args?: { board_id: string; column_values?: string };
  itemName: string;
  groupTitle?: string;
  columns: Record<string, unknown>;
  columnTitles?: Record<string, string>;
  columnTypes?: Record<string, unknown>;
  carriedByTitle?: boolean;
  carriedGroupByTitle?: boolean;
  retired?: boolean;
  accountId: string;
  expires: number;
};
type PrepareCreateItemOutput = {
  status: string;
  message: string;
  create_item_arguments?: z.infer<typeof createItemSchema>;
  board?: { name: string; groups: Record<string, unknown>[]; columns: Record<string, unknown>[] };
};
const createItemDrafts = new Map<string, CreateItemDraft>();
const prepareCreateItemDescription = "Start every Monday item creation here. A follow-up such as 'change the board to voiceos' after a Create item card means change the pending item's destination. For that correction, call this tool with the new board_name and replaces_draft_id. If the pending ID is missing from the context, pass revises_item_name with the exact pending item's name from this conversation. If neither is known, ask which pending item should go on the requested board. Board renaming is unavailable. Omitted group and column arguments are carried over on a revision; ask if a requested value cannot be matched. For a new item, pass item_name and the board the user specified in the request, including a clear reference such as 'that board'. Use board_name or a verified board_id. If the user did not specify a destination, omit both board fields and ask the user to choose. Do not infer a destination from past requests or board lists. If the result is board_choices, ask its question as the final response for that turn and wait for the user to say or type a board name. This is a clarification, so do not open a confirmation yet. A bare board name after that question answers it, even if the reply contains no verb. Call prepare_create_item again with that board_name and pending_item.draft_id as replaces_draft_id, or use revises_item_name with pending_item.item_name if the draft ID is unavailable. Do not list boards or items in response to that choice. Once preparation returns create_item_arguments, call create_item for confirmation. This tool only reads Monday. With a resolved board and without item_name or a revision, it returns groups and columns. Pass optional group_id (ID or title; omit for the top group) and only requested column_values keyed by actual column ID or exact title. Use exact status labels, ISO dates, and Monday person names or IDs. Pass create_item_arguments verbatim to create_item. Never silently drop a requested value.";
const createItemDescription = "Use create_item_arguments from prepare_create_item verbatim. The confirmation lets the user edit the item name and choose a group on the selected board. Approval creates the item in the selected group. Never say an item was created unless the result confirms its ID. For a voice revision such as 'change the board to voiceos', call prepare_create_item with the new board_name and replaces_draft_id or the pending item's exact name in revises_item_name. Ask about any previously requested value with no clear match. Board renaming is unavailable. Do not retry a write automatically.";
const updateItemValuesSchema = z.object({ board_id: id(), item_id: id(), column_values: columnValues() }).strict();
const createUpdateSchema = z.object({ item_id: id(), body: nonempty() }).strict();
const createBoardSchema = z.object({ board_name: nonempty(), board_kind: z.enum(["public", "private", "share"]), workspace_id: id().optional(), folder_id: id().optional(), description: nonempty().optional() }).strict();
const getBoardsSchema = z
  .object({
    ids: ids().optional(),
    page: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    state: z.enum(["active", "archived", "deleted", "all"]).optional(),
    board_kind: z.enum(["private", "public", "share"]).optional(),
    workspace_ids: ids().optional(),
  })
  .strict();
const getItemsSchema = z
  .object({
    ids: ids().optional(),
    board_id: id().optional(),
    board_name: z.string().trim().min(1).max(256).describe("Exact board name from a prior get_boards result, for display only. Never invent a name or use it instead of board_id. May be carried forward with a cursor.").optional(),
    cursor: z.string().trim().min(1).optional(),
    group_id: z.string().trim().min(1).optional(),
    page: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(100).optional(),
    newest_first: z.boolean().optional(),
    exclude_nonactive: z.boolean().optional(),
  })
  .strict();
let client: Composio | undefined;
let connecting: Promise<Output> | undefined;
let disconnecting: Promise<Output> | undefined;
let activeConnectWatcher: AbortController | undefined;

function stopBackgroundConnectWatcher() {
  if (activeConnectWatcher) {
    activeConnectWatcher.abort();
    activeConnectWatcher = undefined;
  }
}

function shouldWatchBackgroundConnect(): boolean {
  if (!process.env.MONDAY_TEST_SCENARIO) return true;
  try {
    const scenario = JSON.parse(
      readFileSync(process.env.MONDAY_TEST_SCENARIO, "utf8"),
    );
    return Boolean(scenario.watchBackgroundConnect);
  } catch {
    return false;
  }
}

function getPollIntervalMs(): number {
  if (!process.env.MONDAY_TEST_SCENARIO) return 2000;
  try {
    const scenario = JSON.parse(
      readFileSync(process.env.MONDAY_TEST_SCENARIO, "utf8"),
    );
    return scenario.pollIntervalMs ?? 50;
  } catch {
    return 50;
  }
}

async function notify(message: string) {
  try {
    await server.server.request(
      {
        method: "voiceos/reminders/trigger",
        params: { message: message.slice(0, 1900), speak: false },
      },
      z.object({ notificationId: z.string() }),
      { timeout: 4000 },
    );
    return true;
  } catch {
    console.error(
      "VoiceOS could not queue the Monday.com notification; the tool result is still available.",
    );
    return false;
  }
}

function startBackgroundConnectWatcher(connectionId: string) {
  if (!shouldWatchBackgroundConnect()) return;
  stopBackgroundConnectWatcher();
  const controller = new AbortController();
  activeConnectWatcher = controller;
  const pollIntervalMs = getPollIntervalMs();

  (async () => {
    const startTime = Date.now();
    // Poll for up to 180 seconds (3 minutes)
    while (!controller.signal.aborted && Date.now() - startTime < 180000) {
      await delay(pollIntervalMs);
      if (controller.signal.aborted) break;
      try {
        const savedAccount = await api().connectedAccounts.get(connectionId, {
          signal: AbortSignal.timeout(5000),
        });
        if (savedAccount?.status === "ACTIVE" && !savedAccount.isDisabled) {
          const state = await load();
          if (state.pending?.id === connectionId) {
            state.accountId = connectionId;
            delete state.pending;
            await save(state);
            await notify(
              "Monday.com — Connected successfully. Your account is ready to use.",
            );
          }
          break;
        }
        if (["FAILED", "EXPIRED", "REVOKED"].includes(savedAccount?.status)) {
          break;
        }
      } catch {
        // Continue polling until timeout or aborted
      }
    }
  })().catch(() => {});
}

function api() {
  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey)
    throw new Error("Add your Composio API key in Monday.com settings first.");
  return (client ??= new Composio({
    apiKey,
    baseURL: "https://backend.composio.dev",
    allowTracking: false,
    disableVersionCheck: true,
  }));
}

// Composio holds provider tokens. Only this installation's identity and connection references are saved locally.
async function save(state: State) {
  const temporary = new URL(
    `./.composio-auth.${randomUUID()}.tmp`,
    import.meta.url,
  );
  await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temporary, stateFile);
}

async function load(): Promise<State> {
  let text: string;
  try {
    text = await readFile(stateFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const state = { userId: `voiceos-monday-${randomUUID()}` };
    await save(state);
    return state;
  }
  const parsed = stateSchema.safeParse(JSON.parse(text));
  if (!parsed.success)
    throw new Error(
      "Invalid local Monday.com connection state. Restore or reset .composio-auth.json before reconnecting.",
    );
  return parsed.data;
}

function httpStatus(error: unknown): number | undefined {
  const value = error as { status?: number; cause?: { status?: number } };
  return value?.status ?? value?.cause?.status;
}

async function account(id: string, signal = AbortSignal.timeout(8000)) {
  try {
    const saved = await api().connectedAccounts.get(id, { signal });
    if (saved.toolkit.slug !== "monday")
      throw new Error(
        "Refusing to use a saved connection that is not Monday.com.",
      );
    return saved;
  } catch (error) {
    if (httpStatus(error) === 404) return undefined;
    if (httpStatus(error) === 401)
      throw new Error(
        "Composio rejected your API key. Update it in Monday.com settings; reconnecting alone will not fix the key.",
      );
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function providerError(message: string): Error {
  if (
    /token.*(expired|invalid|revoked)|(?:expired|invalid|revoked).*token|not authenticated|unauthorized|NOT_AUTHENTICATED|USER_UNAUTHORIZED/i.test(
      message,
    )
  ) {
    return new Error(
      "Monday.com authorization is no longer valid. Run Connect Monday.com again to authorize.",
    );
  }
  return new Error(`Monday.com request failed: ${message}`);
}

async function executeAction(action: Action, args: Record<string, unknown>, expectedAccountId?: string) {
  if (!approvedActions.includes(action))
    throw new Error("This Monday.com operation is not approved.");
  if (disconnecting)
    throw new Error(
      "Monday.com is disconnecting. Wait for it to finish before making another request.",
    );
  const signal = AbortSignal.timeout(20000);
  const state = await load();
  if (!state.accountId)
    throw new Error(
      "Monday.com is not connected. Run Connect Monday.com to authorize or verify browser approval.",
    );
  if (expectedAccountId && state.accountId !== expectedAccountId)
    throw new Error("The connected Monday.com account changed. Prepare the item again.");
  const saved = await account(state.accountId, signal);
  if (!saved || saved.isDisabled || saved.status !== "ACTIVE") {
    throw new Error(
      `Monday.com connection is ${saved?.isDisabled ? "disabled" : (saved?.status?.toLowerCase() ?? "disconnected")}. Run Connect Monday.com again to authorize.`,
    );
  }
  let result;
  try {
    result = await api().tools.execute(
      action,
      {
        connectedAccountId: state.accountId,
        userId: state.userId,
        version: mondayVersion,
        arguments: args,
      },
      { signal },
    );
  } catch (error) {
    if (signal.aborted)
      throw new Error("Monday.com request timed out. Check Monday.com before retrying; the operation may already have completed.");
    if (httpStatus(error) === 401)
      throw new Error(
        "Composio rejected your API key. Update it in Monday.com settings; reconnecting alone will not fix the key.",
      );
    if (httpStatus(error) === 403)
      throw new Error(
        "Monday.com access was denied. Check your board permissions and the Composio app's authorized scopes.",
      );
    throw providerError(
      error instanceof Error ? error.message : "Composio execution failed.",
    );
  }
  if (!result.successful || result.error)
    throw providerError(
      result.error || "Composio reported an unsuccessful execution.",
    );
  // Composio can wrap the Monday GraphQL response in raw_response.
  // Check errors at each layer before reading any returned records or IDs.
  let data = record(result.data);
  if (!data) throw new Error("Monday.com returned an unexpected result. Check Monday.com before retrying a write.");
  for (;;) {
    if (
      data.errors &&
      (!Array.isArray(data.errors) || data.errors.length > 0)
    ) {
      throw providerError(JSON.stringify(data.errors));
    }
    if (data.error || data.error_message)
      throw providerError(String(data.error_message ?? data.error));
    const nested = record(data.raw_response) ?? record(data.data);
    if (!nested) return data;
    data = nested;
  }
}

function records(value: unknown): Record<string, unknown>[] {
  const parsed = z
    .array(
      z
        .object({
          id: z.union([z.string().min(1), z.number()]),
          name: z.string(),
        })
        .passthrough(),
    )
    .safeParse(value);
  if (!parsed.success)
    throw new Error(
      "Monday.com returned an unexpected result shape. No results can be confirmed; try again.",
    );
  return parsed.data;
}

const readPreviewLimit = 6;

function readSummary(count: number, noun: "board" | "item", boardName?: string): string {
  const scope = boardName ? ` on "${boardName}"` : "";
  if (count === 0) return `No matching ${noun}s found${scope}.`;
  if (count > readPreviewLimit) return `Here are the first few ${noun}s${scope}.`;
  return `Found ${count} ${count === 1 ? noun : `${noun}s`}${scope}.`;
}

function displayText(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function itemSubtitle(item: Record<string, unknown>, groupName?: string): string | undefined {
  const columns = Array.isArray(item.column_values) ? item.column_values : [];
  const status = columns.map(record).find(column =>
    displayText(column?.text) && (
      column?.type === "status" || column?.type === "color" ||
      (column?.type == null && column?.id === "status")
    ),
  );
  return displayText(status?.text) ?? displayText(record(item.group)?.title) ?? groupName;
}

function readGlance(data: ReadOutput) {
  const choosingBoard = data.resultType === "board_choices";
  const isBoards = data.resultType !== "tasks";
  const count = data.records.length;
  const visibleCount = count > readPreviewLimit ? readPreviewLimit - 1 : count;
  const rows = data.records.slice(0, visibleCount).map(entry => {
    const subtitle = isBoards ? displayText(record(entry.workspace)?.name) : itemSubtitle(entry, data.groupName);
    return {
      title: (displayText(entry.name) ?? (isBoards ? "Untitled board" : "Untitled item")).slice(0, 60),
      ...(subtitle ? { subtitle: subtitle.slice(0, 60) } : {}),
    };
  });
  if (visibleCount < count) rows.push({ title: `and ${count - visibleCount} more` });
  if (choosingBoard) {
    return [
      { type: "header", title: data.itemName ? `Choose a board for “${data.itemName.slice(0, 39)}”` : "Choose a Monday board" },
      { type: "keyValue", pairs: [["Next", count ? "Say or type the board name." : "Give the exact board name or ID."]] },
      ...(rows.length ? [{ type: "list", rows }] : []),
    ];
  }
  return [
    {
      type: "header",
      title: (isBoards ? "Monday.com boards" : data.boardName ?? "Monday.com items").slice(0, 60),
    },
    rows.length ? { type: "list", rows } : { type: "keyValue", pairs: [["Results", data.message]] },
  ];
}

// Validate every column before executing any write. Keep canonical JSON conversion here.
function normalizeColumns(value: string | Record<string, unknown>, allowEmpty = false): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = typeof value === "string" ? JSON.parse(value) : value; }
  catch { throw new Error("column_values must be a valid JSON object keyed by column ID."); }
  const columns = record(parsed);
  if (!columns || (!allowEmpty && !Object.keys(columns).length) || Object.keys(columns).some(key => !key.trim()))
    throw new Error("column_values must be a nonempty JSON object keyed by column ID.");
  return JSON.parse(JSON.stringify(columns));
}
function writeResult(data: Record<string, unknown>, keys: string[], message: string): WriteOutput {
  const target = keys.map(key => record(data[key])).find(Boolean) ?? data;
  if ((typeof target.id !== "string" && typeof target.id !== "number") || !String(target.id).trim())
    throw new Error("Monday.com did not return a confirmed object ID. Check Monday.com before retrying; the write may have completed.");
  return { status: "Success", message, id: String(target.id) };
}
function metadataRows(value: unknown): Record<string, unknown>[] {
  const parsed = z.array(z.record(z.unknown())).safeParse(value);
  if (!parsed.success) throw new Error("Monday.com returned incomplete board or assignment details.");
  return parsed.data;
}

function boardMetadata(data: Record<string, unknown>, boardId: string, field: "groups" | "columns") {
  const boards = Array.isArray(data.boards) ? metadataRows(data.boards) : [];
  const board = boards.find(entry => String(entry.id) === boardId)
    ?? (boards.length === 1 && boards[0].id === undefined ? boards[0] : undefined);
  return metadataRows(board?.[field] ?? data[field]);
}

function settingsFor(column: Record<string, unknown>) {
  const settings = column.settings ?? column.settings_str;
  if (typeof settings !== "string") return record(settings);
  try { return record(JSON.parse(settings)); } catch { return undefined; }
}

function columnLabels(column: Record<string, unknown>) {
  const settings = settingsFor(column);
  const labels = settings?.labels;
  if (Array.isArray(labels)) {
    return metadataRows(labels)
      .filter(label => !label.is_deactivated && !label.is_archived)
      .map(label => ({ id: String(label.id), label: String(label.label ?? label.name ?? "") }));
  }
  const archived = settings?.labels_archived;
  return Object.entries(record(labels) ?? {})
    .filter(([id, label]) => typeof label === "string" &&
      !(Array.isArray(archived) ? archived.some(entry => String(entry) === id) : record(archived)?.[id]))
    .map(([id, label]) => ({ id, label: label as string }));
}

function emptyColumn(value: unknown): boolean {
  if (value == null || (typeof value === "string" && !value.trim())) return true;
  if (Array.isArray(value)) return value.every(emptyColumn);
  const object = record(value);
  return object !== undefined && Object.values(object).every(emptyColumn);
}

function displayColumnValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(displayColumnValue).join(", ");
  const object = record(value);
  if (object) {
    return Object.entries(object).map(([key, entry]) => {
      const label = key.replace(/([a-z])([A-Z])/g, "$1 $2").replaceAll("_", " ");
      return `${label}: ${displayColumnValue(entry)}`;
    }).join("; ");
  }
  if (value === null) return "Empty";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return String(value);
}

function displayDate(date: unknown) {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const parsed = new Date(date + "T00:00:00Z");
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return undefined;
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(parsed);
}

const peopleEntry = z.object({
  id: z.union([id(), z.string().regex(/^\d+$/).transform(Number).pipe(id())]),
  kind: z.enum(["person", "team"]),
}).strict();

async function prepareColumn(
  column: Record<string, unknown>,
  value: unknown,
  assignees: (kind: "person" | "team") => Promise<Record<string, unknown>[]>,
): Promise<{ value: unknown; display: string }> {
  const title = String(column.title);
  const data = record(value);
  if (column.type === "status" || column.type === "color") {
    const labels = columnLabels(column);
    const label = typeof value === "string" ? value : data?.label;
    const match = labels.find(entry => typeof label === "string"
      ? entry.label === label : typeof data?.index === "number" && entry.id === String(data.index));
    if (!match?.label) {
      const options = labels.map(entry => entry.label).filter(Boolean).join(", ");
      throw new Error(`Choose an exact status label for "${title}".${options ? ` Available labels: ${options}.` : ""}`);
    }
    const encoded = /^\d+$/.test(match.label) ? { index: Number(match.id) } : { label: match.label };
    if ("index" in encoded && !Number.isSafeInteger(encoded.index))
      throw new Error(`Could not verify the status label ID for "${title}".`);
    return { value: encoded, display: match.label };
  }
  if (column.type === "dropdown") {
    const labels = columnLabels(column);
    const byId = data?.labels === undefined && data?.ids !== undefined;
    const requested = typeof value === "string" ? [value] : data?.labels ?? data?.ids;
    const matches = Array.isArray(requested) ? requested.map(option => labels.find(label =>
      byId ? label.id === String(option) : label.label === option)) : [];
    if (!matches.length || matches.some(match => !match?.label))
      throw new Error(`Choose existing dropdown labels for "${title}". Available labels: ${labels.map(entry => entry.label).join(", ")}.`);
    const names = matches.map(match => match!.label);
    return { value: { labels: names }, display: names.join(", ") };
  }
  if (column.type === "date" || column.type === "timeline") {
    const isTimeline = column.type === "timeline";
    const date = isTimeline ? data?.from : typeof value === "string" ? value : data?.date;
    const from = displayDate(date);
    const to = isTimeline ? displayDate(data?.to) : undefined;
    const time = data?.time;
    if (!from || (isTimeline && (!to || String(date) > String(data?.to))) ||
      (time !== undefined && (typeof time !== "string" || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(time)))) {
      throw new Error(`Resolve the date for "${title}" before preparing the item.`);
    }
    return isTimeline
      ? { value: { from: date, to: data?.to }, display: `${from} – ${to}` }
      : { value: { date, ...(time !== undefined ? { time } : {}) }, display: time ? `${from}, ${time}` : from };
  }
  if (column.type === "people") {
    const names = z.array(nonempty()).min(1).safeParse(typeof value === "string" ? [value] : data?.names);
    const entries = z.array(peopleEntry).min(1).safeParse(data?.personsAndTeams);
    if (!names.success && !entries.success)
      throw new Error(`Provide a Monday.com name or ID for "${title}".`);
    const requested = names.success ? names.data : entries.data!;
    const resolved = await Promise.all(requested.map(async entry => {
      if (typeof entry === "string") {
        const users = await assignees("person");
        const exact = users.filter(user => [user.name, user.email].some(value => String(value).toLowerCase() === entry.toLowerCase()));
        const matches = exact.length ? exact : users.filter(user => String(user.name).toLowerCase().includes(entry.toLowerCase()));
        const person = matches.length === 1 ? matches[0] : undefined;
        const id = Number(person?.id);
        const name = displayText(person?.name);
        if (!name || !Number.isSafeInteger(id) || id < 1)
          throw new Error(`Which Monday.com user did you mean by "${entry}" for "${title}"?`);
        return { target: { id, kind: "person" }, name };
      }
      const person = (await assignees(entry.kind)).find(candidate => String(candidate.id) === String(entry.id));
      const name = displayText(person?.name);
      if (!name) throw new Error(`Could not verify the assignee for "${title}".`);
      return { target: entry, name };
    }));
    return { value: { personsAndTeams: resolved.map(entry => entry.target) }, display: resolved.map(entry => entry.name).join(", ") };
  }
  if (column.type === "name") throw new Error("Set the item's name in item_name.");
  return { value, display: displayColumnValue(value) };
}

async function prepareCreateItem(input: CreateItemInput): Promise<PrepareCreateItemOutput | ReadOutput> {
  const requestedColumns = input.column_values === undefined ? undefined
    : Object.entries(normalizeColumns(input.column_values, true)).filter(([, value]) => !emptyColumn(value));
  const accountId = (await load()).accountId;
  if (!accountId) throw new Error("Monday.com is not connected. Run Connect Monday.com.");
  const now = Date.now();
  for (const [key, draft] of createItemDrafts) if (draft.expires <= now) createItemDrafts.delete(key);
  let priorId = input.replaces_draft_id;
  if (!priorId && input.revises_item_name) {
    const matches = [...createItemDrafts].filter(([, draft]) =>
      draft.accountId === accountId && draft.itemName.toLowerCase() === input.revises_item_name?.toLowerCase());
    if (matches.length !== 1)
      throw new Error("Could not identify one pending item by that name. Ask which item to prepare and confirm again.");
    priorId = matches[0][0];
  }
  const prior = priorId ? createItemDrafts.get(priorId) : undefined;
  if (priorId && (!prior || prior.accountId !== accountId))
    throw new Error("The pending item expired or belongs to another account. Prepare it again.");
  if (prior) prior.retired = true;
  const draft_id = randomUUID();
  function replaceDraft(draft: CreateItemDraft) {
    if (priorId && createItemDrafts.get(priorId) !== prior)
      throw new Error("The item already has a newer draft. Review that draft before creating the item.");
    createItemDrafts.set(draft_id, draft);
    if (priorId) createItemDrafts.delete(priorId);
  }
  const name = input.item_name ?? prior?.itemName;
  const lookup = (action: Action, args: Record<string, unknown>) => executeAction(action, args, accountId);
  const limit = 100;
  const boards = new Map<string, Record<string, unknown>>();
  for (let page = 1; ; page++) {
    const found = records((await lookup("MONDAY_BOARDS", { state: "active", page, limit })).boards);
    const count = boards.size;
    for (const entry of found) boards.set(String(entry.id), entry);
    if (found.length < limit) break;
    if (boards.size === count) throw new Error("Could not finish checking the Monday.com boards.");
  }
  const available = [...boards.values()].filter(entry => id().safeParse(Number(entry.id)).success && displayText(entry.name));
  const query = input.board_name?.toLowerCase();
  const exact = query ? available.filter(entry => displayText(entry.name)?.toLowerCase() === query) : [];
  const matches = exact.length || !query
    ? exact
    : available.filter(entry => displayText(entry.name)?.toLowerCase().includes(query));
  const board = input.board_id === undefined
    ? matches.length === 1 ? matches[0] : undefined
    : available.find(entry => String(entry.id) === String(input.board_id));
  if (input.board_id !== undefined && (!board || (query && displayText(board.name)?.toLowerCase() !== query)))
    throw new Error("Could not verify the destination Monday.com board. Ask the user to choose it by name.");

  const boardChanged = String(board?.id) !== prior?.args?.board_id;
  const carriedByTitle = !requestedColumns && Boolean(prior?.carriedByTitle || (boardChanged && prior?.columnTitles));
  const carriedGroupByTitle = input.group_id === undefined && Boolean(prior?.carriedGroupByTitle || (boardChanged && prior?.args));
  const carriedColumns = Object.entries(prior?.columns ?? {}).map(([key, value]) => ({
    key: carriedByTitle ? prior?.columnTitles?.[key] ?? key : key,
    value,
    type: prior?.columnTypes?.[key],
  }));
  const columnValues = requestedColumns?.map(([key, value]) => ({ key, value, type: undefined })) ?? carriedColumns;
  if (new Set(columnValues.map(({ key }) => key)).size !== columnValues.length)
    throw new Error("Multiple requested columns share a title. Ask which destination columns to use.");
  const groupInput = input.group_id ?? prior?.groupTitle;
  const draftDetails = { accountId, expires: now + 30 * 60_000 };
  if (!board) {
    const offered = matches.length ? matches : available;
    const question = name ? `Which Monday board should “${name}” go on?` : "Which Monday board should I use?";
    if (name && offered.length) {
      replaceDraft({
        ...draftDetails, itemName: name, groupTitle: groupInput, carriedByTitle, carriedGroupByTitle,
        columns: Object.fromEntries(columnValues.map(({ key, value }) => [key, value])),
        columnTypes: Object.fromEntries(columnValues.map(({ key, type }) => [key, type])),
      });
    }
    return {
      resultType: "board_choices",
      itemName: name,
      status: "Board selection required",
      message: offered.length ? question : `${question} No active boards were returned.`,
      records: offered,
      pagination: {},
      ...(name && offered.length ? { pending_item: { draft_id, item_name: name } } : {}),
    };
  }
  const boardName = displayText(board?.name);
  if (!boardName)
    throw new Error("Could not verify the destination Monday.com board.");
  const boardId = String(board.id);
  const [groups, columns] = await Promise.all([
    Array.isArray(board.groups) ? metadataRows(board.groups) : lookup("MONDAY_LIST_GROUPS", { board_id: boardId })
      .then(data => boardMetadata(data, boardId, "groups")),
    !name || columnValues.length ? lookup("MONDAY_COLUMNS", { board_ids: [boardId] })
      .then(data => boardMetadata(data, boardId, "columns"))
      : [],
  ]);
  const activeGroups = groups.filter(group => !group.archived && !group.deleted);
  if (!name) {
    return {
      status: "Board details", message: `Found groups and columns for "${boardName}".`,
      board: { name: boardName, groups: activeGroups, columns },
    };
  }
  const topGroup = record(board.top_group);
  const positionsKnown = activeGroups.every(group => typeof group.position === "string" &&
    group.position.trim() && Number.isFinite(Number(group.position)));
  if (positionsKnown) activeGroups.sort((a, b) => Number(a.position) - Number(b.position));
  const groupMatches = activeGroups.filter(group => group.title === groupInput);
  const group = groupInput === undefined
    ? (topGroup?.id && !topGroup.archived && !topGroup.deleted ? topGroup : activeGroups[0])
    : (carriedGroupByTitle ? undefined : activeGroups.find(group => group.id === groupInput))
      ?? (groupMatches.length === 1 ? groupMatches[0] : undefined);
  const groupName = displayText(group?.title);
  if (!groupName || typeof group?.id !== "string")
    throw new Error(`Choose a group on "${boardName}". Available groups: ${activeGroups.map(group => group.title).join(", ")}.`);
  const groupChoices = new Map<string, string>();
  for (const activeGroup of activeGroups) {
    const label = displayText(activeGroup.title);
    if (typeof activeGroup.id === "string" && activeGroup.id && label) groupChoices.set(activeGroup.id, label);
  }
  groupChoices.set(group.id, groupName);

  let users: Promise<Record<string, unknown>[]> | undefined;
  let teams: Promise<Record<string, unknown>[]> | undefined;
  async function listUsers() {
    const usersById = new Map<string, Record<string, unknown>>();
    for (let page = 1; ; page++) {
      const users = records((await lookup("MONDAY_LIST_USERS", { page, limit: 100 })).users);
      if (users.length === 0) break;
      const count = usersById.size;
      for (const user of users) usersById.set(String(user.id), user);
      if (usersById.size === count) throw new Error("Could not finish verifying the Monday.com users.");
    }
    return [...usersById.values()].filter(user => user.enabled !== false && user.is_pending !== true);
  }
  const rows = await Promise.all(columnValues.map(async ({ key, value, type }) => {
    const matches = columns.filter(column => column.title === key);
    const column = (carriedByTitle ? undefined : columns.find(column => column.id === key))
      ?? (matches.length === 1 ? matches[0] : undefined);
    if (typeof column?.id !== "string" || !displayText(column.title) || column.archived)
      throw new Error(`Could not match column "${key}" on "${boardName}". Ask which column or value to use before proposing the item.`);
    const canonicalType = (value: unknown) => value === "color" ? "status" : value;
    if (type !== undefined && canonicalType(type) !== canonicalType(column.type))
      throw new Error(`Column "${key}" has a different type on "${boardName}". Ask which column or value to use before proposing the item.`);
    const resolved = await prepareColumn(column, value, kind => kind === "person"
      ? (users ??= listUsers())
      : (teams ??= lookup("MONDAY_GET_TEAMS", {}).then(data => records(data.teams))));
    return { id: column.id, label: String(column.title), type: column.type, ...resolved };
  }));
  if (new Set(rows.map(row => row.id)).size !== rows.length)
    throw new Error("Specify each column only once.");
  const preview = {
    board: boardName,
    groups: Array.from(groupChoices, ([id, label]) => ({ id, label })),
    columns: rows.map(({ label, display }) => ({ label, value: display })),
  };
  const columnsToWrite = Object.fromEntries(rows.map(row => [row.id, row.value]));
  replaceDraft({
    ...draftDetails, preview, itemName: name, groupTitle: groupInput === undefined ? undefined : groupName,
    columns: columnsToWrite, columnTitles: Object.fromEntries(rows.map(row => [row.id, row.label])),
    columnTypes: Object.fromEntries(rows.map(row => [row.id, row.type])),
    args: {
      board_id: boardId,
      ...(rows.length ? { column_values: JSON.stringify(columnsToWrite) } : {}),
    },
  });
  return {
    status: "Ready for confirmation", message: "Use create_item_arguments to show the confirmation card.",
    create_item_arguments: { draft_id, item_name: name, group_id: group.id, preview },
  };
}

function getReviewedDraft(draftId: string) {
  const draft = createItemDrafts.get(draftId);
  if (!draft || draft.retired || draft.expires <= Date.now())
    throw new Error("The item preview changed, expired, or was already used. Prepare it again before creating the item.");
  return draft;
}

async function createItem(input: z.infer<typeof createItemSchema>): Promise<WriteOutput> {
  const draft = getReviewedDraft(input.draft_id);
  if (!draft.args || !isDeepStrictEqual(draft.preview, input.preview))
    throw new Error("The item preview changed. Prepare it again before creating the item.");
  if (!draft.preview?.groups.some(group => group.id === input.group_id))
    throw new Error("Choose an available group from the selected board.");
  createItemDrafts.delete(input.draft_id);
  const data = await executeAction("MONDAY_CREATE_ITEM", {
    ...draft.args, item_name: input.item_name, group_id: input.group_id,
  }, draft.accountId);
  return writeResult(data, ["create_item"], `Created item "${input.item_name}".`);
}
async function updateItemValues(input: z.infer<typeof updateItemValuesSchema>): Promise<WriteOutput> {
  const columns = normalizeColumns(input.column_values);
  // UPDATE_ITEM accepts scalar/object values and flat arrays, but not null.
  const validValue = (value: unknown): boolean => value !== null &&
    (!Array.isArray(value) || value.every(entry => entry !== null && !Array.isArray(entry)));
  if (Object.values(columns).some(value => !validValue(value)))
    throw new Error("Column values cannot be null or contain nested arrays/null array entries for this Composio action.");
  const completed: string[] = [];
  for (const [column_id, value] of Object.entries(columns)) {
    try {
      const data = await executeAction("MONDAY_UPDATE_ITEM", {
        board_id: String(input.board_id), item_id: String(input.item_id), column_id, value,
      });
      const result = writeResult(data, ["change_column_value", "update_item"], "Updated item.");
      if (result.id !== String(input.item_id)) throw new Error("Monday.com returned an unexpected item ID.");
      completed.push(column_id);
    } catch (error) {
      throw new Error(`Item ${input.item_id}: completed columns: ${completed.join(", ") || "none"}. Could not confirm column ${column_id}; remaining columns were not attempted. ${error instanceof Error ? error.message : "Write failed."} Check Monday.com before retrying.`);
    }
  }
  return { status: "Success", message: `Updated ${completed.length} column(s) on item ${input.item_id}.`, id: String(input.item_id), completedColumns: completed };
}
async function createUpdate(input: z.infer<typeof createUpdateSchema>): Promise<WriteOutput> {
  return writeResult(await executeAction("MONDAY_CREATE_UPDATE", input), ["create_update"], "Posted update/comment.");
}
async function createBoard(input: z.infer<typeof createBoardSchema>): Promise<WriteOutput> {
  return writeResult(await executeAction("MONDAY_CREATE_BOARD", input), ["create_board"], `Created board "${input.board_name}".`);
}

async function getBoards(
  input: z.infer<typeof getBoardsSchema>,
): Promise<ReadOutput> {
  const page = input.page ?? 1;
  const limit = input.limit ?? 25;
  const data = await executeAction("MONDAY_BOARDS", { ...input, page, limit });
  const boards = records(data.boards);
  return {
    resultType: "boards",
    status: "Boards found",
    message: readSummary(boards.length, "board"),
    records: boards,
    pagination: {
      page,
      limit,
      nextPage: boards.length === limit ? page + 1 : null,
    },
  };
}

async function getItems(
  input: z.infer<typeof getItemsSchema>,
): Promise<ReadOutput> {
  if (
    [input.ids, input.board_id, input.cursor].filter(
      (value) => value !== undefined,
    ).length !== 1
  ) {
    throw new Error(
      "Provide exactly one of ids, board_id, or cursor to get items.",
    );
  }
  if (
    input.ids
      ? input.group_id !== undefined
      : [input.page, input.newest_first, input.exclude_nonactive].some(
          (value) => value !== undefined,
        )
  ) {
    throw new Error(
      "group_id is only for board reads; page, newest_first, and exclude_nonactive are only for item-ID reads.",
    );
  }
  if (input.cursor && input.group_id)
    throw new Error(
      "Use cursor alone to continue a board read; do not also provide group_id.",
    );
  if (input.ids && input.board_name) {
    throw new Error("board_name is only for board or cursor reads; item-ID reads may span multiple boards.");
  }
  // Board names are display context, not provider arguments or execution targets.
  const { board_name, ...args } = input;
  const limit = input.limit ?? 25;
  if (input.ids) {
    const page = input.page ?? 1;
    const data = await executeAction("MONDAY_GET_ITEMS", {
      ...args,
      page,
      limit,
    });
    const items = records(data.items);
    return {
      resultType: "tasks",
      status: "Tasks",
      message: readSummary(items.length, "item"),
      records: items,
      pagination: {
        page,
        limit,
        nextPage: items.length === limit ? page + 1 : null,
      },
    };
  }
  const data = await executeAction("MONDAY_ITEMS_PAGE", {
    ...args,
    limit,
    include_column_values: true,
  });
  // Initial queries nest the page under boards (or groups); cursor queries return next_items_page.
  if (Array.isArray(data.boards) && data.boards.length === 0) {
    return {
      resultType: "tasks", status: "Tasks", message: "No matching accessible board found.",
      records: [], pagination: { limit, nextCursor: null },
    };
  }
  const board = Array.isArray(data.boards) ? record(data.boards[0]) : undefined;
  const boardName = displayText(board?.name) ?? board_name;
  const group =
    board && Array.isArray(board.groups) ? record(board.groups[0]) : undefined;
  const groupName = input.group_id ? displayText(group?.title) : undefined;
  const page =
    record(
      data.next_items_page ??
        data.items_page ??
        group?.items_page ??
        board?.items_page,
    ) ?? (Array.isArray(data.items) ? data : undefined);
  if (!page || !(page.cursor === null || typeof page.cursor === "string")) {
    throw new Error(
      "Monday.com returned an unexpected items page or missing pagination cursor. Try again.",
    );
  }
  const items = records(page.items);
  return {
    resultType: "tasks",
    status: "Tasks",
    ...(boardName ? { boardName } : {}),
    ...(groupName ? { groupName } : {}),
    message: readSummary(items.length, "item", boardName),
    records: items,
    pagination: { limit, nextCursor: page.cursor },
  };
}

async function connect(): Promise<Output> {
  // Connect is a short browser handoff, not a task that waits for user consent.
  // Bound the whole handoff so it finishes before VoiceOS's MCP request timeout.
  const signal = AbortSignal.timeout(12000);
  // Validate settings even when no connection has been saved yet.
  api();
  const state = await load();
  const saved = state.pending?.id ?? state.accountId;
  const existing = saved ? await account(saved, signal) : undefined;
  if (existing?.status === "ACTIVE" && !existing.isDisabled) {
    stopBackgroundConnectWatcher();
    state.accountId = existing.id;
    delete state.pending;
    await save(state);
    return {
      connected: true,
      status: "Connected",
      message:
        "Monday.com authorization verified. Your saved connection is ready to use.",
    };
  }
  // If not active, create a fresh authorization session with a valid redirect link.
  // Reopening a previously launched link fails because Composio link sessions expire once visited.
  delete state.pending;
  const session = await api().sessions.create(
    state.userId,
    {
      toolkits: ["monday"],
      tools: { monday: { enable: [] } },
      sandbox: { enable: false },
    },
    { signal, maxRetries: 0 },
  );
  const request = await session.authorize("monday", undefined, {
    signal,
    maxRetries: 0,
  });
  if (
    !request.redirectUrl ||
    new URL(request.redirectUrl).protocol !== "https:"
  ) {
    throw new Error(
      "Composio did not return a valid HTTPS authorization link.",
    );
  }
  state.pending = { id: request.id, url: request.redirectUrl };
  await save(state);
  await new Promise<void>((resolve, reject) => {
    execFile(
      "/usr/bin/open",
      [state.pending!.url],
      { timeout: 8000, signal },
      (error) => (error ? reject(error) : resolve()),
    );
  });
  startBackgroundConnectWatcher(request.id);
  return {
    connected: false,
    status: "Authorization pending",
    authorizationUrl: state.pending.url,
    message:
      "Monday.com authorization opened in your browser. Finish approval there, then run Connect again to verify the connection. If Monday says ‘App is not installed’, ask an admin to install Composio's Monday app using the README link.",
  };
}

async function disconnect(): Promise<Output> {
  stopBackgroundConnectWatcher();
  const state = await load();
  let providerRevoked = true;
  for (const id of new Set(
    [state.accountId, state.pending?.id].filter((id): id is string =>
      Boolean(id),
    ),
  )) {
    const saved = await account(id);
    if (!saved || saved.status === "REVOKED") continue;
    try {
      const revoked = await api().connectedAccounts.revoke(id, {
        signal: AbortSignal.timeout(12000),
      });
      if (revoked.connectedAccount.status !== "REVOKED")
        throw new Error(
          "Composio did not confirm revocation. Run Disconnect again to verify before reconnecting.",
        );
    } catch (error) {
      // Legacy Monday OAuth may not support provider revocation. Disable access in Composio instead.
      if (![400, 409].includes(httpStatus(error) ?? 0)) throw error;
      if (!saved.isDisabled)
        await api().connectedAccounts.disable(id, {
          signal: AbortSignal.timeout(8000),
        });
      providerRevoked = false;
    }
  }
  delete state.accountId;
  delete state.pending;
  await save(state);
  return {
    connected: false,
    status: "Disconnected",
    providerRevoked,
    message: providerRevoked
      ? "Monday.com is disconnected. No boards, items, or memberships were changed."
      : "Monday.com is disconnected in Composio. To also remove provider consent, uninstall the Composio app from your Monday.com account's installed apps. No boards, items, or memberships were changed.",
  };
}

type ProgressContext = {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total: number;
      message: string;
    };
  }) => Promise<void>;
};

async function progress(extra: ProgressContext, message: string, done = false) {
  const progressToken = extra._meta?.progressToken;
  if (progressToken === undefined) return;
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken, progress: done ? 100 : 0, total: 100, message },
    });
  } catch {
    /* A display failure must not change the account operation's outcome. */
  }
}

async function feedback(
  title: string,
  extra: ProgressContext,
  run: () => Promise<Output | ReadOutput | WriteOutput | PrepareCreateItemOutput>,
  notifyResult = false,
  errorTitle?: string,
) {
  await progress(extra, `${title}…`);
  let data: Output | ReadOutput | WriteOutput | PrepareCreateItemOutput | { error: string };
  let isError = false;
  try {
    data = await run();
  } catch (error) {
    isError = true;
    let message =
      error instanceof Error ? error.message : "Composio request failed.";
    const key = process.env.COMPOSIO_API_KEY?.trim();
    if (key) message = message.split(key).join("[redacted]");
    data = {
      error: message
        .replace(/https?:\/\/[^\s"<>]+/g, "[link redacted]")
        .slice(0, 700),
    };
  }
  await progress(extra, `${title}: ${isError ? "failed" : "finished"}`, true);
  if ("create_item_arguments" in data || "board" in data) {
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  }
  let notificationQueued = false;
  if (notifyResult) {
    if (
      await notify(
        `Monday.com — ${title}: ${"error" in data ? data.error : data.message}`,
      )
    ) {
      notificationQueued = true;
    }
  }
  const resultTitle = "error" in data ? errorTitle ?? "Monday.com" : "Monday.com";
  const resultMessage = "error" in data ? (errorTitle ? data.error.slice(0, 64) : data.error) : data.message;
  return {
    isError,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ...data,
          notificationQueued,
          _voiceos_glance: {
            blocks: "records" in data ? readGlance(data) : [
              {
                type: "header",
                title: resultTitle,
                trailing: "error" in data ? "Error" : data.status,
              },
              {
                type: "keyValue",
                pairs: [["Status", resultMessage]],
              },
            ],
          },
        }),
      },
    ],
  };
}

server.registerTool(
  "connect_account",
  {
    title: "Connect Monday.com",
    description:
      "Connect Monday.com through Composio OAuth. Use when asked to connect, authorize, reconnect, or verify the saved Monday.com connection. Verify an active saved account; otherwise open browser authorization and immediately return pending with its link. After browser approval, run Connect again to verify. Only report connected when connected=true; no background sidebar result is scheduled.",
    inputSchema: z.object({}).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async (_input, extra) =>
    feedback("Connect Monday.com", extra, async () => {
      if (disconnecting)
        throw new Error(
          "Monday.com is still disconnecting. Wait for it to finish before connecting.",
        );
      if (!connecting)
        connecting = connect().finally(() => {
          connecting = undefined;
        });
      return await connecting;
    }, true),
);

server.registerTool(
  "connection_status",
  {
    title: "Monday.com account",
    description:
      "Show Monday.com connection status with Connect, Disconnect, and Refresh controls. Use when asked about Monday.com account settings, connection status, expired authorization, or account linking. Read only; does not start OAuth.",
    inputSchema: z.object({}).strict(),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async (_input, extra) =>
    feedback(
      "Check connection",
      extra,
      async () => {
        const state = await load();
        const saved = state.pending?.id ?? state.accountId;
        const acc = saved ? await account(saved) : undefined;
        const connected = acc?.status === "ACTIVE" && !acc.isDisabled;
        const status = connected
          ? "Connected"
          : acc?.isDisabled
            ? "Disabled"
            : (acc?.status ?? "Disconnected");
        const message = connected
          ? "Monday.com is connected and ready to use."
          : status === "EXPIRED"
            ? "Your Monday.com authorization expired. Connect again to authorize."
            : status === "REVOKED"
              ? "Your Monday.com authorization was revoked. Connect again to authorize."
              : ["INITIATED", "INITIALIZING", "PENDING"].includes(status)
                ? "Finish authorizing Monday.com in your browser, then refresh."
                : "Monday.com is disconnected. Connect to authorize in your browser.";
        return { connected: Boolean(connected), status, message };
      },
      false,
    ),
);

server.registerTool(
  "disconnect_account",
  {
    title: "Disconnect Monday.com",
    description:
      "Disconnect this installation's Monday.com account. Use only when asked to disconnect or unlink Monday.com. Revoke authorization when supported; otherwise disable the Composio connection. Does not delete boards, items, or users.",
    inputSchema: z.object({}).strict(),
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async (_input, extra) =>
    feedback("Disconnect Monday.com", extra, async () => {
      if (connecting)
        throw new Error(
          "Monday.com authorization is still running. Finish or wait for it before disconnecting.",
        );
      if (!disconnecting)
        disconnecting = disconnect().finally(() => {
          disconnecting = undefined;
        });
      return await disconnecting;
    }, true),
);

server.registerTool(
  "get_boards",
  {
    title: "Get Monday.com boards",
    description:
      "Find Monday.com boards with optional ID, workspace, state, and visibility filters. When the user asks for tasks on a named board, use this as an intermediate lookup. Prefer an exact board-name match, use a unique clear partial match automatically, and ask when multiple boards could match. Then call get_items with the resolved board_id and exact board_name before answering. For a general board list request, use the short message and let the glance card show the names. Use the full records from the current page for board-specific follow-ups, including boards outside the preview. Pagination starts at page 1. When pagination.nextPage is available, offer to check for more boards and use that page with the previous filters and limit if asked. Counts describe the returned page. Keep IDs internal unless explicitly requested. Read only; does not start OAuth or send notifications.",
    inputSchema: getBoardsSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async (input, extra) =>
    feedback("Get boards", extra, () => getBoards(input), false),
);

server.registerTool(
  "get_items",
  {
    title: "Get Monday.com items",
    description:
      "List Monday.com items when the user asks to view or retrieve them. A bare board name in answer to a pending create-item board question selects the destination for prepare_create_item. Use exactly one of ids, board_id, or cursor. For a named board, first resolve its ID with get_boards: prefer an exact match, otherwise use a unique clear partial match; ask if ambiguous. Pass the exact resolved board_name for display and name that board in the final task answer. Never present get_boards results as tasks; wait for this call to succeed before listing tasks, or report its error. Item-ID reads support page, newest_first, and exclude_nonactive; pagination.nextPage is a possible next page. Board reads include column values and optionally group_id. For an explicit next-page request, use pagination.nextCursor with the previous limit and optional board_name display context. For a general list request, use the short message and let the glance card show the names. Offer to show the next page when there is a cursor, or offer to narrow by group when appropriate. Use the full records from the current page to answer item-specific follow-ups, including items outside the preview. Counts describe the returned page. Keep IDs internal unless explicitly requested, and use only confirmed IDs and names. Read only; does not start OAuth or send notifications.",
    inputSchema: getItemsSchema,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: true,
    },
  },
  async (input, extra) =>
    feedback("Get items", extra, () => getItems(input), false),
);

server.registerTool("prepare_create_item", {
  title: "Prepare Monday.com item", description: prepareCreateItemDescription, inputSchema: prepareCreateItemSchema,
  annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
}, async (input, extra) => feedback("Prepare Monday.com item", extra, () => prepareCreateItem(input), false, "Couldn’t prepare Monday item"));

server.registerTool("create_item", {
  title: "Create Monday.com item", description: createItemDescription, inputSchema: createItemSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async (input, extra) => feedback("Create Monday.com item", extra, () => createItem(input)));

server.registerTool("update_item_values", {
  title: "Update Monday.com item values", description: "Update column values on a specific Monday.com item and board. column_values is a JSON object keyed by column ID. Columns are applied sequentially, not atomically; failures report completed columns. Do not retry automatically.", inputSchema: updateItemValuesSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async (input, extra) => feedback("Update Monday.com item values", extra, () => updateItemValues(input)));

server.registerTool("create_update", {
  title: "Create Monday.com update/comment", description: "Post a comment/update on a specific existing Monday.com item. Requires item_id and a nonempty body. Do not retry automatically after an uncertain outcome.", inputSchema: createUpdateSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async (input, extra) => feedback("Create Monday.com update/comment", extra, () => createUpdate(input)));

server.registerTool("create_board", {
  title: "Create Monday.com board", description: "Create a Monday.com board with an explicit name and visibility, optionally in a workspace/folder. Does not modify memberships. Do not retry automatically after an uncertain outcome.", inputSchema: createBoardSchema,
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
}, async (input, extra) => feedback("Create Monday.com board", extra, () => createBoard(input)));

await server.connect(new StdioServerTransport());
