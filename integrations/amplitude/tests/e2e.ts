// End-to-end test: starts the server through run.sh, as VoiceOS does, and calls every tool over MCP
// against a real Amplitude project. Every tool is read-only, so nothing in the project changes.
//
//   COMPOSIO_API_KEY=... AMPLITUDE_API_KEY=... AMPLITUDE_SECRET_KEY=... \
//   E2E_EVENTS="Page View,Sign Up" E2E_USER=some-user-id bun tests/e2e.ts
//
// E2E_EVENTS: 2-4 event names that exist in the project, in funnel order.
// E2E_USER: a user ID or device ID that exists in the project.
// Optional: AMPLITUDE_REGION (default us), E2E_USER_PREFIX (matches several users), E2E_COHORT
// (name of a discoverable cohort to export).
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXPECTED_TOOLS = 5;
// A range with no data, for the empty-result checks: 60 to 31 days ago by default (Amplitude plans cap how far
// back a query can go). Override with E2E_EMPTY_START / E2E_EMPTY_END (YYYY-MM-DD) if the project had data then.
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const EMPTY_RANGE = { start_date: process.env.E2E_EMPTY_START || daysAgo(60), end_date: process.env.E2E_EMPTY_END || daysAgo(31) };
const PRIVATE_FIELDS = /"(ip_address|ip|city|region|country|dma|device_id|device_ids|device_type|device_family|carrier|location_lat|location_lng|idfa|adid|os_name|platform)"\s*:/;

const { COMPOSIO_API_KEY, AMPLITUDE_API_KEY, AMPLITUDE_SECRET_KEY } = process.env;
const events = (process.env.E2E_EVENTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const userId = process.env.E2E_USER?.trim() ?? "";
if (!COMPOSIO_API_KEY || !AMPLITUDE_API_KEY || !AMPLITUDE_SECRET_KEY || events.length < 2 || events.length > 4 || !userId) {
  console.error("Set COMPOSIO_API_KEY, AMPLITUDE_API_KEY, AMPLITUDE_SECRET_KEY, E2E_EVENTS (2-4 event names) and E2E_USER.");
  process.exit(2);
}

type ToolResult = { isError: boolean; body: any; text: string };
type Outcome = boolean | string;
type Row = { tool: string; check: string; pass: boolean; detail: string; skip?: boolean };

const rows: Row[] = [];
const transcript: string[] = [];
const secrets = [COMPOSIO_API_KEY, AMPLITUDE_API_KEY, AMPLITUDE_SECRET_KEY];

function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.replaceAll(s, "[redacted]");
  return out.replace(/\bak_[A-Za-z0-9_-]{8,}/g, "[redacted]");
}

const transport = new StdioClientTransport({
  command: process.platform === "win32" ? "cmd.exe" : "/bin/zsh",
  args: process.platform === "win32" ? ["/c", "run.cmd"] : ["run.sh"],
  cwd: ROOT,
  stderr: "pipe",
  env: {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    ...(process.env.USERPROFILE ? { USERPROFILE: process.env.USERPROFILE } : {}),
    // VoiceOS passes its bundled runtime here.
    VOICEOS_BUN: process.env.VOICEOS_BUN || process.execPath,
    COMPOSIO_API_KEY,
    AMPLITUDE_API_KEY,
    AMPLITUDE_SECRET_KEY,
    AMPLITUDE_REGION: process.env.AMPLITUDE_REGION || "us",
  },
});
transport.stderr?.on("data", (chunk: Buffer) => transcript.push(String(chunk)));

const client = new Client({ name: "e2e", version: "1.0.0" });
await client.connect(transport);

async function invoke(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const result: any = await client.callTool({ name: tool, arguments: args }, undefined, { timeout: 60_000 });
    const text: string = result.content?.[0]?.text ?? "";
    transcript.push(text);
    try {
      const { _voiceos_glance, ...body } = JSON.parse(text);
      return { isError: Boolean(result.isError), body, text };
    } catch {
      return { isError: true, body: { error: text }, text };
    }
  } catch (err: any) {
    return { isError: true, body: { error: err.message ?? String(err) }, text: "" };
  }
}

function record(tool: string, check: string, result: ToolResult, outcome: Outcome) {
  const pass = outcome === true || (typeof outcome === "string" && outcome.length > 0);
  const detail = typeof outcome === "string" ? outcome : pass ? "" : String(result.body?.error ?? "unexpected result");
  rows.push({ tool, check, pass, detail: redact(detail).slice(0, 110) });
}

async function check(tool: string, name: string, args: Record<string, unknown>, verify: (r: ToolResult) => Outcome) {
  const result = await invoke(tool, args);
  record(tool, name, result, verify(result));
  return result;
}

const rejected = (r: ToolResult) => r.isError && `rejected: ${String(r.body.error).slice(0, 70)}`;

const { tools } = await client.listTools();
rows.push({ tool: "(server)", check: "tools/list", pass: tools.length === EXPECTED_TOOLS, detail: `${tools.length} tools` });

// Event segmentation
const [firstEvent] = events;
await check("get_event_segmentation", "totals, last 30 days", { event_type: firstEvent, metric: "totals", days: 30 }, (r) => !r.isError && r.body.total > 0 && `${r.body.total} events`);
await check("get_event_segmentation", "uniques, weekly", { event_type: firstEvent, interval: "weekly", days: 30 }, (r) => !r.isError && r.body.total > 0 && `${r.body.total} users in ${r.body.series[0].points.length} weeks`);
await check("get_event_segmentation", "grouped by platform", { event_type: "_all", group_by: "platform", days: 30 }, (r) => !r.isError && r.body.group_count >= 1 && `${r.body.group_count} groups`);
await check("get_event_segmentation", "empty: no data in range", { event_type: firstEvent, ...EMPTY_RANGE }, (r) => !r.isError && r.body.total === 0 && "0 events");
await check("get_event_segmentation", "bad: unknown event", { event_type: "voiceos_e2e_no_such_event" }, (r) => r.isError && /no event named/i.test(r.body.error) && "clear error shown");
await check("get_event_segmentation", "bad: invalid date", { event_type: firstEvent, start_date: "2026-13-01" }, rejected);

// Funnel
await check("get_funnel", `${events.length}-step funnel`, { steps: events, days: 30 }, (r) => !r.isError && r.body.steps?.length === events.length && r.body.steps[0].users > 0 && `${r.body.steps.map((s: any) => s.users).join(" → ")} users`);
await check("get_funnel", "empty: no data in range", { steps: events.slice(0, 2), ...EMPTY_RANGE }, (r) => !r.isError && r.body.steps.every((s: any) => s.users === 0) && "all steps 0");
await check("get_funnel", "bad: 1 step", { steps: [firstEvent] }, (r) => r.isError && /2 to 4/.test(r.body.error) && "rejected");
await check("get_funnel", "bad: 5 steps", { steps: ["a", "b", "c", "d", "e"] }, (r) => r.isError && /2 to 4/.test(r.body.error) && "rejected");

// Retention
await check("get_retention", "new users → any event", { days: 14 }, (r) => !r.isError && r.body.users_in_cohorts > 0 && `${r.body.users_in_cohorts} users, day 1 ${r.body.day_1_retention_pct}%`);
await check("get_retention", "event → same event, weekly", { start_event: firstEvent, return_event: firstEvent, interval: "weekly", days: 28 }, (r) => !r.isError && `${r.body.users_in_cohorts} users, ${r.body.periods.length} periods`);
await check("get_retention", "empty: no data in range", { ...EMPTY_RANGE }, (r) => !r.isError && r.body.users_in_cohorts === 0 && "0 users");
await check("get_retention", "bad: start after end", { start_date: "2026-05-10", end_date: "2026-05-01" }, rejected);

// User activity
await check("get_user_activity", "by user ID", { user: userId, limit: 5 }, (r) =>
  !r.isError && r.body.found === true && r.body.events.length > 0 && !PRIVATE_FIELDS.test(r.text) && `${r.body.user.total_events} events, no location/device fields`);
if (process.env.E2E_USER_PREFIX) {
  await check("get_user_activity", "prefix: several users", { user: process.env.E2E_USER_PREFIX }, (r) => !r.isError && r.body.multiple_matches === true && !PRIVATE_FIELDS.test(r.text) && `${r.body.matches.length} candidates`);
}
await check("get_user_activity", "empty: unknown user", { user: "voiceos-e2e-no-such-user@example.com" }, (r) => !r.isError && r.body.found === false && r.body.matches.length === 0 && "not found");
await check("get_user_activity", "bad: limit 0", { user: userId, limit: 0 }, rejected);

// Cohort export
const listed = await check("export_cohort", "list cohorts", {}, (r) => !r.isError && `${r.body.total_cohorts} cohorts`);
if (process.env.E2E_COHORT) {
  let exported = await invoke("export_cohort", { cohort: process.env.E2E_COHORT });
  for (let i = 0; i < 4 && !exported.isError && exported.body.status === "processing"; i++) {
    exported = await invoke("export_cohort", { request_id: exported.body.request_id });
  }
  if (exported.isError && /Growth or Enterprise plan/.test(String(exported.body.error))) {
    // Amplitude refuses key-pair cohort downloads on plans without the Cohort Download API.
    rows.push({ tool: "export_cohort", check: "export by name", pass: true, skip: true, detail: "Amplitude 403: project plan has no cohort download API" });
  } else {
    record("export_cohort", "export by name", exported, !exported.isError && exported.body.status === "done" && !PRIVATE_FIELDS.test(exported.text) && `${exported.body.members} members, ${exported.body.sample?.length ?? 0} sampled`);
  }
} else if (listed.body.total_cohorts === 0) {
  console.log("No discoverable cohorts; set E2E_COHORT to test an export.\n");
}
await check("export_cohort", "bad: unknown cohort", { cohort: "voiceos-e2e-no-such-cohort" }, (r) => r.isError && "error shown");
await check("export_cohort", "bad: invalid request_id", { request_id: "not a valid id!" }, rejected);

await client.close();

const output = transcript.join("\n");
const leaked = secrets.some((s) => output.includes(s!)) || /\bak_[A-Za-z0-9_-]{8,}/.test(output);
rows.push({ tool: "(privacy)", check: "no keys in results or logs", pass: !leaked, detail: "" });

for (const row of rows) {
  console.log(`${row.skip ? "SKIP" : row.pass ? "PASS" : "FAIL"}  ${row.tool} | ${row.check}${row.detail ? ` | ${row.detail}` : ""}`);
}
const failed = rows.filter((row) => !row.pass).length;
const skipped = rows.filter((row) => row.skip).length;
console.log(`\n${rows.length - failed - skipped}/${rows.length} checks passed${skipped ? `, ${skipped} skipped` : ""}`);
process.exit(failed ? 1 : 0);
