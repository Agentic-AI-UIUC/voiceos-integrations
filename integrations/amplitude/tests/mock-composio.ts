// Preloaded into the server for offline tests: replaces fetch with a fake Composio and logs each call to stderr.
const respond = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const success = (data: unknown) => respond({ successful: true, data });
const failure = (status: number, message: string) => respond({ successful: false, error: message, data: { status_code: status, message } });
const COHORT_CSV = "amplitude_id,user_id,ip_address,city,country,gp:plan\n101,alice,203.0.113.7,Champaign,United States,pro\n102,bob,203.0.113.8,Urbana,United States,free\n103,carol,203.0.113.9,Chicago,United States,pro\n104,dave,203.0.113.10,Peoria,United States,free\n";

const statusChecks = new Map<string, number>();
const event = (type: string, day: number) => ({
  event_type: type,
  event_time: `2026-11-${String(day).padStart(2, "0")} 05:00:49.620000`,
  event_properties: { price: 10, ip: "203.0.113.7" },
  session_id: -1,
  ip_address: "203.0.113.7",
  city: "Champaign",
  region: "Illinois",
  country: "United States",
  device_id: "device-1",
  device_type: "Mac",
  os_name: "Chrome",
  platform: "Web",
});

globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
  const href = String(url);
  // The cohort file lives on Composio's file storage, not the API host.
  if (!href.includes("backend.composio.dev")) {
    console.error(`MOCKCALL ${JSON.stringify({ path: "download", url: href })}`);
    if (href.includes("expired")) return new Response("expired", { status: 403 });
    return new Response(COHORT_CSV, { status: 200 });
  }
  const path = href.replace(/^.*\/api\/v3\.1/, "");
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  console.error(`MOCKCALL ${JSON.stringify({ path, arguments: body?.arguments })}`);

  if (path.startsWith("/connected_accounts?")) return respond({ items: [{ id: "ca_test" }] });

  const args = body?.arguments ?? {};
  switch (path.split("/").pop()) {
    case "AMPLITUDE_GET_EVENT_SEGMENTATION": {
      const e = JSON.parse(args.e);
      if (e.event_type === "missing_event") {
        return failure(400, '{"error": {"http_code": 400, "type": "invalid", "message": "Invalid chart definition", "metadata": {"details": "Invalid missing_event", "reason": "event_type_not_found"}}}');
      }
      if (e.event_type === "quiet_event") {
        return success({ data: { data: { series: [[0, 0, 0]], seriesCollapsed: [[{ setId: "", value: 0 }]], seriesLabels: [0], xValues: ["2026-11-01", "2026-11-02", "2026-11-03"] } } });
      }
      if (args.g) {
        const groups = ["Web", "iOS", "Android", "macOS", "Windows", "Linux", "tvOS"];
        return success({ data: { data: { series: groups.map((_, i) => [i, i + 1]), seriesCollapsed: groups.map((_, i) => [{ setId: "", value: 2 * i + 1 }]), seriesLabels: groups, xValues: ["2026-11-01", "2026-11-02"] } } });
      }
      return success({ data: { data: { series: [[0, 6, 2, 4]], seriesCollapsed: [[{ setId: "", value: 12 }]], seriesLabels: [0], xValues: ["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04"] } } });
    }
    case "AMPLITUDE_GET_FUNNEL_DATA":
      if (args.events[0].event_type === "quiet_event") return success({ data: [] });
      return success({ data: [{ events: args.events.map((e: any) => e.event_type), cumulativeRaw: [6, 5, 3].slice(0, args.events.length), avgTransTimes: [0, 93720000, 86400000] }] });
    case "AMPLITUDE_GET_RETENTION":
      if (args.rm === "n-day") return failure(400, '{"error": {"code": 400, "message": "Invalid retention method."}}');
      return success({
        data: {
          series: [
            {
              combined: [{ count: 6, outof: 6 }, { count: 5, outof: 6 }, { count: 2, outof: 4 }, { count: 0, outof: 0, incomplete: true }],
              values: {
                "Nov 04, 2026": [{ count: 4, outof: 4 }, { count: 3, outof: 4 }],
                "Nov 05, 2026": [{ count: 2, outof: 2 }, { count: 2, outof: 2 }],
                "Nov 06, 2026": [{ count: 0, outof: 0 }],
              },
            },
          ],
        },
      });
    case "AMPLITUDE_FIND_USER":
      if (args.user === "ghost" || /\s/.test(args.user) || /^(ghost|voice)/.test(args.user) && args.user !== "voiceos-test-1") return success({ matches: [], type: "nomatch" });
      if (args.user === "voiceos-test-1") return success({ type: "match_user_or_device_id", matches: [{ user_id: "voiceos-test-1", amplitude_id: 101, country: "United States" }] });
      if (args.user === "user") {
        return success({ type: "match_user_prefix", matches: [1, 2, 3, 4, 5, 6, 7].map((i) => ({ user_id: `user-${i}`, amplitude_id: 100 + i, country: "United States", last_device_id: `device-${i}` })) });
      }
      if (args.user === "user-1") {
        return success({ type: "match_user_prefix", matches: [{ user_id: "user-1", amplitude_id: 101, country: "United States" }, { user_id: "user-10", amplitude_id: 110, country: "United States" }] });
      }
      return success({ type: "match_user_or_device_id", matches: [{ user_id: args.user, amplitude_id: 101, country: "United States", last_device_id: "device-1" }] });
    case "AMPLITUDE_GET_USER_ACTIVITY":
      return success({
        events: [event("purchase", 13), event("page_view", 12), event("page_view", 11)],
        userData: { user_id: "user-1", canonical_amplitude_id: 101, first_used: "2026-11-05", last_used: "2026-11-13", num_events: 12, num_sessions: 0, purchases: "0", revenue: "0.0", city: "Champaign", country: "United States", ip_address: "203.0.113.7", device_ids: ["device-1"], properties: { plan: "pro", city: "Champaign" } },
      });
    case "AMPLITUDE_LIST_COHORTS":
      return success({
        cohorts: [
          { id: "c_buyers", name: "Buyers", size: 4, archived: false },
          { id: "c_slow", name: "Slow export", size: 900, archived: false },
          { id: "c_locked", name: "Locked", size: 2, archived: false },
          { id: "c_power1", name: "Power users EU", size: 3, archived: false },
          { id: "c_power2", name: "Power users US", size: 5, archived: false },
          { id: "c_old", name: "Archived buyers", size: 1, archived: true },
          { id: "c_expired", name: "Expired link", size: 7, archived: false },
        ],
      });
    case "AMPLITUDE_GET_COHORT":
      if (args.cohort_id === "c_locked") {
        return failure(403, '{"error": {"http_code": 403, "type": "unspecified", "message": "Unspecified Error", "metadata": {"details": "Unauthorized Reqeust for Cohort Download"}}}');
      }
      return success({ cohort_id: args.cohort_id, request_id: args.cohort_id === "c_slow" ? "req_slow" : args.cohort_id === "c_expired" ? "req_expired" : "req_buyers" });
    case "AMPLITUDE_CHECK_COHORT_STATUS": {
      const n = (statusChecks.get(args.request_id) ?? 0) + 1;
      statusChecks.set(args.request_id, n);
      // req_buyers finishes on the second check; req_slow never finishes.
      const done = (args.request_id === "req_buyers" && n >= 2) || args.request_id === "req_expired";
      return success({ request_id: args.request_id, cohort_id: "c", async_status: done ? "JOB COMPLETED" : "JOB INPROGRESS" });
    }
    case "AMPLITUDE_DOWNLOAD_COHORT_FILE":
      return success({ file: { name: "cohort.csv", mimetype: "text/csv", s3url: `https://files.example.test/${args.request_id === "req_expired" ? "expired" : "cohort"}.csv?sig=x` } });
    default:
      throw new Error(`Unexpected request: ${path}`);
  }
}) as typeof fetch;
