// Bun preload for the child server only. The real Composio SDK still runs;
// every fetch and browser-opening attempt is intercepted before it leaves the process.
import { appendFileSync, readFileSync } from "node:fs";

export type Scenario = {
  accountStatus?: string;
  accountDisabled?: boolean;
  accountToolkit?: string;
  accountHttpStatus?: number;
  stallPendingLookup?: boolean;
  stallOAuthLookup?: boolean;
  oauthWaitTimeoutMs?: number;
  oauthStatuses?: string[];
  activateAfterBrowser?: boolean;
  browserError?: boolean;
  redirectUrl?: string;
  revokeHttpStatus?: number;
  disableHttpStatus?: number;
  operationError?: string | { message: string };
  operationTimeout?: boolean;
  responseData?: unknown;
};

export type RecordedEvent = {
  kind: "request" | "browser" | "unexpected" | "version-check" | "lookup-aborted";
  path?: string;
  method?: string;
  body?: Record<string, unknown>;
  url?: string;
};

const scenarioPath = process.env.TODOIST_TEST_SCENARIO;
const eventsPath = process.env.TODOIST_TEST_EVENTS;
if (!scenarioPath || !eventsPath) {
  throw new Error("This preload is only for the isolated Todoist test harness.");
}

const scenario = (): Scenario => JSON.parse(readFileSync(scenarioPath, "utf8"));
function record(event: RecordedEvent) {
  appendFileSync(eventsPath, JSON.stringify(event) + "\n");
}
function recordedEvents(): RecordedEvent[] {
  return readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
}

// Shorten only the OAuth wait's overall deadline in isolated timeout tests.
const timeoutSignal = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = milliseconds => timeoutSignal(milliseconds === 180000
  ? scenario().oauthWaitTimeoutMs ?? milliseconds : milliseconds);

function waitForAbort(request: Request): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () => {
      record({ kind: "lookup-aborted", path: new URL(request.url).pathname });
      reject(request.signal.reason);
    };
    if (request.signal.aborted) abort();
    else request.signal.addEventListener("abort", abort, { once: true });
  });
}
const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json" },
});

function rawAccount(id: string) {
  const config = scenario();
  const events = recordedEvents();
  const browserIndex = events.findLastIndex(event => event.kind === "browser");
  const opened = browserIndex !== -1;
  const polls = events.slice(browserIndex + 1).filter(event => event.kind === "request"
    && event.method === "GET" && event.path?.endsWith(`/connected_accounts/${id}`)).length;
  const oauthStatus = opened && config.oauthStatuses?.length
    ? config.oauthStatuses[Math.min(polls - 1, config.oauthStatuses.length - 1)] : undefined;
  return {
    id,
    auth_config: {
      id: "ac_test",
      auth_scheme: "OAUTH2",
      is_composio_managed: true,
      is_disabled: false,
    },
    toolkit: { slug: config.accountToolkit ?? "todoist" },
    status: oauthStatus ?? (config.activateAfterBrowser && opened ? "ACTIVE" : config.accountStatus ?? "ACTIVE"),
    status_reason: null,
    is_disabled: config.accountDisabled ?? false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
}

// There is no real execFile implementation in the child process. Even OAuth
// tests cannot open a browser or execute another command.
export function execFile(command: string, args: string[], _options: unknown, callback: (error: Error | null) => void) {
    if (command !== "/usr/bin/open") throw new Error("Unexpected child process request");
    record({ kind: "browser", url: args[0] });
    callback(scenario().browserError ? new Error("Test browser could not open") : null);
}

const defaultData: Record<string, unknown> = {
  TODOIST_CREATE_TASK: { id: "task_new", content: "Buy milk" },
  TODOIST_UPDATE_TASK: { id: "task_1", content: "Updated task" },
  TODOIST_CLOSE_TASK_V1: {},
  TODOIST_GET_ALL_TASKS: { results: [{ id: "task_1", content: "Buy milk" }], next_cursor: null },
  TODOIST_CREATE_PROJECT2: { id: "project_new", name: "Test project" },
  TODOIST_DELETE_PROJECT2: {},
  TODOIST_CREATE_SECTION_V1: { id: "section_new", name: "Test section" },
  TODOIST_DELETE_SECTION2: {},
  TODOIST_GET_ALL_PROJECTS: { results: [{ id: "project_1", name: "Home" }], next_cursor: null },
  TODOIST_LIST_SECTIONS: { results: [{ id: "section_1", name: "Errands" }], next_cursor: null },
  TODOIST_GET_PRODUCTIVITY_STATS: { karma: 225, completed_count: 21 },
  TODOIST_LIST_LABELS: { results: [{ id: "label_1", name: "read" }], next_cursor: null },
  TODOIST_CREATE_LABEL_V1: { id: "label_new", name: "test_label" },
  TODOIST_UPDATE_LABEL_V1_SECOND: { id: "label_1", name: "renamed" },
  TODOIST_DELETE_LABEL_V1: {},
};

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const path = url.pathname;
  const text = await request.text();
  const body = text ? JSON.parse(text) : undefined;
  const config = scenario();
  // A future release must not trigger an SDK notice on the MCP stdout channel.
  if (url.origin === "https://registry.npmjs.org" && path === "/@composio/core/latest") {
    record({ kind: "version-check", path });
    return respond({ version: "99.0.0" });
  }
  record({ kind: "request", path, method: request.method, body });

  if (url.origin !== "https://backend.composio.dev") {
    record({ kind: "unexpected", path });
    throw new Error("Unexpected network origin blocked by the Todoist test harness");
  }

  const account = path.match(/^\/api\/v3(?:\.1)?\/connected_accounts\/([^/]+)$/);
  if (account && request.method === "GET") {
    // Connect first checks the saved account, then looks up the pending link.
    const events = recordedEvents();
    const lookups = events
      .filter(event => event.kind === "request" && event.path === path && event.method === "GET");
    if ((config.stallPendingLookup && account[1] === "ca_pending" && lookups.length === 2)
      || (config.stallOAuthLookup && events.some(event => event.kind === "browser"))) {
      return await waitForAbort(request);
    }
    return config.accountHttpStatus
      ? respond({ message: "Test connected-account lookup failed" }, config.accountHttpStatus)
      : respond(rawAccount(account[1]));
  }
  const revoke = path.match(/^\/api\/v3(?:\.1)?\/connected_accounts\/([^/]+)\/revoke$/);
  if (revoke && request.method === "POST") {
    return config.revokeHttpStatus
      ? respond({ message: "Test revocation unavailable" }, config.revokeHttpStatus)
      : respond({ revoked_tokens: true, connected_account: { id: revoke[1], status: "REVOKED" } });
  }
  if (/^\/api\/v3(?:\.1)?\/connected_accounts\/[^/]+\/status$/.test(path) && request.method === "PATCH") {
    return config.disableHttpStatus
      ? respond({ message: "Test disabling unavailable" }, config.disableHttpStatus)
      : respond({ success: true });
  }
  if (/^\/api\/v3(?:\.1)?\/tool_router\/session$/.test(path) && request.method === "POST") {
    return respond({ session_id: "session_test", config: {}, mcp: { type: "http", url: "https://backend.composio.dev/test-mcp" } });
  }
  if (/^\/api\/v3(?:\.1)?\/tool_router\/session\/session_test\/link$/.test(path)) {
    return respond({ connected_account_id: "ca_pending", redirect_url: config.redirectUrl ?? "https://example.invalid/authorize" });
  }

  const definition = path.match(/^\/api\/v3(?:\.1)?\/tools\/([A-Z0-9_]+)$/)?.[1];
  if (definition && Object.hasOwn(defaultData, definition) && request.method === "GET") {
    return respond({
      slug: definition, name: definition, description: "Offline Todoist tool fixture",
      toolkit: { slug: "todoist", name: "Todoist" },
      input_parameters: { type: "object", properties: {} },
      output_parameters: { type: "object", properties: {} },
      version: "20260731_00", tags: [], is_no_auth: false,
    });
  }

  const operation = path.match(/^\/api\/v3(?:\.1)?\/tools\/execute\/([A-Z0-9_]+)$/)?.[1];
  if (operation && Object.hasOwn(defaultData, operation) && request.method === "POST") {
    if (config.operationTimeout) throw new DOMException("Test request timed out", "TimeoutError");
    return respond(config.operationError
      ? { successful: false, error: config.operationError, data: {} }
      : { successful: true, error: null, data: Object.hasOwn(config, "responseData") ? config.responseData : defaultData[operation] });
  }

  record({ kind: "unexpected", path });
  throw new Error(`Unexpected Composio request blocked: ${request.method} ${path}`);
}) as typeof fetch;
