// Preloaded only in the isolated child server: no real network or browser access.
import { appendFileSync, readFileSync } from "node:fs";

export type Scenario = {
  accountStatus?: string;
  accountDisabled?: boolean;
  accountToolkit?: string;
  accountHttpStatus?: number;
  activateAfterBrowser?: boolean;
  browserError?: boolean;
  redirectUrl?: string;
  revokeHttpStatus?: number;
  revokeStatus?: string;
  disableHttpStatus?: number;
  errorMessage?: string;
  watchBackgroundConnect?: boolean;
  pollIntervalMs?: number;
  failColumn?: string;
  toolData?: Record<string, unknown>;
  toolDataByAction?: Record<string, Record<string, unknown>>;
  userPages?: Record<number, Record<string, unknown>[]>;
  toolSuccessful?: boolean;
  toolError?: string;
  toolHttpStatus?: number;
};
export type Event = { kind: "request" | "browser" | "unexpected" | "version-check"; path?: string; method?: string; body?: Record<string, unknown>; url?: string; version?: string | null };
const scenarioPath = process.env.MONDAY_TEST_SCENARIO;
const eventsPath = process.env.MONDAY_TEST_EVENTS;
if (!scenarioPath || !eventsPath) throw new Error("This preload is only for the isolated Monday.com tests.");
const scenario = (): Scenario => JSON.parse(readFileSync(scenarioPath, "utf8"));
function record(event: Event) { appendFileSync(eventsPath!, JSON.stringify(event) + "\n"); }
const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json" },
});
const toolNames = "MONDAY_BOARDS|MONDAY_GET_ITEMS|MONDAY_ITEMS_PAGE|MONDAY_LIST_GROUPS|MONDAY_COLUMNS|MONDAY_LIST_USERS|MONDAY_GET_TEAMS|MONDAY_CREATE_ITEM|MONDAY_UPDATE_ITEM|MONDAY_CREATE_UPDATE|MONDAY_CREATE_BOARD";

export function execFile(command: string, args: string[], _options: unknown, callback: (error: Error | null) => void) {
  if (command !== "/usr/bin/open") throw new Error("Unexpected child process request");
  record({ kind: "browser", url: args[0] });
  callback(scenario().browserError ? new Error("Test browser could not open") : null);
}

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
  record({ kind: "request", path, method: request.method, body, ...(path.includes("/tools/") ? { version: url.searchParams.get("version") } : {}) });
  if (url.origin === "https://backend.composio.dev") {
    const tool = path.match(new RegExp(`^/api/v3\\.1/tools/(${toolNames})$`));
    if (tool && request.method === "GET") {
      return respond({
        slug: tool[1], name: tool[1], description: "Offline read tool", version: "20261101_00",
        toolkit: { slug: "monday", name: "Monday" },
        input_parameters: { type: "object", properties: {} }, output_parameters: { type: "object", properties: {} },
        tags: ["readOnlyHint"],
      });
    }
    const execute = path.match(new RegExp(`^/api/v3\\.1/tools/execute/(${toolNames})$`));
    if (execute && request.method === "POST") {
      return config.failColumn && body?.arguments?.column_id === config.failColumn
        ? respond({ successful: false, error: "Column permission denied", data: {} })
        : config.toolHttpStatus
        ? respond({ message: config.errorMessage ?? "Test tool unavailable" }, config.toolHttpStatus)
        : respond({
          successful: config.toolSuccessful ?? true, error: config.toolError ?? null,
          data: config.toolDataByAction?.[execute[1]] ?? config.toolData ?? (execute[1] === "MONDAY_LIST_USERS"
            ? { users: config.userPages?.[body?.arguments?.page] ?? [] }
            : execute[1] === "MONDAY_BOARDS" ? { boards: [] }
            : execute[1] === "MONDAY_GET_ITEMS" ? { items: [] } : { items: [], cursor: null }),
        });
    }
    const account = path.match(/^\/api\/v3(?:\.1)?\/connected_accounts\/([^/]+)$/);
    if (account && request.method === "GET") {
      const opened = readFileSync(eventsPath!, "utf8").includes('"kind":"browser"');
      return config.accountHttpStatus
        ? respond({ message: config.errorMessage ?? "Test account lookup failed" }, config.accountHttpStatus)
        : respond({
          id: account[1],
          auth_config: { id: "ac_test", auth_scheme: "OAUTH2", is_composio_managed: true, is_disabled: false },
          toolkit: { slug: config.accountToolkit ?? "monday" },
          status: config.activateAfterBrowser && opened ? "ACTIVE" : config.accountStatus ?? "ACTIVE",
          status_reason: null, is_disabled: config.accountDisabled ?? false,
          created_at: "2026-11-04T00:00:00Z", updated_at: "2026-11-04T00:00:00Z",
        });
    }
    const revoke = path.match(/^\/api\/v3(?:\.1)?\/connected_accounts\/([^/]+)\/revoke$/);
    if (revoke && request.method === "POST") {
      return config.revokeHttpStatus
        ? respond({ message: config.errorMessage ?? "Test revocation unavailable" }, config.revokeHttpStatus)
        : respond({ revoked_tokens: true, connected_account: { id: revoke[1], status: config.revokeStatus ?? "REVOKED" } });
    }
    if (/^\/api\/v3(?:\.1)?\/connected_accounts\/[^/]+\/status$/.test(path) && request.method === "PATCH") {
      return config.disableHttpStatus ? respond({ message: "Test disable failed" }, config.disableHttpStatus) : respond({ success: true });
    }
    if (/^\/api\/v3(?:\.1)?\/tool_router\/session$/.test(path) && request.method === "POST") {
      return respond({ session_id: "session_test", config: {}, mcp: { type: "http", url: "https://backend.composio.dev/test-mcp" } });
    }
    if (/^\/api\/v3(?:\.1)?\/tool_router\/session\/session_test\/link$/.test(path) && request.method === "POST") {
      return respond({ connected_account_id: "ca_pending", redirect_url: config.redirectUrl ?? "https://example.invalid/monday-consent" });
    }
  }
  record({ kind: "unexpected", path });
  throw new Error(`Unexpected network request blocked: ${request.method} ${url.origin}${path}`);
}) as typeof fetch;
