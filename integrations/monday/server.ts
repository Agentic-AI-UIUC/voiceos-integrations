import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Composio } from "@composio/core";
import { z } from "zod";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

const server = new McpServer({ name: "composio-monday", version: "0.1.1" });
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
  resultType: "boards" | "tasks";
  boardName?: string;
  groupName?: string;
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
] as const;
type ReadAction = (typeof readActions)[number];
const id = () => z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const ids = () => z.array(id()).min(1).max(100);
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

async function executeRead(action: ReadAction, args: Record<string, unknown>) {
  if (!readActions.includes(action))
    throw new Error("This Monday.com operation is not approved.");
  if (disconnecting)
    throw new Error(
      "Monday.com is disconnecting. Wait for it to finish before reading boards or items.",
    );
  const signal = AbortSignal.timeout(20000);
  const state = await load();
  if (!state.accountId)
    throw new Error(
      "Monday.com is not connected. Run Connect Monday.com to authorize or verify browser approval.",
    );
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
      throw new Error("Monday.com request timed out. Try the read again.");
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
  // Composio actions can return the GraphQL envelope or its unwrapped data.
  let data = result.data;
  for (;;) {
    if (
      data.errors &&
      (!Array.isArray(data.errors) || data.errors.length > 0)
    ) {
      throw providerError(JSON.stringify(data.errors));
    }
    if (data.error || data.error_message)
      throw providerError(String(data.error_message ?? data.error));
    const nested = record(data.data);
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

function readNames(entries: Record<string, unknown>[]): string {
  const names = entries.slice(0, 3).map(entry => String(entry.name));
  if (entries.length > 3) names.push(`${entries.length - 3} more`);
  return new Intl.ListFormat("en", { type: "conjunction" }).format(names);
}

const itemPreviewLimit = 6;
const itemCount = (count: number) => `${count} ${count === 1 ? "item" : "items"}`;

function itemSummary(count: number, boardName?: string): string {
  const scope = boardName ? ` on "${boardName}"` : "";
  if (count === 0) return `No matching items found${scope}.`;
  if (count > itemPreviewLimit) return `Here are the first few items${scope}.`;
  return `Found ${itemCount(count)}${scope}.`;
}

function displayText(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

function itemGlance(data: ReadOutput) {
  const count = data.records.length;
  const visibleCount = count > itemPreviewLimit ? itemPreviewLimit - 1 : count;
  const rows = data.records.slice(0, visibleCount).map(item => {
    const columns = Array.isArray(item.column_values) ? item.column_values : [];
    const status = columns.map(record).find(column =>
      displayText(column?.text) && (
        column?.type === "status" || column?.type === "color" ||
        (column?.type == null && column?.id === "status")
      ),
    );
    const subtitle = displayText(status?.text) ?? displayText(record(item.group)?.title) ?? data.groupName;
    return {
      title: (displayText(item.name) ?? "Untitled item").slice(0, 60),
      ...(subtitle ? { subtitle: subtitle.slice(0, 60) } : {}),
    };
  });
  if (visibleCount < count) rows.push({ title: `and ${count - visibleCount} more` });
  return [
    {
      type: "header",
      title: (data.boardName ?? "Monday.com items").slice(0, 60),
    },
    rows.length ? { type: "list", rows } : { type: "keyValue", pairs: [["Results", data.message]] },
  ];
}

async function getBoards(
  input: z.infer<typeof getBoardsSchema>,
): Promise<ReadOutput> {
  const page = input.page ?? 1;
  const limit = input.limit ?? 25;
  const data = await executeRead("MONDAY_BOARDS", { ...input, page, limit });
  const boards = records(data.boards);
  return {
    resultType: "boards",
    status: "Boards found",
    message: boards.length
      ? `Boards found: ${readNames(boards)}.${boards.length === limit ? " More results may be available on the next page." : ""}`
      : "No matching boards found.",
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
    const data = await executeRead("MONDAY_GET_ITEMS", {
      ...args,
      page,
      limit,
    });
    const items = records(data.items);
    return {
      resultType: "tasks",
      status: "Tasks",
      message: itemSummary(items.length),
      records: items,
      pagination: {
        page,
        limit,
        nextPage: items.length === limit ? page + 1 : null,
      },
    };
  }
  const data = await executeRead("MONDAY_ITEMS_PAGE", {
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
    message: itemSummary(items.length, boardName),
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
  run: () => Promise<Output | ReadOutput>,
  notifyResult = true,
) {
  await progress(extra, `${title}…`);
  let data: Output | ReadOutput | { error: string };
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
  return {
    isError,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          ...data,
          notificationQueued,
          _voiceos_glance: {
            blocks: "records" in data && data.resultType === "tasks" ? itemGlance(data) : [
              {
                type: "header",
                title: "Monday.com",
                trailing: "error" in data ? "Error" : data.status,
              },
              {
                type: "keyValue",
                pairs: "records" in data ? [
                  ["Boards", data.records.length ? `${readNames(data.records)}.` : data.message],
                  ...(data.pagination.nextPage ? [["More pages", "May be available"]] : []),
                ] : [["Status", "error" in data ? data.error : data.message]],
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
    }),
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
    }),
);

server.registerTool(
  "get_boards",
  {
    title: "Get Monday.com boards",
    description:
      "Find Monday.com boards, not tasks, with optional ID, workspace, state, and visibility filters. When the user asks for tasks on a named board, this is an intermediate lookup: do not announce board names as tasks or present this summary as the task answer. Prefer an exact board-name match; use a unique clear partial match automatically, and ask when multiple boards could match. Then call get_items with the resolved board_id and exact board_name before answering. When the user asks for boards themselves, present the Boards found summary. Keep raw IDs internal unless explicitly requested. Pagination starts at page 1; nextPage is a possible next page, not a guaranteed result. Read only; does not start OAuth or send notifications.",
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
      "Retrieve Monday.com tasks/items using exactly one of ids, board_id, or cursor. For a named board, first resolve its ID with get_boards: prefer an exact match, otherwise use a unique clear partial match; ask if ambiguous. Pass the exact resolved board_name for display and name that board in the final task answer. Never present get_boards results as tasks; wait for this call to succeed before listing tasks, or report its error. Item-ID reads support page, newest_first, and exclude_nonactive; pagination.nextPage is a possible next page. Board reads include column values and optionally group_id. For an explicit next-page request, use pagination.nextCursor with the previous limit and optional board_name display context. For a general list request, use the short message and let the glance card show the names. Offer to show the next page when there is a cursor, or offer to narrow by group when appropriate. Use the full records from the current page to answer item-specific follow-ups, including items outside the preview. Counts describe the returned page. Keep IDs internal unless explicitly requested, and use only confirmed IDs and names. Read only; does not start OAuth or send notifications.",
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

await server.connect(new StdioServerTransport());
