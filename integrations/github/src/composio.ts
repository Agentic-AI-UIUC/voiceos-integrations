/**
 * Composio Platform, v3.1: REST for sessions, Connect Links, connected
 * accounts and auth configs; the session's MCP endpoint for tool execution.
 *
 * The project API key lives only in this process. It is sent to exactly one
 * origin (backend.composio.dev, or a loopback test server), never across a
 * redirect, and never reaches the model, a card, or a log line.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { APPROVED, UPSTREAM_SNAPSHOT, schemaHash, type Slug } from "./catalog.ts";
import { GithubError, sanitizeDetail } from "./errors.ts";

export const DEFAULT_BASE_URL = "https://backend.composio.dev";
export const CLIENT_VERSION = "2.5.2";

/** Only loopback overrides are honoured — a test seam that can't exfiltrate the key. */
export function resolveBaseUrl(override: string | undefined): string {
  if (!override) return DEFAULT_BASE_URL;
  try {
    const url = new URL(override);
    if ((url.protocol === "http:" || url.protocol === "https:") && (url.hostname === "127.0.0.1" || url.hostname === "localhost")) {
      return url.origin;
    }
  } catch {
    // fall through
  }
  console.error("[github] ignoring --composio-base-url: only loopback test servers are allowed");
  return DEFAULT_BASE_URL;
}

/**
 * The plan's direct-tools session: exactly the eight approved tools preloaded,
 * and every broader capability explicitly off — connection-management and
 * search meta tools, the sandbox, raw proxy calls, multi-execute, and
 * "instant" execution on Composio-owned provider accounts.
 */
export function sessionBody(input: { userId: string; authConfigId?: string; accountId?: string }) {
  return {
    user_id: input.userId,
    toolkits: { enable: ["github"] },
    tools: { github: { enable: Object.values(APPROVED) } },
    manage_connections: { enable: false },
    workbench: { enable: false },
    proxy_execute: { enable: false },
    instant: false,
    preload: { tools: "all" },
    search: { enable: false },
    execute: { enable_multi_execute: false },
    ...(input.authConfigId ? { auth_configs: { github: input.authConfigId } } : {}),
    ...(input.accountId ? { connected_accounts: { github: [input.accountId] } } : {}),
  };
}

export class ComposioHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly slug?: string,
  ) {
    super(message);
    this.name = "ComposioHttpError";
  }
}

export interface AccountInfo {
  id: string;
  status: string;
  userId?: string;
  authConfigId?: string;
  requestedScopes: string[];
  displayName?: string;
  createdAt?: string;
}

export interface AuthConfigInfo {
  id: string;
  name: string;
  scopes: string[];
  isComposioManaged: boolean;
  status?: string;
}

const scopesOf = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.map(String).map((s) => s.trim()).filter(Boolean)
    : typeof value === "string"
      ? value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean)
      : [];

function toAccount(raw: any): AccountInfo {
  const displayName = raw?.state?.val?.displayName;
  return {
    id: String(raw?.id ?? ""),
    status: String(raw?.status ?? "UNKNOWN"),
    userId: typeof raw?.user_id === "string" ? raw.user_id : undefined,
    authConfigId: typeof raw?.auth_config?.id === "string" ? raw.auth_config.id : undefined,
    requestedScopes: scopesOf(raw?.requested_scopes),
    displayName: typeof displayName === "string" && displayName.trim() ? displayName.trim().slice(0, 80) : undefined,
    createdAt: typeof raw?.created_at === "string" ? raw.created_at : undefined,
  };
}

function toAuthConfig(raw: any): AuthConfigInfo {
  return {
    id: String(raw?.id ?? ""),
    name: String(raw?.name ?? ""),
    scopes: scopesOf(raw?.credentials?.scopes ?? raw?.scopes),
    isComposioManaged: raw?.is_composio_managed === true,
    status: typeof raw?.status === "string" ? raw.status : undefined,
  };
}

export class ComposioRest {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: { apiKey: string; baseUrl: string; timeoutMs?: number }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: { "x-api-key": this.apiKey, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timedOut = (error as Error)?.name === "TimeoutError";
      throw new ComposioHttpError(0, timedOut ? "Composio did not respond in time." : "Composio could not be reached.");
    }
    const text = await res.text();
    let parsed: any;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = undefined;
    }
    if (!res.ok) {
      const message = parsed?.error?.message ?? parsed?.message ?? `HTTP ${res.status}`;
      throw new ComposioHttpError(res.status, sanitizeDetail(message), parsed?.error?.slug);
    }
    if (parsed === undefined) throw new ComposioHttpError(res.status, "Composio returned a response this integration could not read.");
    return parsed;
  }

  async createSession(body: ReturnType<typeof sessionBody>): Promise<{ session_id: string; mcp: { url: string } }> {
    const res = await this.request("POST", "/api/v3.1/tool_router/session", body);
    if (typeof res?.session_id !== "string" || typeof res?.mcp?.url !== "string") {
      throw new ComposioHttpError(200, "Composio returned a session without an MCP endpoint.");
    }
    return { session_id: res.session_id, mcp: { url: res.mcp.url } };
  }

  async getSession(id: string): Promise<unknown> {
    return this.request("GET", `/api/v3.1/tool_router/session/${encodeURIComponent(id)}`);
  }

  async deleteSession(id: string): Promise<void> {
    await this.request("DELETE", `/api/v3.1/tool_router/session/${encodeURIComponent(id)}`);
  }

  async createLink(sessionId: string): Promise<{ redirect_url: string; connected_account_id: string }> {
    const res = await this.request("POST", `/api/v3.1/tool_router/session/${encodeURIComponent(sessionId)}/link`, { toolkit: "github" });
    if (typeof res?.redirect_url !== "string" || typeof res?.connected_account_id !== "string") {
      throw new ComposioHttpError(200, "Composio returned a connect link without an account.");
    }
    return { redirect_url: res.redirect_url, connected_account_id: res.connected_account_id };
  }

  async getAccount(id: string): Promise<AccountInfo> {
    return toAccount(await this.request("GET", `/api/v3.1/connected_accounts/${encodeURIComponent(id)}`));
  }

  async listAccounts(filter: { userIds: string[]; statuses?: string[]; authConfigIds?: string[] }): Promise<AccountInfo[]> {
    const params = new URLSearchParams({ user_ids: filter.userIds.join(","), toolkit_slugs: "github" });
    if (filter.statuses?.length) params.set("statuses", filter.statuses.join(","));
    if (filter.authConfigIds?.length) params.set("auth_config_ids", filter.authConfigIds.join(","));
    const res = await this.request("GET", `/api/v3.1/connected_accounts?${params}`);
    return (Array.isArray(res?.items) ? res.items : []).map(toAccount);
  }

  async revokeAccount(id: string): Promise<{ revokedTokens: string[]; status: string }> {
    const res = await this.request("POST", `/api/v3.1/connected_accounts/${encodeURIComponent(id)}/revoke`, {});
    return { revokedTokens: Array.isArray(res?.revoked_tokens) ? res.revoked_tokens.map(String) : [], status: String(res?.connected_account?.status ?? "") };
  }

  async deleteAccount(id: string): Promise<void> {
    await this.request("DELETE", `/api/v3.1/connected_accounts/${encodeURIComponent(id)}`);
  }

  async listAuthConfigs(search?: string): Promise<AuthConfigInfo[]> {
    const params = new URLSearchParams({ toolkit_slug: "github" });
    if (search) params.set("search", search);
    const res = await this.request("GET", `/api/v3.1/auth_configs?${params}`);
    return (Array.isArray(res?.items) ? res.items : []).map(toAuthConfig);
  }

  async getAuthConfig(id: string): Promise<AuthConfigInfo> {
    return toAuthConfig(await this.request("GET", `/api/v3.1/auth_configs/${encodeURIComponent(id)}`));
  }

  async createManagedAuthConfig(name: string, scopes: string[]): Promise<string> {
    const res = await this.request("POST", "/api/v3.1/auth_configs", {
      toolkit: { slug: "github" },
      auth_config: { type: "use_composio_managed_auth", name, credentials: { scopes: scopes.join(",") } },
    });
    const id = res?.auth_config?.id ?? res?.id;
    if (typeof id !== "string") throw new ComposioHttpError(200, "Composio created an auth config without an id.");
    return id;
  }
}

// ---------------------------------------------------------------------------
// Upstream MCP
// ---------------------------------------------------------------------------

type Expect = { type: "string" | "integer" | "array"; enum?: string[] };
const s: Expect = { type: "string" };
const i: Expect = { type: "integer" };
const a: Expect = { type: "array" };

/** Every field this integration may send, per tool, and the fields it always sends. */
const EXPECTED_INPUTS: Record<Slug, { fields: Record<string, Expect>; always: string[] }> = {
  GITHUB_CREATE_AN_ISSUE: { fields: { owner: s, repo: s, title: s, body: s, labels: a, assignees: a }, always: ["owner", "repo", "title"] },
  GITHUB_UPDATE_AN_ISSUE: {
    fields: {
      owner: s, repo: s, issue_number: i, title: s, body: s,
      state: { type: "string", enum: ["open", "closed"] },
      state_reason: { type: "string", enum: ["completed", "not_planned", "reopened"] },
      labels: a, assignees: a,
    },
    always: ["owner", "repo", "issue_number"],
  },
  GITHUB_GET_AN_ISSUE: { fields: { owner: s, repo: s, issue_number: i }, always: ["owner", "repo", "issue_number"] },
  GITHUB_CREATE_AN_ISSUE_COMMENT: { fields: { owner: s, repo: s, issue_number: i, body: s }, always: ["owner", "repo", "issue_number", "body"] },
  GITHUB_LIST_PULL_REQUESTS: {
    fields: {
      owner: s, repo: s,
      state: { type: "string", enum: ["open", "closed", "all"] },
      base: s, head: s,
      sort: { type: "string", enum: ["created", "updated", "popularity", "long-running"] },
      direction: { type: "string", enum: ["asc", "desc"] },
      page: i, per_page: i,
    },
    always: ["owner", "repo"],
  },
  GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST: {
    fields: {
      owner: s, repo: s, pull_number: i,
      event: { type: "string", enum: ["APPROVE", "REQUEST_CHANGES", "COMMENT"] },
      body: s, commit_id: s,
    },
    always: ["owner", "repo", "pull_number", "event", "commit_id"],
  },
  GITHUB_SEARCH_REPOSITORIES: {
    fields: {
      q: s,
      sort: { type: "string", enum: ["stars", "forks", "help-wanted-issues", "updated", "created"] },
      order: { type: "string", enum: ["desc", "asc"] },
      page: i, per_page: i,
    },
    always: ["q"],
  },
  GITHUB_SEARCH_CODE: { fields: { q: s, page: i, per_page: i }, always: ["q"] },
};

function typesOf(schema: any): Set<string> {
  const out = new Set<string>();
  const add = (node: any) => {
    if (!node || typeof node !== "object") return;
    if (typeof node.type === "string") out.add(node.type);
    if (Array.isArray(node.type)) node.type.forEach((t: unknown) => out.add(String(t)));
    if (!node.type && Array.isArray(node.enum)) out.add("string");
    for (const key of ["anyOf", "oneOf", "allOf"]) if (Array.isArray(node[key])) node[key].forEach(add);
  };
  add(schema);
  return out;
}

/** Why an upstream schema no longer fits what this integration sends, or null. */
export function checkToolSchema(slug: Slug, schema: any): string | null {
  const expected = EXPECTED_INPUTS[slug];
  const props = schema && typeof schema.properties === "object" ? schema.properties : {};
  for (const [name, want] of Object.entries(expected.fields)) {
    const prop = props[name];
    if (!prop) return `${name} was removed`;
    const types = typesOf(prop);
    const fits = want.type === "integer" ? types.has("integer") || types.has("number") : types.has(want.type);
    if (!fits) return `${name} changed type (expected ${want.type})`;
    if (want.enum && Array.isArray(prop.enum)) {
      const lost = want.enum.filter((v) => !prop.enum.includes(v));
      if (lost.length) return `${name} no longer accepts ${lost.join(", ")}`;
    }
  }
  const required: unknown[] = Array.isArray(schema?.required) ? schema.required : [];
  for (const name of required) {
    if (!expected.always.includes(String(name))) return `now requires ${String(name)}, which this integration never sends`;
  }
  return null;
}

export interface CatalogCheck {
  ok: boolean;
  missing: string[];
  unexpected: string[];
  drift: Record<string, string>;
  /** Approved tools whose schema differs from the recorded snapshot (for review; drift decides usability). */
  changed: string[];
}

export class UpstreamCallError extends Error {
  constructor(
    /** not_sent: refused before any request left (connection retired), so GitHub can't have acted. */
    readonly kind: "timeout" | "transport" | "not_sent",
    message: string,
  ) {
    super(message);
    this.name = "UpstreamCallError";
  }
}

/** Composio refused the key itself: nothing ran. */
function keyRejected(status: unknown): GithubError | undefined {
  if (status === 401) {
    return new GithubError({ category: "composio_auth", message: "Composio rejected the project API key. Check it in VoiceOS → Integrations → GitHub → Configure." });
  }
  if (status === 403) {
    return new GithubError({
      category: "composio_auth",
      message: "This Composio API key can't run GitHub actions. Use a full-access project key, or a scoped one that also allows Session tool execution (write).",
    });
  }
  return undefined;
}

export class UpstreamMcp {
  private client?: Client;
  private inflight = 0;
  private retired = false;

  constructor(
    private readonly opts: { url: string; apiKey: string; baseUrl: string; connectTimeoutMs?: number; listTimeoutMs?: number },
  ) {}

  async connect(): Promise<void> {
    let target: URL;
    try {
      target = new URL(this.opts.url);
    } catch {
      throw new GithubError({ category: "contract", message: "Composio returned an unexpected MCP address, so nothing was sent." });
    }
    const base = new URL(this.opts.baseUrl);
    if (target.origin !== base.origin || !/^\/tool_router\/[A-Za-z0-9_-]+\/mcp$/.test(target.pathname)) {
      throw new GithubError({ category: "contract", message: "Composio returned an unexpected MCP address, so nothing was sent." });
    }
    const client = new Client({ name: "voiceos-github", version: CLIENT_VERSION });
    const transport = new StreamableHTTPClientTransport(target, {
      requestInit: { headers: { "x-api-key": this.opts.apiKey }, redirect: "error" },
      redirectPolicy: "same-origin",
    });
    try {
      await client.connect(transport, { timeout: this.opts.connectTimeoutMs ?? 10_000 });
    } catch (error) {
      await client.close().catch(() => {});
      const text = String((error as Error)?.message ?? error);
      const rejected = keyRejected((error as { code?: unknown })?.code) ?? (/\b401\b|invalid api key|unauthorized/i.test(text) ? keyRejected(401) : undefined);
      if (rejected) throw rejected;
      throw new GithubError({ category: "upstream_unavailable", message: "GitHub or Composio is temporarily unavailable. Try again shortly.", retryable: true, detail: sanitizeDetail(text) });
    }
    this.client = client;
  }

  async verifyCatalog(approved: readonly string[]): Promise<CatalogCheck> {
    const client = this.requireClient();
    const tools: Array<{ name: string; inputSchema: unknown }> = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const res = await client.listTools(cursor ? { cursor } : undefined, { timeout: this.opts.listTimeoutMs ?? 10_000 });
      tools.push(...res.tools);
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    const names = tools.map((t) => t.name);
    const missing = approved.filter((slug) => !names.includes(slug));
    const unexpected = names.filter((name) => !approved.includes(name)).sort();
    const drift: Record<string, string> = {};
    const changed: string[] = [];
    for (const tool of tools) {
      if (!approved.includes(tool.name)) continue;
      const reason = checkToolSchema(tool.name as Slug, tool.inputSchema);
      if (reason) drift[tool.name] = reason;
      if (schemaHash(tool.inputSchema) !== UPSTREAM_SNAPSHOT.inputSchemaSha256[tool.name as Slug]) changed.push(tool.name);
    }
    return { ok: !missing.length && !unexpected.length && !Object.keys(drift).length, missing, unexpected, drift, changed: changed.sort() };
  }

  /** False once retired or closed: no new calls are taken. */
  get accepting(): boolean {
    return !!this.client && !this.retired;
  }

  async call(slug: Slug, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const client = this.client;
    if (!client || this.retired) throw new UpstreamCallError("not_sent", "Not connected to Composio.");
    this.inflight++;
    try {
      return await client.callTool({ name: slug, arguments: args }, undefined, { timeout: timeoutMs });
    } catch (error) {
      const e = error as { code?: number; message?: string };
      if (e?.code === -32001 || /timed out/i.test(String(e?.message))) {
        throw new UpstreamCallError("timeout", "GitHub didn't answer in time.");
      }
      // Composio answers 404 for a session it no longer has (expired, or closed
      // by another server): the request was refused before any tool ran.
      if (e?.code === 404) throw new UpstreamCallError("not_sent", "Composio's session had ended.");
      const rejected = keyRejected(e?.code);
      if (rejected) throw rejected;
      throw new UpstreamCallError("transport", sanitizeDetail(e?.message ?? String(error)));
    } finally {
      this.inflight--;
      if (this.retired && this.inflight === 0) void this.close();
    }
  }

  /**
   * Take no new calls, and close once the calls already sent have settled, so
   * one call's network failure never cuts off another call's outcome.
   */
  retire(): Promise<void> {
    this.retired = true;
    return this.inflight === 0 ? this.close() : Promise.resolve();
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    await client?.close().catch(() => {});
  }

  private requireClient(): Client {
    if (!this.client) throw new UpstreamCallError("transport", "Not connected to Composio.");
    return this.client;
  }
}
