/**
 * Errors the user can act on.
 *
 * Every failure becomes a GithubError with a category (what went wrong, for
 * the model and the audit log), a message (what the user hears and reads),
 * and whether retrying is safe. Upstream text is never shown raw: it is
 * classified into the plan's copy, and only a sanitized snippet survives as
 * `detail`.
 */

export type ErrorCategory =
  | "production_review_required"
  | "invalid_input"
  | "not_connected"
  | "connecting"
  | "reauth_required"
  | "disconnected"
  | "composio_auth"
  | "sso_required"
  | "rate_limited"
  | "not_found"
  | "issues_disabled"
  | "archived"
  | "self_review"
  | "pending_review"
  | "closed_target"
  | "stale_target"
  | "permission"
  | "validation"
  | "confirmation_required"
  | "cancelled"
  | "upstream_unavailable"
  | "catalog_drift"
  | "contract"
  | "unknown_outcome"
  | "unsupported"
  | "upstream_error";

export interface GithubErrorInit {
  category: ErrorCategory;
  message: string;
  title?: string;
  retryable?: boolean;
  retryAfterSeconds?: number;
  nextAction?: string;
  detail?: string;
  field?: string;
  /** A GitHub page where the user can check or finish things (never an auth link). */
  link?: string;
  /** A mistake in the call that the model fixes itself; the user hears nothing about it. */
  modelOnly?: boolean;
}

const TITLES: Record<ErrorCategory, string> = {
  production_review_required: "SOC 2 review required",
  invalid_input: "Check the request",
  not_connected: "Connect GitHub",
  connecting: "Finish connecting GitHub",
  reauth_required: "Reconnect GitHub",
  disconnected: "GitHub is disconnected",
  composio_auth: "Composio key rejected",
  sso_required: "Organization approval needed",
  rate_limited: "GitHub is limiting requests",
  not_found: "Not found",
  issues_disabled: "Issues are turned off",
  archived: "Repository is archived",
  self_review: "Can't review your own PR",
  pending_review: "Pending review exists",
  closed_target: "Pull request is closed",
  stale_target: "Changed while you were reviewing",
  permission: "No permission",
  validation: "GitHub rejected the request",
  confirmation_required: "Confirmation required",
  cancelled: "Not sent",
  upstream_unavailable: "Temporarily unavailable",
  catalog_drift: "GitHub actions unavailable",
  contract: "Unexpected response",
  unknown_outcome: "Check GitHub before resubmitting",
  unsupported: "Not supported here",
  upstream_error: "GitHub returned an error",
};

export class GithubError extends Error {
  readonly category: ErrorCategory;
  readonly title: string;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  readonly nextAction?: string;
  readonly detail?: string;
  readonly field?: string;
  readonly link?: string;
  readonly modelOnly?: boolean;

  constructor(init: GithubErrorInit) {
    super(init.message);
    this.name = "GithubError";
    this.category = init.category;
    this.title = init.title ?? TITLES[init.category];
    this.retryable = init.retryable ?? false;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.nextAction = init.nextAction;
    this.detail = init.detail;
    this.field = init.field;
    this.link = init.link && /^https:\/\/github\.com\//.test(init.link) ? init.link : undefined;
    this.modelOnly = init.modelOnly;
  }

  /** What the model reads. Never includes raw upstream text or credentials. */
  toJSON() {
    return {
      category: this.category,
      title: this.title,
      message: this.message,
      retryable: this.retryable,
      ...(this.retryAfterSeconds !== undefined ? { retry_after_seconds: this.retryAfterSeconds } : {}),
      ...(this.nextAction ? { next_action: this.nextAction } : {}),
      ...(this.field ? { field: this.field } : {}),
      ...(this.detail ? { detail: this.detail } : {}),
      ...(this.link ? { link: this.link } : {}),
    };
  }
}

const READ_TOOLS = new Set(["get_issue", "list_pull_requests", "search_repositories", "search_code"]);
const ISSUE_TOOLS = new Set(["get_issue", "update_issue", "create_issue_comment"]);

/** Strip credentials, URL query strings, and runaway length from upstream text. */
export function sanitizeDetail(raw: unknown): string {
  let s = String(raw ?? "");
  s = s.replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/g, "$1");
  s = s.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
  s = s.replace(/\b(gh[pousr]_[A-Za-z0-9]{10,}|github_pat_[A-Za-z0-9_]{10,})/g, "[redacted]");
  s = s.replace(/\b(x-api-key|x-user-api-key|authorization|api[_-]?key|access[_-]?token|token)\s*[:=]\s*\S+/gi, "$1: [redacted]");
  s = s.replace(/\b(ck|ak|uak|sk)_[A-Za-z0-9_*-]{4,}/g, "[redacted]");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > 240 ? `${s.slice(0, 239)}…` : s;
}

function retryAfter(raw: string): number | undefined {
  const after = raw.match(/retry[- ]?after\D{0,4}(\d{1,6})/i);
  if (after) return Number(after[1]);
  const reset = raw.match(/x-ratelimit-reset\D{0,4}(\d{9,11})/i);
  if (reset) return Math.max(0, Number(reset[1]) - Math.floor(Date.now() / 1000));
  return undefined;
}

export function humanizeWait(seconds: number | undefined): string {
  if (seconds === undefined) return "in a few minutes";
  if (seconds < 60) {
    const s = Math.max(1, Math.ceil(seconds));
    return `in ${s} second${s === 1 ? "" : "s"}`;
  }
  if (seconds < 3600) {
    const minutes = Math.ceil(seconds / 60);
    return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const at = new Date(Date.now() + seconds * 1000);
  return `after ${at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
}

/**
 * The HTTP status the failure reports, read only where a status belongs: at
 * the start ("404 Client Error: …", "403: …", "502 Bad Gateway") or in an
 * explicit "NNN Client/Server Error" or "status: NNN" — never from a URL, a
 * repository name or an issue number.
 */
function statusOf(text: string): number | undefined {
  const m =
    text.match(/^\s*(?:HTTP(?:\/[\d.]+)?\s+)?([1-5]\d\d)(?=\s*:|\s+[A-Z])/) ??
    text.match(/\b([1-5]\d\d) (?:Client|Server) Error\b/i) ??
    text.match(/\b(?:status(?:[ _]code)?|http status|error code)\s*[:=]?\s*([1-5]\d\d)\b/i);
  return m ? Number(m[1]) : undefined;
}

/** The words of a failure without its URLs and API paths, so names inside them can't steer the diagnosis. */
function wordsOf(text: string): string {
  return text
    .replace(/\bfor url:?\s*\S+/gi, " ")
    .replace(/\bhttps?:\/\/\S+/gi, " ")
    .replace(/(^|\s)\/(?:repos|orgs|users|search)\/\S+/gi, " ");
}

const TRANSIENT =
  /internal server error|bad gateway|service unavailable|gateway time-?out|timed? ?out|\bE(?:CONNRESET|CONNREFUSED|TIMEDOUT|AI_AGAIN|PIPE)\b|socket hang up|fetch failed|network (?:error|is unreachable)|connection (?:reset|refused|aborted|closed)/i;
const REAUTH = /bad credentials|requires authentication|(?:token|credentials?|authorization|grant)\b[^.]{0,40}\b(?:has expired|is expired|expired|been revoked|was revoked|revoked)|re-?authenticat(?:e|ion) (?:is )?required/i;

/**
 * Map an upstream failure to the plan's user-facing copy.
 *
 * Order matters. Composio's own refusals come first (nothing reached GitHub).
 * Then anything transient — a 5xx, a timeout, a dropped connection — because
 * for a change that means GitHub may have acted. Only then the definite
 * answers GitHub gives with a 4xx, keyed on the reported status before words.
 */
export function classifyUpstreamFailure(raw: string, ctx: { tool: string }): GithubError {
  const text = String(raw ?? "");
  const detail = sanitizeDetail(text);
  const read = READ_TOOLS.has(ctx.tool);
  const status = statusOf(text);
  const words = wordsOf(text);
  const unspecified = status === undefined;

  if (/MCP error -32602|\bTool [A-Z0-9_]+ not found/.test(text)) {
    return new GithubError({
      category: "catalog_drift",
      message: "GitHub actions are temporarily unavailable because Composio's tool catalog changed. Nothing was sent to GitHub.",
      detail,
    });
  }
  if (/invalid api key|APIKey_|api key (is )?(invalid|revoked|expired)|x-api-key/i.test(words)) {
    return new GithubError({
      category: "composio_auth",
      message: "Composio rejected the project API key. Check it in VoiceOS → Integrations → GitHub → Configure.",
    });
  }
  if (/no active connection|connected account[^.]*(not found|inactive|disabled)|no connected account/i.test(words)) {
    return new GithubError({ category: "not_connected", message: "GitHub isn't connected yet." });
  }
  if ((status !== undefined && status >= 500) || (unspecified && TRANSIENT.test(words))) {
    return new GithubError({
      category: "upstream_unavailable",
      message: "GitHub or Composio is temporarily unavailable. Try again shortly.",
      retryable: read,
      detail,
    });
  }
  if (status === 401 || (unspecified && (REAUTH.test(words) || /\bEXPIRED\b/.test(words)))) {
    return new GithubError({
      category: "reauth_required",
      message: "GitHub access expired or was revoked. Reconnect to continue.",
    });
  }
  const maybe403 = unspecified || status === 403;
  if (maybe403 && /\bsaml\b|\bsso\b|single sign-on|OAuth App access restrictions/i.test(words)) {
    return new GithubError({
      category: "sso_required",
      message: "Your organization may need to approve this OAuth app or renew SSO access.",
      detail,
    });
  }
  if (status === 429 || (maybe403 && /rate limit|secondary rate|abuse detection/i.test(words))) {
    const seconds = retryAfter(text);
    return new GithubError({
      category: "rate_limited",
      message: `GitHub is limiting requests. Try again ${humanizeWait(seconds)}.`,
      retryAfterSeconds: seconds,
      retryable: read,
    });
  }
  const maybe422 = unspecified || status === 422;
  if (maybe422 && /can ?not (approve|request changes on) your own pull request|cannot (approve|request changes on) your own/i.test(words)) {
    return new GithubError({
      category: "self_review",
      message: "GitHub doesn't allow approving or requesting changes on your own pull request. You can post a review comment instead.",
    });
  }
  if (maybe422 && /pending review/i.test(words)) {
    return new GithubError({
      category: "pending_review",
      message: "You already have a pending review on this pull request. Submit or discard it on GitHub, then try again.",
    });
  }
  if (status === 410 || ((unspecified || status === 403 || status === 404) && /issues? (are|has been|have been) disabled/i.test(words))) {
    return new GithubError({ category: "issues_disabled", message: "Issues are turned off for this repository." });
  }
  if ((maybe403 || status === 422) && /\barchived\b|read-only/i.test(words)) {
    return new GithubError({ category: "archived", message: "This repository is archived, so it's read-only." });
  }
  if (status === 404 || (unspecified && /not found/i.test(words))) {
    const message = ISSUE_TOOLS.has(ctx.tool)
      ? "That issue could not be found or this account cannot access it."
      : ctx.tool === "create_pull_request_review"
        ? "That pull request could not be found or this account cannot access it."
        : "This GitHub account cannot access that repository, or it no longer exists.";
    return new GithubError({ category: "not_found", message });
  }
  if (status === 422 || (unspecified && /validation failed|unprocessable|is not a valid|invalid (value|field|assignee|label)/i.test(words))) {
    return new GithubError({ category: "validation", message: `GitHub rejected part of this request: ${detail}`, detail });
  }
  if (status === 403 || (unspecified && /forbidden|not accessible|must have (push|admin|write)|permission/i.test(words))) {
    return new GithubError({
      category: "permission",
      message: "This GitHub account doesn't have permission to do that in this repository.",
      detail,
    });
  }
  return new GithubError({
    category: "upstream_error",
    message: detail ? `GitHub returned an error: ${detail}` : "GitHub returned an error.",
    detail,
  });
}
