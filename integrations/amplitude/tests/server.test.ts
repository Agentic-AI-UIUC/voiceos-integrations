// Offline tests: runs the real server over MCP against tests/mock-composio.ts. No keys or network needed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MOCK = join(ROOT, "tests", "mock-composio.ts");
const manifest = JSON.parse(readFileSync(join(ROOT, "voiceos.integration.json"), "utf8"));
const source = readFileSync(join(ROOT, "server.ts"), "utf8");
const TOOLS = ["export_cohort", "get_event_segmentation", "get_funnel", "get_retention", "get_user_activity"];
// The only Composio actions this integration may call. Anything else (deletes, uploads, event writes) is out.
const APPROVED_SLUGS = [
  "AMPLITUDE_CHECK_COHORT_STATUS",
  "AMPLITUDE_DOWNLOAD_COHORT_FILE",
  "AMPLITUDE_FIND_USER",
  "AMPLITUDE_GET_COHORT",
  "AMPLITUDE_GET_EVENT_SEGMENTATION",
  "AMPLITUDE_GET_FUNNEL_DATA",
  "AMPLITUDE_GET_RETENTION",
  "AMPLITUDE_GET_USER_ACTIVITY",
  "AMPLITUDE_LIST_COHORTS",
];
const SETTINGS = ["AMPLITUDE_API_KEY", "AMPLITUDE_SECRET_KEY", "AMPLITUDE_REGION", "AMPLITUDE_BASE_URL", "AMPLITUDE_POLL_BUDGET_MS"];
const KEYS = { COMPOSIO_API_KEY: "ak_testcomposiokey123", AMPLITUDE_API_KEY: "0123456789abcdef0123456789abcdef", AMPLITUDE_SECRET_KEY: "fedcba9876543210fedcba9876543210" };
const PRIVATE_FIELDS = /"(ip_address|ip|city|region|country|dma|device_id|device_ids|device_type|last_device_id|os_name|platform)"\s*:/;

async function startServer(env: Record<string, string>) {
  const log: string[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--preload", MOCK, join(ROOT, "server.ts")],
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", AMPLITUDE_POLL_BUDGET_MS: "1500", ...env },
  });
  transport.stderr?.on("data", (chunk: Buffer) => log.push(...String(chunk).split("\n").filter(Boolean)));
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(transport);
  return { client, log };
}

let client: Client;
let log: string[];

const calls = () => log.filter((line) => line.startsWith("MOCKCALL ")).map((line) => JSON.parse(line.slice(9)));
const lastArguments = (slug: string) => calls().filter((c) => c.path.endsWith(slug)).at(-1)?.arguments;

async function run(name: string, args: Record<string, unknown>, c: Client = client) {
  const result: any = await c.callTool({ name, arguments: args });
  const text: string = result.content[0].text;
  let body: any = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text };
  }
  return { isError: Boolean(result.isError), text, body, html: String(body._voiceos_glance?.blocks?.[0]?.html ?? "") };
}

const cardRows = (html: string) => html.match(/class="k-rw"/g)?.length ?? 0;

async function expectNoCall(name: string, args: Record<string, unknown>) {
  const before = calls().length;
  const result = await run(name, args);
  expect(result.isError).toBe(true);
  expect(calls()).toHaveLength(before);
  return result;
}

beforeAll(async () => {
  ({ client, log } = await startServer(KEYS));
});

afterAll(async () => {
  await client.close();
});

describe("manifest", () => {
  test("follows VoiceOS's limits", () => {
    expect(manifest.summary.length).toBeLessThanOrEqual(140);
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.id).toBe("com.voiceos.generated.amplitude-analytics");
    expect(manifest.supportedPlatforms).toEqual(["darwin", "win32"]);
    expect(manifest.tools.map((t: any) => t.name).sort()).toEqual(TOOLS);
    for (const tool of manifest.tools) expect(tool.description).toContain("Use when");
  });

  test("allows only the Composio domain", () => {
    expect(manifest.permissions).toEqual([{ kind: "network", domains: ["backend.composio.dev"] }]);
  });

  test("declares no confirmation cards: every tool is read-only", () => {
    expect(manifest.tools.filter((t: any) => t.confirmation)).toEqual([]);
  });

  test("asks for every setting, with secrets as passwords", () => {
    const prefs = Object.fromEntries(manifest.preferences.map((p: any) => [p.name, p.type]));
    expect(prefs).toEqual({ COMPOSIO_API_KEY: "password", AMPLITUDE_API_KEY: "password", AMPLITUDE_SECRET_KEY: "password", AMPLITUDE_REGION: "select" });
    const example = readFileSync(join(ROOT, ".env.example"), "utf8").trim().split("\n").map((l) => l.split("=")[0]);
    expect(example.sort()).toEqual(Object.keys(prefs).sort());
  });
});

describe("server", () => {
  test("matches the manifest tool for tool", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(TOOLS);
    for (const expected of manifest.tools) {
      const actual: any = tools.find((t) => t.name === expected.name);
      expect(actual.description).toBe(expected.description);
      expect(Object.keys(actual.inputSchema.properties).sort()).toEqual(Object.keys(expected.inputSchema.properties).sort());
      expect([...(actual.inputSchema.required ?? [])].sort()).toEqual([...(expected.inputSchema.required ?? [])].sort());
    }
  });

  test("references only approved Composio slugs", () => {
    const used = [...new Set(source.match(/"AMPLITUDE_[A-Z_]+"/g)!.map((slug) => slug.slice(1, -1)))]
      .filter((slug) => !SETTINGS.includes(slug))
      .sort();
    expect(used).toEqual(APPROVED_SLUGS);
  });

  test("runs no macOS-only commands", () => {
    expect(source).not.toMatch(/osascript|pbcopy|\/Users\/|\/bin\/zsh|child_process/);
  });

  test("sets up the connected account with the toolkit's field names", async () => {
    const { client: fresh, log: freshLog } = await startServer({ ...KEYS, AMPLITUDE_REGION: "eu" });
    await run("get_funnel", { steps: ["a", "b"] }, fresh);
    await fresh.close();
    expect(freshLog.some((l) => l.includes("/connected_accounts?toolkit_slugs=amplitude&user_ids=voiceos-amplitude-"))).toBe(true);
  });

  test("explains missing keys without calling Composio", async () => {
    const { client: bare, log: bareLog } = await startServer({ COMPOSIO_API_KEY: "ak_x", AMPLITUDE_API_KEY: "", AMPLITUDE_SECRET_KEY: "" });
    const result = await run("get_event_segmentation", { event_type: "x" }, bare);
    await bare.close();
    expect(result.isError).toBe(true);
    expect(result.body.error).toContain("Settings -> Projects");
    expect(bareLog.filter((l) => l.startsWith("MOCKCALL"))).toEqual([]);
  });
});

describe("get_event_segmentation", () => {
  test("sends e as JSON and maps the interval to Amplitude's value", async () => {
    const { isError, body } = await run("get_event_segmentation", { event_type: "Sign Up", metric: "totals", interval: "weekly", start_date: "2026-11-01", end_date: "20261104" });
    expect(isError).toBe(false);
    expect(lastArguments("AMPLITUDE_GET_EVENT_SEGMENTATION")).toEqual({ e: '{"event_type":"Sign Up"}', m: "totals", i: "7", start: "20261101", end: "20261104" });
    expect(body).toMatchObject({ total: 12, start_date: "2026-11-01", end_date: "2026-11-04" });
    expect(body.series[0].points).toHaveLength(4);
  });

  test("card reads as a sentence with short dates; the data keeps ISO dates", async () => {
    const { body, html } = await run("get_event_segmentation", { event_type: "Sign Up", metric: "totals", start_date: "2025-11-01", end_date: "2025-11-04" });
    expect(html).toContain("Nov 1, 2025 – Nov 4, 2025");
    expect(html).toContain("Sign Up events. Busiest: Nov 2 (6).");
    expect(html).not.toContain("Buckets");
    expect(html).not.toContain("2025-11-01");
    expect(body).toMatchObject({ start_date: "2025-11-01", end_date: "2025-11-04" });
    expect(body.series[0].points[0].time).toBe("2026-11-01");
    const weekly = await run("get_event_segmentation", { event_type: "Sign Up", interval: "weekly" });
    expect(weekly.html).toContain("users did Sign Up. Busiest: the week of Nov 2 (6).");
  });

  test("defaults to daily unique users over the last 7 days", async () => {
    await run("get_event_segmentation", { event_type: "Sign Up" });
    const sent = lastArguments("AMPLITUDE_GET_EVENT_SEGMENTATION");
    expect(sent).toMatchObject({ m: "uniques", i: "1" });
    const span = (Date.parse(`${sent.end.slice(0, 4)}-${sent.end.slice(4, 6)}-${sent.end.slice(6)}`) - Date.parse(`${sent.start.slice(0, 4)}-${sent.start.slice(4, 6)}-${sent.start.slice(6)}`)) / 86_400_000;
    expect(span).toBe(6);
  });

  test("returns an empty range as zero, not an error", async () => {
    const { isError, body, html } = await run("get_event_segmentation", { event_type: "quiet_event" });
    expect(isError).toBe(false);
    expect(body.total).toBe(0);
    expect(html).toContain("users did quiet_event — nothing recorded in this date range.");
  });

  test("names an unknown event plainly", async () => {
    const { isError, body } = await run("get_event_segmentation", { event_type: "missing_event" });
    expect(isError).toBe(true);
    expect(body.error).toBe('Amplitude has no event named "missing_event" in this project. Event names are case-sensitive.');
  });

  test.each([
    ["blank event", { event_type: " " }],
    ["bad date", { event_type: "x", start_date: "2026-02-30" }],
    ["start after end", { event_type: "x", start_date: "2026-05-10", end_date: "2026-05-01" }],
    ["days out of range", { event_type: "x", days: 0 }],
  ])("rejects %s before calling Composio", async (_name, args) => {
    await expectNoCall("get_event_segmentation", args);
  });

  test("groups show 5 rows and the remainder", async () => {
    const { body, html } = await run("get_event_segmentation", { event_type: "x", group_by: "platform" });
    expect(lastArguments("AMPLITUDE_GET_EVENT_SEGMENTATION").g).toBe("platform");
    expect(body.series[0].name).toBe("tvOS");
    expect(body.group_count).toBe(7);
    expect(cardRows(html)).toBe(5);
    expect(html).toContain("+2 more");
  });
});

describe("get_funnel", () => {
  test("reports counts, conversion and time between steps", async () => {
    const { body } = await run("get_funnel", { steps: ["view", "signup", "buy"], conversion_window_days: 7, start_date: "2026-11-01", end_date: "2026-11-14" });
    expect(lastArguments("AMPLITUDE_GET_FUNNEL_DATA")).toEqual({ events: [{ event_type: "view" }, { event_type: "signup" }, { event_type: "buy" }], start: "20261101", end: "20261114", cs: 604800, mode: "ordered" });
    expect(body.steps.map((s: any) => s.users)).toEqual([6, 5, 3]);
    expect(body.overall_conversion_pct).toBe(50);
    expect(body.steps[1]).toMatchObject({ conversion_from_previous_pct: 83.3, avg_time_from_previous: "1d 2h" });
  });

  test("reports zeros when nobody entered", async () => {
    const { isError, body, html } = await run("get_funnel", { steps: ["quiet_event", "b"] });
    expect(isError).toBe(false);
    expect(body.steps.map((s: any) => s.users)).toEqual([0, 0]);
    expect(html).toContain("no one entered the funnel");
  });

  test.each([[["only-one"]], [["a", "b", "c", "d", "e"]], [[]]])("rejects %j before calling Composio", async (steps) => {
    const { body } = await expectNoCall("get_funnel", { steps });
    expect(body.error).toContain("2 to 4 steps");
  });

  test("rejects a conversion window over 90 days", async () => {
    await expectNoCall("get_funnel", { steps: ["a", "b"], conversion_window_days: 120 });
  });
});

describe("get_retention", () => {
  test("sends se/re as JSON strings and omits rm for n-day", async () => {
    const { isError, body } = await run("get_retention", {});
    expect(isError).toBe(false);
    const sent = lastArguments("AMPLITUDE_GET_RETENTION");
    expect(sent).toMatchObject({ se: '{"event_type":"_new"}', re: '{"event_type":"_all"}', i: 1 });
    expect(sent.rm).toBeUndefined();
    expect(body.users_in_cohorts).toBe(6);
    expect(body.day_1_retention_pct).toBe(83.3);
    expect(body.periods).toHaveLength(3);
    expect(body.cohorts.map((c: any) => c.cohort)).toEqual(["Nov 04, 2026", "Nov 05, 2026"]);
  });

  test("sends rolling mode and weekly interval", async () => {
    const { body } = await run("get_retention", { start_event: "signup", return_event: "purchase", interval: "weekly", retention_mode: "rolling" });
    expect(lastArguments("AMPLITUDE_GET_RETENTION")).toMatchObject({ se: '{"event_type":"signup"}', re: '{"event_type":"purchase"}', i: 7, rm: "rolling" });
    expect(body.week_1_retention_pct).toBe(83.3);
  });
});

describe("get_user_activity", () => {
  test("returns the profile and events without location or device fields", async () => {
    const { isError, body, text } = await run("get_user_activity", { user: "alice", limit: 2 });
    expect(isError).toBe(false);
    expect(lastArguments("AMPLITUDE_GET_USER_ACTIVITY")).toEqual({ user: "101", limit: 2, direction: "latest" });
    expect(body.user).toMatchObject({ user_id: "user-1", amplitude_id: 101, total_events: 12, properties: { plan: "pro" } });
    expect(body.events).toHaveLength(2);
    expect(body.events[0]).toEqual({ event_type: "purchase", time: "2026-11-13T05:00:49Z", session_id: null, properties: { price: 10 } });
    expect(text).not.toMatch(PRIVATE_FIELDS);
    expect(text).not.toContain("203.0.113");
    expect(text).not.toContain("Champaign");
  });

  test("returns candidates when several users match", async () => {
    const before = calls().filter((c) => c.path.endsWith("AMPLITUDE_GET_USER_ACTIVITY")).length;
    const { isError, body, html, text } = await run("get_user_activity", { user: "user" });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ found: false, multiple_matches: true });
    expect(body.matches).toHaveLength(7);
    expect(body.matches[0]).toEqual({ user_id: "user-1", amplitude_id: 101 });
    expect(text).not.toMatch(PRIVATE_FIELDS);
    expect(cardRows(html)).toBe(5);
    expect(html).toContain("+2 more");
    expect(calls().filter((c) => c.path.endsWith("AMPLITUDE_GET_USER_ACTIVITY"))).toHaveLength(before);
  });

  test("picks the exact user ID among prefix matches", async () => {
    const { body } = await run("get_user_activity", { user: "user-1" });
    expect(body.found).toBe(true);
    expect(lastArguments("AMPLITUDE_GET_USER_ACTIVITY").user).toBe("101");
  });

  test("finds a user whose ID was split into words by speech", async () => {
    const { isError, body, html } = await run("get_user_activity", { user: "User Voice OS Test 1" });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ found: true, heard: "User Voice OS Test 1", matched_as: "voiceos-test-1" });
    expect(html).toContain("Heard &quot;User Voice OS Test 1&quot;");
    const lookups = calls().filter((c) => c.path.endsWith("AMPLITUDE_FIND_USER")).slice(-17);
    expect(lookups.length).toBeLessThanOrEqual(17);
  });

  test("gives up on a spoken ID after a capped number of spellings", async () => {
    const before = calls().filter((c) => c.path.endsWith("AMPLITUDE_FIND_USER")).length;
    const { isError, body } = await run("get_user_activity", { user: "Ghost Person Number Two" });
    expect(isError).toBe(false);
    expect(body.found).toBe(false);
    expect(body.also_tried.length).toBeGreaterThan(0);
    expect(calls().filter((c) => c.path.endsWith("AMPLITUDE_FIND_USER")).length - before).toBe(1 + body.also_tried.length);
    expect(body.also_tried.length).toBeLessThanOrEqual(16);
  });

  test("reports an unknown user as not found, not an error", async () => {
    const { isError, body } = await run("get_user_activity", { user: "ghost" });
    expect(isError).toBe(false);
    expect(body).toEqual({ query: "ghost", found: false, matches: [], _voiceos_glance: expect.anything() });
  });

  test.each([[{ user: "" }], [{ user: "alice", limit: 0 }], [{ user: "alice", limit: 51 }]])("rejects %j before calling Composio", async (args) => {
    await expectNoCall("get_user_activity", args);
  });
});

describe("export_cohort", () => {
  test("lists discoverable cohorts when none is named", async () => {
    const { body, html } = await run("export_cohort", {});
    expect(body.total_cohorts).toBe(6);
    expect(cardRows(html)).toBe(5);
  });

  test("resolves a name, polls, downloads, and returns a sample without private columns", async () => {
    const { isError, body, text } = await run("export_cohort", { cohort: "buyers" });
    expect(isError).toBe(false);
    expect(lastArguments("AMPLITUDE_GET_COHORT")).toEqual({ cohort_id: "c_buyers" });
    expect(calls().filter((c) => c.path.endsWith("AMPLITUDE_CHECK_COHORT_STATUS")).length).toBeGreaterThanOrEqual(2);
    expect(lastArguments("AMPLITUDE_DOWNLOAD_COHORT_FILE")).toEqual({ request_id: "req_buyers" });
    expect(body).toMatchObject({ status: "done", members: 4, cohort: { id: "c_buyers", name: "Buyers" }, columns: ["amplitude_id", "user_id", "gp:plan"] });
    expect(body.sample).toEqual([
      { amplitude_id: "101", user_id: "alice", "gp:plan": "pro" },
      { amplitude_id: "102", user_id: "bob", "gp:plan": "free" },
      { amplitude_id: "103", user_id: "carol", "gp:plan": "pro" },
    ]);
    expect(text).not.toContain("203.0.113");
    expect(text).not.toContain("s3url");
  });

  test("returns the request ID when the export is still processing, then resumes it", async () => {
    const first = await run("export_cohort", { cohort: "c_slow" });
    expect(first.isError).toBe(false);
    expect(first.body).toMatchObject({ status: "processing", request_id: "req_slow" });
    const before = calls().filter((c) => c.path.endsWith("AMPLITUDE_GET_COHORT")).length;
    const resumed = await run("export_cohort", { request_id: "req_slow" });
    expect(resumed.body.status).toBe("processing");
    expect(calls().filter((c) => c.path.endsWith("AMPLITUDE_GET_COHORT"))).toHaveLength(before);
  });

  test("lists candidates when several cohorts match", async () => {
    const { isError, body } = await run("export_cohort", { cohort: "power users" });
    expect(isError).toBe(false);
    expect(body.matches.map((c: any) => c.id)).toEqual(["c_power1", "c_power2"]);
  });

  test("ignores archived cohorts and names the available ones", async () => {
    const { isError, body } = await run("export_cohort", { cohort: "Archived buyers" });
    expect(isError).toBe(true);
    expect(body.error).toContain('No discoverable cohort matches "Archived buyers"');
  });

  test("explains Amplitude's 403 on export", async () => {
    const { isError, body } = await run("export_cohort", { cohort: "Locked" });
    expect(isError).toBe(true);
    expect(body.error).toBe('Amplitude won\'t export the members of "Locked". Exporting cohorts through its API needs a Growth or Enterprise plan. Amplitude\'s cohort list shows it has 2 users. (Amplitude 403: Unauthorized Request for Cohort Download)');
  });

  test("reports the listed size when the file link can't be read", async () => {
    const { isError, body } = await run("export_cohort", { cohort: "Expired link" });
    expect(isError).toBe(false);
    expect(body).toMatchObject({ status: "done", members: 7, sample: null });
    expect(body.sample_unavailable).toContain("status 403");
  });
});

describe("honesty and privacy", () => {
  test("never reports success when Amplitude refuses a 200 response", async () => {
    const { isError, body } = await run("get_event_segmentation", { event_type: "missing_event" });
    expect(isError).toBe(true);
    expect(body.total).toBeUndefined();
  });

  test("keeps keys out of results and logs", async () => {
    await run("get_user_activity", { user: "alice" });
    const everything = log.join("\n");
    for (const key of Object.values(KEYS)) expect(everything).not.toContain(key);
  });
});
