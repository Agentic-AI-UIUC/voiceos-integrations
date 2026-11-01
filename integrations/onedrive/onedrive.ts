// Composio client and OneDrive item helpers — everything server.ts needs that
// doesn't touch the MCP wire or the widget markup, kept here so it can be tested.
import path from "node:path";
import fs from "node:fs";

export const COMPOSIO_BASE_URL = "https://backend.composio.dev/api/v3.1";
export const RECONNECT_HINT = "Reconnect OneDrive at https://app.composio.dev.";
export const AUTH_ERROR_RE = /token|expire|oauth|reconnect|credentials|unauthori[sz]ed|invalid_grant|no connected account|no active account|access denied/i;
export const NOT_FOUND_RE = /not ?found|itemNotFound|does not exist|404/i;

export function getApiKey(): string {
  const envKey = process.env.COMPOSIO_API_KEY?.trim();
  if (envKey && envKey.length > 5) return envKey;
  throw new Error("Missing Composio API key — please configure COMPOSIO_API_KEY in this integration's settings.");
}

export function extractErrorMessage(err: any): string {
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

export async function resolveConnectedAccount(apiKey: string): Promise<{ accountId?: string; userId: string }> {
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

// Composio wraps Graph payloads to varying depths, and sometimes as a JSON string.
export function unwrap(data: any): any {
  let d = data;
  for (let i = 0; i < 4; i++) {
    if (typeof d === "string") {
      try {
        d = JSON.parse(d);
      } catch {
        return d;
      }
    }
    if (!d || typeof d !== "object" || Array.isArray(d)) return d;
    const inner = d.response_data ?? d.data ?? d.result;
    if (inner === undefined || inner === null) return d;
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
    throw new Error(`Composio rejected the request (HTTP ${res.status}). Check the API key in settings, or ${RECONNECT_HINT.toLowerCase()}`);
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

export function summarizeItem(item: any) {
  return {
    id: String(item?.id || ""),
    name: String(item?.name || "Untitled"),
    path: item?.parentReference?.path ? itemPathOf(item) : undefined,
    is_folder: Boolean(item?.folder),
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

/** Composio stages downloads in its own storage and hands back a signed URL. */
export function findDownloadUrl(d: any): string | undefined {
  const candidates = [
    d?.file?.s3url,
    d?.s3url,
    d?.file?.url,
    d?.downloaded_file_content?.s3url,
    d?.["@microsoft.graph.downloadUrl"],
    d?.downloadUrl,
    d?.download_url,
  ];
  return candidates.find((u) => typeof u === "string" && u.startsWith("https://"));
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
  const url = findDownloadUrl(data);
  if (!url) {
    const fields = data && typeof data === "object" ? Object.keys(data).join(", ") : typeof data;
    throw new Error(`Composio didn't return a download link for "${itemName}" (got: ${fields || "nothing"}).`);
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    throw new Error(`Couldn't fetch "${itemName}" from ${new URL(url).host}: ${extractErrorMessage(err)}`);
  }
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
