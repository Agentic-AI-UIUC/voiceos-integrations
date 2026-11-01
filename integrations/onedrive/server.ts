import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { renderCustom, markHtml, esc, clip } from "./widgetKit.ts";
import { unzipSync, strFromU8 } from "fflate";
import { extractText as extractPdfText } from "unpdf";

// Everything lives in this one file on purpose: VoiceOS publishes only server.ts
// and widgetKit.ts, so a helper module next to it would be missing on install.
// Helpers are exported so tests can import them.

// --- Composio client --------------------------------------------------------
const COMPOSIO_BASE_URL = "https://backend.composio.dev/api/v3.1";
const RECONNECT_HINT = "Reconnect OneDrive at https://app.composio.dev.";
const AUTH_ERROR_RE = /token|expire|oauth|reconnect|credentials|unauthori[sz]ed|invalid_grant|no connected account|no active account|access denied/i;
const NOT_FOUND_RE = /not ?found|itemNotFound|does not exist|404/i;

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

// --- Composio --------------------------------------------------------------

let cachedAccount: { accountId?: string; userId: string } | null = null;

async function resolveConnectedAccount(apiKey: string): Promise<{ accountId?: string; userId: string }> {
  const explicitAccountId = process.env.COMPOSIO_CONNECTED_ACCOUNT_ID?.trim();
  const configuredUserId = process.env.COMPOSIO_USER_ID?.trim() || "default";

  if (explicitAccountId) return { accountId: explicitAccountId, userId: configuredUserId };
  if (cachedAccount) return cachedAccount;

  // Only accept accounts on the OneDrive toolkit — a looser "microsoft" match
  // would happily pick an Outlook or Teams connection and fail confusingly.
  const url = `${COMPOSIO_BASE_URL}/connected_accounts?toolkit_slugs=one_drive&statuses=ACTIVE`;
  try {
    const res = await fetch(url, { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const json: any = await res.json().catch(() => null);
      const items: any[] = Array.isArray(json?.items) ? json.items : Array.isArray(json?.data?.items) ? json.data.items : [];
      const matched = items.find((acc: any) => {
        const slug = String(acc?.toolkit?.slug || acc?.toolkit_slug || "").toLowerCase();
        return (slug === "one_drive" || slug === "onedrive") && String(acc?.status || "").toUpperCase() === "ACTIVE" && !acc?.is_disabled;
      });
      if (matched?.id) {
        cachedAccount = { accountId: matched.id, userId: matched.user_id || configuredUserId };
        console.error(`Resolved OneDrive account ${matched.id} for user ${cachedAccount.userId}`);
        return cachedAccount;
      }
    } else {
      console.error(`Connected account lookup failed: HTTP ${res.status}`);
    }
  } catch (err) {
    console.error("Connected account lookup failed:", err);
  }

  // Not cached: a connection made after startup should be picked up next call.
  return { userId: configuredUserId };
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

/** Executes one Composio OneDrive tool. Throws with a user-readable message on any failure. */
export async function composio(slug: string, args: Record<string, unknown>, timeoutMs = 9000): Promise<any> {
  const apiKey = getApiKey();
  const { accountId, userId } = await resolveConnectedAccount(apiKey);
  const payload: Record<string, unknown> = { user_id: userId, version: "latest", arguments: args };
  if (accountId) payload.connected_account_id = accountId;

  console.error(`Composio ${slug} (user: ${userId}, account: ${accountId || "auto"})`);
  let res: Response;
  try {
    res = await fetch(`${COMPOSIO_BASE_URL}/tools/execute/${slug}`, {
      method: "POST",
      headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`Couldn't reach Composio: ${extractErrorMessage(err)}`);
  }

  const json: any = await res.json().catch(() => null);
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Composio rejected the request (HTTP ${res.status}). Check the API key in settings. ${RECONNECT_HINT}`);
  }
  if (!res.ok || !json || json.successful === false || json.success === false || json.error) {
    const msg = extractErrorMessage(json?.error ?? json?.message ?? json?.detail ?? `HTTP ${res.status} ${res.statusText}`);
    console.error(`Composio ${slug} failed [${res.status}]: ${msg}`);
    throw new Error(AUTH_ERROR_RE.test(msg) ? `${msg} — ${RECONNECT_HINT}` : msg);
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

// Personal IDs look like "D4648F06C91D9D3D!54927"; Business/SharePoint IDs like "01NKDM7HMOJTVYMDOSXFDK2QJDXCDI3WUK".
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
    is_folder: kind === "folder",
    size: typeof item?.size === "number" ? item.size : undefined,
    last_modified: item?.lastModifiedDateTime,
    web_url: item?.webUrl || undefined,
  };
}

/**
 * Turns what the user said — an item ID, a path, or (when allowNameSearch) a bare
 * file name — into a Graph driveItem. Never guesses between several matches.
 */
export async function resolveItem(ref: string, allowNameSearch: boolean): Promise<any> {
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
    if (!allowNameSearch || p.includes("/") || !NOT_FOUND_RE.test(extractErrorMessage(err))) throw err;
  }

  // A bare name that isn't in the root: look for an exact-name match anywhere.
  const hits = listOf(await composio("ONE_DRIVE_SEARCH_ITEMS", { q: p, top: 25 }))
    .filter((i: any) => String(i?.name || "").toLowerCase() === p.toLowerCase());
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) throw new Error(`No OneDrive item named "${p}". Use search_files to find its exact path.`);
  const where = hits.slice(0, 5).map((h: any) => (h?.parentReference?.path ? itemPathOf(h) : h?.id)).join(", ");
  throw new Error(`${hits.length} OneDrive items are named "${p}" (${where}). Ask the user which one, then pass its full path.`);
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
      }, 20000)
    : await composio("ONE_DRIVE_DOWNLOAD_FILE", { item_id: item.id, file_name: itemName }, 15000);
  // Graph's own item metadata carries a short-lived pre-authenticated link to
  // the original bytes; it's the fallback when Composio's response has none.
  const graphUrl = item?.["@microsoft.graph.downloadUrl"];
  const url = findDownloadUrl(data) ?? (!opts.asPdf && typeof graphUrl === "string" && graphUrl.startsWith("https://") ? graphUrl : undefined);
  if (!url) {
    const shape = describeShape(data);
    console.error(`No download URL in Composio response for "${itemName}": ${shape}`);
    throw new Error(`Composio didn't return a download link for "${itemName}". Response shape: ${shape}`);
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
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

export type ReadStrategy = "text" | "ooxml" | "pdf" | "convert" | "unsupported";

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

/** Cuts at a paragraph or line boundary near the limit so the model never sees half a sentence. */
export function truncateText(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  const slice = text.slice(0, maxChars);
  const cut = Math.max(slice.lastIndexOf("\n\n"), slice.lastIndexOf("\n"));
  return { text: (cut > maxChars * 0.8 ? slice.slice(0, cut) : slice).trimEnd(), truncated: true };
}

// --- MCP server ---------------------------------------------------------------

const READ_MAX_BYTES = 25 * 1024 * 1024;

const server = new McpServer({ name: "microsoft-onedrive", version: "1.2.2" });
const ACCENT = "#0078d4"; // Microsoft OneDrive signature Fluent blue

// Fluent icons in matching Microsoft 365 brand colors
const ICONS = {
  folder: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M2.5 5C2.5 4.17 3.17 3.5 4 3.5H8l1.5 1.5H16c.83 0 1.5.67 1.5 1.5V14.5c0 .83-.67 1.5-1.5 1.5H4c-.83 0-1.5-.67-1.5-1.5V5z" fill="#f8d06b"/><path d="M2.5 6.5h15V14.5c0 .83-.67 1.5-1.5 1.5H4c-.83 0-1.5-.67-1.5-1.5V6.5z" fill="#f5be42"/></svg>',
  word: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4.5 2.5C4.5 1.67 5.17 1 6 1H11.5L15.5 5V16.5C15.5 17.33 14.83 18 14 18H6C5.17 18 4.5 17.33 4.5 16.5V2.5z" fill="#0078d4"/><path d="M11.5 1V5H15.5L11.5 1z" fill="#50a0f0"/><text x="6.8" y="13.2" font-size="7.5" font-weight="700" fill="#ffffff" font-family="-apple-system,BlinkMacSystemFont,sans-serif">W</text></svg>',
  excel: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4.5 2.5C4.5 1.67 5.17 1 6 1H11.5L15.5 5V16.5C15.5 17.33 14.83 18 14 18H6C5.17 18 4.5 17.33 4.5 16.5V2.5z" fill="#107c41"/><path d="M11.5 1V5H15.5L11.5 1z" fill="#369e5f"/><text x="6.8" y="13.2" font-size="7.5" font-weight="700" fill="#ffffff" font-family="-apple-system,BlinkMacSystemFont,sans-serif">X</text></svg>',
  powerpoint: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4.5 2.5C4.5 1.67 5.17 1 6 1H11.5L15.5 5V16.5C15.5 17.33 14.83 18 14 18H6C5.17 18 4.5 17.33 4.5 16.5V2.5z" fill="#d83b01"/><path d="M11.5 1V5H15.5L11.5 1z" fill="#f06b3a"/><text x="7" y="13.2" font-size="7.5" font-weight="700" fill="#ffffff" font-family="-apple-system,BlinkMacSystemFont,sans-serif">P</text></svg>',
  file: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4.5 2.5C4.5 1.67 5.17 1 6 1H11.5L15.5 5V16.5C15.5 17.33 14.83 18 14 18H6C5.17 18 4.5 17.33 4.5 16.5V2.5z" fill="color-mix(in srgb,var(--accent) 18%,transparent)" stroke="var(--accent)" stroke-width="1.2"/><path d="M11.5 1V5H15.5" stroke="var(--accent)" stroke-width="1.2"/><path d="M7 9h6M7 12h4" stroke="var(--accent)" stroke-width="1.1" stroke-linecap="round"/></svg>',
  image: '<svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M4.5 2.5C4.5 1.67 5.17 1 6 1H11.5L15.5 5V16.5C15.5 17.33 14.83 18 14 18H6C5.17 18 4.5 17.33 4.5 16.5V2.5z" fill="#008272"/><circle cx="8" cy="8" r="1.5" fill="#ffffff"/><path d="M6 14l2.5-3 2 2.2 2-2.5 2 3.3H6z" fill="#ffffff"/></svg>',
  cloudUpload: '<svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 13.5H3.5C2.12 13.5 1 12.38 1 11C1 9.74 1.94 8.68 3.18 8.53C3.21 6.57 4.8 5 6.78 5C8.16 5 9.38 5.78 10 6.92C10.42 6.65 10.93 6.5 11.5 6.5C12.88 6.5 14 7.62 14 9C14 9.23 13.97 9.45 13.91 9.66C14.56 10.17 15 10.97 15 11.87C15 13.33 13.82 14.5 12.37 14.5H11.5"/><path d="M9 9v6M9 9L6.5 11.5M9 9L11.5 11.5"/></svg>',
  link: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6.5 9.5a3 3 0 0 1 0-4.24l1.77-1.77a3 3 0 0 1 4.24 4.24l-.88.88\"/><path d="M9.5 6.5a3 3 0 0 1 0 4.24l-1.77 1.77a3 3 0 0 1-4.24-4.24l.88-.88"/></svg>',
  check: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5L6.5 11.5L12.5 4.5"/></svg>',
  trash: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M2.5 4h11M5.5 4V2.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1V4M13 4v9.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 13.5V4M6.5 7v5M9.5 7v5"/></svg>',
  search: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>',
};

function getFileIcon(name: string, isFolder: boolean): string {
  if (isFolder) return ICONS.folder;
  const ext = (name.split(".").pop() || "").toLowerCase();
  if (["doc", "docx"].includes(ext)) return ICONS.word;
  if (["xls", "xlsx", "csv"].includes(ext)) return ICONS.excel;
  if (["ppt", "pptx"].includes(ext)) return ICONS.powerpoint;
  if (["png", "jpg", "jpeg", "svg", "webp", "gif"].includes(ext)) return ICONS.image;
  return ICONS.file;
}

function formatSize(bytes?: number): string {
  if (bytes === undefined || bytes === null || isNaN(bytes)) return "—";
  if (bytes === 0) return "0 KB";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  const safeI = Math.min(i, units.length - 1);
  return `${(bytes / Math.pow(1024, safeI)).toFixed(safeI === 0 ? 0 : 1)} ${units[safeI]}`;
}

function formatDate(dateStr?: string): string {
  if (!dateStr) return "Recently";
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "Recently";
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    if (diffHours < 1) return "Just now";
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays === 1) return "Yesterday";
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  } catch {
    return "Recently";
  }
}

// Fluent Design stylesheet utilizing theme variables
const FLUENT_CSS = `
.od-card{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink-1);padding:11px 13px 13px;background:transparent}
.od-hd{display:flex;align-items:center;gap:8px;height:28px;margin-bottom:8px}
.od-hd b{font-size:12.5px;font-weight:600;color:var(--ink-1);letter-spacing:-.01em}
.od-bc{font-size:10.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.od-cnt{font-size:11px;color:var(--ink-4);font-variant-numeric:tabular-nums;margin-left:auto;flex:none}
.od-rw{display:flex;align-items:center;gap:10px;height:42px;padding:0 8px;border-radius:6px;border-top:1px solid var(--line);text-decoration:none;color:inherit}
.od-rw:first-of-type{border-top:0}
.od-ico{flex:none;width:20px;height:20px;display:grid;place-items:center}
.od-main{flex:1;min-width:0}
.od-ttl{display:block;font-size:13px;font-weight:500;color:var(--ink-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.od-sub{display:block;font-size:10.5px;color:var(--ink-4);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.od-fig{flex:none;min-width:58px;text-align:right;font-size:11.5px;color:var(--ink-3);font-variant-numeric:tabular-nums}
.od-more{display:flex;align-items:center;justify-content:center;padding:7px 0 2px;font-size:11px;color:var(--ink-4);font-variant-numeric:tabular-nums;border-top:1px solid var(--line);margin-top:4px}
.od-empty{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:22px 14px}
.od-empty-ico{margin-bottom:8px;opacity:.85}
.od-empty-ttl{font-size:13.5px;font-weight:600;color:var(--ink-1)}
.od-empty-hint{font-size:11px;color:var(--ink-4);margin-top:3px}
.od-qpill{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:999px;background:color-mix(in srgb,var(--accent) 14%,transparent);border:1px solid color-mix(in srgb,var(--accent) 30%,transparent);color:var(--accent);font-size:11px;font-weight:500;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.od-sr-badge{font-size:10.5px;color:var(--ink-4);margin-top:1px;display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.od-receipt-hero{display:flex;align-items:center;gap:12px;padding:10px 12px;background:var(--fill-1);border-radius:8px;border:1px solid var(--line);margin-bottom:10px}
.od-hero-ico{width:36px;height:36px;border-radius:6px;background:color-mix(in srgb,var(--accent) 20%,transparent);border:1px solid color-mix(in srgb,var(--accent) 40%,transparent);display:grid;place-items:center;flex:none;box-shadow:0 0 12px color-mix(in srgb,var(--accent) 25%,transparent);color:var(--accent)}
.od-hero-m{flex:1;min-width:0}
.od-hero-name{font-size:13.5px;font-weight:600;color:var(--ink-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.od-hero-status{display:flex;align-items:center;gap:4px;font-size:10.5px;color:var(--good);margin-top:2px;font-weight:500}
.od-rail{height:3px;border-radius:3px;background:var(--track);overflow:hidden;margin-bottom:9px}
.od-rail-fill{height:100%;border-radius:3px;background:var(--accent);width:100%}
.od-stats{display:flex;gap:8px;margin-bottom:8px}
.od-stat-pill{flex:1;min-width:0;padding:5px 8px;border-radius:6px;background:var(--fill-1);border:1px solid var(--line);font-size:11px;color:var(--ink-2);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.od-stat-pill b{font-weight:600;color:var(--ink-1);margin-right:4px}
.od-local-path{font-family:ui-monospace,Menlo,Monaco,monospace;font-size:10.5px;color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 2px}
.od-pill{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:600;padding:2px 7px;border-radius:999px;background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent);white-space:nowrap}
.od-pill.good{background:color-mix(in srgb,var(--good) 18%,transparent);color:var(--good)}
.od-pill.bad{background:color-mix(in srgb,var(--bad) 18%,transparent);color:var(--bad)}
.od-callout{padding:10px 12px;background:var(--fill-1);border:1px solid var(--line);border-radius:6px;margin-bottom:8px}
.od-callout.alert{background:color-mix(in srgb,var(--bad) 10%,transparent);border-color:color-mix(in srgb,var(--bad) 30%,transparent)}
.od-link-box{display:flex;align-items:center;gap:8px;padding:8px 10px;background:color-mix(in srgb,var(--accent) 10%,transparent);border:1px solid color-mix(in srgb,var(--accent) 30%,transparent);border-radius:6px;margin:8px 0}
.od-link-text{flex:1;min-width:0;font-family:ui-monospace,Menlo,Monaco,monospace;font-size:11px;color:var(--accent);text-decoration:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
`;

function copyToMacClipboard(text: string): boolean {
  try {
    const res = spawnSync("pbcopy", { input: text, timeout: 2000 });
    return res.status === 0;
  } catch (err) {
    console.error("Clipboard write skipped:", err);
    return false;
  }
}

function widgetResult(data: Record<string, unknown>, card: { html: string; height: number }) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        ...data,
        _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
      }),
    }],
  };
}


// TOOL 1: list_files (READ)
server.registerTool(
  "list_files",
  {
    title: "List files and folder contents",
    description: "List files and folders inside a Microsoft OneDrive folder (root by default). Use when the user asks what's in their OneDrive or in a specific folder, or wants to browse directories. Each item comes back with a `path` to pass to download_file, create_share_link, or delete_file.",
    inputSchema: {
      folder_path: z.string().optional().describe("OneDrive folder path relative to the root (e.g. 'Documents' or 'Documents/Projects'); leave empty for the root"),
      limit: z.number().min(1).max(20).optional().describe("Maximum number of items to return (1-20, default 8)"),
    },
  },
  async (args) => {
    const folder = normPath(args?.folder_path);
    const limit = Math.min(Math.max(Math.round(args?.limit ?? 8), 1), 20);

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

    const displayPath = folder ? `My files > ${folder.replace(/\//g, " > ")}` : "My files";
    const countLabel = `${items.length}${hasMore ? "+" : ""} items`;

    if (items.length === 0) {
      const body = `
        <div class="od-card">
          <div class="od-hd">${markHtml()}<span class="od-bc">${esc(displayPath)}</span><span class="od-cnt">0 items</span></div>
          <div class="od-empty">
            <div class="od-empty-ico">${ICONS.folder}</div>
            <div class="od-empty-ttl">This folder is empty</div>
            <div class="od-empty-hint">Ask VoiceOS to upload a note here.</div>
          </div>
        </div>
      `;
      const card = renderCustom({ accent: ACCENT, css: FLUENT_CSS, body, height: 160 });
      return widgetResult({ folder: folder || "/", item_count: 0, items: [] }, card);
    }

    const shown = items.slice(0, 4);
    const rowsHtml = shown.map((f) => `
        <div class="od-rw">
          <div class="od-ico">${getFileIcon(f.name, f.kind !== "file")}</div>
          <div class="od-main">
            <span class="od-ttl">${esc(clip(f.name, 36))}</span>
            <span class="od-sub">Modified ${esc(formatDate(f.last_modified))}</span>
          </div>
          <div class="od-fig">${esc(f.kind === "folder" ? "Folder" : f.kind === "other" ? "—" : formatSize(f.size))}</div>
        </div>
      `).join("");

    const moreCount = items.length - shown.length;
    const moreHtml = moreCount > 0 || hasMore ? `<div class="od-more">+${moreCount}${hasMore ? "+" : ""} more items</div>` : "";
    const cardHeight = 44 + shown.length * 42 + (moreHtml ? 28 : 0) + 12;

    const body = `
      <div class="od-card">
        <div class="od-hd">${markHtml()}<span class="od-bc">${esc(displayPath)}</span><span class="od-cnt">${esc(countLabel)}</span></div>
        ${rowsHtml}
        ${moreHtml}
      </div>
    `;
    const card = renderCustom({ accent: ACCENT, css: FLUENT_CSS, body, height: cardHeight });
    return widgetResult({ folder: folder || "/", item_count: items.length, has_more: hasMore, items }, card);
  }
);

// TOOL 2: search_files (READ)
server.registerTool(
  "search_files",
  {
    title: "Search files",
    description: "Search Microsoft OneDrive for files and folders by keyword (matches names, metadata, and file contents). Use when the user wants to find or locate a file but doesn't know which folder it's in. Each result has an `id` (and usually a `path`) to pass to download_file, create_share_link, or delete_file.",
    inputSchema: {
      query: z.string().describe("Plain keywords or a file name (no wildcards or filters like 'filetype:')"),
      limit: z.number().min(1).max(20).optional().describe("Maximum results to return (1-20, default 5)"),
    },
  },
  async (args) => {
    const query = String(args?.query || "").trim();
    if (!query) throw new Error("search_files needs a query.");
    const limit = Math.min(Math.max(Math.round(args?.limit ?? 5), 1), 20);

    const data = await composio("ONE_DRIVE_SEARCH_ITEMS", { q: query, top: limit });
    const items = listOf(data).slice(0, limit).map(summarizeItem);
    const clippedQuery = clip(query, 24);

    if (items.length === 0) {
      const body = `
        <div class="od-card">
          <div class="od-hd">${markHtml()}<span class="od-qpill">Search: "${esc(clippedQuery)}"</span><span class="od-cnt">0 results</span></div>
          <div class="od-empty">
            <div class="od-empty-ico">${ICONS.search}</div>
            <div class="od-empty-ttl">No files match "${esc(clippedQuery)}"</div>
            <div class="od-empty-hint">Check the spelling, or browse folders in My files.</div>
          </div>
        </div>
      `;
      const card = renderCustom({ accent: ACCENT, css: FLUENT_CSS, body, height: 165 });
      return widgetResult({ query, total_matches: 0, results: [] }, card);
    }

    const shown = items.slice(0, 4);
    const rowsHtml = shown.map((f) => {
      const parent = f.path ? path.posix.dirname(f.path) : "";
      const where = parent && parent !== "." ? `in ${esc(clip(parent, 30))}` : f.path ? "in My files" : "";
      return `
        <div class="od-rw">
          <div class="od-ico">${getFileIcon(f.name, f.kind !== "file")}</div>
          <div class="od-main">
            <span class="od-ttl">${esc(clip(f.name, 34))}</span>
            <span class="od-sr-badge">${where || `Modified ${esc(formatDate(f.last_modified))}`}</span>
          </div>
          <div class="od-fig">${esc(f.kind === "folder" ? "Folder" : f.kind === "other" ? "—" : formatSize(f.size))}</div>
        </div>
      `;
    }).join("");

    const moreCount = items.length - shown.length;
    const moreHtml = moreCount > 0 ? `<div class="od-more">+${moreCount} more matching files</div>` : "";
    const cardHeight = 44 + shown.length * 44 + (moreCount > 0 ? 28 : 0) + 12;

    const body = `
      <div class="od-card">
        <div class="od-hd">${markHtml()}<span class="od-qpill">Search: "${esc(clippedQuery)}"</span><span class="od-cnt">${items.length} results</span></div>
        ${rowsHtml}
        ${moreHtml}
      </div>
    `;
    const card = renderCustom({ accent: ACCENT, css: FLUENT_CSS, body, height: cardHeight });
    return widgetResult({ query, total_matches: items.length, results: items }, card);
  }
);

// TOOL 3: download_file (READ)
server.registerTool(
  "download_file",
  {
    title: "Download file",
    description: "Download a file from Microsoft OneDrive into the Mac's ~/Downloads folder (never overwrites; adds ' (1)' if the name is taken). Use when the user asks to download, save locally, or fetch a OneDrive file. Pass a path or id from list_files/search_files; a bare file name also works if it's unique.",
    inputSchema: {
      item_path: z.string().describe("OneDrive path relative to the root (e.g. 'Documents/Report.pdf'), item id, or unique file name"),
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

    const body = `
      <div class="od-card">
        <div class="od-hd">${markHtml()}<b>Microsoft OneDrive</b><span class="od-pill good">Downloaded</span></div>
        <div class="od-receipt-hero">
          <div class="od-hero-ico">${ICONS.check}</div>
          <div class="od-hero-m">
            <div class="od-hero-name">${esc(clip(savedName, 34))}</div>
            <div class="od-hero-status">${ICONS.check} Saved to Mac Downloads</div>
          </div>
        </div>
        <div class="od-rail"><div class="od-rail-fill"></div></div>
        <div class="od-stats">
          <div class="od-stat-pill"><b>File size:</b> ${esc(fileSizeStr)}</div>
          <div class="od-stat-pill"><b>Folder:</b> ~/Downloads</div>
        </div>
        <div class="od-local-path">${esc(localTarget)}</div>
      </div>
    `;
    const card = renderCustom({ accent: ACCENT, css: FLUENT_CSS, body, height: 185 });
    return widgetResult({
      status: "downloaded",
      onedrive_item: itemName,
      file_name: savedName,
      local_path: localTarget,
      bytes: buffer.length,
      file_size: fileSizeStr,
    }, card);
  }
);

// TOOL 3b: read_file (READ)
server.registerTool(
  "read_file",
  {
    title: "Read file contents",
    description: "Read the text of a Microsoft OneDrive file so you can summarize it, answer questions about it, or quote from it. Works with Word, Excel, PowerPoint, PDF, and plain-text files (txt, md, csv, json, code); not images or scanned PDFs. Use when the user asks what a OneDrive file says, wants it summarized, or asks a question about its contents. Pass a path or id from list_files/search_files; a bare file name also works if it's unique.",
    inputSchema: {
      item_path: z.string().describe("OneDrive path relative to the root (e.g. 'Documents/Q3 Report.docx'), item id, or unique file name"),
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

    const body = `
      <div class="od-card">
        <div class="od-hd">${markHtml()}<b>Microsoft OneDrive</b><span class="od-pill">Read</span></div>
        <div class="od-receipt-hero">
          <div class="od-hero-ico">${getFileIcon(itemName, false)}</div>
          <div class="od-hero-m">
            <div class="od-hero-name">${esc(clip(itemName, 34))}</div>
            <div class="od-sub">${esc(detail)}</div>
          </div>
        </div>
        <div class="od-callout">
          <div class="od-local-path">${esc(clip(text.replace(/\s+/g, " "), 120))}</div>
        </div>
      </div>
    `;
    const card = renderCustom({ accent: ACCENT, css: FLUENT_CSS, body, height: 170 });
    return widgetResult({
      file_name: itemName,
      path: item?.parentReference?.path ? itemPathOf(item) : undefined,
      format: kind,
      pages,
      word_count: words,
      truncated,
      returned_chars: returned.length,
      total_chars: text.length,
      content: returned,
    }, card);
  }
);

// TOOL 4: upload_file (ACT)
server.registerTool(
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

    let created: any;
    try {
      created = await composio("ONE_DRIVE_ONEDRIVE_CREATE_TEXT_FILE", {
        name: fileName,
        content,
        folder: folder ? `/${folder}` : "/",
        conflict_behavior: "rename",
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/content-range/i.test(msg)) {
        throw new Error(`OneDrive rejected the upload of "${fileName}" (${msg}). Composio's upload step failed; try again, or check the destination folder "${folder || "/"}" exists.`);
      }
      throw err;
    }
    const finalName = String(created?.name || fileName);
    const folderDisplay = folder ? `/${folder}` : "My files";
    const fileSizeStr = formatSize(typeof created?.size === "number" ? created.size : Buffer.byteLength(content, "utf-8"));

    const body = `
      <div class="od-card">
        <div class="od-hd">${markHtml()}<b>Microsoft OneDrive</b><span class="od-pill good">Uploaded</span></div>
        <div class="od-receipt-hero">
          <div class="od-hero-ico">${ICONS.cloudUpload}</div>
          <div class="od-hero-m">
            <div class="od-hero-name">${esc(clip(finalName, 34))}</div>
            <div class="od-sub">Saved in ${esc(folderDisplay)}</div>
          </div>
        </div>
        <div class="od-stats">
          <div class="od-stat-pill"><b>Size:</b> ${esc(fileSizeStr)}</div>
          <div class="od-stat-pill"><b>Status:</b> ${finalName === fileName ? "Saved" : "Renamed (name taken)"}</div>
        </div>
        <div class="od-callout">
          <div class="od-local-path">${padded ? "(empty — one blank line)" : esc(clip(content, 120))}</div>
        </div>
      </div>
    `;
    const card = renderCustom({ accent: ACCENT, css: FLUENT_CSS, body, height: 210 });
    return widgetResult({
      status: "uploaded",
      file_name: finalName,
      renamed: finalName !== fileName,
      path: folder ? `${folder}/${finalName}` : finalName,
      id: created?.id,
      web_url: created?.webUrl,
      size: fileSizeStr,
      note: padded ? "OneDrive's upload can't create a 0-byte file through Composio, so the file contains a single blank line." : undefined,
    }, card);
  }
);

// TOOL 5: create_folder (ACT)
server.registerTool(
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

    const created = await composio("ONE_DRIVE_ONEDRIVE_CREATE_FOLDER", {
      name: folderName,
      parent_folder: parent ? `/${parent}` : "/",
      conflict_behavior: "rename",
    });
    const finalName = String(created?.name || folderName);
    const parentDisplay = parent ? `/${parent}` : "My files";

    const body = `
      <div class="od-card">
        <div class="od-hd">${markHtml()}<b>Microsoft OneDrive</b><span class="od-pill good">Folder Created</span></div>
        <div class="od-receipt-hero">
          <div class="od-hero-ico">${ICONS.folder}</div>
          <div class="od-hero-m">
            <div class="od-hero-name">${esc(clip(finalName, 34))}</div>
            <div class="od-sub">Created in ${esc(parentDisplay)}</div>
          </div>
        </div>
        <div class="od-stats">
          <div class="od-stat-pill"><b>Type:</b> Folder</div>
          <div class="od-stat-pill"><b>Status:</b> ${finalName === folderName ? "Created" : "Renamed (name taken)"}</div>
        </div>
      </div>
    `;
    const card = renderCustom({ accent: ACCENT, css: FLUENT_CSS, body, height: 175 });
    return widgetResult({
      status: "folder_created",
      folder_name: finalName,
      renamed: finalName !== folderName,
      path: parent ? `${parent}/${finalName}` : finalName,
      id: created?.id,
    }, card);
  }
);

const LINK_SCOPE_LABELS: Record<string, string> = {
  anonymous: "Anyone with the link",
  organization: "People in your organization",
  users: "Specific people",
};

// TOOL 6: create_share_link (ACT)
server.registerTool(
  "create_share_link",
  {
    title: "Create share link",
    description: "Create a sharing link for a Microsoft OneDrive file or folder and copy it to the Mac clipboard. Use when the user asks to share a file, get a link to it, or let someone view or edit it. Who can open the link follows the account's default sharing settings. Pass a path or id from list_files/search_files; a bare file name also works if it's unique.",
    inputSchema: {
      item_path: z.string().describe("OneDrive path relative to the root (e.g. 'Documents/Report.docx'), item id, or unique file name"),
      scope: z.enum(["view", "edit"]).or(z.literal("")).optional().describe("Link permission: 'view' for read-only or 'edit' to allow editing (default: 'view')"),
    },
  },
  async (args) => {
    const type = String(args?.scope || "").trim().toLowerCase() === "edit" ? "edit" : "view";
    const item = await resolveItem(args?.item_path, true);
    const itemName = String(item?.name || args?.item_path);

    const perm = await composio("ONE_DRIVE_CREATE_LINK", { item_id: item.id, type });
    const shareUrl = perm?.link?.webUrl || perm?.webUrl;
    if (typeof shareUrl !== "string" || !shareUrl.startsWith("https://")) {
      throw new Error(`OneDrive didn't return a sharing link for "${itemName}".`);
    }
    const copied = copyToMacClipboard(shareUrl);
    const linkType = perm?.link?.type || type;
    const permLabel = linkType === "edit" ? "Can edit" : "Can view";
    const audience = LINK_SCOPE_LABELS[String(perm?.link?.scope || "")] || "Default sharing settings";

    const body = `
      <div class="od-card">
        <div class="od-hd">${markHtml()}<b>Microsoft OneDrive</b><span class="od-pill good">Link Created</span></div>
        <div class="od-callout">
          <div class="od-hero-name">${esc(clip(itemName, 36))}</div>
          <div class="od-sub">${esc(audience)} · ${esc(permLabel)}</div>
        </div>
        <div class="od-link-box">
          <span style="color:var(--accent);flex:none">${ICONS.link}</span>
          <a class="od-link-text" href="${esc(shareUrl)}">${esc(clip(shareUrl, 42))}</a>
        </div>
        <div style="display:flex;align-items:center;justify-content:space-between;margin-top:4px">
          ${copied ? `<span class="od-pill good">Copied to clipboard</span>` : `<span class="od-pill bad">Not copied</span>`}
          <span class="od-sub">${esc(permLabel)}</span>
        </div>
      </div>
    `;
    const card = renderCustom({ accent: ACCENT, css: FLUENT_CSS, body, height: 195 });
    return widgetResult({
      status: "link_created",
      item: itemName,
      url: shareUrl,
      permission: permLabel,
      audience,
      copied_to_clipboard: copied,
    }, card);
  }
);

// TOOL 7: delete_file (ACT)
server.registerTool(
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

    await composio("ONE_DRIVE_DELETE_ITEM", { item_id: item.id });

    const body = `
      <div class="od-card">
        <div class="od-hd">
          ${markHtml()}
          <b>Microsoft OneDrive</b>
          <span class="od-pill bad">Moved to Recycle Bin</span>
        </div>
        <div class="od-callout alert">
          <div style="display:flex;align-items:center;gap:8px">
            <span style="color:var(--bad);flex:none">${ICONS.trash}</span>
            <span class="od-hero-name">"${esc(clip(itemName, 34))}"</span>
          </div>
          <div class="od-sub" style="margin-top:6px;line-height:1.35">
            ${isFolder ? "Folder and its contents" : "File"} moved to the OneDrive recycle bin. Restore it from OneDrive on the web.
          </div>
        </div>
      </div>
    `;
    const card = renderCustom({ accent: ACCENT, css: FLUENT_CSS, body, height: 160 });
    return widgetResult({
      status: "deleted",
      item: itemName,
      path: item?.parentReference?.path ? itemPathOf(item) : undefined,
      was_folder: isFolder,
      destination: "Recycle Bin",
    }, card);
  }
);

// Tests import this file for its helpers; only a real launch opens the MCP wire.
if (!process.env.ONEDRIVE_TEST_NO_CONNECT) {
  await server.connect(new StdioServerTransport());
}
