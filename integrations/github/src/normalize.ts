/**
 * Provider payloads → the bounded facts this integration reports.
 *
 * Identity fields are validated, never assumed: a payload without an issue
 * number is not an issue, and a write whose response can't be read is not a
 * success. Links survive only as https://github.com URLs inside the expected
 * repository, and everything else GitHub returns stays plain data.
 */
import { GithubError } from "./errors.ts";

export const BODY_LIMIT = 1500;
/** In a list, each PR's description is only a glimpse; ask for one PR by number to read more. */
export const LIST_BODY_LIMIT = 300;
const SHA = /^[0-9a-f]{40}$/;
const HEX_COLOR = /^[0-9a-f]{6}$/i;

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Characters that change or hide what a person reads without showing
 * themselves: zero-width spaces, direction overrides, invisible tag
 * characters (a known way to slip instructions to a model). Joiners that
 * shape real words and emoji stay.
 */
const HIDDEN =
  /\u{1F3F4}[\u{E0020}-\u{E007E}]+\u{E007F}|[\u00AD\u061C\u115F\u1160\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\u3164\uFEFF\uFFA0]|[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
/** The text as people see it. Subdivision flags (England's 🏴 plus its tag letters) are real emoji and stay. */
export const visible = (s: string) => s.replace(HIDDEN, (m) => (m.startsWith("\u{1F3F4}") ? m : ""));
const int = (v: unknown): number | undefined => (typeof v === "number" && Number.isInteger(v) ? v : undefined);
const login = (v: any): string | undefined => str(v?.login);

export function safeGithubUrl(url: unknown, owner?: string, repo?: string): string | undefined {
  if (typeof url !== "string") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || parsed.hostname !== "github.com" || parsed.username || parsed.password || parsed.port) return undefined;
  if (owner && repo) {
    const [o, r] = parsed.pathname.split("/").filter(Boolean);
    if (!o || !r || o.toLowerCase() !== owner.toLowerCase() || r.toLowerCase() !== repo.toLowerCase()) return undefined;
  }
  return parsed.toString();
}

export interface LabelFact {
  name: string;
  color?: string;
}

export interface IssueFacts {
  number: number;
  title: string;
  state: "open" | "closed";
  state_reason: string | null;
  is_pull_request: boolean;
  author?: string;
  labels: LabelFact[];
  assignees: string[];
  comments: number;
  locked: boolean;
  created_at?: string;
  updated_at?: string;
  closed_at: string | null;
  html_url?: string;
  body: string;
  body_truncated: boolean;
}

const contract = (what: string) => new GithubError({ category: "contract", message: `Composio returned ${what} this integration could not read.` });

function labelsOf(raw: unknown): LabelFact[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l: any) => {
      const name = typeof l === "string" ? l : str(l?.name);
      if (!name) return undefined;
      const color = str(l?.color);
      return color && HEX_COLOR.test(color) ? { name, color: color.toLowerCase() } : { name };
    })
    .filter((l): l is LabelFact => !!l);
}

export function normalizeIssue(raw: any, owner: string, repo: string): IssueFacts {
  const number = int(raw?.number);
  const title = str(raw?.title);
  const state = raw?.state;
  if (number === undefined || title === undefined || (state !== "open" && state !== "closed")) throw contract("an issue");
  const body = visible(str(raw?.body) ?? "");
  return {
    number,
    title: visible(title),
    state,
    state_reason: str(raw?.state_reason) ?? null,
    is_pull_request: !!raw?.pull_request,
    author: login(raw?.user),
    labels: labelsOf(raw?.labels),
    assignees: Array.isArray(raw?.assignees) ? raw.assignees.map(login).filter((l: unknown): l is string => !!l) : [],
    comments: int(raw?.comments) ?? 0,
    locked: raw?.locked === true,
    created_at: str(raw?.created_at),
    updated_at: str(raw?.updated_at),
    closed_at: str(raw?.closed_at) ?? null,
    html_url: safeGithubUrl(raw?.html_url, owner, repo),
    body: body.slice(0, BODY_LIMIT),
    body_truncated: body.length > BODY_LIMIT,
  };
}

export interface PullFacts {
  number: number;
  title: string;
  state: "open" | "closed";
  /** The one state people ask about first; merged and closed outrank draft. */
  status: "open" | "draft" | "merged" | "closed";
  merged: boolean;
  draft: boolean;
  author?: string;
  /** Present when GitHub sent them (list results do): who's asked to review, labels, assignees. */
  requested_reviewers?: string[];
  requested_teams?: string[];
  labels?: string[];
  assignees?: string[];
  head_ref?: string;
  head_sha?: string;
  base_ref?: string;
  created_at?: string;
  updated_at?: string;
  merged_at?: string;
  closed_at?: string;
  html_url?: string;
  body?: string;
  body_truncated?: boolean;
}

export function normalizePull(raw: any, owner: string, repo: string): PullFacts {
  const number = int(raw?.number);
  const title = str(raw?.title);
  const state = raw?.state;
  if (number === undefined || title === undefined || (state !== "open" && state !== "closed")) throw contract("a pull request");
  const sha = str(raw?.head?.sha)?.toLowerCase();
  const body = typeof raw?.body === "string" ? visible(raw.body) : undefined;
  const names = (v: unknown, key: string) => (v as any[]).map((x) => (typeof x === "string" ? x : str(x?.[key]))).filter((x): x is string => !!x);
  const merged = !!raw?.merged_at;
  const draft = raw?.draft === true;
  return {
    number,
    title: visible(title),
    state,
    status: merged ? "merged" : state === "closed" ? "closed" : draft ? "draft" : "open",
    merged,
    draft,
    author: login(raw?.user),
    ...(Array.isArray(raw?.requested_reviewers) ? { requested_reviewers: names(raw.requested_reviewers, "login") } : {}),
    ...(Array.isArray(raw?.requested_teams) ? { requested_teams: names(raw.requested_teams, "slug") } : {}),
    ...(Array.isArray(raw?.labels) ? { labels: names(raw.labels, "name") } : {}),
    ...(Array.isArray(raw?.assignees) ? { assignees: names(raw.assignees, "login") } : {}),
    head_ref: str(raw?.head?.ref),
    head_sha: sha && SHA.test(sha) ? sha : undefined,
    base_ref: str(raw?.base?.ref),
    created_at: str(raw?.created_at),
    updated_at: str(raw?.updated_at),
    ...(str(raw?.merged_at) ? { merged_at: raw.merged_at } : {}),
    ...(str(raw?.closed_at) ? { closed_at: raw.closed_at } : {}),
    html_url: safeGithubUrl(raw?.html_url, owner, repo),
    ...(body !== undefined ? { body: body.slice(0, BODY_LIMIT), body_truncated: body.length > BODY_LIMIT } : {}),
  };
}

export function listExcerpt(p: PullFacts): PullFacts {
  if (p.body === undefined || p.body.length <= LIST_BODY_LIMIT) return p;
  return { ...p, body: p.body.slice(0, LIST_BODY_LIMIT), body_truncated: true };
}

export interface RepoFacts {
  full_name: string;
  description?: string;
  stars: number;
  forks: number;
  language?: string;
  private: boolean;
  archived: boolean;
  fork: boolean;
  updated_at?: string;
  pushed_at?: string;
  html_url?: string;
}

export function normalizeRepo(raw: any): RepoFacts {
  const fullName = str(raw?.full_name);
  if (!fullName || !/^[^/\s]+\/[^/\s]+$/.test(fullName)) throw contract("a repository");
  const [owner, name] = fullName.split("/");
  const description = visible(str(raw?.description) ?? "").trim();
  return {
    full_name: fullName,
    ...(description ? { description: description.slice(0, 300) } : {}),
    stars: int(raw?.stargazers_count) ?? int(raw?.watchers_count) ?? 0,
    forks: int(raw?.forks_count) ?? int(raw?.forks) ?? 0,
    ...(str(raw?.language) ? { language: raw.language } : {}),
    private: raw?.private === true,
    archived: raw?.archived === true,
    fork: raw?.fork === true,
    updated_at: str(raw?.updated_at),
    pushed_at: str(raw?.pushed_at),
    html_url: safeGithubUrl(raw?.html_url, owner, name),
  };
}

export interface CodeFacts {
  repository: string;
  path: string;
  html_url?: string;
  fragment?: string;
  fragments?: string[];
  fragments_truncated?: boolean;
  /** Public, revision-pinned source for VoiceOS's existing web reader; never an auth link. */
  source_url?: string;
}

export function normalizeCodeHit(raw: any): CodeFacts {
  const repository = str(raw?.repository?.full_name);
  const path = str(raw?.path);
  if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository) || !path) throw contract("a code search result");
  const [owner, name] = repository.split("/");
  const excerpts: string[] = Array.isArray(raw?.text_matches)
    ? [...new Set<string>(raw.text_matches.filter((m: any) => !m?.property || m.property === "content").map((m: any) => typeof m?.fragment === "string" ? visible(m.fragment) : "").filter((s: string) => s.trim()))]
    : [];
  const fragments = excerpts.slice(0, 4).map((s) => s.slice(0, 1500));
  // An import alone rarely explains the implementation. Keep it as evidence,
  // but prefer a handler/function excerpt for the compact card preview.
  const fragment = fragments.find((s) => /\bfunction\b|=>|\.handle\s*\(|\bclass\s/.test(s)) ?? fragments[0];
  const htmlUrl = safeGithubUrl(raw?.html_url, owner, name);
  let sourceUrl: string | undefined;
  if (raw.repository.private === false && htmlUrl && !path.split("/").some((part) => !part || part === "." || part === "..")) {
    const pathname = new URL(htmlUrl).pathname;
    const prefix = `/${owner}/${name}/blob/`;
    const suffix = `/${path.split("/").map(encodeURIComponent).join("/")}`;
    if (pathname.startsWith(prefix) && pathname.endsWith(suffix)) {
      const revision = pathname.slice(prefix.length, -suffix.length);
      // GitHub search supplies an immutable commit URL. Do not guess branches.
      if (/^[0-9a-f]{40}$/i.test(revision)) sourceUrl = `https://raw.githubusercontent.com/${owner}/${name}/${revision}${suffix}`;
    }
  }
  return {
    repository,
    path,
    html_url: htmlUrl,
    ...(fragment ? { fragment, fragments, fragments_truncated: excerpts.length > 4 || excerpts.some((s) => s.length > 1500) } : {}),
    ...(sourceUrl ? { source_url: sourceUrl } : {}),
  };
}

export interface CommentFacts {
  id: number;
  html_url?: string;
  created_at?: string;
  author?: string;
}

export function normalizeComment(raw: any, owner: string, repo: string): CommentFacts {
  const id = int(raw?.id);
  if (id === undefined) throw contract("a comment");
  return { id, html_url: safeGithubUrl(raw?.html_url, owner, repo), created_at: str(raw?.created_at), author: login(raw?.user) };
}

export interface ReviewFacts {
  id: number;
  state: string;
  commit_id?: string;
  submitted_at?: string;
  html_url?: string;
  author?: string;
}

export function normalizeReview(raw: any, owner: string, repo: string): ReviewFacts {
  const id = int(raw?.id);
  const state = str(raw?.state);
  if (id === undefined || !state) throw contract("a review");
  return {
    id,
    state: state.toUpperCase(),
    commit_id: str(raw?.commit_id)?.toLowerCase(),
    submitted_at: str(raw?.submitted_at),
    html_url: safeGithubUrl(raw?.html_url, owner, repo),
    author: login(raw?.user),
  };
}
