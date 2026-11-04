/**
 * The GitHub account lifecycle, from "not connected" to a verified, pinned,
 * catalog-checked Composio session — and back out through reconnect and
 * disconnect.
 *
 * Linking follows the plan's rules: a Connect Link is created only for this
 * integration's own opaque user and its own repo-only auth config; a browser
 * redirect proves nothing, so an account is bound only after Composio reports
 * it ACTIVE for that user and that auth config with acceptable scopes; and
 * binding bumps a generation so approvals made under another account can be
 * refused. Disconnect revokes and deletes, best effort, and never lets a
 * cleanup failure restore access.
 */
import { createHash, randomBytes } from "node:crypto";
import { APPROVED, UPSTREAM_SNAPSHOT } from "./catalog.ts";
import { ComposioHttpError, UpstreamMcp, sessionBody, type AccountInfo, type AuthConfigInfo, type ComposioRest } from "./composio.ts";
import { GithubError } from "./errors.ts";
import { KeyedMutex, type AccountState, type DisconnectRecord, type Environment, type StateStore } from "./state.ts";

export const AUTH_CONFIG_NAME = "VoiceOS GitHub (repo scope)";
export const REQUESTED_SCOPES = ["repo"];
const ALLOWED_SCOPES = new Set(["repo", "public_repo"]);
export const LINK_TTL_MS = 10 * 60_000;
const SLUGS: string[] = Object.values(APPROVED);

export const CONNECTION_OFF_MESSAGE = "“Use my GitHub connection” is off in Configure, so VoiceOS isn't connected to GitHub. Turn it on to connect.";
export const DISCONNECTED_MESSAGE =
  "GitHub is disconnected. VoiceOS stopped using this account; changes already sent to GitHub remain. Turn on “Use my GitHub connection” in Configure to connect again.";

export type ConnectStage = "not_connected" | "connecting" | "reauth_required";

// The share review rejects this guard in tool descriptions, so the connect results carry it. Without
// it, Agent Mode called list_integrations, said "GitHub is not a supported integration", and searched the web.
const SUPPORTED = " GitHub is supported: this is VoiceOS's GitHub integration, and it connects only through this card. Listing integrations or searching the web can't connect it.";
const NEXT_ACTION: Record<ConnectStage, string> = {
  not_connected: `Click Connect GitHub on the card, approve access in the browser, then ask again.${SUPPORTED}`,
  connecting: `Approve access in the browser window that opened, or click Open sign-in again on the card. Then ask again.${SUPPORTED}`,
  reauth_required: `Click Reconnect GitHub on the card, approve access in the browser, then ask again.${SUPPORTED}`,
};

/** The call can't proceed until the user (re)connects GitHub. Carries the link for the card only. */
export class ConnectRequired extends GithubError {
  constructor(
    readonly stage: ConnectStage,
    message: string,
    readonly connectUrl: string | undefined,
    readonly scopes: string[],
    /** A change was refused before it was sent, and its draft travels back with the result. */
    readonly draftSaved = false,
  ) {
    super({ category: stage, message: draftSaved && stage === "reauth_required" ? `${message} Your draft is saved.` : message, nextAction: NEXT_ACTION[stage] });
  }

  keepingDraft(): ConnectRequired {
    return this.draftSaved ? this : new ConnectRequired(this.stage, this.message, this.connectUrl, this.scopes, true);
  }
}

export interface Ready {
  accountId: string;
  displayName?: string;
  generation: number;
  boundAt: number;
  /** Set when this binding replaced another account: approvals given before it are void. */
  identityChangedAt?: number;
  scopes: string[];
  upstream: UpstreamMcp;
  unavailable: Map<string, string>;
}

export interface ConnectionOptions {
  rest: ComposioRest;
  apiKey: string;
  baseUrl: string;
  store: StateStore;
  environment: Environment;
  connectionEnabled: boolean;
  userIdOverride?: string;
  authConfigPin?: string;
  now?: () => number;
  audit?: (event: string, fields?: Record<string, unknown>) => void;
  poll?: { fastMs: number; fastForMs: number; slowMs: number; giveUpMs: number } | false;
  upstreamTimeouts?: { connectMs: number; listMs: number };
}

const DEFAULT_POLL = { fastMs: 2_000, fastForMs: 30_000, slowMs: 5_000, giveUpMs: 5 * 60_000 };

function mapRest(error: unknown, action: string): GithubError {
  if (error instanceof GithubError) return error;
  if (error instanceof ComposioHttpError) {
    if (error.status === 401) {
      return new GithubError({ category: "composio_auth", message: "Composio rejected the project API key. Check it in VoiceOS → Integrations → GitHub → Configure." });
    }
    if (error.status === 403) {
      return new GithubError({
        category: "composio_auth",
        message: `This Composio API key isn't allowed to ${action}. Use a full-access project key, or a scoped one with Auth configs, Connected accounts and Session management (read and write) and Session tool execution (write).`,
      });
    }
    if (error.status === 429) {
      return new GithubError({ category: "rate_limited", message: "Composio is limiting requests. Try again in a few minutes.", retryable: true });
    }
    if (error.status === 0 || error.status >= 500) {
      return new GithubError({ category: "upstream_unavailable", message: "GitHub or Composio is temporarily unavailable. Try again shortly.", retryable: true });
    }
    return new GithubError({ category: "upstream_error", message: `Composio couldn't ${action}: ${error.message}`, detail: error.message });
  }
  return new GithubError({ category: "upstream_unavailable", message: "GitHub or Composio is temporarily unavailable. Try again shortly.", retryable: true });
}

const sameScopes = (a: string[], b: string[]) => a.length === b.length && a.every((s) => b.includes(s));

export class ConnectionManager {
  readonly userId: string;
  private readonly scopeKey: string;
  private readonly now: () => number;
  private readonly lock = new KeyedMutex();
  private authConfig?: AuthConfigInfo;
  private link?: { url: string; accountId: string };
  private linkSessionId?: string;
  private live?: { accountId: string; generation: number; upstream: UpstreamMcp; unavailable: Map<string, string>; sessionId: string };
  /** Sessions this process opened. Another server sharing the folder owns the rest. */
  private readonly ownSessions = new Set<string>();
  private poller?: ReturnType<typeof setTimeout>;
  private stopped = false;
  /** Best-effort cleanup (old sessions and accounts) the user doesn't wait for; stop() lets it finish. */
  private readonly cleanup = new Set<Promise<void>>();

  constructor(private readonly opts: ConnectionOptions) {
    this.now = opts.now ?? Date.now;
    this.userId = opts.userIdOverride?.trim() || this.identity();
    const fingerprint = createHash("sha256").update(opts.apiKey).digest("hex").slice(0, 12);
    this.scopeKey = `${opts.environment}:${fingerprint}:${this.userId}`;
  }

  /** A stable, opaque, per-environment Composio user id — never from model input. */
  private identity(): string {
    const env = this.opts.environment;
    const existing = this.opts.store.snapshot().identities[env];
    if (existing) return existing.userId;
    const userId = `voiceos-github-${env}-${randomBytes(10).toString("hex")}`;
    this.opts.store.update((s) => {
      s.identities[env] ??= { userId, createdAt: new Date(this.now()).toISOString() };
    });
    return this.opts.store.snapshot().identities[env]!.userId;
  }

  private account(): AccountState {
    return this.opts.store.snapshot().accounts[this.scopeKey] ?? { generation: 0 };
  }

  private saveAccount(mutate: (a: AccountState) => void) {
    this.opts.store.update((s) => {
      const a = s.accounts[this.scopeKey] ?? { generation: 0 };
      mutate(a);
      s.accounts[this.scopeKey] = a;
    });
  }

  private audit(event: string, fields: Record<string, unknown> = {}) {
    this.opts.audit?.(event, fields);
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  /** Ready to execute, or a GithubError saying exactly what the user must do. */
  ensureReady(): Promise<Ready> {
    return this.lock.run("ready", () => this.readyOnce());
  }

  /**
   * Open the GitHub session for an account that's already connected, so the
   * first question doesn't wait for it. Only ever for an active binding: it
   * never starts a sign-in link or creates an auth config, and a call that
   * arrives meanwhile waits on the same lock and uses what this opened.
   */
  warm(): Promise<void> {
    return this.lock.run("ready", async () => {
      if (this.stopped || !this.opts.connectionEnabled) return;
      const acct = this.account();
      if (acct.bound?.status !== "active") return;
      if (this.live && this.live.accountId === acct.bound.accountId && this.live.generation === acct.generation) return;
      await this.openUpstream(acct, await this.ensureAuthConfig({ mayCreate: false }), { warm: true });
    });
  }

  private later(work: () => Promise<unknown>) {
    const done: Promise<void> = work()
      .then(
        () => {},
        () => {},
      )
      .finally(() => this.cleanup.delete(done));
    this.cleanup.add(done);
  }

  private async readyOnce(): Promise<Ready> {
    if (!this.opts.connectionEnabled) {
      await this.disconnect();
      throw new GithubError({ category: "disconnected", message: DISCONNECTED_MESSAGE });
    }
    const config = await this.ensureAuthConfig();
    if (this.unfinishedCleanup().length) {
      // A disconnect's cleanup failed earlier: keep trying, but never at the cost of this call.
      await this.cleanUpRetired().catch((error) => console.error("[github] cleanup retry failed:", (error as Error).message));
    }

    let acct = this.account();
    if (acct.bound?.status === "active") {
      if (this.live && this.live.accountId === acct.bound.accountId && this.live.generation === acct.generation) return this.readyFrom(acct);
      return this.openUpstream(acct, config);
    }

    if (acct.pending) {
      const verdict = await this.checkPending(config);
      if (verdict === "bound") return this.openUpstream(this.account(), config);
      if (verdict === "waiting") throw this.connectError(this.account().bound ? "reauth_required" : "connecting");
    }

    acct = this.account();
    if (!acct.bound && (await this.adoptExisting(config))) return this.openUpstream(this.account(), config);

    await this.startLink(config);
    throw this.connectError(this.account().bound ? "reauth_required" : "not_connected");
  }

  private connectError(stage: ConnectStage): ConnectRequired {
    const message =
      stage === "reauth_required"
        ? "GitHub access expired or was revoked. Reconnect to continue."
        : stage === "connecting"
          ? "Finish connecting GitHub in your browser, then ask again."
          : "GitHub isn't connected yet.";
    return new ConnectRequired(stage, message, this.link?.url, this.authConfig?.scopes ?? REQUESTED_SCOPES);
  }

  /** The repo-only auth config every link and session uses. Never Composio's broad default. */
  private async ensureAuthConfig(opts: { mayCreate?: boolean } = {}): Promise<AuthConfigInfo> {
    if (this.authConfig) return this.authConfig;
    const rest = this.opts.rest;
    const pin = this.opts.authConfigPin?.trim();
    let config: AuthConfigInfo | undefined;
    if (pin) {
      try {
        config = await rest.getAuthConfig(pin);
      } catch (error) {
        if (error instanceof ComposioHttpError && error.status === 404) {
          throw new GithubError({ category: "composio_auth", message: "The GitHub auth config ID in Configure wasn't found in this Composio project." });
        }
        throw mapRest(error, "read the GitHub auth config");
      }
    } else {
      const cached = this.account().authConfigId;
      if (cached) {
        try {
          config = await rest.getAuthConfig(cached);
        } catch (error) {
          if (!(error instanceof ComposioHttpError && error.status === 404)) throw mapRest(error, "read the GitHub auth config");
        }
      }
      if (!config) {
        let existing: AuthConfigInfo[];
        try {
          existing = await rest.listAuthConfigs(AUTH_CONFIG_NAME);
        } catch (error) {
          throw mapRest(error, "list auth configs");
        }
        config = existing.find(
          (c) => c.name === AUTH_CONFIG_NAME && c.isComposioManaged && c.status !== "DISABLED" && sameScopes(c.scopes, REQUESTED_SCOPES),
        );
        if (!config && opts.mayCreate === false) {
          throw new GithubError({ category: "not_connected", message: "There's no GitHub auth config yet." });
        }
        if (!config) {
          try {
            const id = await rest.createManagedAuthConfig(AUTH_CONFIG_NAME, REQUESTED_SCOPES);
            config = { id, name: AUTH_CONFIG_NAME, scopes: [...REQUESTED_SCOPES], isComposioManaged: true };
            this.audit("auth_config_created", { auth_config_id: id, scopes: REQUESTED_SCOPES });
          } catch (error) {
            if (error instanceof ComposioHttpError && error.status === 403) {
              throw new GithubError({
                category: "composio_auth",
                message:
                  "This Composio API key can't create the repo-only GitHub auth config. Use a full-access project key, or set GitHub auth config ID in Configure to one limited to the repo scope.",
              });
            }
            throw mapRest(error, "create the GitHub auth config");
          }
        }
      }
      const id = config.id;
      this.saveAccount((a) => {
        a.authConfigId = id;
      });
    }
    const extra = config.scopes.filter((scope) => !ALLOWED_SCOPES.has(scope));
    if (!config.scopes.length) {
      throw new GithubError({ category: "permission", message: "Couldn't confirm which GitHub scopes the auth config requests. Use one limited to the repo scope." });
    }
    if (extra.length) {
      throw new GithubError({
        category: "permission",
        message: `The GitHub auth config asks for more access (${extra.join(", ")}) than this integration allows. Use one limited to the repo scope.`,
      });
    }
    this.authConfig = config;
    return config;
  }

  /** Composio says ACTIVE, for this user, through this auth config, within allowed scopes. */
  private isOurs(info: AccountInfo, config: AuthConfigInfo): boolean {
    if (info.status !== "ACTIVE") return false;
    if (info.authConfigId !== config.id) return false;
    if (info.userId !== undefined && info.userId !== this.userId) return false;
    return info.requestedScopes.every((scope) => ALLOWED_SCOPES.has(scope));
  }

  private checkPending(config: AuthConfigInfo): Promise<"bound" | "waiting" | "dead"> {
    return this.lock.run("pending", async () => {
      const pending = this.account().pending;
      if (!pending) return this.account().bound?.status === "active" ? "bound" : "dead";
      let info: AccountInfo | undefined;
      try {
        info = await this.opts.rest.getAccount(pending.accountId);
      } catch (error) {
        if (!(error instanceof ComposioHttpError && error.status === 404)) throw mapRest(error, "check the GitHub connection");
      }
      if (info?.status === "ACTIVE") {
        if (this.isOurs(info, config)) {
          await this.bind(info);
          return "bound";
        }
        this.audit("connection_rejected", { reason: "ownership_or_scope_mismatch" });
        await this.forgetPending();
        return "dead";
      }
      const fresh = this.now() - Date.parse(pending.createdAt) < LINK_TTL_MS;
      if (info && (info.status === "INITIALIZING" || info.status === "INITIATED") && fresh && this.link?.accountId === pending.accountId) {
        return "waiting";
      }
      if (info && fresh && (info.status === "INITIALIZING" || info.status === "INITIATED")) {
        // Waiting, but this process lost the link (restart). Leave the attempt
        // to finish or expire on its own; a new link replaces it here.
        this.saveAccount((a) => {
          a.pending = undefined;
        });
        return "dead";
      }
      this.audit("connection_failed", { status: info?.status ?? "missing" });
      await this.forgetPending();
      return "dead";
    });
  }

  private async forgetPending() {
    const pending = this.account().pending;
    this.saveAccount((a) => {
      a.pending = undefined;
    });
    if (this.link?.accountId === pending?.accountId) this.link = undefined;
    if (pending) await this.opts.rest.deleteAccount(pending.accountId).catch(() => {});
  }

  private async adoptExisting(config: AuthConfigInfo): Promise<boolean> {
    let found: AccountInfo[];
    try {
      found = await this.opts.rest.listAccounts({ userIds: [this.userId], statuses: ["ACTIVE"], authConfigIds: [config.id] });
    } catch (error) {
      throw mapRest(error, "list GitHub connections");
    }
    const retired = this.account().retired ?? {};
    const mine = found
      .filter((info) => this.isOurs(info, config) && !retired[info.id])
      .sort((a, b) => Date.parse(b.createdAt ?? "") - Date.parse(a.createdAt ?? ""));
    if (!mine.length) return false;
    await this.bind(mine[0]);
    this.audit("connection_reused", {});
    return true;
  }

  private async bind(info: AccountInfo) {
    const acct = this.account();
    const previous = acct.bound?.accountId;
    const lastKnown = previous ?? acct.lastAccountId;
    this.saveAccount((a) => {
      a.generation += 1;
      a.bound = {
        accountId: info.id,
        boundAt: this.iso(),
        status: "active",
        displayName: info.displayName,
        scopes: info.requestedScopes,
        // A different account, or any binding after a disconnect, voids earlier approvals.
        replaced: (!!lastKnown && lastKnown !== info.id) || !!acct.disconnect,
      };
      a.lastAccountId = info.id;
      a.pending = undefined;
      a.disconnect = undefined;
    });
    this.link = undefined;
    this.stopPoller();
    await this.dropUpstream();
    if (previous && previous !== info.id) this.later(() => this.opts.rest.deleteAccount(previous));
    if (this.linkSessionId) {
      const id = this.linkSessionId;
      this.linkSessionId = undefined;
      this.later(() => this.opts.rest.deleteSession(id));
    }
    this.audit("connection_activated", { generation: this.account().generation });
  }

  private async startLink(config: AuthConfigInfo) {
    const rest = this.opts.rest;
    try {
      if (!this.linkSessionId) {
        this.linkSessionId = (await rest.createSession(sessionBody({ userId: this.userId, authConfigId: config.id }))).session_id;
      }
      const link = await rest.createLink(this.linkSessionId);
      const url = new URL(link.redirect_url);
      // The only sign-in host the Connect card will open (cards.ts): anything else would be a dead button.
      if (url.protocol !== "https:" || url.hostname !== "connect.composio.dev" || url.username || url.password || url.port) {
        await rest.deleteAccount(link.connected_account_id).catch(() => {});
        throw new GithubError({ category: "contract", message: "Composio returned an unexpected sign-in address, so it wasn't opened." });
      }
      this.saveAccount((a) => {
        a.pending = { accountId: link.connected_account_id, createdAt: this.iso() };
      });
      this.link = { url: link.redirect_url, accountId: link.connected_account_id };
      this.audit("connection_started", {});
      this.startPoller(config);
    } catch (error) {
      throw mapRest(error, "start the GitHub connection");
    }
  }

  private startPoller(config: AuthConfigInfo) {
    this.stopPoller();
    const poll = this.opts.poll === undefined ? DEFAULT_POLL : this.opts.poll;
    if (!poll) return;
    const started = this.now();
    const step = () => {
      if (this.stopped) return;
      const elapsed = this.now() - started;
      if (elapsed > poll.giveUpMs) return;
      this.poller = setTimeout(async () => {
        try {
          const verdict = await this.checkPending(config);
          if (verdict === "waiting") step();
          // Approved in the browser: open the session while the user comes back to ask.
          else if (verdict === "bound") void this.warm().catch((error) => console.error("[github] warm-up after connecting failed:", (error as Error).message));
        } catch {
          step();
        }
      }, elapsed < poll.fastForMs ? poll.fastMs : poll.slowMs);
      this.poller.unref?.();
    };
    step();
  }

  private stopPoller() {
    if (this.poller) clearTimeout(this.poller);
    this.poller = undefined;
  }

  private async openUpstream(acct: AccountState, config: AuthConfigInfo, opts: { warm?: boolean } = {}): Promise<Ready> {
    const bound = acct.bound!;
    const rest = this.opts.rest;
    // The session is requested while the account is checked, and used only if the check passes.
    const opening = rest.createSession(sessionBody({ userId: this.userId, authConfigId: config.id, accountId: bound.accountId })).then(
      (session) => ({ session }),
      (error: unknown) => ({ error }),
    );
    const discard = () =>
      this.later(async () => {
        const unused = await opening;
        if ("session" in unused) await rest.deleteSession(unused.session.session_id);
      });
    let info: AccountInfo | undefined;
    try {
      info = await rest.getAccount(bound.accountId);
    } catch (error) {
      if (!(error instanceof ComposioHttpError && error.status === 404)) {
        discard();
        throw mapRest(error, "check the GitHub connection");
      }
    }
    if (!info || !this.isOurs(info, config)) {
      discard();
      // Deleted, revoked, or expired outside VoiceOS: never keep using it.
      this.audit("connection_lost", { status: info?.status ?? "missing" });
      if (info) {
        this.saveAccount((a) => {
          if (a.bound) a.bound.status = "reauth_required";
        });
      } else {
        this.saveAccount((a) => {
          a.bound = undefined;
        });
      }
      // Warming up never starts a sign-in link: the next question does, and shows it.
      if (opts.warm) throw new GithubError({ category: "not_connected", message: "The GitHub connection is gone." });
      await this.startLink(config);
      throw this.connectError(this.account().bound ? "reauth_required" : "not_connected");
    }
    if (this.stopped) {
      discard();
      throw new GithubError({ category: "upstream_unavailable", message: "The GitHub integration stopped." });
    }

    const opened = await opening;
    if ("error" in opened) throw mapRest(opened.error, "open a GitHub session");
    const session = opened.session;
    this.ownSessions.add(session.session_id);
    const upstream = new UpstreamMcp({
      url: session.mcp.url,
      apiKey: this.opts.apiKey,
      baseUrl: this.opts.baseUrl,
      connectTimeoutMs: this.opts.upstreamTimeouts?.connectMs,
      listTimeoutMs: this.opts.upstreamTimeouts?.listMs,
    });
    await upstream.connect();
    let check;
    try {
      check = await upstream.verifyCatalog(SLUGS);
    } catch (error) {
      await upstream.close();
      throw mapRest(error, "list GitHub actions");
    }
    if (check.unexpected.length) {
      await upstream.close();
      await rest.deleteSession(session.session_id).catch(() => {});
      this.audit("catalog_rejected", { unexpected: check.unexpected });
      throw new GithubError({
        category: "catalog_drift",
        message: "GitHub actions are paused: Composio exposed tools beyond the eight this integration allows. Nothing was sent to GitHub.",
        detail: `unexpected: ${check.unexpected.join(", ")}`,
      });
    }
    if (this.stopped) {
      // Shut down while this was opening: don't leave a live connection behind.
      await upstream.close();
      this.later(() => rest.deleteSession(session.session_id));
      throw new GithubError({ category: "upstream_unavailable", message: "The GitHub integration stopped." });
    }
    const unavailable = new Map<string, string>();
    for (const slug of check.missing) unavailable.set(slug, "not offered by Composio");
    for (const [slug, reason] of Object.entries(check.drift)) unavailable.set(slug, reason);
    if (unavailable.size) this.audit("catalog_drift", { tools: Object.fromEntries(unavailable) });
    if (check.changed.length) this.audit("upstream_schema_changed", { tools: check.changed, catalog_version: UPSTREAM_SNAPSHOT.catalogVersion });

    const previousSession = this.account().session?.id;
    this.saveAccount((a) => {
      a.session = { id: session.session_id, configDigest: createHash("sha256").update(JSON.stringify(sessionBody({ userId: this.userId, authConfigId: config.id, accountId: bound.accountId }))).digest("hex").slice(0, 16), createdAt: this.iso() };
    });
    if (previousSession && previousSession !== session.session_id && this.ownSessions.delete(previousSession)) {
      this.later(() => rest.deleteSession(previousSession));
    }
    await this.dropUpstream();
    this.live = { accountId: bound.accountId, generation: acct.generation, upstream, unavailable, sessionId: session.session_id };
    return this.readyFrom(this.account());
  }

  private readyFrom(acct: AccountState): Ready {
    const bound = acct.bound!;
    return {
      accountId: bound.accountId,
      displayName: bound.displayName,
      generation: acct.generation,
      boundAt: Date.parse(bound.boundAt),
      ...(bound.replaced ? { identityChangedAt: Date.parse(bound.boundAt) } : {}),
      scopes: bound.scopes ?? [],
      upstream: this.live!.upstream,
      unavailable: this.live!.unavailable,
    };
  }

  /** GitHub rejected the token: stop using it until the user reconnects. */
  async markReauthRequired(): Promise<void> {
    this.saveAccount((a) => {
      if (a.bound) a.bound.status = "reauth_required";
    });
    await this.dropUpstream();
    this.audit("connection_reauth_required", {});
  }

  /**
   * Forget the live MCP session (after a transport failure) so the next call
   * reconnects; calls already sent finish first. Given the connection that
   * failed, only that one goes: a late failure on a connection that was
   * already replaced never retires its replacement.
   */
  async dropUpstream(failed?: UpstreamMcp): Promise<void> {
    const live = this.live;
    if (failed && live?.upstream !== failed) {
      await failed.retire();
      return;
    }
    this.live = undefined;
    await live?.upstream.retire();
  }

  /** Disconnect from outside a tool call's readiness check, including at startup. */
  ensureDisconnected(): Promise<DisconnectRecord> {
    return this.lock.run("ready", () => this.disconnect());
  }

  private unfinishedCleanup(): string[] {
    const done = (e: { revocation: string; deleted: boolean }) => e.deleted && e.revocation !== "failed" && e.revocation !== "not_attempted";
    return Object.entries(this.account().retired ?? {})
      .filter(([, entry]) => !done(entry))
      .map(([id]) => id);
  }

  /** Revoke, then delete, every retired account not yet confirmed gone. Safe to repeat. */
  private async cleanUpRetired(): Promise<void> {
    const rest = this.opts.rest;
    for (const id of this.unfinishedCleanup()) {
      let { revocation, deleted } = this.account().retired![id];
      if (revocation === "failed" || revocation === "not_attempted") {
        try {
          const res = await rest.revokeAccount(id);
          revocation = res.revokedTokens.length ? "revoked" : "already_revoked";
        } catch (error) {
          const status = error instanceof ComposioHttpError ? error.status : 0;
          // 400: Composio can't revoke this toolkit. 404: the account is already gone, so its grant can't be confirmed either.
          revocation = status === 400 || status === 404 ? "unsupported" : "failed";
          if (status === 404) deleted = true;
        }
      }
      if (!deleted && revocation !== "failed") {
        try {
          await rest.deleteAccount(id);
          deleted = true;
        } catch (error) {
          deleted = error instanceof ComposioHttpError && error.status === 404;
        }
      }
      this.saveAccount((a) => {
        (a.retired ??= {})[id] = { ...a.retired![id], revocation, deleted };
      });
    }
  }

  async disconnect(): Promise<DisconnectRecord> {
    const acct = this.account();
    if (!acct.bound && !acct.pending && acct.disconnect?.completedAt && !this.unfinishedCleanup().length) return acct.disconnect;
    this.stopPoller();
    this.link = undefined;
    await this.dropUpstream();
    let accountId = acct.disconnect?.accountId;
    let requestedAt = acct.disconnect?.requestedAt ?? this.iso();
    if (acct.bound || acct.pending || !acct.disconnect) {
      // Stop using everything first, so nothing new can run while Composio is cleaned up.
      requestedAt = this.iso();
      accountId = acct.bound?.accountId;
      this.saveAccount((a) => {
        a.generation += 1;
        a.disconnect = { requestedAt, ...(accountId ? { accountId } : {}) };
        if (a.bound) (a.retired ??= {})[a.bound.accountId] = { revocation: "not_attempted", deleted: false, at: requestedAt };
        a.bound = undefined;
        a.session = undefined;
      });
      const rest = this.opts.rest;
      for (const id of [acct.session?.id, this.linkSessionId]) if (id) await rest.deleteSession(id).catch(() => {});
      this.linkSessionId = undefined;
      if (acct.pending) await rest.deleteAccount(acct.pending.accountId).catch(() => {});
      this.saveAccount((a) => {
        a.pending = undefined;
      });
    }
    await this.cleanUpRetired();
    const entry = accountId ? this.account().retired?.[accountId] : undefined;
    const record: DisconnectRecord = {
      requestedAt,
      ...(accountId ? { accountId } : {}),
      completedAt: this.iso(),
      revocation: entry?.revocation ?? "not_attempted",
      deleted: entry?.deleted ?? false,
    };
    this.saveAccount((a) => {
      a.disconnect = record;
    });
    this.audit("connection_disconnected", { revocation: record.revocation, deleted: record.deleted, pending_cleanup: this.unfinishedCleanup().length });
    return record;
  }

  disconnectRecord(): DisconnectRecord | undefined {
    return this.account().disconnect;
  }

  /**
   * Shut down: let a warm-up in flight notice and back out, then delete the
   * session this process opened (another process's stays), so every launch
   * doesn't leave one behind on Composio. Bounded, since VoiceOS is waiting.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    this.stopPoller();
    const within = (ms: number, work: Promise<unknown>) => Promise.race([work, new Promise((resolve) => setTimeout(resolve, ms).unref?.())]);
    await within(3_000, this.lock.run("ready", async () => {}));
    const mine = this.live && this.ownSessions.delete(this.live.sessionId) ? this.live.sessionId : undefined;
    await this.dropUpstream();
    if (mine) this.later(() => this.opts.rest.deleteSession(mine));
    await within(2_000, Promise.allSettled([...this.cleanup]));
  }
}
