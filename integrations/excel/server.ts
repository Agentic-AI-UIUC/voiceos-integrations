import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { Composio } from "@composio/core";
import { renderCustom, markHtml, esc, clip } from "./widgetKit.ts";

const server = new McpServer({ name: "microsoft-excel", version: "1.0.0" });
const ACCENT = "#107c41"; // Microsoft Excel brand green
const COMPOSIO_BASE_URL = "https://backend.composio.dev";
const BUILD_ID = "excel-review-fixed-v5-collections";

export const APPROVED_COMPOSIO_ACTIONS = {
  excel_get_workbook: "EXCEL_GET_WORKBOOK",
  excel_get_worksheet: "EXCEL_GET_WORKSHEET",
  excel_get_range: "EXCEL_GET_RANGE",
  excel_list_worksheets: "EXCEL_LIST_WORKSHEETS",
  excel_create_worksheet: "EXCEL_ADD_WORKSHEET",
  excel_rename_worksheet: "EXCEL_UPDATE_WORKSHEET",
  excel_delete_worksheet: "EXCEL_DELETE_WORKSHEET",
  excel_update_range: "EXCEL_UPDATE_RANGE",
  excel_add_table_rows: "EXCEL_ADD_TABLE_ROW",
  excel_create_chart: "EXCEL_ADD_CHART",
} as const;

export const APPROVED_SLUG_SET = new Set<string>([
  "EXCEL_GET_WORKBOOK",
  "EXCEL_GET_WORKSHEET",
  "EXCEL_GET_RANGE",
  "EXCEL_LIST_WORKSHEETS",
  "EXCEL_ADD_WORKSHEET",
  "EXCEL_UPDATE_WORKSHEET",
  "EXCEL_DELETE_WORKSHEET",
  "EXCEL_UPDATE_RANGE",
  "EXCEL_ADD_TABLE_ROW",
  "EXCEL_ADD_CHART",
]);

console.error(`[microsoft-excel] Loaded ${BUILD_ID} - Manual account execution path active`);

const CSS = `
.xl{font:13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:12px 14px 14px}
.xl-hd{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.xl-meta{flex:1;min-width:0}
.xl-title{display:block;font-size:13.5px;font-weight:600;color:var(--ink-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;letter-spacing:-.01em}
.xl-sub{display:block;font-size:11px;color:var(--ink-3);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xl-chip{display:inline-flex;align-items:center;padding:2px 8px;border-radius:4px;background:color-mix(in srgb,var(--accent) 15%,transparent);border:1px solid var(--accent);color:var(--accent);font:600 11px/1.4 ui-monospace,SFMono-Regular,Consolas,monospace;letter-spacing:.02em;text-transform:uppercase;flex:none}
.xl-dim{font-size:11px;color:var(--ink-3);font-variant-numeric:tabular-nums;margin-left:auto}
.xl-pill{flex:none;font-size:10px;font-weight:600;letter-spacing:.02em;padding:2px 7px;border-radius:999px;white-space:nowrap;background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent)}
.xl-pill.good{background:color-mix(in srgb,var(--good) 18%,transparent);color:var(--good)}
.xl-pill.bad{background:color-mix(in srgb,var(--bad) 18%,transparent);color:var(--bad)}
.xl-status-bar{display:flex;align-items:center;gap:6px;padding:6px 9px;border-radius:5px;background:var(--fill-1);border:1px solid var(--line);margin-bottom:10px}
.xl-status-dot{width:6px;height:6px;border-radius:50%;background:var(--good);flex:none}
.xl-status-txt{font-size:11px;font-weight:500;color:var(--ink-2);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xl-tabs-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:6px}
.xl-tabs-lbl{font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-4)}
.xl-tabs{display:flex;align-items:center;gap:6px;overflow-x:auto;padding-bottom:2px;scrollbar-width:none}
.xl-tabs::-webkit-scrollbar{display:none}
.xl-tab{display:inline-flex;align-items:center;gap:5px;height:24px;padding:0 9px;border-radius:4px;font-size:11.5px;font-weight:500;white-space:nowrap;flex:none;background:var(--fill-1);border:1px solid var(--line);color:var(--ink-2)}
.xl-tab.active{background:color-mix(in srgb,var(--accent) 18%,transparent);border-color:var(--accent);color:var(--ink-1);font-weight:600}
.xl-dot{width:5px;height:5px;border-radius:50%;background:var(--accent);flex:none}
.xl-stats{display:flex;align-items:center;gap:14px;margin-top:10px;padding-top:10px;border-top:1px solid var(--line)}
.xl-stat{flex:1;min-width:0}
.xl-stat-k{display:block;font-size:10px;font-weight:500;text-transform:uppercase;letter-spacing:.03em;color:var(--ink-4)}
.xl-stat-v{display:block;font-size:12.5px;font-weight:600;color:var(--ink-1);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.xl-list{border-radius:6px;border:1px solid var(--line);background:var(--fill-1);overflow:hidden}
.xl-rw{display:flex;align-items:center;gap:9px;padding:7px 10px;border-top:1px solid var(--line);text-decoration:none;color:inherit}
.xl-rw:first-child{border-top:0}
.xl-rw-idx{flex:none;width:18px;font-size:10.5px;font-weight:600;color:var(--ink-4);font-variant-numeric:tabular-nums}
.xl-rw-m{flex:1;min-width:0}
.xl-rw-title{display:block;font-size:12.5px;font-weight:500;color:var(--ink-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xl-rw-sub{display:block;font-size:10.5px;color:var(--ink-4);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.xl-rw-v{flex:none;font-size:11.5px;font-weight:500;color:var(--ink-3);font-variant-numeric:tabular-nums}
.xl-hint{font-size:10.5px;color:var(--ink-4);margin-top:7px;font-style:italic}
.xl-empty{padding:16px;text-align:center;color:var(--ink-3);font-size:12px}
.xl-err{display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:6px;background:color-mix(in srgb,var(--bad) 12%,transparent);border:1px solid color-mix(in srgb,var(--bad) 30%,transparent);color:var(--ink-1);font-size:11.5px;margin-top:8px}
.xl-err-ico{color:var(--bad);flex:none;margin-top:1px}

.xr-wrap{border-radius:6px;border:1px solid var(--line);background:var(--fill-1);overflow:hidden}
.xr-tbl{width:100%;border-collapse:collapse;font-size:11.5px;table-layout:fixed}
.xr-th{height:24px;padding:0 6px;background:var(--fill-2);border-right:1px solid var(--line);border-bottom:1px solid var(--line);font-size:10px;font-weight:600;color:var(--ink-3);text-align:center;user-select:none}
.xr-corner{width:28px;background:var(--fill-2);border-right:1px solid var(--line);border-bottom:1px solid var(--line)}
.xr-idx{width:28px;height:25px;padding:0 4px;background:var(--fill-2);border-right:1px solid var(--line);border-bottom:1px solid var(--line);font-size:10px;font-weight:600;color:var(--ink-3);text-align:center;user-select:none;font-variant-numeric:tabular-nums}
.xr-cell{height:25px;padding:0 7px;border-right:1px solid var(--line);border-bottom:1px solid var(--line);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;background:var(--fill-1)}
.xr-cell:last-child{border-right:0}
.xr-rw:last-child .xr-cell{border-bottom:0}
.xr-rw:last-child .xr-idx{border-bottom:0}
.xr-num{text-align:right;font-variant-numeric:tabular-nums;color:var(--ink-1)}
.xr-txt{text-align:left;color:var(--ink-2)}
.xr-blank{color:var(--ink-4);font-style:italic;font-size:11px}
.xr-more{display:block;margin-top:6px;font-size:11px;color:var(--ink-4);text-align:right;font-style:italic}

.xl-chart-box{margin-top:8px;padding:12px;border-radius:6px;border:1px solid var(--line);background:var(--fill-1);display:flex;align-items:center;justify-content:center}
`;

const ICON_ERR = `<svg class="xl-err-ico" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6.2"/><path d="M8 5.2v3.6M8 11.2h.01"/></svg>`;

export function cleanSheetName(rawName: string): string {
  const FORBIDDEN_CHARS = new Set(["\\", "/", "?", "*", ":", "[", "]"]);
  let clean = "";
  for (let i = 0; i < rawName.length && clean.length < 31; i++) {
    const ch = rawName[i];
    clean += FORBIDDEN_CHARS.has(ch) ? "_" : ch;
  }
  clean = clean.trim();
  return clean || "Sheet1";
}

export function parseSheetAndAddress(
  rawRange: string,
  explicitSheet?: string,
): { sheet?: string; address: string } {
  const rangeStr = String(rawRange || "").trim();
  const explicit = explicitSheet ? String(explicitSheet).trim() : undefined;

  let sheetFromRange: string | undefined;
  let address = rangeStr;

  if (rangeStr.includes("!")) {
    const lastExcl = rangeStr.lastIndexOf("!");
    let sheetPart = rangeStr.slice(0, lastExcl).trim();
    address = rangeStr.slice(lastExcl + 1).trim();

    if (sheetPart.startsWith("'") && sheetPart.endsWith("'") && sheetPart.length >= 2) {
      sheetPart = sheetPart.slice(1, -1).split("''").join("'");
    }
    sheetFromRange = sheetPart;
  }

  if (explicit && sheetFromRange && explicit.toLowerCase() !== sheetFromRange.toLowerCase()) {
    throw new Error(
      `Conflicting worksheet names: range specifies '${sheetFromRange}' but worksheet_name is '${explicit}'.`,
    );
  }

  const finalSheet = explicit || sheetFromRange;
  return { sheet: finalSheet, address };
}

export function parse2DArray(input: any): any[][] {
  if (Array.isArray(input)) {
    return input.map((item) => (Array.isArray(item) ? item : [item]));
  }
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input);
      if (Array.isArray(parsed)) {
        return parsed.map((item) => (Array.isArray(item) ? item : [item]));
      }
    } catch {
      return input.split("\n").filter(Boolean).map((line: string) => line.split(",").map((c: string) => c.trim()));
    }
  }
  return [];
}

/**
 * Extract candidate owner strings from an account record using documented raw response fields.
 */
export function extractAccountOwner(acc: any): string {
  if (!acc || typeof acc !== "object") return "";
  const candidates = [
    acc.clientUniqueUserId,
    acc.client_unique_user_id,
    acc.userId,
    acc.user_id,
    acc.userUuid,
    acc.user_uuid,
    acc.entityId,
    acc.entity_id,
    acc.user?.clientUniqueUserId,
    acc.user?.id,
    acc.user?.uuid,
    acc.user?.userUuid,
    acc.user?.email,
    acc.user?.username,
    acc.user?.userName,
    acc.memberId,
    acc.member_id,
    acc.metadata?.clientUniqueUserId,
    acc.metadata?.userId,
    acc.metadata?.user_uuid,
    acc.metadata?.entityId,
    acc.connectionParams?.userId,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return "";
}

export function doesAccountBelongToUser(acc: any, targetUserId: string): boolean {
  const cleanTarget = String(targetUserId || "").trim().toLowerCase();
  if (!cleanTarget) return false;

  const ids = new Set<string>();
  const add = (val: any) => {
    if (typeof val === "string" && val.trim()) {
      ids.add(val.trim().toLowerCase());
    }
  };

  add(acc.clientUniqueUserId);
  add(acc.client_unique_user_id);
  add(acc.userId);
  add(acc.user_id);
  add(acc.userUuid);
  add(acc.user_uuid);
  add(acc.entityId);
  add(acc.entity_id);
  add(acc.memberId);
  add(acc.member_id);
  if (acc.user && typeof acc.user === "object") {
    add(acc.user.clientUniqueUserId);
    add(acc.user.id);
    add(acc.user.uuid);
    add(acc.user.userUuid);
    add(acc.user.email);
    add(acc.user.username);
    add(acc.user.userName);
  }
  if (acc.metadata && typeof acc.metadata === "object") {
    add(acc.metadata.clientUniqueUserId);
    add(acc.metadata.userId);
    add(acc.metadata.user_uuid);
    add(acc.metadata.entityId);
  }
  if (acc.connectionParams && typeof acc.connectionParams === "object") {
    add(acc.connectionParams.userId);
  }

  return ids.has(cleanTarget);
}

export type OwnershipStatus = "MATCH" | "MISMATCH" | "UNKNOWN";

export interface OwnershipCheckResult {
  status: OwnershipStatus;
  owner: string | null;
}

/**
 * Inspect account ownership using documented raw response fields.
 * A missing response field is treated as UNKNOWN, NEVER as an owner mismatch.
 * A verified mismatch occurs only when a documented owner field is present and differs from target.
 */
export function checkAccountOwnership(acc: any, targetUserId: string): OwnershipCheckResult {
  const cleanTarget = String(targetUserId || "").trim().toLowerCase();
  if (!cleanTarget) {
    return { status: "UNKNOWN", owner: null };
  }

  const rawOwner = extractAccountOwner(acc);
  if (!rawOwner) {
    // Missing response field - do not assume a mismatch
    return { status: "UNKNOWN", owner: null };
  }

  if (doesAccountBelongToUser(acc, cleanTarget) || rawOwner.toLowerCase() === cleanTarget) {
    return { status: "MATCH", owner: rawOwner };
  }

  // Documented owner field is present and differs from configured target
  return { status: "MISMATCH", owner: rawOwner };
}

export function extractAppIdentifier(acc: any): string {
  if (!acc || typeof acc !== "object") return "";
  const candidates: any[] = [
    acc.appName,
    acc.app_name,
    acc.appUniqueId,
    acc.app_unique_id,
    acc.toolkitSlug,
    acc.toolkit,
    acc.app,
    acc.integration,
    acc.integrationId,
    acc.integration_id,
    acc.appId,
    acc.slug,
  ];

  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) {
      return c.trim();
    }
    if (c && typeof c === "object") {
      const inner =
        c.name ||
        c.appName ||
        c.app_name ||
        c.appUniqueId ||
        c.app_unique_id ||
        c.slug ||
        c.key ||
        c.toolkit ||
        c.id;
      if (typeof inner === "string" && inner.trim()) {
        return inner.trim();
      }
    }
  }
  return "";
}

export function isExcelApp(appInput: any): boolean {
  if (!appInput) return false;
  let raw = "";
  if (typeof appInput === "string") {
    raw = appInput;
  } else if (typeof appInput === "object") {
    raw = extractAppIdentifier(appInput) || "";
  }
  const norm = raw.trim().toLowerCase().replace(/[-_ ]/g, "");
  return (
    norm === "excel" ||
    norm === "microsoftexcel" ||
    norm === "msexcel" ||
    norm === "office365excel" ||
    norm === "microsoft365excel"
  );
}

export function extractAccountStatus(acc: any): string {
  if (!acc || typeof acc !== "object") return "";
  if (typeof acc.status === "string" && acc.status.trim()) return acc.status.trim();
  if (typeof acc.connectionStatus === "string" && acc.connectionStatus.trim()) return acc.connectionStatus.trim();
  if (typeof acc.connection_status === "string" && acc.connection_status.trim()) return acc.connection_status.trim();
  if (typeof acc.state === "string" && acc.state.trim()) return acc.state.trim();
  if (acc.isActive === true || acc.active === true) return "ACTIVE";
  if (acc.isActive === false || acc.active === false) return "INACTIVE";
  return "";
}

export function isAccountActive(accOrStatus: any): boolean {
  if (!accOrStatus) return false;
  if (typeof accOrStatus === "object") {
    if (accOrStatus.isActive === true || accOrStatus.active === true) return true;
    const s = extractAccountStatus(accOrStatus);
    return isAccountActive(s);
  }
  const norm = String(accOrStatus).trim().toUpperCase();
  return (
    norm === "ACTIVE" ||
    norm === "CONNECTED" ||
    norm === "SUCCESS" ||
    norm === "COMPLETED" ||
    norm === "VALID"
  );
}

export interface ConnectedAccountRecord {
  id: string;
  userId?: string;
  userUuid?: string;
  entityId?: string;
  user_id?: string;
  clientUniqueUserId?: string;
  client_unique_user_id?: string;
  appName?: string;
  app?: any;
  appUniqueId?: string;
  integrationId?: string;
  toolkit?: any;
  status?: string;
  connectionStatus?: string;
  isActive?: boolean;
  active?: boolean;
  user?: any;
  [key: string]: any;
}

export function findActiveExcelAccount(
  accounts: ConnectedAccountRecord[],
  targetUserId: string,
  explicitId?: string,
): { selectedId?: string; error?: string; ownershipStatus?: OwnershipStatus } {
  const cleanTarget = String(targetUserId || "").trim();
  if (!cleanTarget) {
    return { error: "Missing required Composio user ID." };
  }

  const cleanExplicit = explicitId ? String(explicitId).trim() : "";

  // 1. If explicitId is provided (manual selection):
  if (cleanExplicit) {
    const directMatch = accounts.find((a) => a.id === cleanExplicit);
    if (directMatch) {
      // Check ownership using documented raw response fields
      const ownership = checkAccountOwnership(directMatch, cleanTarget);

      // Strict enforcement: Never bypass a real, verified ownership mismatch
      if (ownership.status === "MISMATCH") {
        const actualOwner = ownership.owner;
        return {
          ownershipStatus: "MISMATCH",
          error: `Connected account '${cleanExplicit}' belongs to Composio user '${actualOwner}', not '${cleanTarget}'. Please update COMPOSIO_USER_ID to '${actualOwner}' in settings, or connect a Microsoft Excel account for '${cleanTarget}' at app.composio.dev/connected-accounts.`,
        };
      }

      // Verify toolkit is Excel
      if (!isExcelApp(directMatch)) {
        const appName = extractAppIdentifier(directMatch) || "unknown";
        return {
          error: `Connected account '${cleanExplicit}' is associated with app '${appName}', not Microsoft Excel. Please select an Excel account.`,
        };
      }

      // Verify status is ACTIVE
      if (!isAccountActive(directMatch)) {
        const status = extractAccountStatus(directMatch) || "INACTIVE";
        return {
          error: `Connected account '${cleanExplicit}' for user '${cleanTarget}' is not active (status: ${status}). Please reconnect your Microsoft 365 / Excel account at app.composio.dev/connected-accounts.`,
        };
      }

      return { selectedId: directMatch.id, ownershipStatus: ownership.status };
    }

    return {
      error: `Connected account '${cleanExplicit}' was not found among active Excel connections for user '${cleanTarget}'.`,
    };
  }

  // 2. Automatic resolution (when NO explicitId is provided):
  // Filter for accounts with verified ownership matching target user
  const userAccounts = accounts.filter((acc) => {
    const own = checkAccountOwnership(acc, cleanTarget);
    return own.status === "MATCH";
  });

  const activeExcelAccounts = userAccounts.filter((acc) => isExcelApp(acc) && isAccountActive(acc));

  if (activeExcelAccounts.length === 0) {
    return {
      error: `No active Microsoft Excel connection found for Composio user ID '${cleanTarget}'. Please connect your Microsoft 365 / Excel account in Composio at app.composio.dev/connected-accounts using user ID '${cleanTarget}'.`,
    };
  }

  if (activeExcelAccounts.length > 1) {
    const ids = activeExcelAccounts.map((a) => a.id).join(", ");
    return {
      error: `Multiple active Excel connections found for user ID '${cleanTarget}' (${ids}). Please specify the desired account ID in COMPOSIO_CONNECTED_ACCOUNT_ID in settings.`,
    };
  }

  return { selectedId: activeExcelAccounts[0].id, ownershipStatus: "MATCH" };
}

// SDK 0.27.0 raw account retrieval preserves user_id, unlike normalized responses.
export async function resolveConnectedAccountId(composio: any, _apiKey: string, userId: string): Promise<string> {
  const accountId = process.env.COMPOSIO_CONNECTED_ACCOUNT_ID?.trim();
  if (!accountId) throw new Error("COMPOSIO_CONNECTED_ACCOUNT_ID is required for v1 QA.");
  const account = await composio.client.connectedAccounts.retrieve(accountId, { signal: AbortSignal.timeout(8000) });
  if (account.id !== accountId) throw new Error("Connected account response does not match the configured account ID.");
  if (typeof account.user_id !== "string" || !account.user_id.trim()) {
    throw new Error("Cannot verify connected account ownership: Composio omitted user_id. No tool was executed.");
  }
  if (account.user_id !== userId) throw new Error("Connected account belongs to a different Composio user. Check COMPOSIO_USER_ID.");
  if (account.toolkit?.slug !== "excel") throw new Error("Configured connected account is not an Excel account.");
  if (account.status !== "ACTIVE") throw new Error("Excel account is not active. Reconnect in the Composio dashboard.");
  return accountId;
}

export function prepareRangeActionArgs(
  actionName: string,
  inputArgs: Record<string, any>,
): Record<string, any> {
  const workbookId = (inputArgs?.workbook_id ? String(inputArgs.workbook_id).trim() : "") ||
    process.env.DEFAULT_WORKBOOK_ID?.trim() || "";
  if (!workbookId) {
    throw new Error("No workbook ID provided. Please specify a workbook_id or configure DEFAULT_WORKBOOK_ID.");
  }

  const rawRange = String(inputArgs?.range || inputArgs?.address || "A1:C4").trim();
  const { sheet, address } = parseSheetAndAddress(rawRange, inputArgs?.worksheet_name || inputArgs?.worksheet);

  const mapped: Record<string, any> = {
    ...inputArgs,
    item_id: workbookId,
    workbook_id: workbookId,
    address,
    range: address,
  };

  if (sheet) {
    mapped.worksheet_id = sheet;
    mapped.worksheet = sheet;
    mapped.worksheet_name = sheet;
  }

  if (inputArgs?.drive_id) {
    mapped.drive_id = String(inputArgs.drive_id).trim();
  }

  if (actionName === "EXCEL_UPDATE_RANGE" && inputArgs?.values !== undefined) {
    mapped.values = parse2DArray(inputArgs.values);
  }

  return mapped;
}

export function prepareWorksheetActionArgs(
  actionName: string,
  inputArgs: Record<string, any>,
  schemaProperties?: Record<string, any>,
): Record<string, any> {
  const workbookId = (inputArgs?.workbook_id ? String(inputArgs.workbook_id).trim() : "") ||
    process.env.DEFAULT_WORKBOOK_ID?.trim() || "";
  if (!workbookId) {
    throw new Error("No workbook ID provided. Please specify a workbook_id or configure DEFAULT_WORKBOOK_ID.");
  }

  const rawName = (inputArgs?.name ? String(inputArgs.name).trim() : "") ||
    (inputArgs?.worksheet_name ? String(inputArgs.worksheet_name).trim() : "") ||
    (inputArgs?.worksheet ? String(inputArgs.worksheet).trim() : "") ||
    (inputArgs?.title ? String(inputArgs.title).trim() : "");
  if (!rawName) {
    throw new Error("Worksheet name is required.");
  }

  const cleanName = cleanSheetName(rawName);

  const mapped: Record<string, any> = {
    ...inputArgs,
    item_id: workbookId,
    workbook_id: workbookId,
    name: cleanName,
    worksheet_name: cleanName,
    worksheet: cleanName,
    sheet_name: cleanName,
    sheetName: cleanName,
    title: cleanName,
  };

  if (inputArgs?.drive_id) {
    mapped.drive_id = String(inputArgs.drive_id).trim();
  }

  return mapped;
}

export function prepareUpdateWorksheetArgs(
  inputArgs: Record<string, any>,
  schemaProperties?: Record<string, any>,
): Record<string, any> {
  const workbookId = (inputArgs?.workbook_id ? String(inputArgs.workbook_id).trim() : "") ||
    process.env.DEFAULT_WORKBOOK_ID?.trim() || "";
  if (!workbookId) {
    throw new Error("No workbook ID provided. Please specify a workbook_id or configure DEFAULT_WORKBOOK_ID.");
  }

  const currentName = String(inputArgs?.current_name || inputArgs?.worksheet || "").trim();
  const newName = String(inputArgs?.new_name || inputArgs?.name || "").trim();
  if (!currentName) {
    throw new Error("Current worksheet name is required.");
  }
  if (!newName) {
    throw new Error("New worksheet name is required.");
  }

  const cleanNewName = cleanSheetName(newName);

  const mapped: Record<string, any> = {
    ...inputArgs,
    item_id: workbookId,
    workbook_id: workbookId,
    worksheet: currentName,
    current_name: currentName,
    name: cleanNewName,
    new_name: cleanNewName,
  };

  if (inputArgs?.drive_id) {
    mapped.drive_id = String(inputArgs.drive_id).trim();
  }

  return mapped;
}

export function prepareDeleteWorksheetArgs(
  actionName: string,
  inputArgs: Record<string, any>,
  schemaProperties?: Record<string, any>,
  resolvedSheetId?: string,
  resolvedSheetName?: string,
): Record<string, any> {
  const workbookId = (inputArgs?.workbook_id ? String(inputArgs.workbook_id).trim() : "") ||
    process.env.DEFAULT_WORKBOOK_ID?.trim() || "";
  if (!workbookId) {
    throw new Error("No workbook ID provided. Please specify a workbook_id or configure DEFAULT_WORKBOOK_ID.");
  }

  const rawTarget = (inputArgs?.worksheet_name ? String(inputArgs.worksheet_name).trim() : "") ||
    (inputArgs?.worksheet ? String(inputArgs.worksheet).trim() : "") ||
    (inputArgs?.name ? String(inputArgs.name).trim() : "") ||
    (inputArgs?.sheet_name ? String(inputArgs.sheet_name).trim() : "") ||
    (inputArgs?.id ? String(inputArgs.id).trim() : "");
  if (!rawTarget) {
    throw new Error("Worksheet name or ID is required to delete a worksheet.");
  }

  let cleanName = rawTarget;
  if (cleanName.startsWith("'") && cleanName.endsWith("'") && cleanName.length >= 2) {
    cleanName = cleanName.slice(1, -1).split("''").join("'");
  }

  const targetName = resolvedSheetName || cleanName;
  const targetId = resolvedSheetId || targetName;

  const mapped: Record<string, any> = {
    ...inputArgs,
    item_id: workbookId,
    workbook_id: workbookId,
    file_id: workbookId,
    workbookId: workbookId,
    worksheet_id: targetId,
    workbookWorksheet_id: targetId,
    worksheetId: targetId,
    id: targetId,
    worksheet_name: targetName,
    worksheet: targetName,
    name: targetName,
    sheet_name: targetName,
    sheetName: targetName,
    title: targetName,
  };

  if (inputArgs?.drive_id) {
    mapped.drive_id = String(inputArgs.drive_id).trim();
  }

  return mapped;
}

export function prepareTableActionArgs(
  actionName: string,
  inputArgs: Record<string, any>,
  schemaProperties?: Record<string, any>,
): Record<string, any> {
  const workbookId = (inputArgs?.workbook_id ? String(inputArgs.workbook_id).trim() : "") ||
    process.env.DEFAULT_WORKBOOK_ID?.trim() || "";
  if (!workbookId) {
    throw new Error("No workbook ID provided. Please specify a workbook_id or configure DEFAULT_WORKBOOK_ID.");
  }

  const tableIdentifier = (inputArgs?.table_id ? String(inputArgs.table_id).trim() : "") ||
    (inputArgs?.table_name ? String(inputArgs.table_name).trim() : "");
  if (!tableIdentifier) {
    throw new Error(
      "Target table ID or table name is required (e.g. 'ReleaseQATable'). In Excel, table names function as valid table IDs under Microsoft Graph. You can find or set the table name in Excel under Table Design -> Table Name."
    );
  }

  const parsedRows = parse2DArray(inputArgs?.rows ?? inputArgs?.values);

  const mapped: Record<string, any> = {
    ...inputArgs,
    item_id: workbookId,
    workbook_id: workbookId,
    table_id: tableIdentifier,
    table_name: tableIdentifier,
    table: tableIdentifier,
    tableName: tableIdentifier,
    values: parsedRows,
    rows: parsedRows,
  };

  if (inputArgs?.worksheet_name || inputArgs?.worksheet) {
    const sheet = String(inputArgs.worksheet_name || inputArgs.worksheet).trim();
    mapped.worksheet_name = sheet;
    mapped.worksheet = sheet;
    mapped.worksheet_id = sheet;
  }

  if (inputArgs?.drive_id) {
    mapped.drive_id = String(inputArgs.drive_id).trim();
  }

  return mapped;
}

export const SUPPORTED_SERIES_BY = ["Auto", "Columns", "Rows"];

export function prepareChartActionArgs(
  inputArgs: Record<string, any>,
  schemaProperties?: Record<string, any>,
): Record<string, any> {
  const workbookId = (inputArgs?.workbook_id ? String(inputArgs.workbook_id).trim() : "") ||
    process.env.DEFAULT_WORKBOOK_ID?.trim() || "";
  if (!workbookId) {
    throw new Error("No workbook ID provided. Please specify a workbook_id or configure DEFAULT_WORKBOOK_ID.");
  }

  const rawRange = String(inputArgs?.range || "A1:C5").trim();
  const { sheet, address } = parseSheetAndAddress(rawRange, inputArgs?.worksheet_name);

  const chartType = String(inputArgs?.chart_type || inputArgs?.type || "ColumnClustered").trim();
  const chartTitle = inputArgs?.title ? String(inputArgs.title).trim() : "Excel Chart";

  let acceptedSeries = SUPPORTED_SERIES_BY;
  let defaultSeries = "Auto";
  if (schemaProperties?.seriesby) {
    if (Array.isArray(schemaProperties.seriesby.enum) && schemaProperties.seriesby.enum.length > 0) {
      acceptedSeries = schemaProperties.seriesby.enum;
    }
    if (schemaProperties.seriesby.default) {
      defaultSeries = schemaProperties.seriesby.default;
    }
  }

  let resolvedSeriesBy = defaultSeries;
  const userSeriesBy = inputArgs?.series_by || inputArgs?.seriesby;
  if (userSeriesBy) {
    const rawUser = String(userSeriesBy).trim();
    const match = acceptedSeries.find((s) => s.toLowerCase() === rawUser.toLowerCase());
    if (!match) {
      throw new Error(
        `Unsupported series_by value '${rawUser}'. Supported values are: ${acceptedSeries.join(", ")}.`,
      );
    }
    resolvedSeriesBy = match;
  }

  const escapedSheet = sheet ? sheet.split("'").join("''") : "";
  const fullSourceData = sheet ? `'${escapedSheet}'!${address}` : rawRange;

  const mapped: Record<string, any> = {
    ...inputArgs,
    item_id: workbookId,
    workbook_id: workbookId,
    sourcedata: fullSourceData,
    source_data: fullSourceData,
    range: fullSourceData,
    address,
    type: chartType,
    chart_type: chartType,
    seriesby: resolvedSeriesBy,
    series_by: resolvedSeriesBy,
    title: chartTitle,
  };

  if (sheet) {
    mapped.worksheet_id = sheet;
    mapped.worksheet = sheet;
    mapped.worksheet_name = sheet;
    mapped.sheet_name = sheet;
  }

  if (inputArgs?.drive_id) {
    mapped.drive_id = String(inputArgs.drive_id).trim();
  }

  return mapped;
}

export function runRegressionTests(): { passed: boolean; details: string; results: Record<string, boolean> } {
  const results: Record<string, boolean> = {};

  // 1. Assert exact approved slugs for all 10 tools
  results["audit: excel_rename_worksheet uses EXCEL_UPDATE_WORKSHEET"] =
    APPROVED_COMPOSIO_ACTIONS.excel_rename_worksheet === "EXCEL_UPDATE_WORKSHEET";
  results["audit: excel_delete_worksheet uses EXCEL_DELETE_WORKSHEET"] =
    APPROVED_COMPOSIO_ACTIONS.excel_delete_worksheet === "EXCEL_DELETE_WORKSHEET";
  results["audit: excel_get_workbook uses EXCEL_GET_WORKBOOK"] =
    APPROVED_COMPOSIO_ACTIONS.excel_get_workbook === "EXCEL_GET_WORKBOOK";
  results["audit: excel_get_worksheet uses EXCEL_GET_WORKSHEET"] =
    APPROVED_COMPOSIO_ACTIONS.excel_get_worksheet === "EXCEL_GET_WORKSHEET";
  results["audit: excel_get_range uses EXCEL_GET_RANGE"] =
    APPROVED_COMPOSIO_ACTIONS.excel_get_range === "EXCEL_GET_RANGE";
  results["audit: excel_list_worksheets uses EXCEL_LIST_WORKSHEETS"] =
    APPROVED_COMPOSIO_ACTIONS.excel_list_worksheets === "EXCEL_LIST_WORKSHEETS";
  results["audit: excel_create_worksheet uses EXCEL_ADD_WORKSHEET"] =
    APPROVED_COMPOSIO_ACTIONS.excel_create_worksheet === "EXCEL_ADD_WORKSHEET";
  results["audit: excel_update_range uses EXCEL_UPDATE_RANGE"] =
    APPROVED_COMPOSIO_ACTIONS.excel_update_range === "EXCEL_UPDATE_RANGE";
  results["audit: excel_add_table_rows uses EXCEL_ADD_TABLE_ROW"] =
    APPROVED_COMPOSIO_ACTIONS.excel_add_table_rows === "EXCEL_ADD_TABLE_ROW";
  results["audit: excel_create_chart uses EXCEL_ADD_CHART"] =
    APPROVED_COMPOSIO_ACTIONS.excel_create_chart === "EXCEL_ADD_CHART";

  // 2. Slug set integrity
  const allRegistryValues = Object.values(APPROVED_COMPOSIO_ACTIONS);
  results["audit: all 10 registered actions are in approved slug set"] =
    allRegistryValues.every((slug) => APPROVED_SLUG_SET.has(slug));
  results["audit: registry has no duplicate actions"] =
    new Set(allRegistryValues).size === 10;
  results["audit: no guessed slugs or derived names"] =
    !allRegistryValues.some((slug) => slug.includes("RENAME") || slug.includes("CREATE_SHEET"));

  // 3. Schema mappings for EXCEL_UPDATE_WORKSHEET
  const ren = prepareUpdateWorksheetArgs({
    workbook_id: "wb_qa_123",
    current_name: "Sheet1",
    new_name: "Revenue Summary",
  });
  results["rename mapping: current_name -> worksheet"] = ren.worksheet === "Sheet1";
  results["rename mapping: new_name -> name"] = ren.name === "Revenue Summary";
  results["rename mapping: workbook_id -> item_id"] = ren.item_id === "wb_qa_123";

  // 4. Schema mappings for EXCEL_DELETE_WORKSHEET
  const del1 = prepareDeleteWorksheetArgs("EXCEL_DELETE_WORKSHEET", {
    workbook_id: "wb_qa_123",
    worksheet_name: "Old Draft",
  });
  results["delete mapping: worksheet_name -> worksheet_id"] = del1.worksheet_id === "Old Draft";
  results["delete mapping: workbook_id -> item_id"] = del1.item_id === "wb_qa_123";

  // 5. Table rows mapping
  const c1 = prepareTableActionArgs("EXCEL_ADD_TABLE_ROW", {
    workbook_id: "wb_qa_123",
    table_name: "ReleaseQATable",
    rows: [["Col1", "Col2"]],
  });
  results["table mapping: table_name -> table_id"] = c1.table_id === "ReleaseQATable";
  results["table mapping: workbook_id -> item_id"] = c1.item_id === "wb_qa_123";

  // 6. Add worksheet mapping
  const ws1 = prepareWorksheetActionArgs("EXCEL_ADD_WORKSHEET", {
    workbook_id: "wb_qa_123",
    name: "Q3 Forecast",
  });
  results["add worksheet mapping: name -> name"] = ws1.name === "Q3 Forecast";
  results["add worksheet mapping: workbook_id -> item_id"] = ws1.item_id === "wb_qa_123";

  // 7. Unit checks: Connected account ownership verification and manual path restoration
  // Check 7a: Verified mismatch reports exact documented owner without placeholder
  const diffOwnerRes = findActiveExcelAccount(
    [{ id: "ca_test_owner_mismatch", userId: "default", appName: "excel", status: "ACTIVE" }],
    "qa_user_mismatch",
    "ca_test_owner_mismatch",
  );
  results["account lookup: verified owner mismatch reports exact owner and suggests user ID"] =
    !diffOwnerRes.selectedId &&
    (diffOwnerRes.error?.includes("belongs to Composio user 'default', not 'qa_user_mismatch'") ?? false) &&
    (diffOwnerRes.error?.includes("update COMPOSIO_USER_ID to 'default'") ?? false);

  // Check 7b: Never bypass ownership validation when mismatch is verified
  const foreignAccount = findActiveExcelAccount(
    [{ id: "ca_foreign_1", clientUniqueUserId: "other_user_88", appName: "excel", status: "ACTIVE" }],
    "target_user_42",
    "ca_foreign_1",
  );
  results["account lookup: never bypasses ownership validation for foreign account"] =
    !foreignAccount.selectedId && (foreignAccount.error?.includes("belongs to Composio user 'other_user_88'") ?? false);

  // Check 7c: Missing owner response field is NOT treated as an owner mismatch
  const missingOwnerRes = findActiveExcelAccount(
    [{ id: "ca_missing_owner", appName: "excel", status: "ACTIVE" }],
    "target_user_42",
    "ca_missing_owner",
  );
  results["account lookup: missing response owner field is not treated as mismatch"] =
    missingOwnerRes.selectedId === "ca_missing_owner" &&
    missingOwnerRes.ownershipStatus === "UNKNOWN" &&
    !missingOwnerRes.error;

  // Check 7d: App as nested object in Composio SDK response
  const objectAppRes = findActiveExcelAccount(
    [{ id: "ca_nested_app", clientUniqueUserId: "target_user_42", app: { name: "excel", appUniqueId: "EXCEL" }, status: "ACTIVE" }],
    "target_user_42",
    "ca_nested_app",
  );
  results["account lookup: recognizes app when app is object { name: 'excel' }"] =
    objectAppRes.selectedId === "ca_nested_app";

  // Check 7e: Documented raw field clientUniqueUserId under user object
  const nestedUserRes = findActiveExcelAccount(
    [{ id: "ca_user_obj", user: { clientUniqueUserId: "target_user_42" }, appName: "excel", status: "ACTIVE" }],
    "target_user_42",
  );
  results["account lookup: recognizes owner under user.clientUniqueUserId"] =
    nestedUserRes.selectedId === "ca_user_obj";

  // Check 7f: Inactive / expired status is rejected with reconnect instructions
  const expiredRes = findActiveExcelAccount(
    [{ id: "ca_exp_1", userId: "target_user_42", appName: "excel", status: "EXPIRED" }],
    "target_user_42",
    "ca_exp_1",
  );
  results["account lookup: rejects expired account and instructs to reconnect"] =
    !expiredRes.selectedId && (expiredRes.error?.includes("is not active (status: EXPIRED)") ?? false);

  // Check 7g: Non-Excel toolkit is rejected
  const nonExcelRes = findActiveExcelAccount(
    [{ id: "ca_sheets_1", userId: "target_user_42", appName: "google_sheets", status: "ACTIVE" }],
    "target_user_42",
    "ca_sheets_1",
  );
  results["account lookup: rejects non-Excel account"] =
    !nonExcelRes.selectedId && (nonExcelRes.error?.includes("associated with app 'google_sheets'") ?? false);

  // Check 7h: Zero matching accounts gives connection instructions
  const zeroRes = findActiveExcelAccount([], "target_user_42");
  results["account lookup: zero accounts returns connection instructions"] =
    !zeroRes.selectedId && (zeroRes.error?.includes("No active Microsoft Excel connection found") ?? false);

  // Check 7i: Multiple active Excel accounts prompt for explicit selection
  const multiRes = findActiveExcelAccount(
    [
      { id: "ca_active_1", userId: "target_user_42", appName: "excel", status: "ACTIVE" },
      { id: "ca_active_2", userId: "target_user_42", appName: "microsoft-excel", status: "ACTIVE" },
    ],
    "target_user_42",
  );
  results["account lookup: multiple accounts prompt for explicit choice"] =
    !multiRes.selectedId && (multiRes.error?.includes("Multiple active Excel connections found") ?? false);

  // Check 7j: Multiple accounts disambiguated by explicitId
  const disambigRes = findActiveExcelAccount(
    [
      { id: "ca_active_1", userId: "target_user_42", appName: "excel", status: "ACTIVE" },
      { id: "ca_active_2", userId: "target_user_42", appName: "microsoft-excel", status: "ACTIVE" },
    ],
    "target_user_42",
    "ca_active_2",
  );
  results["account lookup: disambiguates when explicitId matches owned active account"] =
    disambigRes.selectedId === "ca_active_2" && !disambigRes.error;

  const allPassed = Object.values(results).every(Boolean);
  return {
    passed: allPassed,
    details: allPassed ? "All regression tests passed." : "Regression test failed.",
    results,
  };
}

function isAuthFailure(errorMessage: string, errorCode?: string): boolean {
  const code = (errorCode || "").toUpperCase();
  if (
    code === "CONNECTED_ACCOUNT_EXPIRED" ||
    code === "CONNECTED_ACCOUNT_REVOKED" ||
    code === "CONNECTED_ACCOUNT_INACTIVE" ||
    code === "TOKEN_EXPIRED" ||
    code === "INVALID_GRANT" ||
    code === "AUTH_ERROR" ||
    code === "AUTH_EXPIRED" ||
    code === "AUTH_REVOKED" ||
    code === "UNAUTHORIZED"
  ) {
    return true;
  }

  const msg = (errorMessage || "").toLowerCase();
  const authPhrases = [
    "token has expired",
    "token expired",
    "token revoked",
    "token invalid",
    "expired token",
    "revoked token",
    "invalid_grant",
    "invalid grant",
    "refresh token",
    "connected account is expired",
    "connected account is revoked",
    "connected account is inactive",
    "reconnect your account",
    "reconnect at app.composio.dev",
    "microsoft 365 authentication failed",
    "microsoft 365 authentication expired",
    "authentication is missing, expired, or revoked",
  ];

  return authPhrases.some((phrase) => msg.includes(phrase));
}

// Normalize collection responses once for both cards and write preflights.
// Unknown/malformed responses must never be treated as an empty collection.
export function readExcelCollection(data: any, kind: "worksheets" | "tables"): any[] {
  const label = kind === "worksheets" ? "worksheet list" : "table list";
  const fail = (reason: string): never => { throw new Error("Cannot confirm the complete " + label + ": " + reason + ". No write attempted."); };
  let current = data;
  for (let depth = 0; depth < 5; depth++) {
    if (!current || typeof current !== "object") return fail("unexpected response type");
    if (current.error || current.successful === false || current.success === false) return fail("provider reported an error");
    if (current["@odata.nextLink"] || current.odata_next_link || current.next_link || current.nextLink || current.has_more || current.next_cursor || current.pagination?.next_link || current.pagination?.has_more) return fail("additional pages were returned");
    const keys = kind === "worksheets" ? ["value", "worksheets", "sheets"] : ["value", "tables"];
    const collections = Array.isArray(current) ? [current] : keys.filter(key => key in current).map(key => current[key]);
    if (collections.length) {
      if (collections.some(value => !Array.isArray(value))) return fail("collection is not an array");
      if (collections.some(value => JSON.stringify(value) !== JSON.stringify(collections[0]))) return fail("conflicting collection fields");
      return collections[0].map((item: any) => {
        if (kind === "worksheets" && typeof item === "string" && item.trim()) return {name: item};
        if (!item || typeof item !== "object" || typeof item.name !== "string" || !item.name.trim()) return fail("item has no name");
        return item;
      });
    }
    if (current.response_data !== undefined) current = current.response_data;
    else if (current.data !== undefined) current = current.data;
    else return fail("unrecognized fields: " + Object.keys(current).join(", "));
  }
  return fail("response nesting exceeds limit");
}

// Internal read-only lookup; this does not add another exposed MCP tool.
export async function resolveWriteTarget(action: string, input: Record<string, any>, read: (action: string, args: any) => Promise<any>): Promise<Record<string, any>> {
  const context = {workbook_id: input.workbook_id, drive_id: input.drive_id};
  const sheetsData = await read("EXCEL_LIST_WORKSHEETS", context);
  const sheets = readExcelCollection(sheetsData, "worksheets");
  let requested = input.worksheet_name;
  if (action === "EXCEL_ADD_CHART") requested = parseSheetAndAddress(String(input.range), input.worksheet_name).sheet;
  const selected = requested ? sheets.filter((sheet: any) => typeof sheet.name === "string" && (sheet.name.toLowerCase() === String(requested).toLowerCase() || sheet.id === requested)) : sheets;
  if (requested && selected.length !== 1) throw new Error("Worksheet '" + requested + "' was not found in this workbook. Available worksheets: " + sheets.map((sheet: any) => sheet.name).join(", ") + ". No write attempted. Choose an existing sheet; no automatic substitution.");
  if (action === "EXCEL_DELETE_WORKSHEET") {
    if (!requested) throw new Error("Specify the exact worksheet to delete. No write attempted.");
    if (sheets.length <= 1 || (selected[0].visibility === "Visible" && !sheets.some((sheet: any) => sheet !== selected[0] && sheet.visibility === "Visible"))) throw new Error("Cannot delete the last visible worksheet. No write attempted.");
    return {...input, worksheet_name: selected[0].name};
  }
  if (action === "EXCEL_ADD_CHART") {
    if (!requested) throw new Error("Specify worksheet_name or a sheet-qualified chart range. No write attempted.");
    return {...input, worksheet_name: selected[0].name};
  }
  const identifier = String(input.table_id || input.table_name || "").trim();
  if (!identifier) throw new Error("Specify a table name or ID. No write attempted.");
  const matches: any[] = [];
  const available: string[] = [];
  // Reads run concurrently; any failed or incomplete lookup blocks the write.
  await Promise.all(selected.map(async (sheet: any) => {
    const data = await read("EXCEL_LIST_TABLES", {...context, worksheet_name: sheet.name});
    for (const table of readExcelCollection(data, "tables")) {
      available.push(String(table.name || table.id));
      if (table.id === identifier || (typeof table.name === "string" && table.name.toLowerCase() === identifier.toLowerCase())) matches.push({table, sheet});
    }
  }));
  if (matches.length !== 1 || typeof matches[0].table.id !== "string" || !matches[0].table.id) throw new Error("Table '" + identifier + "' could not be uniquely resolved in this workbook. Available tables: " + (available.join(", ") || "none") + ". Confirm the table exists (not just a named range), the workbook is correct, and Excel has saved. No rows appended.");
  return {...input, table_id: matches[0].table.id, worksheet_name: matches[0].sheet.name};
}

export const WRITE_ACTIONS = new Set(["EXCEL_ADD_WORKSHEET", "EXCEL_UPDATE_WORKSHEET", "EXCEL_DELETE_WORKSHEET", "EXCEL_UPDATE_RANGE", "EXCEL_ADD_TABLE_ROW", "EXCEL_ADD_CHART"]);
export function timeoutMessage(action: string): string {
  return WRITE_ACTIONS.has(action)
    ? `Composio request timed out while executing ${action}. Outcome unknown: the change may already have completed. Check the workbook before retrying; do not repeat the write automatically.`
    : `Composio request timed out while executing ${action}. Please try again.`;
}

export function mapPinnedAction(action: string, input: Record<string, any>): Record<string, any> {
  const item_id = input.workbook_id || input.item_id || process.env.DEFAULT_WORKBOOK_ID?.trim();
  let args: Record<string, any> = { item_id };
  switch (action) {
    case "EXCEL_GET_WORKBOOK": case "EXCEL_LIST_WORKSHEETS": break;
    case "EXCEL_LIST_TABLES": case "EXCEL_GET_WORKSHEET": args.worksheet = input.worksheet_name || input.worksheet; break;
    case "EXCEL_ADD_WORKSHEET": args.name = prepareWorksheetActionArgs(action, input).name; break;
    case "EXCEL_UPDATE_WORKSHEET": {
      const mapped = prepareUpdateWorksheetArgs(input);
      args.worksheet = mapped.worksheet; args.name = mapped.name; break;
    }
    case "EXCEL_DELETE_WORKSHEET": args.worksheet = input.worksheet_name || input.worksheet || input.resolved_name; break;
    case "EXCEL_GET_RANGE": case "EXCEL_UPDATE_RANGE": {
      const mapped = prepareRangeActionArgs(action, input);
      args.worksheet_id = mapped.worksheet_id; args.address = mapped.address;
      if (action === "EXCEL_UPDATE_RANGE") args.values = mapped.values;
      break;
    }
    case "EXCEL_ADD_TABLE_ROW": {
      const mapped = prepareTableActionArgs(action, input);
      args.table_id = mapped.table_id; args.values = mapped.values; break;
    }
    case "EXCEL_ADD_CHART": {
      const mapped = prepareChartActionArgs(input);
      args.worksheet = mapped.worksheet; args.type = mapped.type;
      args.sourcedata = mapped.sourcedata; args.seriesby = mapped.seriesby; break;
    }
    default: throw new Error("Unsupported Excel action.");
  }
  const drive = input.drive_id || process.env.DEFAULT_DRIVE_ID?.trim() || /^([0-9a-f]{16})!/i.exec(String(item_id || ""))?.[1];
  if (drive) args.drive_id = drive;
  return Object.fromEntries(Object.entries(args).filter(([,value]) => value !== undefined));
}

export async function executeComposioAction(actionName: string, inputArgs: Record<string, any>, clientForTest?: any): Promise<any> {
  if (!APPROVED_SLUG_SET.has(actionName) && actionName !== "EXCEL_LIST_TABLES") {
    throw new Error(`Unapproved action slug '${actionName}'. Only audited, approved Composio slugs may be executed.`);
  }

  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("Missing Composio API key. Please configure COMPOSIO_API_KEY in integration settings.");
  }

  const userId = process.env.COMPOSIO_USER_ID?.trim();
  if (!userId) {
    throw new Error("Missing Composio user ID. Please configure COMPOSIO_USER_ID in integration settings.");
  }

  let composio: any;
  try {
    composio = clientForTest ?? new Composio({ apiKey, baseUrl: COMPOSIO_BASE_URL });
  } catch (initErr: any) {
    throw new Error(`Failed to initialize Composio client: ${initErr.message || String(initErr)}`);
  }

  const connectedAccountId = await resolveConnectedAccountId(composio, apiKey, userId);

  const configuredVersion = process.env.COMPOSIO_EXCEL_VERSION?.trim();
  const version = !configuredVersion || configuredVersion.toLowerCase() === "latest"
    ? "20261029_00"
    : configuredVersion;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 19000);
  try {
    const tool = await composio.tools.getRawComposioToolBySlug(actionName, { version }, { signal: controller.signal });
    const properties = tool.inputParameters?.properties;
    if (!properties) throw new Error("Missing pinned tool input schema; no execution attempted.");
    const mappedArgs = mapPinnedAction(actionName, inputArgs);
    // Optional drive scoping is only applicable when the action declares it.
    if (!("drive_id" in properties)) delete mappedArgs.drive_id;
    for (const key of Object.keys(mappedArgs)) {
      if (!(key in properties)) throw new Error(`${actionName} (${version}): pinned mapping field ${key} is absent from the catalog. Catalog fields: ${Object.keys(properties).join(", ")}. No execution attempted.`);
    }
    const missing = (tool.inputParameters.required || []).filter((key: string) => mappedArgs[key] === undefined || mappedArgs[key] === "");
    if (missing.length) throw new Error(`${actionName} (${version}) requires: ${missing.join(", ")}. No execution attempted.`);
    const res = await composio.tools.execute(actionName, {
      userId, connectedAccountId, arguments: mappedArgs, version,
    }, { signal: controller.signal, maxRetries: 0 });

    if (
      res &&
      (res.successful === false ||
        res.success === false ||
        res.error ||
        res.data?.error ||
        res.response_data?.error)
    ) {
      const detail =
        res.error ||
        res.data?.error ||
        res.response_data?.error ||
        res.message ||
        res.details ||
        "Execution failed";
      const errorMsg = typeof detail === "string" ? detail : (detail?.message || JSON.stringify(detail));
      const errorCode =
        res.error_code ||
        res.errorCode ||
        res.code ||
        res.data?.error_code ||
        res.response_data?.error_code ||
        "ACTION_EXECUTION_FAILED";

      if (isAuthFailure(errorMsg, errorCode)) {
        throw new Error("Microsoft 365 authentication is missing, expired, or revoked in Composio. Reconnect at app.composio.dev.");
      }

      const codePrefix = errorCode ? `[${errorCode}] ` : "";
      throw new Error(`Composio action error (${actionName}): ${codePrefix}${errorMsg}`);
    }

    const data = res?.data?.response_data ?? res?.data ?? res?.response_data ?? res;
    return data;
  } catch (err: any) {
    if (controller.signal.aborted) {
      throw new Error(timeoutMessage(actionName));
    }
    let currentErr = err;
    const seen = new Set();
    while (currentErr?.cause && !seen.has(currentErr.cause)) {
      seen.add(currentErr);
      currentErr = currentErr.cause;
    }
    const errorData = currentErr?.response?.data || currentErr?.data || currentErr?.error;
    const statusCode = currentErr?.response?.status || currentErr?.status || currentErr?.statusCode;
    const errorCode =
      errorData?.error_code || errorData?.errorCode || errorData?.code || currentErr?.code || (statusCode ? `HTTP_${statusCode}` : "");
    const detail = errorData?.error?.message || errorData?.error || errorData?.message || errorData?.details || currentErr?.message || String(currentErr);
    const rawMsg = typeof detail === "string" ? detail : JSON.stringify(detail);
    const lowMsg = rawMsg.toLowerCase();

    if (statusCode === 401 && (lowMsg.includes("api_key") || lowMsg.includes("apikey") || lowMsg.includes("api key") || lowMsg.includes("unauthorized"))) {
      throw new Error("Composio API key is invalid or unauthorized. Please verify COMPOSIO_API_KEY in integration settings.");
    }

    if (isAuthFailure(rawMsg, errorCode)) {
      throw new Error("Microsoft 365 authentication is missing, expired, or revoked in Composio. Reconnect at app.composio.dev.");
    }

    const codePrefix = errorCode ? `[${errorCode}] ` : "";
    throw new Error(`Composio action error (${actionName}): ${codePrefix}${rawMsg}`);
  } finally {
    clearTimeout(timeout);
  }
}

function renderGenericErrorCard(title: string, message: string, target?: string) {
  const body = `
    <div class="xl">
      <div class="xl-hd">
        ${markHtml()}
        <div class="xl-meta">
          <span class="xl-title">${esc(clip(title, 32))}</span>
          ${target ? `<span class="xl-sub">${esc(clip(target, 32))}</span>` : ""}
        </div>
      </div>
      <div class="xl-err">
        ${ICON_ERR}
        <div>${esc(clip(message, 180))}</div>
      </div>
    </div>
  `;
  return renderCustom({ accent: ACCENT, css: CSS, body, height: 125 });
}

function colStrToIdx(colStr: string): number {
  let idx = 0;
  for (let i = 0; i < colStr.length; i++) {
    idx = idx * 26 + (colStr.charCodeAt(i) - 64);
  }
  return Math.max(0, idx - 1);
}

function idxToColStr(idx: number): string {
  let num = idx + 1;
  let str = "";
  while (num > 0) {
    const rem = (num - 1) % 26;
    str = String.fromCharCode(65 + rem) + str;
    num = Math.floor((num - 1) / 26);
  }
  return str || "A";
}

function parseRangeStart(address: string): { startColIdx: number; startRowIdx: number } {
  const cellPart = address.includes("!") ? address.split("!")[1] : address;
  const startCell = cellPart.includes(":") ? cellPart.split(":")[0] : cellPart;

  let colStr = "";
  let rowStr = "";
  for (const ch of startCell.toUpperCase()) {
    if (ch >= "A" && ch <= "Z") colStr += ch;
    else if (ch >= "0" && ch <= "9") rowStr += ch;
  }

  const startColIdx = colStr ? colStrToIdx(colStr) : 0;
  const rawRow = rowStr ? parseInt(rowStr, 10) : 1;
  const startRowIdx = isNaN(rawRow) ? 1 : rawRow;
  return { startColIdx, startRowIdx };
}

// ==========================================
// 1. excel_get_workbook (READ)
// ==========================================
server.registerTool(
  "excel_get_workbook",
  {
    title: "Get workbook",
    description: "Retrieve overview metadata and worksheets for an Excel workbook in OneDrive/SharePoint via Composio. Use when the user asks what sheets are in the workbook, wants to view workbook details, or inspect the default spreadsheet.",
    inputSchema: {
      drive_id: z.string().optional().describe("Drive containing the workbook. Defaults to DEFAULT_DRIVE_ID; specify for SharePoint or another drive."),
      workbook_id: z.string().optional().describe("OneDrive or SharePoint driveItem ID of the Excel workbook. Defaults to DEFAULT_WORKBOOK_ID in settings."),
    } as any,
  },
  async (args: any) => {
    const workbookId = (args?.workbook_id ? String(args.workbook_id).trim() : "") || process.env.DEFAULT_WORKBOOK_ID?.trim() || "";
    if (!workbookId) {
      throw new Error("No workbook ID provided. Please specify a workbook_id or configure DEFAULT_WORKBOOK_ID in settings.");
    }

    try {
      const data = await executeComposioAction(APPROVED_COMPOSIO_ACTIONS.excel_get_workbook, {
        workbook_id: workbookId,
        item_id: workbookId,
        drive_id: args?.drive_id?.trim() || undefined,
      });

      let resolvedItemId = workbookId;
      if (data?.id) resolvedItemId = data.id;
      if (data?.item_id) resolvedItemId = data.item_id;

      const fileName = data?.name || data?.filename || `Workbook (${clip(resolvedItemId, 16)})`;
      let rawSheets: any[] = [];
      if (Array.isArray(data?.worksheets)) rawSheets = data.worksheets;
      else if (Array.isArray(data?.sheets)) rawSheets = data.sheets;
      else if (Array.isArray(data?.value)) rawSheets = data.value;

      const worksheets = rawSheets.map((s: any, idx: number) => {
        if (typeof s === "string") return { name: s, position: idx };
        return { name: s.name || `Sheet${idx + 1}`, position: s.position ?? idx, visibility: s.visibility ?? "Visible" };
      });

      let contentSection = "";
      let cardHeight = 155;

      if (worksheets.length > 0) {
        const tabsHtml = worksheets.slice(0, 6).map((w, i) => `
          <div class="xl-tab${i === 0 ? " active" : ""}">
            ${i === 0 ? '<span class="xl-dot"></span>' : ""}
            <span>${esc(clip(w.name, 20))}</span>
          </div>
        `).join("");

        contentSection = `
          <div class="xl-tabs-hd"><span class="xl-tabs-lbl">Worksheets</span></div>
          <div class="xl-tabs">${tabsHtml}</div>
          <div class="xl-stats">
            <div class="xl-stat"><span class="xl-stat-k">Sheets</span><span class="xl-stat-v">${worksheets.length}</span></div>
            <div class="xl-stat"><span class="xl-stat-k">Drive Item</span><span class="xl-stat-v">${esc(clip(resolvedItemId, 16))}</span></div>
          </div>
        `;
        cardHeight = 160;
      } else {
        contentSection = `
          <div class="xl-status-bar"><span class="xl-status-dot"></span><span class="xl-status-txt">Connected · Active Workbook</span></div>
          <div class="xl-stats">
            <div class="xl-stat"><span class="xl-stat-k">Status</span><span class="xl-stat-v">Ready</span></div>
            <div class="xl-stat"><span class="xl-stat-k">Drive Item</span><span class="xl-stat-v">${esc(clip(resolvedItemId, 18))}</span></div>
          </div>
        `;
      }

      const body = `
        <div class="xl">
          <div class="xl-hd">
            ${markHtml()}
            <div class="xl-meta">
              <span class="xl-title">${esc(clip(fileName, 34))}</span>
              <span class="xl-sub">OneDrive · ${esc(clip(resolvedItemId, 22))}</span>
            </div>
          </div>
          ${contentSection}
        </div>
      `;

      const card = renderCustom({ accent: ACCENT, css: CSS, body, height: cardHeight });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            name: fileName,
            id: resolvedItemId,
            worksheets,
            raw_data: data,
            _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
          }),
        }],
      };
    } catch (err: any) {
      const errorCard = renderGenericErrorCard("Excel Workbook Error", err.message, workbookId);
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: err.message,
            workbook_id: workbookId,
            _voiceos_glance: { blocks: [{ type: "widget", html: errorCard.html, height: errorCard.height }] },
          }),
        }],
      };
    }
  },
);

// ==========================================
// 2. excel_get_worksheet (READ)
// ==========================================
server.registerTool(
  "excel_get_worksheet",
  {
    title: "Get worksheet",
    description: "Get details and properties of a specific worksheet in an Excel workbook by name or ID. Use when the user asks about a particular sheet's position or visibility.",
    inputSchema: {
      worksheet_name: z.string().describe("Name or ID of the worksheet to inspect."),
      workbook_id: z.string().optional().describe("OneDrive or SharePoint driveItem ID of the Excel workbook."),
      drive_id: z.string().optional().describe("Drive containing the workbook."),
    } as any,
  },
  async (args: any) => {
    const workbookId = (args?.workbook_id ? String(args.workbook_id).trim() : "") || process.env.DEFAULT_WORKBOOK_ID?.trim() || "";
    const sheetName = String(args?.worksheet_name || "").trim();
    if (!workbookId) throw new Error("No workbook ID provided. Specify workbook_id or configure DEFAULT_WORKBOOK_ID in settings.");
    if (!sheetName) throw new Error("Missing worksheet_name argument.");

    try {
      const data = await executeComposioAction(APPROVED_COMPOSIO_ACTIONS.excel_get_worksheet, {
        workbook_id: workbookId,
        item_id: workbookId,
        worksheet: sheetName,
        worksheet_name: sheetName,
        drive_id: args?.drive_id?.trim() || undefined,
      });

      const name = data?.name || sheetName;
      const position = data?.position ?? 0;
      const visibility = data?.visibility || "Visible";
      const id = data?.id || sheetName;

      const body = `
        <div class="xl">
          <div class="xl-hd">
            ${markHtml()}
            <div class="xl-meta">
              <span class="xl-title">${esc(clip(name, 28))}</span>
              <span class="xl-sub">Worksheet details</span>
            </div>
            <span class="xl-pill ${visibility === "Visible" ? "good" : ""}">${esc(visibility)}</span>
          </div>
          <div class="xl-stats">
            <div class="xl-stat"><span class="xl-stat-k">Index</span><span class="xl-stat-v">#${position + 1}</span></div>
            <div class="xl-stat"><span class="xl-stat-k">Sheet ID</span><span class="xl-stat-v">${esc(clip(id, 16))}</span></div>
          </div>
          <div class="xl-hint">Use excel_get_range to inspect cell data in this sheet.</div>
        </div>
      `;

      const card = renderCustom({ accent: ACCENT, css: CSS, body, height: 150 });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            name,
            position,
            visibility,
            id,
            raw_data: data,
            _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
          }),
        }],
      };
    } catch (err: any) {
      const errCard = renderGenericErrorCard("Get Worksheet Error", err.message, sheetName);
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: err.message,
            worksheet_name: sheetName,
            _voiceos_glance: { blocks: [{ type: "widget", html: errCard.html, height: errCard.height }] },
          }),
        }],
      };
    }
  },
);

// ==========================================
// 3. excel_get_range (READ)
// ==========================================
server.registerTool(
  "excel_get_range",
  {
    title: "Get cell range",
    description: "Read cell values and dimensions from an Excel worksheet range (e.g. 'A1:C10', 'Sheet1!B2:E6', or 'VoiceOS QA'!A1:B4) via Composio. Use when the user asks to read data, view cells, check a table, or inspect specific numbers or labels from an Excel sheet.",
    inputSchema: {
      range: z.string().describe("Excel range address (e.g., 'A1:D5', 'Sheet1!A1:D5', or ''VoiceOS QA'!A1:B4')."),
      drive_id: z.string().optional().describe("Drive containing the workbook. Defaults to DEFAULT_DRIVE_ID; specify for SharePoint or another drive."),
      workbook_id: z.string().optional().describe("OneDrive or SharePoint driveItem ID of the Excel workbook. Defaults to DEFAULT_WORKBOOK_ID in integration settings."),
      worksheet_name: z.string().optional().describe("Optional worksheet name if not specified in the range address."),
    } as any,
  },
  async (args: any) => {
    const workbookId = (args?.workbook_id ? String(args.workbook_id).trim() : "") || process.env.DEFAULT_WORKBOOK_ID?.trim() || "";
    const rangeParam = (args?.range ? String(args.range).trim() : "A1:C4").trim();

    if (!workbookId) {
      throw new Error("No workbook ID provided. Please specify a workbook_id or configure DEFAULT_WORKBOOK_ID in settings.");
    }

    try {
      const { sheet, address } = parseSheetAndAddress(rangeParam, args?.worksheet_name);
      const actionInput: Record<string, any> = {
        workbook_id: workbookId,
        item_id: workbookId,
        drive_id: args?.drive_id?.trim() || undefined,
        range: address,
        address,
      };
      if (sheet) {
        actionInput.worksheet_id = sheet;
        actionInput.worksheet = sheet;
        actionInput.worksheet_name = sheet;
      }

      const data = await executeComposioAction(APPROVED_COMPOSIO_ACTIONS.excel_get_range, actionInput);
      const resolvedAddress = data?.address || data?.range || (sheet ? `${sheet}!${address}` : address);
      let values: any[][] = [];
      if (Array.isArray(data?.values)) values = data.values;
      else if (Array.isArray(data?.text)) values = data.text;
      else if (Array.isArray(data?.cell_values)) values = data.cell_values;

      const totalRows = data?.rowCount ?? values.length;
      const totalCols = data?.columnCount ?? (values.length > 0 && Array.isArray(values[0]) ? values[0].length : 0);
      const { startColIdx, startRowIdx } = parseRangeStart(address);

      const MAX_ROWS = 5;
      const MAX_COLS = 4;
      const displayRows = values.slice(0, MAX_ROWS);
      const colCount = Math.min(totalCols || 1, MAX_COLS);

      let gridHtml = "";
      if (values.length === 0) {
        gridHtml = `<div class="xl-empty">Empty range (no cell data)</div>`;
      } else {
        const headerThs = Array.from({ length: colCount }, (_, i) => `<th class="xr-th">${esc(idxToColStr(startColIdx + i))}</th>`).join("");
        const rowsHtml = displayRows.map((rowVals, rIdx) => {
          const rowNum = startRowIdx + rIdx;
          const safeRow = Array.isArray(rowVals) ? rowVals : [rowVals];
          const cellsHtml = Array.from({ length: colCount }, (_, cIdx) => {
            const val = safeRow[cIdx];
            if (val === null || val === undefined || val === "") return `<td class="xr-cell"><span class="xr-blank">—</span></td>`;
            const strVal = String(val).trim();
            const isNum = !isNaN(Number(strVal.replace(/[$,%]/g, ""))) && strVal !== "";
            return `<td class="xr-cell ${isNum ? "xr-num" : "xr-txt"}">${esc(clip(strVal, 22))}</td>`;
          }).join("");
          return `<tr class="xr-rw"><td class="xr-idx">${rowNum}</td>${cellsHtml}</tr>`;
        }).join("");

        const moreRow = totalRows > MAX_ROWS || totalCols > MAX_COLS
          ? `<div class="xr-more">+${Math.max(0, totalRows - MAX_ROWS)} more row${totalRows - MAX_ROWS === 1 ? "" : "s"}</div>`
          : "";

        gridHtml = `
          <div class="xr-wrap">
            <table class="xr-tbl">
              <thead><tr><th class="xr-corner"></th>${headerThs}</tr></thead>
              <tbody>${rowsHtml}</tbody>
            </table>
          </div>
          ${moreRow}
        `;
      }

      const dimLabel = `${totalRows} row${totalRows === 1 ? "" : "s"} × ${totalCols} col${totalCols === 1 ? "" : "s"}`;
      const body = `
        <div class="xl">
          <div class="xl-hd">
            ${markHtml()}
            <span class="xl-chip">${esc(clip(resolvedAddress, 24))}</span>
            <span class="xl-dim">${dimLabel}</span>
          </div>
          ${gridHtml}
        </div>
      `;

      const cardHeight = Math.min(420, 68 + (values.length > 0 ? 24 + displayRows.length * 25 + 16 : 48));
      const card = renderCustom({ accent: ACCENT, css: CSS, body, height: cardHeight });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            address: resolvedAddress,
            rowCount: totalRows,
            columnCount: totalCols,
            values,
            raw_data: data,
            _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
          }),
        }],
      };
    } catch (err: any) {
      const errorCard = renderGenericErrorCard("Range Read Error", err.message, rangeParam);
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: err.message,
            address: rangeParam,
            _voiceos_glance: { blocks: [{ type: "widget", html: errorCard.html, height: errorCard.height }] },
          }),
        }],
      };
    }
  },
);

// ==========================================
// 4. excel_list_worksheets (READ)
// ==========================================
server.registerTool(
  "excel_list_worksheets",
  {
    title: "List worksheets",
    description: "List all worksheet tabs in an Excel workbook with their names, positions, and visibility. Use when the user asks what tabs or sheets exist in the spreadsheet.",
    inputSchema: {
      workbook_id: z.string().optional().describe("OneDrive or SharePoint driveItem ID of the Excel workbook. Defaults to DEFAULT_WORKBOOK_ID in settings."),
      drive_id: z.string().optional().describe("Drive containing the workbook."),
    } as any,
  },
  async (args: any) => {
    const workbookId = (args?.workbook_id ? String(args.workbook_id).trim() : "") || process.env.DEFAULT_WORKBOOK_ID?.trim() || "";
    if (!workbookId) throw new Error("No workbook ID provided. Specify workbook_id or configure DEFAULT_WORKBOOK_ID in settings.");

    try {
      let data: any;
      try {
        data = await executeComposioAction(APPROVED_COMPOSIO_ACTIONS.excel_list_worksheets, {
          workbook_id: workbookId,
          item_id: workbookId,
          drive_id: args?.drive_id?.trim() || undefined,
        });
      } catch {
        data = await executeComposioAction(APPROVED_COMPOSIO_ACTIONS.excel_get_workbook, {
          workbook_id: workbookId,
          item_id: workbookId,
          drive_id: args?.drive_id?.trim() || undefined,
        });
      }

      const rawSheets = readExcelCollection(data, "worksheets");

      const worksheets = rawSheets.map((s: any, idx: number) => ({
        name: typeof s === "string" ? s : s.name || `Sheet${idx + 1}`,
        position: typeof s === "object" ? s.position ?? idx : idx,
        visibility: typeof s === "object" ? s.visibility ?? "Visible" : "Visible",
      }));

      const rows = worksheets.slice(0, 5).map((w) => `
        <div class="xl-rw">
          <span class="xl-rw-idx">#${w.position + 1}</span>
          <div class="xl-rw-m"><span class="xl-rw-title">${esc(clip(w.name, 28))}</span></div>
          <span class="xl-pill ${w.visibility === "Visible" ? "good" : ""}">${esc(w.visibility)}</span>
        </div>
      `).join("");

      const body = `
        <div class="xl">
          <div class="xl-hd">
            ${markHtml()}
            <div class="xl-meta">
              <span class="xl-title">Worksheets</span>
              <span class="xl-sub">${worksheets.length} sheet${worksheets.length === 1 ? "" : "s"}</span>
            </div>
            <span class="xl-chip">${esc(clip(workbookId, 16))}</span>
          </div>
          <div class="xl-list">${rows || '<div class="xl-empty">No worksheets found</div>'}</div>
        </div>
      `;

      const card = renderCustom({ accent: ACCENT, css: CSS, body, height: 60 + Math.max(1, Math.min(worksheets.length, 5)) * 34 });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            worksheets,
            count: worksheets.length,
            _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
          }),
        }],
      };
    } catch (err: any) {
      const errCard = renderGenericErrorCard("List Worksheets Error", err.message, workbookId);
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: err.message,
            _voiceos_glance: { blocks: [{ type: "widget", html: errCard.html, height: errCard.height }] },
          }),
        }],
      };
    }
  },
);

// ==========================================
// 5. excel_create_worksheet (ACTING)
// ==========================================
server.registerTool(
  "excel_create_worksheet",
  {
    title: "Create worksheet",
    description: "Create a new worksheet tab in an Excel workbook. Use when the user asks to add, insert, or create a new sheet or tab.",
    inputSchema: {
      name: z.string().describe("Name for the new worksheet."),
      worksheet_name: z.string().optional().describe("Alternative alias for worksheet name."),
      workbook_id: z.string().optional().describe("OneDrive or SharePoint driveItem ID of the Excel workbook. Defaults to DEFAULT_WORKBOOK_ID in settings."),
      drive_id: z.string().optional().describe("Drive containing the workbook."),
    } as any,
  },
  async (args: any) => {
    const workbookId = (args?.workbook_id ? String(args.workbook_id).trim() : "") || process.env.DEFAULT_WORKBOOK_ID?.trim() || "";
    const rawName = String(args?.name || args?.worksheet_name || "").trim();
    if (!workbookId) throw new Error("No workbook ID provided. Specify workbook_id or configure DEFAULT_WORKBOOK_ID in settings.");
    if (!rawName) throw new Error("Worksheet name is required.");

    const cleanName = cleanSheetName(rawName);

    let data: any;
    let finalName = cleanName;
    let collisionResolved = false;

    try {
      data = await executeComposioAction(APPROVED_COMPOSIO_ACTIONS.excel_create_worksheet, {
        workbook_id: workbookId,
        item_id: workbookId,
        name: cleanName,
        worksheet_name: cleanName,
        drive_id: args?.drive_id?.trim() || undefined,
      });
    } catch (firstErr: any) {
      throw firstErr; // Never change the approved name or retry a write automatically.
    }

    const createdName = data?.name || finalName;
    const body = `
      <div class="xl">
        <div class="xl-hd">
          ${markHtml()}
          <div class="xl-meta">
            <span class="xl-title">${esc(clip(createdName, 28))}</span>
            <span class="xl-sub">${collisionResolved ? `Created as '${esc(clip(createdName, 18))}' (${esc(clip(cleanName, 14))} existed)` : "Worksheet created successfully"}</span>
          </div>
          <span class="xl-pill good">Created</span>
        </div>
        <div class="xl-stats">
          <div class="xl-stat"><span class="xl-stat-k">Status</span><span class="xl-stat-v">Ready</span></div>
          <div class="xl-stat"><span class="xl-stat-k">Workbook</span><span class="xl-stat-v">${esc(clip(workbookId, 16))}</span></div>
        </div>
        ${collisionResolved ? `<div class="xl-hint">A sheet named '${esc(cleanName)}' already existed in this workbook, so it was created with a unique suffix.</div>` : ""}
      </div>
    `;

    const card = renderCustom({ accent: ACCENT, css: CSS, body, height: collisionResolved ? 165 : 145 });
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          status: "created",
          name: createdName,
          original_requested_name: cleanName,
          renamed_due_to_collision: collisionResolved,
          raw_data: data,
          _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
        }),
      }],
    };
  },
);

// ==========================================
// 6. excel_rename_worksheet (ACTING)
// ==========================================
server.registerTool(
  "excel_rename_worksheet",
  {
    title: "Rename worksheet",
    description: "Rename an existing worksheet tab in an Excel workbook. Use when the user asks to rename a sheet or change its tab title.",
    inputSchema: {
      current_name: z.string().describe("Current name of the worksheet."),
      new_name: z.string().describe("New name for the worksheet."),
      workbook_id: z.string().optional().describe("OneDrive or SharePoint driveItem ID of the Excel workbook. Defaults to DEFAULT_WORKBOOK_ID in settings."),
      drive_id: z.string().optional().describe("Drive containing the workbook."),
    } as any,
  },
  async (args: any) => {
    const workbookId = (args?.workbook_id ? String(args.workbook_id).trim() : "") || process.env.DEFAULT_WORKBOOK_ID?.trim() || "";
    const currentName = String(args?.current_name || "").trim();
    const newName = String(args?.new_name || "").trim();
    if (!workbookId) throw new Error("No workbook ID provided. Specify workbook_id or configure DEFAULT_WORKBOOK_ID in settings.");
    if (!currentName || !newName) throw new Error("Both current_name and new_name are required.");

    const cleanNewName = cleanSheetName(newName);

    try {
      const data = await executeComposioAction(APPROVED_COMPOSIO_ACTIONS.excel_rename_worksheet, {
        workbook_id: workbookId,
        item_id: workbookId,
        current_name: currentName,
        worksheet: currentName,
        new_name: cleanNewName,
        name: cleanNewName,
        drive_id: args?.drive_id?.trim() || undefined,
      });

      const body = `
        <div class="xl">
          <div class="xl-hd">
            ${markHtml()}
            <div class="xl-meta">
              <span class="xl-title">${esc(clip(cleanNewName, 28))}</span>
              <span class="xl-sub">Renamed from ${esc(clip(currentName, 20))}</span>
            </div>
            <span class="xl-pill good">Renamed</span>
          </div>
          <div class="xl-stats">
            <div class="xl-stat"><span class="xl-stat-k">Old Tab</span><span class="xl-stat-v">${esc(clip(currentName, 18))}</span></div>
            <div class="xl-stat"><span class="xl-stat-k">New Tab</span><span class="xl-stat-v">${esc(clip(cleanNewName, 18))}</span></div>
          </div>
        </div>
      `;

      const card = renderCustom({ accent: ACCENT, css: CSS, body, height: 145 });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "renamed",
            current_name: currentName,
            new_name: cleanNewName,
            raw_data: data,
            _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
          }),
        }],
      };
    } catch (err: any) {
      const errCard = renderGenericErrorCard("Rename Worksheet Error", err.message, currentName);
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: err.message,
            _voiceos_glance: { blocks: [{ type: "widget", html: errCard.html, height: errCard.height }] },
          }),
        }],
      };
    }
  },
);

// ==========================================
// 7. excel_delete_worksheet (ACTING - DESTRUCTIVE)
// ==========================================
server.registerTool(
  "excel_delete_worksheet",
  {
    title: "Delete worksheet",
    description: "Delete a worksheet tab from an Excel workbook. This action permanently deletes sheet data. Use when the user specifically requests to delete or remove a sheet.",
    inputSchema: {
      worksheet_name: z.string().describe("Name of the worksheet to permanently delete."),
      workbook_id: z.string().optional().describe("OneDrive or SharePoint driveItem ID of the Excel workbook. Defaults to DEFAULT_WORKBOOK_ID in settings."),
      drive_id: z.string().optional().describe("Drive containing the workbook."),
    } as any,
  },
  async (args: any) => {
    const workbookId = (args?.workbook_id ? String(args.workbook_id).trim() : "") || process.env.DEFAULT_WORKBOOK_ID?.trim() || "";
    const rawTarget = String(args?.worksheet_name || args?.name || args?.worksheet || "").trim();
    if (!workbookId) throw new Error("No workbook ID provided. Specify workbook_id or configure DEFAULT_WORKBOOK_ID in settings.");
    if (!rawTarget) throw new Error("worksheet_name is required.");

    try {
      let cleanedTarget = rawTarget;
      if (cleanedTarget.startsWith("'") && cleanedTarget.endsWith("'") && cleanedTarget.length >= 2) {
        cleanedTarget = cleanedTarget.slice(1, -1).split("''").join("'");
      }

      const target = await resolveWriteTarget("EXCEL_DELETE_WORKSHEET", {workbook_id: workbookId, worksheet_name: cleanedTarget, drive_id: args?.drive_id?.trim() || undefined}, executeComposioAction);
      const resolvedName = target.worksheet_name;
      const data = await executeComposioAction(APPROVED_COMPOSIO_ACTIONS.excel_delete_worksheet, target);

      const body = `
        <div class="xl">
          <div class="xl-hd">
            ${markHtml()}
            <div class="xl-meta">
              <span class="xl-title">${esc(clip(resolvedName, 28))}</span>
              <span class="xl-sub">Worksheet deleted</span>
            </div>
            <span class="xl-pill bad">Deleted</span>
          </div>
          <div class="xl-stats">
            <div class="xl-stat"><span class="xl-stat-k">Removed</span><span class="xl-stat-v">${esc(clip(resolvedName, 18))}</span></div>
            <div class="xl-stat"><span class="xl-stat-k">Workbook</span><span class="xl-stat-v">${esc(clip(workbookId, 16))}</span></div>
          </div>
        </div>
      `;

      const card = renderCustom({ accent: ACCENT, css: CSS, body, height: 145 });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "deleted",
            worksheet_name: resolvedName,
            raw_data: data,
            _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
          }),
        }],
      };
    } catch (err: any) {
      const errCard = renderGenericErrorCard("Delete Worksheet Error", err.message, rawTarget);
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: err.message,
            worksheet_name: rawTarget,
            _voiceos_glance: { blocks: [{ type: "widget", html: errCard.html, height: errCard.height }] },
          }),
        }],
      };
    }
  },
);

// ==========================================
// 8. excel_update_range (ACTING)
// ==========================================
server.registerTool(
  "excel_update_range",
  {
    title: "Update cell range",
    description: "Write or update cell values in an Excel worksheet range (e.g. 'A1:B2', 'Sheet1!A1:B2', or ''VoiceOS QA'!A1:B2'). Use when the user asks to write numbers, set values, or update cells in a sheet.",
    inputSchema: {
      range: z.string().describe("Target cell range address (e.g. 'A1:B2', 'Sheet1!A1:B2', or ''VoiceOS QA'!A1:B2')."),
      values: z.union([z.array(z.array(z.any())), z.string()]).describe("2D array of values or rows of cell values to update."),
      worksheet_name: z.string().optional().describe("Optional worksheet name if not prefixed in range address."),
      workbook_id: z.string().optional().describe("OneDrive or SharePoint driveItem ID of the Excel workbook. Defaults to DEFAULT_WORKBOOK_ID in settings."),
      drive_id: z.string().optional().describe("Drive containing the workbook."),
    } as any,
  },
  async (args: any) => {
    const workbookId = (args?.workbook_id ? String(args.workbook_id).trim() : "") || process.env.DEFAULT_WORKBOOK_ID?.trim() || "";
    const range = String(args?.range || "").trim();
    if (!workbookId) throw new Error("No workbook ID provided. Specify workbook_id or configure DEFAULT_WORKBOOK_ID in settings.");
    if (!range) throw new Error("Range address is required.");

    const parsedValues = parse2DArray(args?.values);

    try {
      const { sheet, address } = parseSheetAndAddress(range, args?.worksheet_name);
      const actionInput: Record<string, any> = {
        workbook_id: workbookId,
        item_id: workbookId,
        range: address,
        address,
        values: parsedValues,
        drive_id: args?.drive_id?.trim() || undefined,
      };
      if (sheet) {
        actionInput.worksheet_id = sheet;
        actionInput.worksheet = sheet;
        actionInput.worksheet_name = sheet;
      }

      const data = await executeComposioAction(APPROVED_COMPOSIO_ACTIONS.excel_update_range, actionInput);
      const displayAddress = sheet ? `${sheet}!${address}` : address;

      const body = `
        <div class="xl">
          <div class="xl-hd">
            ${markHtml()}
            <span class="xl-chip">${esc(clip(displayAddress, 24))}</span>
            <span class="xl-pill good">Updated</span>
          </div>
          <div class="xl-stats">
            <div class="xl-stat"><span class="xl-stat-k">Rows Written</span><span class="xl-stat-v">${parsedValues.length}</span></div>
            <div class="xl-stat"><span class="xl-stat-k">Columns</span><span class="xl-stat-v">${parsedValues[0]?.length || 0}</span></div>
          </div>
          <div class="xl-hint">Use excel_get_range to verify the updated cell values.</div>
        </div>
      `;

      const card = renderCustom({ accent: ACCENT, css: CSS, body, height: 150 });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "updated",
            range: displayAddress,
            rows_written: parsedValues.length,
            raw_data: data,
            _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
          }),
        }],
      };
    } catch (err: any) {
      const errCard = renderGenericErrorCard("Update Range Error", err.message, range);
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: err.message,
            _voiceos_glance: { blocks: [{ type: "widget", html: errCard.html, height: errCard.height }] },
          }),
        }],
      };
    }
  },
);

// ==========================================
// 9. excel_add_table_rows (ACTING)
// ==========================================
server.registerTool(
  "excel_add_table_rows",
  {
    title: "Add table rows",
    description: "Append new data rows to an existing Excel table (e.g. 'ReleaseQATable' on 'Release QA Verified'). Use when the user asks to insert or append rows to a table.",
    inputSchema: {
      table_id: z.string().optional().describe("Table ID or table name in Excel (e.g. 'ReleaseQATable' or a table GUID). In Excel and Microsoft Graph, the table name functions directly as the table ID, viewable in Excel under Table Design -> Table Name."),
      table_name: z.string().optional().describe("Name of the target Excel table (e.g. 'ReleaseQATable'). Will be mapped to table_id under Microsoft Graph."),
      rows: z.union([z.array(z.array(z.any())), z.string()]).describe("2D array of row data to append or JSON string (e.g. [['2025-06-01', 'QA Verified', 'Passed']]). Mapped to values for Excel."),
      workbook_id: z.string().optional().describe("OneDrive or SharePoint driveItem ID of the Excel workbook. Defaults to DEFAULT_WORKBOOK_ID in settings."),
      worksheet_name: z.string().optional().describe("Worksheet containing the table (e.g. 'Release QA Verified')."),
      drive_id: z.string().optional().describe("Drive containing the workbook."),
    } as any,
  },
  async (args: any) => {
    const workbookId = (args?.workbook_id ? String(args.workbook_id).trim() : "") || process.env.DEFAULT_WORKBOOK_ID?.trim() || "";
    const tableIdentifier = (args?.table_id ? String(args.table_id).trim() : "") || (args?.table_name ? String(args.table_name).trim() : "");
    if (!workbookId) throw new Error("No workbook ID provided. Specify workbook_id or configure DEFAULT_WORKBOOK_ID in settings.");
    if (!tableIdentifier) {
      throw new Error(
        "Target table ID or table name is required (e.g. 'ReleaseQATable'). In Excel, table names function as valid table IDs under Microsoft Graph. You can find or set the table name in Excel under Table Design -> Table Name."
      );
    }

    const parsedRows = parse2DArray(args?.rows ?? args?.values);
    if (!parsedRows || parsedRows.length === 0) {
      throw new Error("Row data is required. Provide a 2D array of row values to append.");
    }

    try {
      const data = await executeComposioAction(APPROVED_COMPOSIO_ACTIONS.excel_add_table_rows, await resolveWriteTarget("EXCEL_ADD_TABLE_ROW", {
        workbook_id: workbookId,
        item_id: workbookId,
        table_id: tableIdentifier,
        table_name: tableIdentifier,
        table: tableIdentifier,
        tableName: tableIdentifier,
        rows: parsedRows,
        values: parsedRows,
        worksheet_name: args?.worksheet_name?.trim() || undefined,
        worksheet: args?.worksheet_name?.trim() || undefined,
        drive_id: args?.drive_id?.trim() || undefined,
      }, executeComposioAction));

      const worksheetName = args?.worksheet_name?.trim() || "";
      const body = `
        <div class="xl">
          <div class="xl-hd">
            ${markHtml()}
            <div class="xl-meta">
              <span class="xl-title">${esc(clip(tableIdentifier, 28))}</span>
              <span class="xl-sub">${worksheetName ? esc(clip(worksheetName, 20)) + " · " : ""}Rows added to table</span>
            </div>
            <span class="xl-pill good">Appended</span>
          </div>
          <div class="xl-stats">
            <div class="xl-stat"><span class="xl-stat-k">Rows Added</span><span class="xl-stat-v">${parsedRows.length}</span></div>
            <div class="xl-stat"><span class="xl-stat-k">Columns</span><span class="xl-stat-v">${parsedRows[0]?.length || 0}</span></div>
          </div>
        </div>
      `;

      const card = renderCustom({ accent: ACCENT, css: CSS, body, height: 145 });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "rows_added",
            table_id: tableIdentifier,
            table_name: tableIdentifier,
            rows_count: parsedRows.length,
            raw_data: data,
            _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
          }),
        }],
      };
    } catch (err: any) {
      const errCard = renderGenericErrorCard("Add Table Rows Error", err.message, tableIdentifier);
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: err.message,
            table_id: tableIdentifier,
            table_name: tableIdentifier,
            _voiceos_glance: { blocks: [{ type: "widget", html: errCard.html, height: errCard.height }] },
          }),
        }],
      };
    }
  },
);

// ==========================================
// 10. excel_create_chart (ACTING)
// ==========================================
server.registerTool(
  "excel_create_chart",
  {
    title: "Create chart",
    description: "Create an Excel chart (e.g. ColumnClustered, Line, Pie) from a range of cell data via Composio. Use when the user asks to create, insert, or plot a chart or graph.",
    inputSchema: {
      range: z.string().describe("Source cell range for chart data (e.g. 'A1:C5', 'Sheet1!A1:D10', or ''VoiceOS QA'!A1:B4')."),
      chart_type: z.string().describe("Chart type: 'ColumnClustered', 'Line', 'Pie', 'BarClustered', etc."),
      series_by: z.string().optional().describe("Series arrangement: 'Columns', 'Rows', or 'Auto'. Defaults to 'Auto'."),
      title: z.string().optional().describe("Optional title for the chart."),
      worksheet_name: z.string().optional().describe("Worksheet where chart will be created."),
      workbook_id: z.string().optional().describe("OneDrive or SharePoint driveItem ID of the Excel workbook. Defaults to DEFAULT_WORKBOOK_ID in settings."),
      drive_id: z.string().optional().describe("Drive containing the workbook."),
    } as any,
  },
  async (args: any) => {
    const workbookId = (args?.workbook_id ? String(args.workbook_id).trim() : "") || process.env.DEFAULT_WORKBOOK_ID?.trim() || "";
    const range = String(args?.range || "").trim();
    const chartType = String(args?.chart_type || "ColumnClustered").trim();
    const chartTitle = args?.title ? String(args.title).trim() : "Excel Chart";

    if (!workbookId) throw new Error("No workbook ID provided. Specify workbook_id or configure DEFAULT_WORKBOOK_ID in settings.");
    if (!range) throw new Error("Source range is required.");

    try {
      const { sheet, address } = parseSheetAndAddress(range, args?.worksheet_name);
      const actionInput: Record<string, any> = {
        workbook_id: workbookId,
        item_id: workbookId,
        range,
        chart_type: chartType,
        series_by: args?.series_by,
        title: chartTitle,
        worksheet_name: sheet,
        worksheet: sheet,
        worksheet_id: sheet,
        drive_id: args?.drive_id?.trim() || undefined,
      };

      const data = await executeComposioAction(APPROVED_COMPOSIO_ACTIONS.excel_create_chart, await resolveWriteTarget("EXCEL_ADD_CHART", actionInput, executeComposioAction));

      const resolvedSeries = actionInput.seriesby || actionInput.series_by || "Auto";
      const displayRange = sheet ? `${sheet}!${address}` : range;

      const body = `
        <div class="xl">
          <div class="xl-hd">
            ${markHtml()}
            <div class="xl-meta">
              <span class="xl-title">${esc(clip(chartTitle, 28))}</span>
              <span class="xl-sub">${esc(chartType)} · ${esc(clip(displayRange, 16))} · ${esc(resolvedSeries)}</span>
            </div>
            <span class="xl-pill good">Inserted</span>
          </div>
          <div class="xl-chart-box">
            <svg width="280" height="48" viewBox="0 0 280 48" fill="none">
              <rect x="20" y="24" width="22" height="24" rx="2" fill="var(--accent)" opacity="0.85"/>
              <rect x="52" y="14" width="22" height="34" rx="2" fill="var(--accent)"/>
              <rect x="84" y="28" width="22" height="20" rx="2" fill="var(--accent)" opacity="0.6"/>
              <rect x="116" y="8" width="22" height="40" rx="2" fill="var(--accent)"/>
              <rect x="148" y="18" width="22" height="30" rx="2" fill="var(--accent)" opacity="0.9"/>
              <rect x="180" y="12" width="22" height="36" rx="2" fill="var(--accent)"/>
              <rect x="212" y="22" width="22" height="26" rx="2" fill="var(--accent)" opacity="0.75"/>
              <rect x="244" y="16" width="22" height="32" rx="2" fill="var(--accent)"/>
            </svg>
          </div>
        </div>
      `;

      const card = renderCustom({ accent: ACCENT, css: CSS, body, height: 165 });
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "chart_created",
            title: chartTitle,
            chart_type: chartType,
            series_by: resolvedSeries,
            range: displayRange,
            raw_data: data,
            _voiceos_glance: { blocks: [{ type: "widget", html: card.html, height: card.height }] },
          }),
        }],
      };
    } catch (err: any) {
      const errCard = renderGenericErrorCard("Create Chart Error", err.message, range);
      return {
        isError: true,
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            error: err.message,
            _voiceos_glance: { blocks: [{ type: "widget", html: errCard.html, height: errCard.height }] },
          }),
        }],
      };
    }
  },
);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await server.connect(new StdioServerTransport());
}
