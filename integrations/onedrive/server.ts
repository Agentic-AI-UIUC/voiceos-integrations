import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { renderCustom, markHtml, esc, clip } from "./widgetKit.ts";
import { unzipSync, strFromU8 } from "fflate";
import { extractText as extractPdfText } from "unpdf";

// Everything lives in this one file on purpose: VoiceOS publishes only server.ts
// and widgetKit.ts, so a helper module next to it would be missing on install.
// Helpers are exported so tests can import them.

// --- Composio client --------------------------------------------------------
const COMPOSIO_BASE_URL = "https://backend.composio.dev/api/v3.1";
// Pinned so the argument names this file sends (folder, parent_folder,
// conflict_behavior, use_me_drive, scope, …) can't change underneath it. Check
// the tool schemas at the new version before bumping.
export const COMPOSIO_TOOLKIT_VERSION = "20261101_00";
const RECONNECT_HINT = "Reconnect OneDrive at https://app.composio.dev.";
const AUTH_ERROR_RE = /token|expire|oauth|reconnect|credentials|unauthori[sz]ed|invalid_grant|no connected account|no active account|access denied/i;
const NOT_FOUND_RE = /not ?found|itemNotFound|does not exist|404/i;

// VoiceOS timing limits: a sync tool must answer well within the turn, using
// ~8 s timeouts on its own requests, and anything over ~20 s has to run as a
// background tool. One tool call can make several requests (look up, search,
// convert, download), so each call gets a single budget and every request's
// timeout is capped by what remains of it.
const REQUEST_TIMEOUT_MS = 8_000;
const TOOL_BUDGET_MS = 18_000;
const toolDeadline = new AsyncLocalStorage<number>();

/** Runs fn under a time budget that every request inside it shares. */
export function runWithBudget<T>(budgetMs: number, fn: () => Promise<T>): Promise<T> {
  return toolDeadline.run(Date.now() + budgetMs, fn);
}

/** Timeout for the next request: at most `cap`, and never past the current tool's budget. */
function timeLeft(cap = REQUEST_TIMEOUT_MS): number {
  const end = toolDeadline.getStore();
  if (end === undefined) return cap;
  const left = end - Date.now();
  if (left < 1_000) throw new Error("OneDrive is taking too long to respond. Try again in a moment.");
  return Math.min(cap, left);
}

function getApiKey(): string {
  const envKey = process.env.COMPOSIO_API_KEY?.trim();
  if (envKey && envKey.length > 5) return envKey;
  throw new Error("Missing Composio API key — please configure COMPOSIO_API_KEY in this integration's settings.");
}

function extractErrorMessage(err: any): string {
  if (!err) return "Unknown error occurred";
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    if (typeof err.message === "string" && err.message.trim().length > 0) return err.message;
    if (typeof err.error === "string" && err.error.trim().length > 0) return err.error;
    if (err.error && typeof err.error === "object") {
      const nested = extractErrorMessage(err.error);
      if (nested && nested !== "Unknown error occurred") return nested;
    }
    if (typeof err.detail === "string" && err.detail.trim().length > 0) return err.detail;
    if (typeof err.description === "string" && err.description.trim().length > 0) return err.description;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

type Account = { accountId: string; userId: string };
let cachedAccount: (Account & { key: string }) | null = null;

/**
 * Only an active account on the OneDrive toolkit — a looser "microsoft" match
 * would happily pick an Outlook or Teams connection and fail confusingly.
 */
function isActiveOneDrive(acc: any): boolean {
  const slug = String(acc?.toolkit?.slug || acc?.toolkit_slug || "").toLowerCase();
  return (slug === "one_drive" || slug === "onedrive") && String(acc?.status || "").toUpperCase() === "ACTIVE" && !acc?.is_disabled;
}

/** GETs a connected-accounts endpoint. Returns null on 404; throws on any other failure. */
async function fetchAccounts(apiKey: string, pathAndQuery: string): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${COMPOSIO_BASE_URL}${pathAndQuery}`, { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(timeLeft(5_000)) });
  } catch (err) {
    throw new Error(`Couldn't reach Composio to look up your OneDrive connection: ${extractErrorMessage(err)}`);
  }
  if (res.status === 404) return null;
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Composio rejected the connected-account lookup (HTTP ${res.status}). Check the API key in settings.`);
  }
  const json: any = await res.json().catch(() => null);
  if (!res.ok || !json) throw new Error(`Composio's connected-account lookup failed (HTTP ${res.status}).`);
  return json;
}

/**
 * The OneDrive account to act on, always one that belongs to COMPOSIO_USER_ID.
 * A project API key can see every user's connections, so an account is never
 * taken just because it exists in the project: a configured ID is checked
 * against the user, and auto-detect refuses unless exactly one account matches.
 */
async function resolveConnectedAccount(apiKey: string): Promise<Account> {
  const explicitAccountId = process.env.COMPOSIO_CONNECTED_ACCOUNT_ID?.trim();
  const userId = process.env.COMPOSIO_USER_ID?.trim() || "default";
  const key = `${userId}\n${explicitAccountId || ""}`;
  if (cachedAccount?.key === key) return cachedAccount;

  let account: Account;
  if (explicitAccountId) {
    const acc = await fetchAccounts(apiKey, `/connected_accounts/${encodeURIComponent(explicitAccountId)}`);
    if (!acc) {
      throw new Error(`Connected account ${explicitAccountId} isn't in this Composio project. Check Connected Account ID in settings, or clear it to auto-detect.`);
    }
    if (!isActiveOneDrive(acc)) {
      throw new Error(`Connected account ${explicitAccountId} isn't an active OneDrive connection. Check Connected Account ID in settings. ${RECONNECT_HINT}`);
    }
    if (acc.user_id !== userId) {
      throw new Error(`Connected account ${explicitAccountId} belongs to a different Composio user than "${userId}". Set Composio User ID to the account's user, or clear Connected Account ID.`);
    }
    account = { accountId: explicitAccountId, userId };
  } else {
    const query = new URLSearchParams({ toolkit_slugs: "one_drive", statuses: "ACTIVE", user_ids: userId });
    const json = await fetchAccounts(apiKey, `/connected_accounts?${query}`);
    const items: any[] = Array.isArray(json?.items) ? json.items : Array.isArray(json?.data?.items) ? json.data.items : [];
    // Filtered again here so the user scoping never rests on the query alone.
    const mine = items.filter((acc) => isActiveOneDrive(acc) && acc?.user_id === userId && acc?.id);
    if (mine.length === 0) {
      throw new Error(`No active OneDrive connection for Composio user "${userId}". Connect OneDrive for that user at https://app.composio.dev, or set Composio User ID in settings.`);
    }
    if (mine.length > 1) {
      const ids = mine.slice(0, 5).map((acc) => acc.id).join(", ");
      throw new Error(`Composio user "${userId}" has ${mine.length} active OneDrive connections (${ids}). Put the one to use in Connected Account ID in settings.`);
    }
    account = { accountId: mine[0].id, userId };
  }
  // Only a resolved account is cached, so a connection made after startup is picked up next call.
  cachedAccount = { ...account, key };
  console.error(`Using OneDrive account ${account.accountId} for user ${userId}`);
  return account;
}

/**
 * The error for a write whose request went out but whose answer never came
 * back: it may have run. Write tools that pick a new name on conflict would
 * create a duplicate on retry, so the user is told to look first.
 */
function unknownOutcome(action: string, cause: string): Error {
  return new Error(
    `Couldn't confirm whether OneDrive ${action}: the request was sent, but no answer came back (${cause}). It may have gone through. Check OneDrive before trying again.`,
  );
}

function parseIfJson(value: any): any {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/**
 * Composio wraps Graph payloads to varying depths, and sometimes as a JSON
 * string. Only descends into a wrapper that holds an object: when `data` is a
 * plain message ("File downloaded"), its siblings (such as `file`) are the payload.
 */
export function unwrap(data: any): any {
  let d = parseIfJson(data);
  for (let i = 0; i < 4 && d && typeof d === "object" && !Array.isArray(d); i++) {
    const inner = parseIfJson(d.response_data ?? d.data ?? d.result);
    if (!inner || typeof inner !== "object") return d;
    d = inner;
  }
  return d;
}

export function listOf(d: any): any[] {
  if (Array.isArray(d)) return d;
  if (Array.isArray(d?.value)) return d.value;
  if (Array.isArray(d?.items)) return d.items;
  return [];
}

/**
 * Executes one Composio OneDrive tool. Throws with a user-readable message on any failure.
 * `write` names what a mutating call does ("created the folder …"), so a lost
 * answer is reported as an unknown outcome rather than a plain failure.
 */
export async function composio(slug: string, args: Record<string, unknown>, opts: { write?: string } = {}): Promise<any> {
  const apiKey = getApiKey();
  const { accountId, userId } = await resolveConnectedAccount(apiKey);
  const payload = { user_id: userId, connected_account_id: accountId, version: COMPOSIO_TOOLKIT_VERSION, arguments: args };

  console.error(`Composio ${slug} (user: ${userId}, account: ${accountId})`);
  const timeoutMs = timeLeft();
  let res: Response;
  try {
    res = await fetch(`${COMPOSIO_BASE_URL}/tools/execute/${slug}`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (opts.write) throw unknownOutcome(opts.write, extractErrorMessage(err));
    throw new Error(`Couldn't reach Composio: ${extractErrorMessage(err)}`);
  }

  const json: any = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Composio rejected the request (HTTP ${res.status}). Check the API key in settings. ${RECONNECT_HINT}`);
  }
  // A gateway error or an unreadable reply says nothing about whether the write ran.
  if (opts.write && ([502, 503, 504].includes(res.status) || (res.ok && !json))) {
    throw unknownOutcome(opts.write, `HTTP ${res.status}${json ? "" : ", unreadable reply"}`);
  }
  if (!res.ok || !json || json.successful === false || json.success === false || json.error) {
    const msg = extractErrorMessage(json?.error ?? json?.message ?? json?.detail ?? `HTTP ${res.status} ${res.statusText}`);
    console.error(`Composio ${slug} failed [${res.status}]: ${msg}`);
    if (AUTH_ERROR_RE.test(msg)) {
      cachedAccount = null; // the account may have been revoked or replaced; look it up again next call
      throw new Error(`${msg} — ${RECONNECT_HINT}`);
    }
    throw new Error(msg);
  }
  return unwrap(json.data ?? json.result ?? json.response_data);
}

// --- OneDrive items ----------------------------------------------------------

/** "", "/", "root", "My files" → "" (root); otherwise a drive-relative path without slashes at the ends. */
export function normPath(raw?: string): string {
  const p = String(raw || "")
    .trim()
    .replace(/^\/?drive\/root:/i, "")
    .replace(/^\/+|\/+$/g, "")
    .replace(/^my files(\/|$)/i, "");
  return /^root$/i.test(p) ? "" : p;
}

// Personal IDs look like "0123456789ABCDEF!54927"; Business/SharePoint IDs like "01NKDM7HMOJTVYMDOSXFDK2QJDXCDI3WUK".
export function looksLikeItemId(s: string): boolean {
  return /^[0-9a-f]{12,16}![\w.-]+$/i.test(s) || /^01[A-Z0-9]{30,}$/.test(s);
}

/** Drive-relative path of a Graph driveItem, e.g. "Documents/Report.docx". */
export function itemPathOf(item: any): string {
  const parent = String(item?.parentReference?.path || "");
  const m = parent.match(/root:\/?(.*)$/);
  const dir = m ? decodeURIComponent(m[1]) : "";
  return dir ? `${dir}/${item?.name}` : String(item?.name || "");
}

/**
 * "folder", "file", or "other" — Personal Vault and similar special items come
 * back from Graph with neither a folder nor a file facet.
 */
export function itemKind(item: any): "folder" | "file" | "other" {
  if (item?.folder || item?.package) return "folder";
  if (item?.file) return "file";
  return "other";
}

export function summarizeItem(item: any) {
  const kind = itemKind(item);
  return {
    id: String(item?.id || ""),
    name: String(item?.name || "Untitled"),
    path: item?.parentReference?.path ? itemPathOf(item) : undefined,
    kind,
    size: typeof item?.size === "number" ? item.size : undefined,
    last_modified: item?.lastModifiedDateTime,
    web_url: item?.webUrl || undefined,
  };
}

// Words people say after a file name ("the budget PDF") that aren't part of it.
const SPOKEN_TYPE_WORDS = /\s+(pdf|docx?|word|xlsx?|excel|spreadsheet|pptx?|powerpoint|slides|deck|txt|text|md|markdown|csv|file|document|doc)$/;

/** A file name as someone would say it: no extension, separators as spaces, lowercase. */
export function spokenName(name: string): string {
  let s = String(name || "").toLowerCase().replace(/\.[a-z0-9]{1,5}$/, "").replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim();
  while (SPOKEN_TYPE_WORDS.test(s)) s = s.replace(SPOKEN_TYPE_WORDS, "");
  return s;
}

/**
 * Picks the one search hit the user meant, trying stricter matches first:
 * exact name, then the same name ignoring extension and spoken type words
 * ("Getting started with OneDrive PDF"), then a unique name prefix. Returns
 * every hit at the first tier that matches anything, so the caller can refuse
 * to guess between several.
 */
export function matchByName(hits: any[], query: string): any[] {
  const q = query.toLowerCase();
  const spoken = spokenName(query);
  const tiers: Array<(name: string) => boolean> = [
    (name) => name.toLowerCase() === q,
    (name) => spoken.length > 0 && spokenName(name) === spoken,
    (name) => spoken.length >= 3 && spokenName(name).startsWith(spoken),
  ];
  for (const matches of tiers) {
    const found = hits.filter((h) => matches(String(h?.name || "")));
    if (found.length) return found;
  }
  return [];
}

/**
 * Turns what the user said — an item ID, a path, or (when loose) a spoken name,
 * optionally under a folder — into a Graph driveItem. Never guesses between
 * several matches; strict mode (delete) accepts only an exact ID or path.
 */
export async function resolveItem(ref: string, loose: boolean): Promise<any> {
  const raw = String(ref || "").trim();
  if (!raw) throw new Error("No OneDrive file or folder was given.");
  if (looksLikeItemId(raw)) return composio("ONE_DRIVE_GET_ITEM", { item_id: raw });

  const p = normPath(raw);
  if (!p) throw new Error("That's the OneDrive root folder. Name a specific file or folder.");
  try {
    const item = await composio("ONE_DRIVE_GET_ITEM_BY_PATH", { item_path: p });
    if (item?.id) return item;
    throw new Error(`OneDrive returned no item for "${p}".`);
  } catch (err) {
    if (!loose || !NOT_FOUND_RE.test(extractErrorMessage(err))) throw err;
  }

  // Not at that exact path: search by the spoken name, keeping hits inside the
  // folder the user named, if any.
  const slash = p.lastIndexOf("/");
  const folder = slash >= 0 ? p.slice(0, slash).toLowerCase() : "";
  const name = slash >= 0 ? p.slice(slash + 1) : p;
  const hits = listOf(await composio("ONE_DRIVE_SEARCH_ITEMS", { q: spokenName(name) || name, top: 25 }))
    .filter((h: any) => !folder || path.posix.dirname(itemPathOf(h)).toLowerCase() === folder);
  const found = matchByName(hits, name);
  if (found.length === 1) return found[0];
  if (found.length === 0) throw new Error(`No OneDrive item matches "${p}". Use search_files to find it.`);
  const where = found.slice(0, 5).map((h: any) => (h?.parentReference?.path ? itemPathOf(h) : h?.name)).join(", ");
  throw new Error(`${found.length} OneDrive items match "${p}" (${where}). Ask the user which one, then pass its full path.`);
}

const DOWNLOAD_URL_KEY_RE = /s3url|download|file_?url|^url$/i;
const PAGE_URL_KEY_RE = /web_?url/i; // links to the OneDrive web page, not the file bytes

/**
 * Composio stages downloads in its own storage and hands back a signed URL, but
 * the field holding it differs between actions (`file.s3url`, `file_url`, …),
 * so search the whole response, shallowest match first.
 */
export function findDownloadUrl(d: any, depth = 0): string | undefined {
  const obj = parseIfJson(d);
  if (!obj || typeof obj !== "object" || depth > 5) return undefined;
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && value.startsWith("https://") && DOWNLOAD_URL_KEY_RE.test(key) && !PAGE_URL_KEY_RE.test(key)) {
      return value;
    }
  }
  for (const value of Object.values(obj)) {
    const hit = findDownloadUrl(value, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

/** Field names and types only, never values — safe to put in errors and logs. */
export function describeShape(value: any, depth = 0): string {
  if (Array.isArray(value)) return `[${value.length ? describeShape(value[0], depth + 1) : ""}]`;
  if (!value || typeof value !== "object") return value === null ? "null" : typeof value;
  if (depth > 3) return "{…}";
  return `{${Object.keys(value).slice(0, 12).map((k) => `${k}: ${describeShape(value[k], depth + 1)}`).join(", ")}}`;
}

/**
 * Fetches a file's bytes through Composio. With asPdf, OneDrive converts the
 * file to PDF server-side first (Office and OpenDocument formats).
 */
export async function downloadBytes(item: any, opts: { asPdf?: boolean } = {}): Promise<Buffer> {
  const itemName = String(item?.name || "download");
  const data = opts.asPdf
    ? await composio("ONE_DRIVE_DOWNLOAD_ITEM_AS_FORMAT", {
        item_id: item.id,
        format: "pdf",
        file_name: `${itemName.replace(/\.[^.]+$/, "")}.pdf`,
      })
    : await composio("ONE_DRIVE_DOWNLOAD_FILE", { item_id: item.id, file_name: itemName });
  // Graph's own item metadata carries a short-lived pre-authenticated link to
  // the original bytes; it's the fallback when Composio's response has none.
  const url = findDownloadUrl(data) ?? (opts.asPdf ? undefined : httpsUrl(item?.["@microsoft.graph.downloadUrl"]));
  if (!url) {
    const shape = describeShape(data);
    console.error(`No download URL in Composio response for "${itemName}": ${shape}`);
    throw new Error(`Composio didn't return a download link for "${itemName}". Response shape: ${shape}`);
  }
  const timeoutMs = timeLeft(TOOL_BUDGET_MS);
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw new Error(`Couldn't fetch "${itemName}" from ${new URL(url).host}: ${extractErrorMessage(err)}`);
  }
}

/**
 * Composio uploads text through a OneDrive upload session, and a 0-byte body
 * produces a malformed Content-Range header ("bytes 0--1/0") that OneDrive
 * rejects. An empty file is therefore sent as a single newline.
 */
export function uploadableText(content: string): { content: string; padded: boolean } {
  return content.length === 0 ? { content: "\n", padded: true } : { content, padded: false };
}

/** A name that can only ever land directly inside ~/Downloads. */
export function safeLocalName(requested: string | undefined, itemName: string): string {
  let name = String(requested || "").trim() || itemName;
  name = name.replace(/[\/\\:\u0000-\u001f]/g, "_").replace(/^\.+/, "").trim();
  if (!name) name = "OneDrive download";
  if (!path.extname(name) && path.extname(itemName)) name += path.extname(itemName);
  return name;
}

/** Writes without ever overwriting: "Report.pdf" → "Report (1).pdf" → … */
export async function writeUnique(dir: string, name: string, data: Buffer): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let n = 0; n < 100; n++) {
    const target = path.join(dir, n === 0 ? name : `${stem} (${n})${ext}`);
    try {
      await fs.promises.writeFile(target, data, { flag: "wx" });
      return target;
    } catch (err: any) {
      if (err?.code !== "EEXIST") throw err;
    }
  }
  throw new Error(`Too many files named "${name}" already exist in ~/Downloads.`);
}

/** Test hook: forget the auto-discovered connected account. */
export function resetAccountCache(): void {
  cachedAccount = null;
}

// --- Text extraction (read_file) --------------------------------------------
// Office Open XML files (docx/xlsx/pptx) are zip archives of XML, so they are
// unzipped and walked here rather than pulling in one heavy parser per format.
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "xml", "html", "htm", "log", "yaml", "yml",
  "ini", "cfg", "conf", "toml", "js", "ts", "jsx", "tsx", "py", "rb", "go", "java", "c", "h",
  "cpp", "cs", "sh", "sql", "css", "srt", "vtt",
]);
const OOXML_EXTENSIONS = new Set(["docx", "xlsx", "pptx"]);
/** Formats OneDrive can convert to PDF server-side before we read them. */
const CONVERTIBLE_EXTENSIONS = new Set(["doc", "xls", "ppt", "rtf", "odt", "ods", "odp", "docm", "xlsm", "pptm"]);

type ReadStrategy = "text" | "ooxml" | "pdf" | "convert" | "unsupported";

function extensionOf(name: string): string {
  return path.extname(name).slice(1).toLowerCase();
}

export function readStrategy(name: string): ReadStrategy {
  const ext = extensionOf(name);
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  if (OOXML_EXTENSIONS.has(ext)) return "ooxml";
  if (ext === "pdf") return "pdf";
  if (CONVERTIBLE_EXTENSIONS.has(ext)) return "convert";
  return "unsupported";
}

export function decodeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function tidy(text: string): string {
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function docxText(files: Record<string, Uint8Array>): string {
  const xml = files["word/document.xml"];
  if (!xml) throw new Error("This .docx has no document body.");
  let out = "";
  const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<\/w:p>|<w:tab\/>|<w:br\b[^>]*\/>/g;
  for (const m of strFromU8(xml).matchAll(re)) {
    if (m[1] !== undefined) out += decodeXml(m[1]);
    else if (m[0] === "<w:tab/>") out += "\t";
    else out += "\n";
  }
  return tidy(out);
}

function pptxText(files: Record<string, Uint8Array>): string {
  const slides = Object.keys(files)
    .map((f) => ({ f, n: Number(f.match(/^ppt\/slides\/slide(\d+)\.xml$/)?.[1]) }))
    .filter((s) => s.n > 0)
    .sort((a, b) => a.n - b.n);
  return tidy(slides.map(({ f, n }) => {
    let body = "";
    for (const m of strFromU8(files[f]).matchAll(/<a:t>([^<]*)<\/a:t>|<\/a:p>/g)) {
      body += m[1] !== undefined ? decodeXml(m[1]) : "\n";
    }
    return `--- Slide ${n} ---\n${tidy(body)}`;
  }).join("\n\n"));
}

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+/g, "").toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function xlsxText(files: Record<string, Uint8Array>): string {
  const read = (p: string) => (files[p] ? strFromU8(files[p]) : "");

  const shared = [...read("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((si) =>
    decodeXml([...si[1].matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join("")),
  );

  // Sheet order and names come from workbook.xml; files come from its relationships.
  const rels = new Map(
    [...read("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)].map((r) => [
      r[0].match(/\bId="([^"]+)"/)?.[1],
      r[0].match(/\bTarget="([^"]+)"/)?.[1],
    ]),
  );
  const sheets = [...read("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)].map((s) => {
    const target = rels.get(s[0].match(/\br:id="([^"]+)"/)?.[1]) || "";
    return {
      name: decodeXml(s[0].match(/\bname="([^"]*)"/)?.[1] || "Sheet"),
      file: target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`,
    };
  });

  return tidy(sheets.filter((s) => files[s.file]).map((sheet) => {
    const rows = [...read(sheet.file).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((row) => {
      const cells: string[] = [];
      for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const inner = c[2] || "";
        const type = attrs.match(/\bt="(\w+)"/)?.[1];
        const v = inner.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        let value = "";
        if (type === "s" && v !== undefined) value = shared[Number(v)] ?? "";
        else if (type === "inlineStr") value = decodeXml([...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join(""));
        else if (type === "b" && v !== undefined) value = v === "1" ? "TRUE" : "FALSE";
        else if (v !== undefined) value = decodeXml(v);
        const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
        const col = ref ? columnIndex(ref) : cells.length;
        while (cells.length < col) cells.push("");
        cells[col] = value;
      }
      return cells.join("\t").replace(/\t+$/, "");
    }).filter((r) => r.length > 0);
    return `--- Sheet: ${sheet.name} ---\n${rows.join("\n")}`;
  }).join("\n\n"));
}

export function ooxmlText(name: string, bytes: Uint8Array): string {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error(`"${name}" isn't a valid Office file (couldn't unzip it).`);
  }
  const ext = extensionOf(name);
  if (ext === "docx") return docxText(files);
  if (ext === "pptx") return pptxText(files);
  return xlsxText(files);
}

export async function pdfText(bytes: Uint8Array): Promise<{ text: string; pages: number }> {
  const { totalPages, text } = await extractPdfText(new Uint8Array(bytes), { mergePages: false });
  return {
    pages: totalPages,
    text: tidy(text.map((t, i) => (totalPages > 1 ? `--- Page ${i + 1} ---\n${t.trim()}` : t.trim())).join("\n\n")),
  };
}

export function plainText(bytes: Uint8Array): string {
  if (bytes.subarray(0, 8000).includes(0)) throw new Error("This file looks binary, not text.");
  return new TextDecoder("utf-8").decode(bytes).replace(/^﻿/, "");
}

/** One-line card preview: drops the "--- Page 2 ---" style section markers and collapses whitespace. */
export function previewText(text: string): string {
  return text.replace(/^--- (?:Page|Slide|Sheet:) [^\n]* ---$/gm, " ").replace(/\s+/g, " ").trim();
}

/** Cuts at a paragraph or line boundary near the limit so the model never sees half a sentence. */
export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const slice = text.slice(0, maxChars);
  const cut = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"));
  return { text: (cut > maxChars * 0.8 ? slice.slice(0, cut) : slice).trimEnd(), truncated: true };
}

// --- Glance cards ---------------------------------------------------------------
// Monochrome on purpose: every colour comes from the kit's ink/fill/line
// variables, so a card reads white-on-black in dark mode and black-on-white in
// light mode, with no brand blue and no status red or green.

const VISIBLE_ROWS = 6; // lists scroll inside the card past this many rows
const NEUTRAL_ACCENT = "#8e8e93"; // grey, so the kit's accent wash adds no hue
const ROW_HEIGHT = 44;
const READ_MAX_BYTES = 25 * 1024 * 1024;

const server = new McpServer({ name: "microsoft-onedrive", version: "1.6.0" });

// Every tool handler runs under TOOL_BUDGET_MS (see timeLeft).
const registerTool = ((name: string, config: any, handler: (...a: any[]) => any) =>
  server.registerTool(name, config, (...a: any[]) => runWithBudget(TOOL_BUDGET_MS, () => handler(...a)))) as typeof server.registerTool;

const svg = (paths: string) =>
  `<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
const PAGE = '<path d="M4.5 2.25h5.25L13.5 6v9a.75.75 0 0 1-.75.75h-8.25a.75.75 0 0 1-.75-.75V3a.75.75 0 0 1 .75-.75z"/><path d="M9.75 2.25V6h3.75"/>';
const TRAY = '<path d="M3 12.5v1.75c0 .41.34.75.75.75h10.5c.41 0 .75-.34.75-.75V12.5"/>';

const ICONS = {
  folder: svg('<path d="M2.25 5.25c0-.83.67-1.5 1.5-1.5h3.4l1.5 1.5h5.6c.83 0 1.5.67 1.5 1.5v6.75c0 .83-.67 1.5-1.5 1.5H3.75c-.83 0-1.5-.67-1.5-1.5z"/>'),
  file: svg(PAGE),
  doc: svg(`${PAGE}<path d="M6.5 9.5h5M6.5 12h3.5"/>`),
  sheet: svg(`${PAGE}<path d="M6 9h6v4.5H6zM6 11.25h6M9 9v4.5"/>`),
  slides: svg(`${PAGE}<path d="M6 9.25h6v3.5H6z"/>`),
  image: svg('<rect x="2.5" y="3" width="13" height="12" rx="1.5"/><circle cx="6.5" cy="7" r="1.2"/><path d="m2.5 13 3.8-3.8 3 3 2-2 3.2 3.2"/>'),
  vault: svg('<rect x="3.75" y="8" width="10.5" height="7.5" rx="1.5"/><path d="M6 8V5.75a3 3 0 0 1 6 0V8"/>'),
  download: svg(`<path d="M9 3v8.25M5.75 8 9 11.25 12.25 8"/>${TRAY}`),
  link: svg('<path d="M7.5 10.5a3 3 0 0 0 4.24 0l2.12-2.12a3 3 0 0 0-4.24-4.24l-.7.7"/><path d="M10.5 7.5a3 3 0 0 0-4.24 0L4.14 9.62a3 3 0 0 0 4.24 4.24l.7-.7"/>'),
  trash: svg('<path d="M3 4.75h12M7 4.75V3.5c0-.41.34-.75.75-.75h2.5c.41 0 .75.34.75.75v1.25M4.5 4.75l.6 9.6c.03.5.44.9.94.9h5.92c.5 0 .91-.4.94-.9l.6-9.6"/>'),
  search: svg('<circle cx="8" cy="8" r="4.75"/><path d="m11.5 11.5 3.25 3.25"/>'),
  open: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8l4-4M4.5 4H8v3.5"/></svg>',
};

function itemIcon(name: string, kind: "folder" | "file" | "other"): string {
  if (kind === "folder") return ICONS.folder;
  if (kind === "other") return ICONS.vault;
  const ext = extensionOf(name);
  if (["doc", "docx", "pdf", "txt", "md", "rtf", "odt"].includes(ext)) return ICONS.doc;
  if (["xls", "xlsx", "csv", "ods"].includes(ext)) return ICONS.sheet;
  if (["ppt", "pptx", "odp"].includes(ext)) return ICONS.slides;
  if (["png", "jpg", "jpeg", "gif", "webp", "heic", "svg"].includes(ext)) return ICONS.image;
  return ICONS.file;
}

function formatSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return "—";
  if (bytes === 0) return "0 KB";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(dateStr?: string): string {
  const d = new Date(dateStr ?? "");
  if (isNaN(d.getTime())) return "Recently";
  const hours = Math.floor((Date.now() - d.getTime()) / 3_600_000);
  if (hours < 1) return "Just now";
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function httpsUrl(url: unknown): string | undefined {
  return typeof url === "string" && /^https:\/\/[^\s"']+$/i.test(url) ? url : undefined;
}

const CARD_CSS = `
.c{padding:12px 14px 13px}
.hd{display:flex;align-items:center;gap:8px;height:24px;margin-bottom:8px}
.hd-t{flex:1;min-width:0;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hd-n{flex:none;font-size:11px;color:var(--ink-4);font-variant-numeric:tabular-nums}
.tag{flex:none;font-size:10.5px;font-weight:600;padding:2px 8px;border-radius:999px;border:1px solid var(--line);color:var(--ink-2);white-space:nowrap}
.ls{max-height:${VISIBLE_ROWS * ROW_HEIGHT}px;overflow-y:auto;overscroll-behavior:contain;margin:0 -6px}
.ls.more{-webkit-mask-image:linear-gradient(#000 calc(100% - 30px),transparent);mask-image:linear-gradient(#000 calc(100% - 30px),transparent)}
.ls.more.end{-webkit-mask-image:none;mask-image:none}
.rw{display:flex;align-items:center;gap:11px;height:${ROW_HEIGHT}px;padding:0 8px;border-radius:10px;color:inherit;text-decoration:none}
a.rw:hover,a.hero:hover{background:var(--fill-1)}
.ic{flex:none;width:28px;height:28px;border-radius:8px;background:var(--fill-1);color:var(--ink-2);display:grid;place-items:center}
.m{flex:1;min-width:0}
.t{font-size:13.5px;font-weight:560;color:var(--ink-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.s{font-size:11px;color:var(--ink-3);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.f{flex:none;font-size:11.5px;color:var(--ink-3);font-variant-numeric:tabular-nums}
.go{flex:none;width:12px;color:var(--ink-4);opacity:.45;transition:opacity .15s}
a.rw:hover .go,a.hero:hover .go{opacity:1}
.hero{display:flex;align-items:center;gap:12px;padding:10px 12px;border-radius:14px;border:1px solid var(--line);color:inherit;text-decoration:none}
.hero .ic{width:36px;height:36px;border-radius:10px;color:var(--ink-1)}
.hero .t{font-size:14.5px;font-weight:600}
.kv{display:flex;gap:18px;margin-top:10px;padding:0 4px}
.kv div{min-width:0}
.kv b{display:block;font-size:10px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-4)}
.kv span{display:block;font-size:12.5px;color:var(--ink-1);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pv{margin-top:10px;padding:0 4px;font-size:12.5px;line-height:1.45;color:var(--ink-2);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.mono{margin-top:8px;padding:0 4px;font:11px/1.4 ui-monospace,Menlo,monospace;color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lnk{display:flex;align-items:center;gap:8px;margin-top:10px;padding:9px 12px;border-radius:12px;background:var(--fill-1);color:var(--ink-1);text-decoration:none;font:11.5px/1.3 ui-monospace,Menlo,monospace}
.lnk span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lnk:hover{background:var(--fill-2)}
.empty{padding:16px 8px 8px;text-align:center}
.empty .ic{margin:0 auto 8px}
.empty .s{white-space:normal}
`;

// Lifts the fade off a scrolled list once its last row is in view.
const SCROLL_JS =
  "<script>document.querySelectorAll('.ls.more').forEach(function(l){l.addEventListener('scroll',function(){l.classList.toggle('end',l.scrollTop+l.clientHeight>=l.scrollHeight-2)})})</script>";

interface CardRow {
  icon: string;
  title: string;
  subtitle: string;
  figure?: string;
  href?: string;
}

function header(title: string, trailing = ""): string {
  return `<div class="hd">${markHtml()}<span class="hd-t">${esc(title)}</span>${trailing}</div>`;
}

const tag = (text: string) => `<span class="tag">${esc(text)}</span>`;
const count = (text: string) => `<span class="hd-n">${esc(text)}</span>`;

function rowHtml(r: CardRow): string {
  const href = httpsUrl(r.href);
  const inner = `<span class="ic">${r.icon}</span><span class="m"><div class="t">${esc(clip(r.title, 60))}</div><div class="s">${esc(r.subtitle)}</div></span>${r.figure ? `<span class="f">${esc(r.figure)}</span>` : ""}${href ? `<span class="go">${ICONS.open}</span>` : ""}`;
  return href ? `<a class="rw" href="${esc(href)}">${inner}</a>` : `<div class="rw">${inner}</div>`;
}

function scrollList(rows: CardRow[]): string {
  return `<div class="ls${rows.length > VISIBLE_ROWS ? " more" : ""}">${rows.map(rowHtml).join("")}</div>`;
}

function hero(icon: string, title: string, subtitle: string, href?: string): string {
  const link = httpsUrl(href);
  const inner = `<span class="ic">${icon}</span><span class="m"><div class="t">${esc(clip(title, 60))}</div><div class="s">${esc(subtitle)}</div></span>${link ? `<span class="go">${ICONS.open}</span>` : ""}`;
  return link ? `<a class="hero" href="${esc(link)}">${inner}</a>` : `<div class="hero">${inner}</div>`;
}

function facts(pairs: Array<[string, string]>): string {
  return `<div class="kv">${pairs.map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join("")}</div>`;
}

function emptyState(icon: string, title: string, hint: string): string {
  return `<div class="empty"><div class="ic">${icon}</div><div class="t">${esc(title)}</div><div class="s">${esc(hint)}</div></div>`;
}

type CardTheme = "auto" | "dark" | "light";

/** The user's Card theme setting (manifest preference CARD_THEME); anything unrecognised means auto. */
export function cardTheme(raw = process.env.CARD_THEME): CardTheme {
  const v = String(raw ?? "").trim().toLowerCase();
  return v === "dark" || v === "light" ? v : "auto";
}

/**
 * Pins a user-chosen theme. VoiceOS's init message sets the theme it wants, so
 * a watcher puts the chosen one back; and because cards are otherwise
 * transparent over the host surface, a pinned theme paints its own background
 * so it stays readable whatever the host draws behind it.
 */
export function themePin(theme: CardTheme): { css: string; js: string } {
  if (theme === "auto") return { css: "", js: "" };
  return {
    // On the root: the kit styles body with a more specific accent-wash rule.
    css: `html{background:${theme === "light" ? "#fff" : "#000"}}`,
    js: `<script>(function(){var h=document.documentElement,t='${theme}';function pin(){if(h.getAttribute('data-k-theme')!==t)h.setAttribute('data-k-theme',t)}pin();new MutationObserver(pin).observe(h,{attributes:true,attributeFilter:['data-k-theme']})})()</script>`,
  };
}

function card(body: string, height: number) {
  const scrolls = body.includes('class="ls more"');
  const theme = cardTheme();
  const pin = themePin(theme);
  return renderCustom({
    accent: NEUTRAL_ACCENT,
    css: CARD_CSS + pin.css,
    body: `<div class="c">${body}</div>${scrolls ? SCROLL_JS : ""}${pin.js}`,
    height,
    theme: theme === "auto" ? undefined : theme,
  });
}

const listCardHeight = (rows: number) => 50 + Math.min(rows, VISIBLE_ROWS) * ROW_HEIGHT;

function copyToMacClipboard(text: string): boolean {
  try {
    const res = spawnSync("pbcopy", { input: text, timeout: 2000 });
    return res.status === 0;
  } catch (err) {
    console.error("Clipboard write skipped:", err);
    return false;
  }
}

function widgetResult(data: Record<string, unknown>, rendered: { html: string; height: number }) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        ...data,
        _voiceos_glance: { blocks: [{ type: "widget", html: rendered.html, height: rendered.height }] },
      }),
    }],
  };
}

// TOOL 1: list_files (READ)
registerTool(
  "list_files",
  {
    title: "List files and folder contents",
    description: "List files and folders inside a Microsoft OneDrive folder (root by default). Use when the user asks what's in their OneDrive or in a specific folder, or wants to browse directories. Each item comes back with a `path` to pass to download_file, create_share_link, or delete_file.",
    inputSchema: {
      folder_path: z.string().optional().describe("OneDrive folder path relative to the root (e.g. 'Documents' or 'Documents/Projects'); leave empty for the root"),
      limit: z.number().min(1).max(50).optional().describe("Maximum number of items to return (1-50, default 20)"),
    },
  },
  async (args) => {
    const folder = normPath(args?.folder_path);
    const limit = Math.min(Math.max(Math.round(args?.limit ?? 20), 1), 50);

    const data = await composio("ONE_DRIVE_LIST_FOLDER_CHILDREN", {
      use_me_drive: true,
      folder_path: folder ? `/${folder}` : "/",
      top: limit,
    });
    const items = listOf(data).slice(0, limit).map((item: any) => {
      const s = summarizeItem(item);
      return { ...s, path: folder ? `${folder}/${s.name}` : s.name };
    });
    const hasMore = Boolean(data?.next_page_token || data?.["@odata.nextLink"]);
    const title = folder ? `My files / ${folder.replace(/\//g, " / ")}` : "My files";

    if (items.length === 0) {
      const rendered = card(header(title, count("0 items")) + emptyState(ICONS.folder, "This folder is empty", "Ask VoiceOS to upload a note here."), 150);
      return widgetResult({ folder: folder || "/", item_count: 0, items: [] }, rendered);
    }

    const rows = items.map((f): CardRow => ({
      icon: itemIcon(f.name, f.kind),
      title: f.name,
      subtitle: `Modified ${formatDate(f.last_modified)}`,
      figure: f.kind === "file" ? formatSize(f.size) : undefined,
      href: f.web_url,
    }));
    const rendered = card(header(title, count(`${items.length}${hasMore ? "+" : ""} items`)) + scrollList(rows), listCardHeight(rows.length));
    return widgetResult({ folder: folder || "/", item_count: items.length, has_more: hasMore, items }, rendered);
  }
);

// TOOL 2: search_files (READ)
registerTool(
  "search_files",
  {
    title: "Search files",
    description: "Search Microsoft OneDrive for files and folders by keyword (matches names, metadata, and file contents). Use when the user wants to find or locate a file but doesn't know which folder it's in. Each result has an `id` (and usually a `path`) to pass to download_file, create_share_link, or delete_file.",
    inputSchema: {
      query: z.string().describe("Plain keywords or a file name (no wildcards or filters like 'filetype:')"),
      limit: z.number().min(1).max(25).optional().describe("Maximum results to return (1-25, default 10)"),
    },
  },
  async (args) => {
    const query = String(args?.query || "").trim();
    if (!query) throw new Error("search_files needs a query.");
    const limit = Math.min(Math.max(Math.round(args?.limit ?? 10), 1), 25);

    const data = await composio("ONE_DRIVE_SEARCH_ITEMS", { q: query, top: limit });
    const items = listOf(data).slice(0, limit).map(summarizeItem);
    const title = `Search · "${clip(query, 28)}"`;

    if (items.length === 0) {
      const rendered = card(header(title, count("0 results")) + emptyState(ICONS.search, "No matches", "Check the spelling, or browse folders in My files."), 150);
      return widgetResult({ query, total_matches: 0, results: [] }, rendered);
    }

    const rows = items.map((f): CardRow => {
      const parent = f.path ? path.posix.dirname(f.path) : "";
      return {
        icon: itemIcon(f.name, f.kind),
        title: f.name,
        subtitle: parent && parent !== "." ? `in ${parent}` : f.path ? "in My files" : `Modified ${formatDate(f.last_modified)}`,
        figure: f.kind === "file" ? formatSize(f.size) : undefined,
        href: f.web_url,
      };
    });
    const rendered = card(header(title, count(`${items.length} result${items.length === 1 ? "" : "s"}`)) + scrollList(rows), listCardHeight(rows.length));
    return widgetResult({ query, total_matches: items.length, results: items }, rendered);
  }
);

// TOOL 3: download_file (READ)
registerTool(
  "download_file",
  {
    title: "Download file",
    description: "Download a file from Microsoft OneDrive into the Mac's ~/Downloads folder (never overwrites; adds ' (1)' if the name is taken). Use when the user asks to download, save locally, or fetch a OneDrive file. Call it directly with the name the user said (with or without extension, optionally with its folder); don't search first. If several files match, the error lists them.",
    inputSchema: {
      item_path: z.string().describe("File name as the user said it, path (e.g. 'Documents/Report.pdf'), or item id"),
      file_name: z.string().optional().describe("Optional file name to save as inside ~/Downloads"),
    },
  },
  async (args) => {
    const item = await resolveItem(args?.item_path, true);
    if (item?.folder) throw new Error(`"${item.name}" is a folder; only files can be downloaded.`);

    const itemName = String(item?.name || "download");
    const buffer = await downloadBytes(item);

    const downloadDir = path.join(os.homedir(), "Downloads");
    await fs.promises.mkdir(downloadDir, { recursive: true });
    const localTarget = await writeUnique(downloadDir, safeLocalName(args?.file_name, itemName), buffer);
    const savedName = path.basename(localTarget);
    const fileSizeStr = formatSize(buffer.length);

    const rendered = card(
      header("OneDrive", tag("Downloaded")) +
        hero(ICONS.download, savedName, "Saved to your Mac · open in OneDrive", item?.webUrl) +
        facts([["Size", fileSizeStr], ["Folder", "~/Downloads"]]) +
        `<div class="mono">${esc(localTarget)}</div>`,
      190,
    );
    return widgetResult({
      status: "downloaded",
      onedrive_item: itemName,
      file_name: savedName,
      local_path: localTarget,
      bytes: buffer.length,
      file_size: fileSizeStr,
    }, rendered);
  }
);

// TOOL 3b: read_file (READ)
registerTool(
  "read_file",
  {
    title: "Read file contents",
    description: "Read the text of a Microsoft OneDrive file so you can summarize it, answer questions about it, or quote from it. Works with Word, Excel, PowerPoint, PDF, and plain-text files (txt, md, csv, json, code); not images or scanned PDFs. Use when the user asks what a OneDrive file says, wants it summarized, or asks a question about its contents; then answer from the returned document_text (the card is only a preview). Call it directly with the name the user said (with or without extension, optionally with its folder); don't search first. If several files match, the error lists them.",
    inputSchema: {
      item_path: z.string().describe("File name as the user said it, path (e.g. 'Documents/Q3 Report.docx'), or item id"),
      max_chars: z.number().min(1000).max(60000).optional().describe("Maximum characters of text to return (default 20000)"),
    },
  },
  async (args) => {
    const maxChars = Math.min(Math.max(Math.round(args?.max_chars ?? 20000), 1000), 60000);
    const item = await resolveItem(args?.item_path, true);
    if (item?.folder) throw new Error(`"${item.name}" is a folder. Use list_files to see what's inside.`);

    const itemName = String(item?.name || "file");
    const strategy = readStrategy(itemName);
    if (strategy === "unsupported") {
      const ext = extensionOf(itemName) || "no extension";
      throw new Error(`Can't read text from "${itemName}" (${ext}). Supported: Word, Excel, PowerPoint, PDF, and plain-text files.`);
    }
    if (typeof item?.size === "number" && item.size > READ_MAX_BYTES) {
      throw new Error(`"${itemName}" is ${formatSize(item.size)}, too large to read here (limit ${formatSize(READ_MAX_BYTES)}). Use download_file instead.`);
    }

    let text: string;
    let pages: number | undefined;
    if (strategy === "text") {
      text = plainText(await downloadBytes(item));
    } else if (strategy === "ooxml") {
      text = ooxmlText(itemName, await downloadBytes(item));
    } else {
      ({ text, pages } = await pdfText(await downloadBytes(item, { asPdf: strategy === "convert" })));
    }
    if (!text.trim()) {
      throw new Error(`"${itemName}" has no extractable text${strategy === "pdf" ? " (it may be a scanned PDF)" : ""}.`);
    }

    const { text: returned, truncated } = truncateText(text, maxChars);
    const words = text.split(/\s+/).filter(Boolean).length;
    const kind = strategy === "text" ? "Text" : strategy === "pdf" || strategy === "convert" ? "PDF" : extensionOf(itemName).toUpperCase();
    const detail = [`${words.toLocaleString("en-US")} words`, pages ? `${pages} page${pages === 1 ? "" : "s"}` : "", truncated ? "partial" : ""]
      .filter(Boolean)
      .join(" · ");

    const rendered = card(
      header("OneDrive", tag("Read")) +
        hero(itemIcon(itemName, "file"), itemName, detail, item?.webUrl) +
        `<div class="pv">${esc(clip(previewText(text), 280))}</div>`,
      165,
    );
    // The text leads, under a name that can't be mistaken for MCP's own `content`
    // array, with an explicit cue: the card is only a preview, so the agent has
    // to answer from document_text itself.
    return widgetResult({
      document_text: returned,
      next_step: "Answer the user's request (summarize, explain, quote) from document_text. The card only shows a short preview.",
      file_name: itemName,
      path: item?.parentReference?.path ? itemPathOf(item) : undefined,
      format: kind,
      pages,
      word_count: words,
      truncated,
      returned_chars: returned.length,
      total_chars: text.length,
    }, rendered);
  }
);

// TOOL 4: upload_file (ACT)
registerTool(
  "upload_file",
  {
    title: "Upload file",
    description: "Create a new plain-text file (e.g. .txt or .md) in Microsoft OneDrive from text the user dictates or that you compose. Use when the user asks to upload, create, write, or save a note or text file to OneDrive. Never overwrites: if the name is taken OneDrive picks a new one, which the result reports.",
    inputSchema: {
      file_name: z.string().describe("File name to create, including extension (e.g. 'Notes.md' or 'Summary.txt')"),
      content: z.string().describe("Text content of the file"),
      folder_path: z.string().optional().describe("Destination OneDrive folder path relative to the root (default: 'Documents'; '/' for the root)"),
    },
  },
  async (args) => {
    const fileName = String(args?.file_name || "").trim();
    if (!fileName) throw new Error("upload_file needs a file name.");
    const { content, padded } = uploadableText(String(args?.content ?? ""));
    const rawFolder = String(args?.folder_path ?? "").trim();
    const folder = rawFolder ? normPath(rawFolder) : "Documents";

    const where = folder ? `/${folder}` : "/";
    let created: any;
    try {
      created = await composio(
        "ONE_DRIVE_ONEDRIVE_CREATE_TEXT_FILE",
        { name: fileName, content, folder: where, conflict_behavior: "rename" },
        { write: `created "${fileName}" in ${where}` },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/content-range/i.test(msg)) {
        // Fails partway through the upload session, so a file may exist anyway;
        // a blind retry would add a renamed copy next to it.
        throw new Error(`OneDrive rejected part of the upload of "${fileName}" (${msg}), so it may or may not have been created. Check ${where} in OneDrive (and that the folder exists) before trying again.`);
      }
      throw err;
    }
    const finalName = String(created?.name || fileName);
    const renamed = finalName !== fileName;
    const fileSizeStr = formatSize(typeof created?.size === "number" ? created.size : Buffer.byteLength(content, "utf-8"));

    const rendered = card(
      header("OneDrive", tag(renamed ? "Uploaded · renamed" : "Uploaded")) +
        hero(itemIcon(finalName, "file"), finalName, `in ${folder ? `/${folder}` : "My files"}`, created?.webUrl) +
        facts([["Size", fileSizeStr], ["Status", renamed ? "Name was taken" : "Saved"]]) +
        `<div class="pv">${padded ? "Empty file (one blank line)" : esc(clip(content, 280))}</div>`,
      200,
    );
    return widgetResult({
      status: "uploaded",
      file_name: finalName,
      renamed,
      path: folder ? `${folder}/${finalName}` : finalName,
      id: created?.id,
      web_url: created?.webUrl,
      size: fileSizeStr,
      note: padded ? "OneDrive's upload can't create a 0-byte file through Composio, so the file contains a single blank line." : undefined,
    }, rendered);
  }
);

// TOOL 5: create_folder (ACT)
registerTool(
  "create_folder",
  {
    title: "Create folder",
    description: "Create a new folder in Microsoft OneDrive. Use when the user asks to create, make, or add a folder in OneDrive. If the name is taken OneDrive picks a new one, which the result reports.",
    inputSchema: {
      folder_name: z.string().describe("Name of the folder to create (e.g. 'Projects' or 'Archive')"),
      parent_path: z.string().optional().describe("Existing parent folder path relative to the root (e.g. 'Documents'); leave blank for the root"),
    },
  },
  async (args) => {
    const folderName = String(args?.folder_name || "").trim();
    if (!folderName) throw new Error("create_folder needs a folder name.");
    const parent = normPath(args?.parent_path);

    const where = parent ? `/${parent}` : "/";
    const created = await composio(
      "ONE_DRIVE_ONEDRIVE_CREATE_FOLDER",
      { name: folderName, parent_folder: where, conflict_behavior: "rename" },
      { write: `created the folder "${folderName}" in ${where}` },
    );
    const finalName = String(created?.name || folderName);
    const renamed = finalName !== folderName;

    const rendered = card(
      header("OneDrive", tag("Folder created")) +
        hero(ICONS.folder, finalName, `in ${parent ? `/${parent}` : "My files"}`, created?.webUrl) +
        facts([["Status", renamed ? `"${folderName}" was taken` : "Created"]]),
      150,
    );
    return widgetResult({
      status: "folder_created",
      folder_name: finalName,
      renamed,
      path: parent ? `${parent}/${finalName}` : finalName,
      id: created?.id,
    }, rendered);
  }
);

const LINK_SCOPE_LABELS: Record<string, string> = {
  anonymous: "Anyone with the link",
  organization: "People in your organization",
  users: "Specific people",
};

/**
 * The Graph link scope for what the user asked for. Always explicit: left
 * unset, OneDrive falls back to the account's default, which on a personal
 * account is a public link. Blank means anyone, as the confirmation card says.
 */
export function linkScope(audience: unknown): "anonymous" | "organization" {
  const v = String(audience ?? "").trim().toLowerCase();
  if (!v || v === "anyone" || v === "anonymous") return "anonymous";
  if (v === "organization" || v === "organisation" || v === "org") return "organization";
  throw new Error(`Unknown link audience "${audience}". Use "anyone" or "organization".`);
}

// TOOL 6: create_share_link (ACT)
registerTool(
  "create_share_link",
  {
    title: "Create share link",
    description: "Create a sharing link for a Microsoft OneDrive file or folder and copy it to the Mac clipboard. Use when the user asks to share a file, get a link to it, or let someone view or edit it. By default anyone who has the link can open it; pass audience 'organization' when the user wants only people in their work or school organization. Call it directly with the name the user said (with or without extension, optionally with its folder); don't search first. If several files match, the error lists them.",
    inputSchema: {
      item_path: z.string().describe("File or folder name as the user said it, path (e.g. 'Documents/Report.docx'), or item id"),
      scope: z.enum(["view", "edit"]).or(z.literal("")).optional().describe("Link permission: 'view' for read-only or 'edit' to allow editing (default: 'view')"),
      audience: z.enum(["anyone", "organization"]).or(z.literal("")).optional().describe("Who can open the link: 'anyone' who has it (default) or 'organization' for people in the user's work or school organization only (not available on personal accounts)"),
    },
  },
  async (args) => {
    const type = String(args?.scope || "").trim().toLowerCase() === "edit" ? "edit" : "view";
    const scope = linkScope(args?.audience);
    const item = await resolveItem(args?.item_path, true);
    const itemName = String(item?.name || args?.item_path);
    if (scope === "organization" && item?.parentReference?.driveType === "personal") {
      throw new Error(`Personal OneDrive accounts can't make organization-only links. Use audience "anyone" to share "${itemName}" with anyone who has the link.`);
    }

    const perm = await composio("ONE_DRIVE_CREATE_LINK", { item_id: item.id, type, scope }, { write: `created a share link for "${itemName}"` });
    const shareUrl = httpsUrl(perm?.link?.webUrl || perm?.webUrl);
    if (!shareUrl) throw new Error(`OneDrive didn't return a sharing link for "${itemName}".`);
    const copied = copyToMacClipboard(shareUrl);
    const permLabel = (perm?.link?.type || type) === "edit" ? "Can edit" : "Can view";
    const audience = LINK_SCOPE_LABELS[String(perm?.link?.scope || scope)];

    const rendered = card(
      header("OneDrive", tag("Link created")) +
        hero(itemIcon(itemName, itemKind(item)), itemName, `${audience} · ${permLabel}`, item?.webUrl) +
        `<a class="lnk" href="${esc(shareUrl)}">${ICONS.link}<span>${esc(shareUrl)}</span></a>` +
        facts([["Clipboard", copied ? "Copied" : "Not copied"]]),
      200,
    );
    return widgetResult({
      status: "link_created",
      item: itemName,
      url: shareUrl,
      permission: permLabel,
      audience,
      copied_to_clipboard: copied,
    }, rendered);
  }
);

// TOOL 7: delete_file (ACT)
registerTool(
  "delete_file",
  {
    title: "Delete file",
    description: "Delete a file or folder in Microsoft OneDrive (moves it to the OneDrive recycle bin, where it can be restored). Use when the user asks to delete, remove, or trash a OneDrive item. Requires the exact path or id from list_files/search_files — never guess one from a bare name.",
    inputSchema: {
      item_path: z.string().describe("Exact OneDrive path relative to the root (e.g. 'Documents/Old.docx') or item id"),
    },
  },
  async (args) => {
    // Strict: no fuzzy name search before a destructive action.
    const item = await resolveItem(args?.item_path, false);
    const itemName = String(item?.name || args?.item_path);
    const isFolder = Boolean(item?.folder);

    await composio("ONE_DRIVE_DELETE_ITEM", { item_id: item.id }, { write: `deleted "${itemName}"` });

    const rendered = card(
      header("OneDrive", tag("Deleted")) +
        hero(ICONS.trash, itemName, `${isFolder ? "Folder and its contents" : "File"} moved to the recycle bin`) +
        `<div class="pv">Restore it from the recycle bin on OneDrive on the web.</div>`,
      150,
    );
    return widgetResult({
      status: "deleted",
      item: itemName,
      path: item?.parentReference?.path ? itemPathOf(item) : undefined,
      was_folder: isFolder,
      destination: "Recycle Bin",
    }, rendered);
  }
);

// Tests import this file for its helpers; only a real launch opens the MCP wire.
if (!process.env.ONEDRIVE_TEST_NO_CONNECT) {
  await server.connect(new StdioServerTransport());
}
