import { expect, test } from "bun:test";
import { createGa, propertyName } from "../server.ts";

/** A fake Composio execute that records calls and answers with `data`. */
function fakeExecute(data: unknown) {
  const calls: { slug: string; args: any }[] = [];
  const execute = async (slug: string, args: Record<string, unknown>) => {
    calls.push({ slug, args });
    return data;
  };
  return { execute, calls };
}

// Shapes copied from real GOOGLE_ANALYTICS_* responses for the test property.
const REALTIME = {
  dimensionHeaders: [{ name: "unifiedScreenName" }],
  metricHeaders: [{ name: "activeUsers", type: "TYPE_INTEGER" }],
  rowCount: 2,
  rows: [
    { dimensionValues: [{ value: "Blog · GA Test Site" }], metricValues: [{ value: "1" }] },
    { dimensionValues: [{ value: "Home · GA Test Site" }], metricValues: [{ value: "3" }] },
  ],
};
const EMPTY_REPORT = {
  dimensionHeaders: [{ name: "pagePath" }],
  metricHeaders: [{ name: "screenPageViews", type: "TYPE_INTEGER" }],
  metadata: { currencyCode: "USD", timeZone: "America/Los_Angeles" },
  rowCount: 0,
  rows: [],
};

test("propertyName accepts a bare ID or a resource name, and falls back to the default", () => {
  expect(propertyName("563733408")).toBe("properties/563733408");
  expect(propertyName(" properties/563733408 ")).toBe("properties/563733408");
  expect(propertyName(undefined, "42")).toBe("properties/42");
  expect(propertyName("", "42")).toBe("properties/42");
});

test("propertyName rejects a missing or non-numeric ID with a fix the user can act on", () => {
  expect(() => propertyName(undefined, undefined)).toThrow(/No GA4 property ID/);
  expect(() => propertyName("G-MFNBL19KFV")).toThrow(/Measurement ID/);
});

test("runReport sends GA's request shape, sorted by the first metric by default", async () => {
  const fx = fakeExecute(EMPTY_REPORT);
  await createGa(fx.execute).runReport({
    property_id: "563733408", metrics: ["screenPageViews", "activeUsers"], dimensions: ["pagePath"],
  });
  expect(fx.calls[0]).toEqual({
    slug: "GOOGLE_ANALYTICS_RUN_REPORT",
    args: {
      property: "properties/563733408",
      dateRanges: [{ startDate: "7daysAgo", endDate: "today" }],
      metrics: [{ name: "screenPageViews" }, { name: "activeUsers" }],
      dimensions: [{ name: "pagePath" }],
      orderBys: [{ metric: { metricName: "screenPageViews" }, desc: true }],
      limit: 10,
    },
  });
});

test("order_by on a dimension sorts by that dimension, ascending when asked", async () => {
  const fx = fakeExecute(EMPTY_REPORT);
  await createGa(fx.execute, "1").runReport({ metrics: ["activeUsers"], dimensions: ["date"], order_by: "date", descending: false });
  expect(fx.calls[0].args.orderBys).toEqual([{ dimension: { dimensionName: "date" }, desc: false }]);
});

test("an empty report is a normal result that carries the property's time zone", async () => {
  const out = await createGa(fakeExecute(EMPTY_REPORT).execute, "1").runReport({ metrics: ["screenPageViews"] });
  expect(out).toEqual({
    property_id: "1", start_date: "7daysAgo", end_date: "today",
    time_zone: "America/Los_Angeles", row_count: 0, rows: [],
  });
});

test("realtime rows become objects keyed by field name, with numeric metrics", async () => {
  const fx = fakeExecute(REALTIME);
  const out = await createGa(fx.execute, "1").runRealtimeReport({ dimensions: ["unifiedScreenName"] });
  expect(fx.calls[0].args.metrics).toEqual([{ name: "activeUsers" }]); // default metric
  expect(out).toEqual({
    property_id: "1", window: "last 30 minutes", row_count: 2,
    rows: [
      { unifiedScreenName: "Blog · GA Test Site", activeUsers: 1 },
      { unifiedScreenName: "Home · GA Test Site", activeUsers: 3 },
    ],
  });
});

const METADATA = {
  name: "properties/1/metadata",
  dimensions: [
    { apiName: "pagePath", uiName: "Page path", category: "Page / Screen", description: "long text" },
    { apiName: "country", uiName: "Country", category: "Geography", description: "long text" },
    { apiName: "customEvent:location", uiName: "location", category: "Custom", customDefinition: true },
  ],
  metrics: [
    { apiName: "screenPageViews", uiName: "Views", category: "Page / Screen", type: "TYPE_INTEGER", description: "long text" },
    { apiName: "activeUsers", uiName: "Active users", category: "User", type: "TYPE_INTEGER", description: "long text" },
  ],
  comparisons: [{ apiName: "comparisons/allUsers" }],
};

test("getMetadata asks for the property's metadata and returns only field names, grouped by category", async () => {
  const fx = fakeExecute(METADATA);
  const out = await createGa(fx.execute, "1").getMetadata({});
  expect(fx.calls[0]).toEqual({ slug: "GOOGLE_ANALYTICS_GET_METADATA", args: { name: "properties/1/metadata" } });
  expect(out).toEqual({
    property_id: "1",
    dimensions: { "Page / Screen": ["pagePath"], Geography: ["country"], Custom: ["customEvent:location"] },
    metrics: { "Page / Screen": ["screenPageViews"], User: ["activeUsers"] },
  });
});

test("getMetadata filters by category or by words in the API or display name, case-insensitively", async () => {
  const ga = createGa(fakeExecute(METADATA).execute, "1");
  expect(await ga.getMetadata({ category: "page / screen" })).toMatchObject({
    dimensions: { "Page / Screen": ["pagePath"] }, metrics: { "Page / Screen": ["screenPageViews"] },
  });
  // "views" matches screenPageViews by API name; "active" matches activeUsers.
  expect((await ga.getMetadata({ search: "VIEWS" })).metrics).toEqual({ "Page / Screen": ["screenPageViews"] });
  expect((await ga.getMetadata({ search: "active" })).dimensions).toEqual({});
});
