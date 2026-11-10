import { expect, test } from "bun:test";
import { change, errorCard, fmtMetric, metadataCard, periodLabel, realtimeCard, reportCard } from "../server.ts";

// Cards are checked by the text a user reads, not by markup.
const text = (card: { html: string }) => card.html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");

test("metrics read the way people say them: compact counts, rates as %, durations as time", () => {
  expect(fmtMetric("screenPageViews", 842)).toBe("842");
  expect(fmtMetric("screenPageViews", 12_340)).toBe("12.3k");
  expect(fmtMetric("activeUsers", 2_500_000)).toBe("2.5M");
  expect(fmtMetric("engagementRate", 0.4234)).toBe("42.3%");
  expect(fmtMetric("bounceRate", 0.5)).toBe("50%");
  expect(fmtMetric("averageSessionDuration", 125.4)).toBe("2m 5s");
  expect(fmtMetric("averageSessionDuration", 42)).toBe("42s");
});

test("change vs the previous period: signed percent, good when up, except for bounce rate", () => {
  expect(change("sessions", 125, 100)).toEqual({ delta: "+25%", tone: "good" });
  expect(change("sessions", 90, 100)).toEqual({ delta: "−10%", tone: "bad" });
  expect(change("bounceRate", 0.6, 0.5)).toEqual({ delta: "+20%", tone: "bad" });
  expect(change("sessions", 5, 0)).toEqual({}); // no baseline, no percent
});

test("period labels spell out GA's date words", () => {
  expect(periodLabel("7daysAgo", "today")).toBe("7 days ago – today");
  expect(periodLabel("yesterday", "yesterday")).toBe("Yesterday");
  expect(periodLabel("2026-11-01", "2026-11-09")).toBe("2026-11-01 – 2026-11-09");
});

const REPORT = {
  property_id: "1", start_date: "7daysAgo", end_date: "today", time_zone: "America/Los_Angeles",
  row_count: 8, totals: { screenPageViews: 1240, activeUsers: 310 },
  rows: Array.from({ length: 8 }, (_, i) => ({ pagePath: `/page-${i}`, screenPageViews: 100 - i, activeUsers: 10 })),
};

test("a report card shows the period, the totals, and at most 5 top rows by the first metric", () => {
  const t = text(reportCard(REPORT));
  expect(t).toContain("7 days ago – today");
  expect(t).toContain("Views");
  expect(t).toContain("1.2k");
  expect(t).toContain("Active users");
  expect(t).toContain("/page-4");
  expect(t).not.toContain("/page-5");
});

test("a comparison card shows the current totals with their change, and only current-period rows", () => {
  const t = text(reportCard({
    ...REPORT, compare_start_date: "14daysAgo", compare_end_date: "8daysAgo",
    totals: { current: { screenPageViews: 125 }, previous: { screenPageViews: 100 } },
    rows: [
      { pagePath: "/", dateRange: "current", screenPageViews: 90 },
      { pagePath: "/", dateRange: "previous", screenPageViews: 70 },
    ],
  }));
  expect(t).toContain("vs previous");
  expect(t).toContain("125");
  expect(t).toContain("+25%");
  expect(t).toContain("90");
  expect(t).not.toContain("70");
});

test("an empty report says there is no data, distinct from an error", () => {
  const t = text(reportCard({ ...REPORT, row_count: 0, totals: { screenPageViews: 0 }, rows: [] }));
  expect(t).toContain("No data for this period");
});

test("a realtime card leads with people on the site now and their pages", () => {
  const t = text(realtimeCard({
    property_id: "1", window: "last 30 minutes", row_count: 2, totals: { activeUsers: 3 },
    rows: [{ unifiedScreenName: "Pricing", activeUsers: 2 }, { unifiedScreenName: "Blog", activeUsers: 1 }],
  }));
  expect(t).toContain("Right now");
  expect(t).toContain("Active users");
  expect(t).toContain("Pricing");
});

test("an empty realtime card says nobody is on the site", () => {
  expect(text(realtimeCard({ property_id: "1", window: "last 30 minutes", row_count: 0, totals: { activeUsers: 0 }, rows: [] })))
    .toContain("No one on the site right now");
});

test("a metadata card counts the fields and lists every one of them, metrics first, in a scrollable list", () => {
  const t = text(metadataCard({
    property_id: "1",
    dimensions: { "Page / Screen": ["pagePath", "pageTitle"] },
    metrics: { "Page / Screen": ["screenPageViews", "views2", "views3", "views4", "views5", "views6"] },
  }, { category: "Page / Screen" }));
  expect(t).toContain("Page / Screen");
  expect(t).toContain("6");
  expect(t).toContain("screenPageViews");
  expect(t).toContain("views6");
  expect(t.indexOf("views6")).toBeLessThan(t.indexOf("pageTitle"));
});

test("an error card carries the plain-words message, and says when reconnecting is the fix", () => {
  const t = text(errorCard("Google Analytics access was revoked. Reconnect the Google account.", true));
  expect(t).toContain("Google Analytics access was revoked.");
  expect(t).toContain("Reconnect needed");
  expect(text(errorCard("Quota used up.", false))).not.toContain("Reconnect needed");
});
