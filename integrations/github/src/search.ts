/** Search continuations keep the exact query, ordering and displayed slice together. */
import { randomBytes } from "node:crypto";
import { GithubError } from "./errors.ts";

export type SearchTool = "search_repositories" | "search_code";
export const SEARCH_ROWS = 5;
export const SEARCH_SCOPE = "GitHub's indexed code search covers default branches and may omit files, including files in forks. No indexed match does not prove absence, even on the default branch.";
const CURSOR_TTL = 10 * 60_000;
const CACHE_TTL = 30_000;

interface Snapshot {
  account: string;
  tool: SearchTool;
  args: Record<string, any>;
  items: any[];
  total: number;
  incomplete: boolean;
  fetchedAt: number;
}
interface Continuation { snapshot: Snapshot; offset: number; expires: number }

export class SearchMemory {
  private readonly cursors = new Map<string, Continuation>();
  private readonly cache = new Map<string, Snapshot>();
  private readonly previous = new Map<string, Snapshot>();
  constructor(private readonly now: () => number) {}

  resume(tool: SearchTool, account: string, cursor: string): Continuation {
    const next = this.cursors.get(cursor);
    if (!next || next.expires <= this.now() || next.snapshot.account !== account || next.snapshot.tool !== tool) {
      throw new GithubError({ category: "invalid_input", field: "cursor", message: "That search continuation expired or belongs to a different search. Repeat the original search to start again.", modelOnly: true });
    }
    return next;
  }

  cached(tool: SearchTool, account: string, args: Record<string, any>): Snapshot | undefined {
    const snapshot = this.cache.get(this.key(tool, account, args));
    return snapshot && this.now() - snapshot.fetchedAt < CACHE_TTL ? snapshot : undefined;
  }

  /** A plain follow-up can arrive with a rebuilt query and an omitted sort. */
  inherit(tool: SearchTool, account: string, args: Record<string, any>): Record<string, any> {
    const prior = this.previous.get(`${tool}:${account}`);
    if (!prior || this.now() - prior.fetchedAt >= CURSOR_TTL) return args;
    const canonical = (q: string, withoutFork = false) => (q.match(/(?:[^\s"]|"[^"]*")+/g) ?? [])
      .filter((token) => !withoutFork || !/^fork:/i.test(token)).map((token) => token.toLowerCase()).sort().join(" ");
    // Do not reuse settings across different terms, owners, languages or visibility.
    const same = canonical(args.q) === canonical(prior.args.q);
    const forkOnlyChange = tool === "search_repositories" && !same && canonical(args.q, true) === canonical(prior.args.q, true);
    if (!(same && args.page > 1) && !forkOnlyChange) return args;
    return { ...args, ...(args.sort === undefined && prior.args.sort ? { sort: prior.args.sort } : {}), ...(args.order === undefined && prior.args.order ? { order: prior.args.order } : {}) };
  }

  save(tool: SearchTool, account: string, args: Record<string, any>, data: any): Snapshot {
    if (!Array.isArray(data?.items) || !Number.isInteger(data?.total_count) || data.total_count < 0) {
      throw new GithubError({ category: "contract", message: "Composio returned search results this integration could not read." });
    }
    const limit = Math.min(args.per_page, 1000 - (args.page - 1) * args.per_page);
    const snapshot: Snapshot = { tool, account, args: { ...args }, items: data.items.slice(0, limit), total: data.total_count, incomplete: data.incomplete_results === true, fetchedAt: this.now() };
    this.cache.set(this.key(tool, account, args), snapshot);
    this.prune();
    return snapshot;
  }

  /** The same answer for another wording of the search (a misheard repository, then the one meant). */
  alias(tool: SearchTool, account: string, args: Record<string, any>, snapshot: Snapshot) {
    this.cache.set(this.key(tool, account, args), snapshot);
    this.prune();
  }

  /** Both narration and the card consume only these rows, in this order. */
  slice(snapshot: Snapshot, offset = 0) {
    this.previous.set(`${snapshot.tool}:${snapshot.account}`, snapshot);
    const items = snapshot.items.slice(offset, offset + SEARCH_ROWS);
    const { page, per_page } = snapshot.args;
    const start = (page - 1) * per_page + offset + 1;
    const end = start + items.length - 1;
    const moreOnPage = offset + items.length < snapshot.items.length;
    // Never skip an unreturned gap or cross GitHub's 1,000-result boundary.
    const morePages = snapshot.items.length >= per_page && page * per_page < Math.min(snapshot.total, 1000);
    let next: { tool: SearchTool; arguments: { cursor: string } } | undefined;
    if (items.length && (moreOnPage || morePages)) {
      const cursor = randomBytes(18).toString("hex");
      this.cursors.set(cursor, {
        snapshot: moreOnPage ? snapshot : { ...snapshot, args: { ...snapshot.args, page: page + 1 }, items: [], fetchedAt: 0 },
        offset: moreOnPage ? offset + items.length : 0,
        expires: this.now() + CURSOR_TTL,
      });
      next = { tool: snapshot.tool, arguments: { cursor } };
      this.prune();
    }
    return { items, display: { start: items.length ? start : 0, end: items.length ? end : 0, count: items.length }, ...(next ? { next } : {}) };
  }

  private key(tool: SearchTool, account: string, args: Record<string, any>): string {
    return JSON.stringify([tool, account, args.q, args.sort ?? null, args.order ?? null, args.page, args.per_page, args.intent ?? null]);
  }

  private prune() {
    for (const [key, value] of this.cursors) if (value.expires <= this.now()) this.cursors.delete(key);
    for (const [key, value] of this.cache) if (this.now() - value.fetchedAt >= CACHE_TTL) this.cache.delete(key);
    for (const map of [this.cursors, this.cache, this.previous]) while (map.size > 60) map.delete(map.keys().next().value!);
  }
}

/** Explicit fork intent becomes an upstream qualifier; it never changes visibility. */
export function repositoryQuery(q: string, includeForks?: boolean): string {
  if (includeForks === undefined) return q;
  const tokens = q.match(/(?:[^\s"]|"[^"]*")+/g) ?? [];
  const qualifier = tokens.find((t) => /^fork:/i.test(t));
  const desired = includeForks ? "true" : "false";
  if (qualifier && qualifier.toLowerCase() !== `fork:${desired}`) {
    throw new GithubError({ category: "invalid_input", field: "include_forks", message: "The fork qualifier conflicts with include_forks. Correct the call to match the user's request; nothing was sent to GitHub.", modelOnly: true });
  }
  return qualifier ? q : `${q} fork:${desired}`;
}
