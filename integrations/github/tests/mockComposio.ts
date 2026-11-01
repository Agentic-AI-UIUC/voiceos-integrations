/**
 * A local stand-in for Composio's v3.1 REST API and session MCP endpoint,
 * mirroring behavior observed live on 2026-10-24:
 *  - tools/list returns the recorded schemas (tests/fixtures/composio-mcp-tools-list.json),
 *    filtered to the session's enabled tools; unknown tools fail with -32602.
 *  - results are JSON text envelopes {successful, data, error}; failures set isError.
 *  - with no active pinned connection, calls fail with the live "No active connection" text.
 * Behind it sits a small fake GitHub with failure injection for every path the
 * integration must handle. Test infrastructure only.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import toolsFixture from "./fixtures/composio-mcp-tools-list.json";

export const MOCK_API_KEY = "test_project_key_0123456789";
const VIEWER = "voiceos-tester";

type Failure =
  | "bad_credentials"
  | "not_found"
  | "rate_limit"
  | "server_error"
  | "hang"
  | "successful_false"
  | "garbage"
  | "self_review"
  | { text: string; isError?: boolean };

export interface FakeIssue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  state_reason: string | null;
  labels: string[];
  assignees: string[];
  user: string;
  comments: number;
  locked: boolean;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  isPull?: boolean;
}

export interface FakePull {
  number: number;
  title: string;
  body?: string;
  state: "open" | "closed";
  draft: boolean;
  user: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  merged_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FakeRepo {
  owner: string;
  name: string;
  private: boolean;
  description: string;
  stars: number;
  language: string;
  fork?: boolean;
  updated_at?: string;
  pushed_at?: string;
  issues: Map<number, FakeIssue>;
  pulls: Map<number, FakePull>;
  nextNumber: number;
  files: Array<{ path: string; content: string; text_matches?: Array<{ fragment: string; property?: string }> }>;
  pushAccess: boolean;
}

interface Account {
  id: string;
  user_id: string;
  status: string;
  auth_config_id: string;
  requested_scopes: string[];
  displayName?: string;
  created_at: string;
  revokedAtGithub?: boolean;
}

interface Session {
  id: string;
  user_id: string;
  body: any;
  tools: string[];
  authConfigId?: string;
  pinned?: string;
}

let clock = Date.parse("2026-10-24T18:00:00Z");
const tick = () => new Date((clock += 60_000)).toISOString();
const rand = (n = 12) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");

export function makeRepo(owner: string, name: string, extra: Partial<FakeRepo> = {}): FakeRepo {
  return {
    owner,
    name,
    private: false,
    description: `${name} by ${owner}`,
    stars: 10,
    language: "TypeScript",
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    files: [],
    pushAccess: true,
    ...extra,
  };
}

export function startMockComposio() {
  const repos = new Map<string, FakeRepo>();
  const accounts = new Map<string, Account>();
  const sessions = new Map<string, Session>();
  const authConfigs = new Map<string, { id: string; name: string; scopes: string[]; is_composio_managed: boolean; created_at: string }>();
  const transports = new Map<string, WebStandardStreamableHTTPServerTransport>();
  const failures = new Map<string, Failure[]>();
  const calls: Array<{ slug: string; args: any; sessionId: string }> = [];
  const rest: Array<{ method: string; path: string; body: any }> = [];
  const extraTools: any[] = [];
  const removedTools = new Set<string>();
  const hangs: Array<() => void> = [];
  const restFailures: Array<{ match: RegExp; remaining: number; status: number }> = [];
  const transportFailures: string[] = [];
  const rewrites = new Map<string, (data: any) => any>();
  let mcpForbidden = false;
  let linkHost = "connect.composio.dev";
  const onCall = new Map<string, () => void>();
  let defaultAuthConfigScopes = ["repo", "user", "gist", "notifications", "project", "workflow", "codespace"];
  let authConfigCreateForbidden = false;

  const repoKey = (o: string, r: string) => `${o}/${r}`.toLowerCase();
  const findRepo = (o: string, r: string) => repos.get(repoKey(o, r));
  const htmlBase = (repo: FakeRepo) => `https://github.com/${repo.owner}/${repo.name}`;

  const issueJson = (repo: FakeRepo, i: FakeIssue) => ({
    id: 1000 + i.number,
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    state_reason: i.state_reason,
    locked: i.locked,
    comments: i.comments,
    labels: i.labels.map((name, idx) => ({ id: idx + 1, name, color: "ededed", default: false, node_id: `L${idx}`, url: "" })),
    assignees: i.assignees.map((login) => ({ login, html_url: `https://github.com/${login}`, type: "User" })),
    user: { login: i.user, html_url: `https://github.com/${i.user}`, type: "User" },
    html_url: `${htmlBase(repo)}/${i.isPull ? "pull" : "issues"}/${i.number}`,
    created_at: i.created_at,
    updated_at: i.updated_at,
    closed_at: i.closed_at,
    ...(i.isPull ? { pull_request: { url: "", html_url: `${htmlBase(repo)}/pull/${i.number}`, diff_url: "", patch_url: "" } } : {}),
  });

  const pullJson = (repo: FakeRepo, p: FakePull) => ({
    id: 5000 + p.number,
    number: p.number,
    title: p.title,
    ...(p.body !== undefined ? { body: p.body } : {}),
    state: p.state,
    draft: p.draft,
    user: { login: p.user, id: 1, html_url: `https://github.com/${p.user}`, avatar_url: "", type: "User" },
    head: { ref: p.head.ref, sha: p.head.sha, label: `${repo.owner}:${p.head.ref}` },
    base: { ref: p.base.ref, sha: "0".repeat(40), label: `${repo.owner}:${p.base.ref}` },
    html_url: `${htmlBase(repo)}/pull/${p.number}`,
    merged_at: p.merged_at,
    closed_at: p.state === "closed" ? p.updated_at : null,
    created_at: p.created_at,
    updated_at: p.updated_at,
    author_association: "MEMBER",
    labels: [],
    requested_reviewers: [],
  });

  const ok = (data: unknown) => ({
    content: [{ type: "text", text: JSON.stringify({ successful: true, data, error: null, log_id: `log_${rand(6)}` }) }],
  });
  const fail = (message: string) => ({
    content: [{ type: "text", text: JSON.stringify({ successful: false, data: { error: message }, error: message }) }],
    isError: true,
  });

  async function runFailure(f: Failure) {
    if (f === "hang") {
      await new Promise<void>((resolve) => hangs.push(resolve));
      return fail("hung call released");
    }
    if (f === "bad_credentials") return fail("401 Client Error: Unauthorized: Bad credentials");
    if (f === "not_found") return fail("404 Client Error: Not Found");
    if (f === "rate_limit") return fail("403 Client Error: API rate limit exceeded for user. Retry-After: 30");
    if (f === "server_error") return fail("502 Server Error: Bad Gateway");
    if (f === "self_review") return fail("422 Client Error: Unprocessable Entity: Can not approve your own pull request");
    if (f === "successful_false") return { content: [{ type: "text", text: JSON.stringify({ successful: false, data: {}, error: "Validation Failed" }) }] };
    if (f === "garbage") return { content: [{ type: "text", text: "<html>oops</html>" }] };
    return { content: [{ type: "text", text: f.text }], ...(f.isError === false ? {} : { isError: true }) };
  }

  function github(slug: string, a: any) {
    const repo = a.owner && a.repo ? findRepo(a.owner, a.repo) : undefined;
    const needRepo = () => {
      if (!repo) throw new Error("404 Client Error: Not Found for url: https://api.github.com/repos/x/y");
      return repo;
    };
    switch (slug) {
      case "GITHUB_GET_AN_ISSUE": {
        const r = needRepo();
        const issue = r.issues.get(Number(a.issue_number));
        if (!issue) throw new Error("404 Client Error: Not Found");
        return issueJson(r, issue);
      }
      case "GITHUB_CREATE_AN_ISSUE": {
        const r = needRepo();
        const number = r.nextNumber++;
        const at = tick();
        const issue: FakeIssue = {
          number, title: a.title, body: a.body ?? "", state: "open", state_reason: null,
          labels: r.pushAccess ? a.labels ?? [] : [], assignees: r.pushAccess ? a.assignees ?? [] : [],
          user: VIEWER, comments: 0, locked: false, created_at: at, updated_at: at, closed_at: null,
        };
        r.issues.set(number, issue);
        return issueJson(r, issue);
      }
      case "GITHUB_UPDATE_AN_ISSUE": {
        const r = needRepo();
        const issue = r.issues.get(Number(a.issue_number));
        if (!issue) throw new Error("404 Client Error: Not Found");
        if (a.title !== undefined) issue.title = a.title;
        if (a.body !== undefined) issue.body = a.body ?? "";
        if (a.state !== undefined) {
          issue.state = a.state;
          issue.closed_at = a.state === "closed" ? tick() : null;
          issue.state_reason = a.state_reason ?? (a.state === "closed" ? "completed" : "reopened");
        }
        if (a.labels !== undefined && r.pushAccess) issue.labels = a.labels;
        if (a.assignees !== undefined && r.pushAccess) issue.assignees = a.assignees;
        issue.updated_at = tick();
        return issueJson(r, issue);
      }
      case "GITHUB_CREATE_AN_ISSUE_COMMENT": {
        const r = needRepo();
        const issue = r.issues.get(Number(a.issue_number));
        if (!issue) throw new Error("404 Client Error: Not Found");
        issue.comments++;
        issue.updated_at = tick();
        const id = 9000 + issue.comments;
        return {
          id, body: a.body, user: { login: VIEWER, type: "User" }, created_at: issue.updated_at, updated_at: issue.updated_at,
          html_url: `${htmlBase(r)}/${issue.isPull ? "pull" : "issues"}/${issue.number}#issuecomment-${id}`,
          issue_url: "", author_association: "MEMBER", node_id: "C", url: "",
        };
      }
      case "GITHUB_LIST_PULL_REQUESTS": {
        const r = needRepo();
        let list = [...r.pulls.values()];
        const state = a.state ?? "open";
        if (state !== "all") list = list.filter((p) => p.state === state);
        if (a.base) list = list.filter((p) => p.base.ref === a.base);
        if (a.head) list = list.filter((p) => p.head.ref === String(a.head).split(":").pop());
        const sortKey = a.sort === "updated" ? "updated_at" : "created_at";
        list.sort((x, y) => (x[sortKey] < y[sortKey] ? -1 : 1));
        if ((a.direction ?? "desc") === "desc") list.reverse();
        const per = a.per_page ?? 30;
        const page = a.page ?? 1;
        return { pull_requests: list.slice((page - 1) * per, page * per).map((p) => pullJson(r, p)) };
      }
      case "GITHUB_CREATE_A_REVIEW_FOR_A_PULL_REQUEST": {
        const r = needRepo();
        const pr = r.pulls.get(Number(a.pull_number));
        if (!pr) throw new Error("404 Client Error: Not Found");
        if (!a.event) return { id: 77, state: "PENDING", body: a.body ?? "", commit_id: a.commit_id ?? pr.head.sha, html_url: `${htmlBase(r)}/pull/${pr.number}#pullrequestreview-77`, user: { login: VIEWER } };
        if (pr.user === VIEWER && a.event !== "COMMENT") throw new Error("422 Client Error: Unprocessable Entity: Can not approve your own pull request");
        const state = { APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" }[a.event as string];
        return {
          id: 88, state, body: a.body ?? "", commit_id: a.commit_id ?? pr.head.sha, submitted_at: tick(),
          html_url: `${htmlBase(r)}/pull/${pr.number}#pullrequestreview-88`, user: { login: VIEWER, type: "User" },
          pull_request_url: "", author_association: "MEMBER", node_id: "R", _links: {},
        };
      }
      case "GITHUB_SEARCH_REPOSITORIES": {
        const terms = String(a.q).toLowerCase().split(/\s+/).filter((t) => t && !t.includes(":"));
        const qualifiers = Object.fromEntries([...String(a.q).matchAll(/\b(user|org|language|fork|is):([^\s]+)/gi)].map((m) => [m[1].toLowerCase(), m[2].toLowerCase()]));
        // GitHub reads user:@me as the signed-in account.
        const ownerQualifier = (qualifiers.user ?? qualifiers.org) === "@me" ? VIEWER.toLowerCase() : qualifiers.user ?? qualifiers.org;
        const hits = [...repos.values()].filter((r) =>
          terms.every((t) => `${r.owner}/${r.name} ${r.description}`.toLowerCase().includes(t)) &&
          (!ownerQualifier || r.owner.toLowerCase() === ownerQualifier) &&
          (!qualifiers.language || r.language.toLowerCase() === qualifiers.language) &&
          (qualifiers.fork === "only" ? r.fork : qualifiers.fork === "true" || !r.fork) &&
          (!qualifiers.is || (qualifiers.is === "private" ? r.private : !r.private))
        );
        if (a.sort === "updated") hits.sort((x, y) => (x.updated_at ?? "").localeCompare(y.updated_at ?? "") * (a.order === "asc" ? 1 : -1));
        if (a.sort === "stars") hits.sort((x, y) => (x.stars - y.stars) * (a.order === "asc" ? 1 : -1));
        const per = a.per_page ?? 30;
        const page = a.page ?? 1;
        return {
          total_count: hits.length,
          incomplete_results: false,
          items: hits.slice((page - 1) * per, page * per).map((r) => ({
            id: 1, name: r.name, full_name: `${r.owner}/${r.name}`, private: r.private, html_url: htmlBase(r),
            description: r.description, stargazers_count: r.stars, forks_count: 2, language: r.language,
            updated_at: r.updated_at ?? "2026-10-20T00:00:00Z", pushed_at: r.pushed_at ?? "2026-10-20T00:00:00Z", archived: false, fork: r.fork ?? false,
            // Like GitHub's, the count includes open pull requests.
            open_issues_count: [...r.issues.values()].filter((i) => i.state === "open").length,
            owner: { login: r.owner }, default_branch: "main", score: 1,
          })),
        };
      }
      case "GITHUB_SEARCH_CODE": {
        const tokens = String(a.q).split(/\s+/).filter(Boolean);
        const repoFilter = tokens.find((t) => t.startsWith("repo:"))?.slice(5).toLowerCase();
        // Like GitHub (checked live 2026-10-28): code search scoped to a repository that doesn't exist finds nothing
        // and says the results are incomplete; it isn't refused. Repository search refuses it with 422.
        if (repoFilter && !repos.has(repoFilter)) return { total_count: 0, incomplete_results: true, items: [] };
        const terms = tokens.filter((t) => !t.includes(":")).map((t) => t.toLowerCase());
        const hits: any[] = [];
        for (const r of repos.values()) {
          if (repoFilter && repoKey(r.owner, r.name) !== repoFilter) continue;
          for (const f of r.files) {
            if (terms.every((t) => f.content.toLowerCase().includes(t))) {
              hits.push({
                name: f.path.split("/").pop(), path: f.path, sha: "1".repeat(40), score: 1, url: "", git_url: "",
                html_url: `${htmlBase(r)}/blob/main/${f.path}`,
                ...(f.text_matches ? { text_matches: f.text_matches } : {}),
                repository: { id: 1, name: r.name, full_name: `${r.owner}/${r.name}`, private: r.private, html_url: htmlBase(r), owner: { login: r.owner } },
              });
            }
          }
        }
        const page = a.page ?? 1;
        const per = a.per_page ?? 30;
        return { total_count: hits.length, incomplete_results: false, items: hits.slice((page - 1) * per, page * per) };
      }
      default:
        throw new Error(`MCP error -32602: Tool ${slug} not found`);
    }
  }

  function listedTools(session: Session) {
    const base = (toolsFixture.tools as any[]).filter((t) => session.tools.includes(t.name) && !removedTools.has(t.name));
    return [...base, ...extraTools];
  }

  function mcpServerFor(session: Session) {
    const server = new Server({ name: "mcp-typescript server on vercel", version: "0.1.0" }, { capabilities: { tools: { listChanged: true } } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listedTools(session) }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const slug = req.params.name;
      const args = req.params.arguments ?? {};
      if (!listedTools(session).some((t) => t.name === slug)) {
        return { content: [{ type: "text", text: `MCP error -32602: Tool ${slug} not found` }], isError: true };
      }
      calls.push({ slug, args, sessionId: session.id });
      const hook = onCall.get(slug);
      if (hook) {
        onCall.delete(slug);
        hook();
      }
      const queued = failures.get(slug);
      if (queued?.length) return runFailure(queued.shift()!);
      const account = session.pinned ? accounts.get(session.pinned) : undefined;
      if (!account || account.status !== "ACTIVE") {
        return fail("No active connection found for toolkit(s) 'github' in this session.");
      }
      if (account.revokedAtGithub) return fail("401 Client Error: Unauthorized: Bad credentials");
      try {
        const data = github(slug, args);
        const rewrite = rewrites.get(slug);
        if (rewrite) rewrites.delete(slug);
        return ok(rewrite ? rewrite(structuredClone(data)) : data);
      } catch (error) {
        return fail((error as Error).message);
      }
    });
    return server;
  }

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const apiError = (status: number, message: string, slug = "Error") =>
    json(status, { error: { message, code: status, slug, status, request_id: rand() } });

  const accountJson = (a: Account) => ({
    id: a.id,
    status: a.status,
    user_id: a.user_id,
    toolkit: { slug: "github" },
    auth_config: { id: a.auth_config_id, auth_scheme: "OAUTH2", is_composio_managed: true, is_disabled: false },
    requested_scopes: a.requested_scopes,
    state: { authScheme: "OAUTH2", val: { status: a.status, ...(a.displayName ? { displayName: a.displayName } : {}), oauth_token: "gho_secret_should_never_leak" } },
    status_reason: null,
    is_disabled: false,
    created_at: a.created_at,
    updated_at: a.created_at,
  });

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const body = req.method === "POST" || req.method === "PATCH" ? await req.clone().json().catch(() => undefined) : undefined;
    if (!path.includes("/mcp")) rest.push({ method: req.method, path: path + url.search, body });
    if (req.headers.get("x-api-key") !== MOCK_API_KEY) {
      return apiError(401, `Invalid API key: ${String(req.headers.get("x-api-key") ?? "").slice(0, 3)}**`, "APIKey_InvalidAPIKey");
    }
    const restFailure = path.includes("/mcp") ? undefined : restFailures.find((f) => f.remaining > 0 && f.match.test(path));
    if (restFailure) {
      restFailure.remaining--;
      return apiError(restFailure.status, "Service temporarily unavailable");
    }

    const mcp = path.match(/^\/tool_router\/([^/]+)\/mcp$/);
    if (mcp && mcpForbidden) {
      return apiError(403, `This API key does not have the permissions required for POST /tool_router/${mcp[1]}/mcp. This route requires: session_tool_execution:write`);
    }
    if (mcp) {
      const session = sessions.get(mcp[1]);
      if (!session) return apiError(404, "Session not found");
      const queued = body?.method === "tools/call" ? transportFailures.indexOf(body?.params?.name) : -1;
      if (queued !== -1) {
        transportFailures.splice(queued, 1);
        return new Response("upstream connection reset", { status: 502 });
      }
      const sid = req.headers.get("mcp-session-id");
      let transport = sid ? transports.get(sid) : undefined;
      if (!transport) {
        if (sid) return json(404, { jsonrpc: "2.0", error: { code: -32001, message: "Session not found" }, id: null });
        transport = new WebStandardStreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
          enableJsonResponse: true,
          onsessioninitialized: (id) => {
            transports.set(id, transport!);
          },
        });
        await mcpServerFor(session).connect(transport);
      }
      return transport.handleRequest(req);
    }

    let m: RegExpMatchArray | null;
    if (req.method === "POST" && path === "/api/v3.1/tool_router/session") {
      const id = `trs_${rand()}`;
      const enabled: string[] = body?.tools?.github?.enable ?? [];
      const pinned = body?.connected_accounts?.github?.[0];
      if (pinned) {
        const acct = accounts.get(pinned);
        if (!acct || acct.user_id !== body.user_id) return apiError(400, "Connected account does not belong to this user");
      }
      const session: Session = { id, user_id: body.user_id, body, tools: enabled, authConfigId: body?.auth_configs?.github, pinned };
      sessions.set(id, session);
      return json(201, {
        session_id: id,
        mcp: { type: "http", url: `${url.origin}/tool_router/${id}/mcp` },
        tool_router_tools: [...enabled].sort(),
        config: { user_id: body.user_id },
        config_version: 1,
      });
    }
    if ((m = path.match(/^\/api\/v3\.1\/tool_router\/session\/([^/]+)$/))) {
      const s = sessions.get(m[1]);
      if (!s) return apiError(404, "Session not found");
      if (req.method === "DELETE") {
        sessions.delete(m[1]);
        return json(200, { success: true });
      }
      return json(200, { session_id: s.id, config: { user_id: s.user_id }, mcp: { type: "http", url: `${url.origin}/tool_router/${s.id}/mcp` } });
    }
    if ((m = path.match(/^\/api\/v3\.1\/tool_router\/session\/([^/]+)\/toolkits$/))) {
      const s = sessions.get(m[1]);
      if (!s) return apiError(404, "Session not found");
      const acct = s.pinned ? accounts.get(s.pinned) : undefined;
      return json(200, {
        items: [{ slug: "github", name: "GitHub", enabled: true, is_no_auth: false, composio_managed_auth_schemes: ["OAUTH2"], meta: { logo: "", description: "" }, connected_account: acct ? { id: acct.id, status: acct.status } : null }],
        next_cursor: null, total_pages: 1, current_page: 1, total_items: 1,
      });
    }
    if ((m = path.match(/^\/api\/v3\.1\/tool_router\/session\/([^/]+)\/link$/)) && req.method === "POST") {
      const s = sessions.get(m[1]);
      if (!s) return apiError(404, "Session not found");
      let authConfigId = s.authConfigId;
      if (!authConfigId) {
        authConfigId = `ac_${rand()}`;
        authConfigs.set(authConfigId, { id: authConfigId, name: `auth_config_github_${Date.now()}`, scopes: defaultAuthConfigScopes, is_composio_managed: true, created_at: tick() });
      }
      const ac = authConfigs.get(authConfigId);
      const id = `ca_${rand()}`;
      accounts.set(id, { id, user_id: s.user_id, status: "INITIALIZING", auth_config_id: authConfigId, requested_scopes: ac?.scopes ?? [], created_at: tick() });
      return json(201, { link_token: `lk_${rand()}`, redirect_url: `https://${linkHost}/link/lk_${rand()}`, connected_account_id: id, experimental: { account_type: "PRIVATE" } });
    }
    if (path === "/api/v3.1/connected_accounts" && req.method === "GET") {
      const users = url.searchParams.get("user_ids")?.split(",");
      const statuses = url.searchParams.get("statuses")?.split(",");
      const acs = url.searchParams.get("auth_config_ids")?.split(",");
      const items = [...accounts.values()]
        .filter((a) => (!users || users.includes(a.user_id)) && (!statuses || statuses.includes(a.status)) && (!acs || acs.includes(a.auth_config_id)))
        .map(accountJson);
      return json(200, { items, next_cursor: null, total_pages: 1, current_page: 1, total_items: items.length });
    }
    if ((m = path.match(/^\/api\/v3\.1\/connected_accounts\/([^/]+)\/revoke$/)) && req.method === "POST") {
      const a = accounts.get(m[1]);
      if (!a) return apiError(404, "Connected account not found");
      const already = a.status === "REVOKED";
      a.status = "REVOKED";
      return json(200, { revoked_tokens: already ? [] : ["access_token"], connected_account: { id: a.id, status: a.status } });
    }
    if ((m = path.match(/^\/api\/v3\.1\/connected_accounts\/([^/]+)$/))) {
      const a = accounts.get(m[1]);
      if (!a) return apiError(404, "Connected account not found");
      if (req.method === "DELETE") {
        accounts.delete(m[1]);
        return json(200, { success: true });
      }
      return json(200, accountJson(a));
    }
    if (path === "/api/v3.1/auth_configs" && req.method === "GET") {
      const search = url.searchParams.get("search");
      const items = [...authConfigs.values()]
        .filter((c) => !search || c.name.includes(search) || c.id === search)
        .map((c) => ({ id: c.id, name: c.name, type: "default", status: "ENABLED", auth_scheme: "OAUTH2", is_composio_managed: c.is_composio_managed, toolkit: { slug: "github", logo: "" }, credentials: { scopes: c.scopes }, no_of_connections: 0, created_at: c.created_at }));
      return json(200, { items, next_cursor: null, total_pages: 1, current_page: 1, total_items: items.length });
    }
    if (path === "/api/v3.1/auth_configs" && req.method === "POST") {
      if (authConfigCreateForbidden) return apiError(403, "API key lacks permission: auth_configs:write", "Forbidden");
      const id = `ac_${rand()}`;
      const scopes = String(body?.auth_config?.credentials?.scopes ?? "").split(",").map((s: string) => s.trim()).filter(Boolean);
      authConfigs.set(id, { id, name: body?.auth_config?.name ?? "", scopes, is_composio_managed: body?.auth_config?.type === "use_composio_managed_auth", created_at: tick() });
      return json(201, { toolkit: { slug: "github" }, auth_config: { id, auth_scheme: "OAUTH2", is_composio_managed: true, restrict_to_following_tools: [] } });
    }
    if ((m = path.match(/^\/api\/v3\.1\/auth_configs\/([^/]+)$/))) {
      const c = authConfigs.get(m[1]);
      if (!c) return apiError(404, "Auth config not found");
      return json(200, { id: c.id, name: c.name, type: "default", status: "ENABLED", auth_scheme: "OAUTH2", is_composio_managed: c.is_composio_managed, toolkit: { slug: "github" }, credentials: { scopes: c.scopes } });
    }
    return apiError(404, `No mock route for ${req.method} ${path}`);
  }

  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: handle });
  const baseUrl = `http://127.0.0.1:${server.port}`;

  return {
    baseUrl,
    apiKey: MOCK_API_KEY,
    viewer: VIEWER,
    repos,
    accounts,
    sessions,
    authConfigs,
    calls,
    rest,
    addRepo(repo: FakeRepo) {
      repos.set(repoKey(repo.owner, repo.name), repo);
      return repo;
    },
    addIssue(repo: FakeRepo, init: Partial<FakeIssue> & { title: string }) {
      const number = init.number ?? repo.nextNumber++;
      repo.nextNumber = Math.max(repo.nextNumber, number + 1);
      const at = tick();
      const issue: FakeIssue = { number, body: "", state: "open", state_reason: null, labels: [], assignees: [], user: "octocat", comments: 0, locked: false, created_at: at, updated_at: at, closed_at: null, ...init };
      repo.issues.set(number, issue);
      return issue;
    },
    addPull(repo: FakeRepo, init: Partial<FakePull> & { title: string }) {
      const number = init.number ?? repo.nextNumber++;
      repo.nextNumber = Math.max(repo.nextNumber, number + 1);
      const at = tick();
      const pull: FakePull = { number, state: "open", draft: false, user: "octocat", head: { ref: `feature-${number}`, sha: (number.toString(16) + "a".repeat(40)).slice(0, 40) }, base: { ref: "main" }, merged_at: null, created_at: at, updated_at: at, ...init };
      repo.pulls.set(number, pull);
      repo.issues.set(number, { number, title: pull.title, body: "", state: pull.state, state_reason: null, labels: [], assignees: [], user: pull.user, comments: 0, locked: false, created_at: at, updated_at: at, closed_at: null, isPull: true });
      return pull;
    },
    /** Simulate the user finishing GitHub consent in the browser. */
    activate(accountId: string, extra: { displayName?: string } = {}) {
      const a = accounts.get(accountId);
      if (!a) throw new Error(`no account ${accountId}`);
      a.status = "ACTIVE";
      if (extra.displayName) a.displayName = extra.displayName;
    },
    setAccountStatus(accountId: string, status: string) {
      accounts.get(accountId)!.status = status;
    },
    revokeAtGithub(accountId: string) {
      accounts.get(accountId)!.revokedAtGithub = true;
    },
    failNext(slug: string, failure: Failure) {
      const list = failures.get(slug) ?? [];
      list.push(failure);
      failures.set(slug, list);
    },
    /** The next `times` REST calls whose path matches fail with `status` (Composio unreachable, by default). */
    failRest(match: RegExp, times = 1, status = 503) {
      restFailures.push({ match, remaining: times, status });
    },
    clearRestFailures() {
      restFailures.length = 0;
    },
    /** The next MCP call to `slug` dies in transit (HTTP 502 from the MCP endpoint); it never reaches GitHub. */
    failNextTransport(slug: string) {
      transportFailures.push(slug);
    },
    /** GitHub performs the next `slug` call normally, then answers with `fn(data)`. */
    rewriteNextResponse(slug: string, fn: (data: any) => any) {
      rewrites.set(slug, fn);
    },
    /** Composio forgets every tool-router session (expiry); their MCP endpoints answer 404. */
    expireSessions() {
      sessions.clear();
    },
    /** The project key lacks "Session tool execution": the MCP endpoint answers 403. */
    forbidMcp() {
      mcpForbidden = true;
    },
    /** Host of the sign-in links Composio hands out. */
    setLinkHost(host: string) {
      linkHost = host;
    },
    /** Run `fn` while the next call to `slug` is being handled (after it was received). */
    onNextCall(slug: string, fn: () => void) {
      onCall.set(slug, fn);
    },
    releaseHangs() {
      while (hangs.length) hangs.shift()!();
    },
    addExtraTool(name: string) {
      extraTools.push({ name, description: "meta", inputSchema: { type: "object", properties: {} } });
    },
    removeTool(slug: string) {
      removedTools.add(slug);
    },
    mutateToolSchema(slug: string, mutate: (schema: any) => void) {
      const tool = (toolsFixture.tools as any[]).find((t) => t.name === slug);
      const copy = structuredClone(tool);
      mutate(copy.inputSchema);
      removedTools.add(slug);
      extraTools.push(copy);
    },
    setDefaultAuthConfigScopes(scopes: string[]) {
      defaultAuthConfigScopes = scopes;
    },
    forbidAuthConfigCreate() {
      authConfigCreateForbidden = true;
    },
    stop() {
      this.releaseHangs();
      server.stop(true);
    },
  };
}

export type MockComposio = ReturnType<typeof startMockComposio>;
