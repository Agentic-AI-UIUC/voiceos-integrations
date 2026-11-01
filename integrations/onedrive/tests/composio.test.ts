import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "./no-connect.ts";
import { composio, downloadBytes, resetAccountCache, resolveItem } from "../server.ts";

type Call = { url: string; body: any };
let calls: Call[] = [];
const realFetch = globalThis.fetch;

/** Routes each Composio tool slug to a canned { status, json } reply. */
function mockComposio(routes: Record<string, (args: any) => { status?: number; json: any }>) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (url.startsWith("https://files.example/")) {
      return url.endsWith("/missing") ? new Response("gone", { status: 403 }) : new Response(`bytes of ${url}`);
    }
    if (url.includes("/connected_accounts")) {
      return Response.json({ items: [{ id: "ca_test", user_id: "u1", status: "ACTIVE", toolkit: { slug: "one_drive" } }] });
    }
    const slug = url.split("/tools/execute/")[1];
    const route = routes[slug];
    if (!route) return Response.json({ successful: false, error: `unexpected slug ${slug}` }, { status: 400 });
    const { status = 200, json } = route(body?.arguments);
    return Response.json(json, { status });
  }) as typeof fetch;
}

const executed = () => calls.filter((c) => c.url.includes("/tools/execute/")).map((c) => c.url.split("/tools/execute/")[1]);

beforeEach(() => {
  calls = [];
  resetAccountCache();
  process.env.COMPOSIO_API_KEY = "ak_test_key";
  delete process.env.COMPOSIO_CONNECTED_ACCOUNT_ID;
  delete process.env.COMPOSIO_USER_ID;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("composio()", () => {
  test("sends the discovered account and returns unwrapped data", async () => {
    mockComposio({ ONE_DRIVE_GET_ROOT: () => ({ json: { successful: true, data: { response_data: { id: "root" } } } }) });
    expect(await composio("ONE_DRIVE_GET_ROOT", {})).toEqual({ id: "root" });
    const exec = calls.find((c) => c.url.includes("/tools/execute/"))!;
    expect(exec.body).toMatchObject({ user_id: "u1", connected_account_id: "ca_test", arguments: {} });
  });

  test("uses an explicit connected account without looking one up", async () => {
    process.env.COMPOSIO_CONNECTED_ACCOUNT_ID = "ca_explicit";
    mockComposio({ ONE_DRIVE_GET_ROOT: () => ({ json: { successful: true, data: {} } }) });
    await composio("ONE_DRIVE_GET_ROOT", {});
    expect(calls.some((c) => c.url.includes("/connected_accounts"))).toBe(false);
    expect(calls[0].body.connected_account_id).toBe("ca_explicit");
  });

  test("throws Composio's error instead of returning it", async () => {
    mockComposio({ ONE_DRIVE_GET_ROOT: () => ({ json: { successful: false, error: "Something broke" } }) });
    await expect(composio("ONE_DRIVE_GET_ROOT", {})).rejects.toThrow("Something broke");
  });

  test("adds a reconnect hint to auth failures", async () => {
    mockComposio({ ONE_DRIVE_GET_ROOT: () => ({ json: { successful: false, error: "Access token expired" } }) });
    await expect(composio("ONE_DRIVE_GET_ROOT", {})).rejects.toThrow(/Reconnect OneDrive/);
  });

  test("explains a rejected API key", async () => {
    mockComposio({ ONE_DRIVE_GET_ROOT: () => ({ status: 401, json: { error: "bad key" } }) });
    await expect(composio("ONE_DRIVE_GET_ROOT", {})).rejects.toThrow(/HTTP 401/);
  });

  test("refuses to run without an API key", async () => {
    delete process.env.COMPOSIO_API_KEY;
    mockComposio({});
    await expect(composio("ONE_DRIVE_GET_ROOT", {})).rejects.toThrow(/COMPOSIO_API_KEY/);
    expect(calls).toHaveLength(0);
  });
});

describe("resolveItem()", () => {
  const notFound = () => ({ json: { successful: false, error: "itemNotFound: The resource could not be found." } });

  test("looks up IDs directly", async () => {
    mockComposio({ ONE_DRIVE_GET_ITEM: (a) => ({ json: { successful: true, data: { id: a.item_id, name: "x" } } }) });
    expect((await resolveItem("D4648F06C91D9D3D!54927", false)).id).toBe("D4648F06C91D9D3D!54927");
    expect(executed()).toEqual(["ONE_DRIVE_GET_ITEM"]);
  });

  test("looks up paths without a leading slash", async () => {
    mockComposio({ ONE_DRIVE_GET_ITEM_BY_PATH: (a) => ({ json: { successful: true, data: { id: "1", name: a.item_path } } }) });
    expect((await resolveItem("/Documents/Report.docx", true)).name).toBe("Documents/Report.docx");
  });

  test("falls back to an exact-name search for a bare name", async () => {
    mockComposio({
      ONE_DRIVE_GET_ITEM_BY_PATH: notFound,
      ONE_DRIVE_SEARCH_ITEMS: () => ({
        json: { successful: true, data: { value: [{ id: "a", name: "Budget.xlsx" }, { id: "b", name: "Budget old.xlsx" }] } },
      }),
    });
    expect((await resolveItem("budget.xlsx", true)).id).toBe("a");
  });

  test("refuses to pick between several matches", async () => {
    mockComposio({
      ONE_DRIVE_GET_ITEM_BY_PATH: notFound,
      ONE_DRIVE_SEARCH_ITEMS: () => ({
        json: {
          successful: true,
          data: {
            value: [
              { id: "a", name: "Notes.txt", parentReference: { path: "/drive/root:/A" } },
              { id: "b", name: "Notes.txt", parentReference: { path: "/drive/root:/B" } },
            ],
          },
        },
      }),
    });
    await expect(resolveItem("Notes.txt", true)).rejects.toThrow(/A\/Notes.txt, B\/Notes.txt/);
  });

  test("never searches by name when strict (delete)", async () => {
    mockComposio({ ONE_DRIVE_GET_ITEM_BY_PATH: notFound });
    await expect(resolveItem("Notes.txt", false)).rejects.toThrow(/itemNotFound/);
    expect(executed()).toEqual(["ONE_DRIVE_GET_ITEM_BY_PATH"]);
  });

  test("rejects the root folder", async () => {
    mockComposio({});
    await expect(resolveItem("My files", true)).rejects.toThrow(/root folder/);
  });
});

describe("downloadBytes()", () => {
  const item = { id: "D4648F06C91D9D3D!1", name: "Q3 Report.doc" };

  test("downloads the original file from Composio's staged URL", async () => {
    mockComposio({
      ONE_DRIVE_DOWNLOAD_FILE: (a) => ({ json: { successful: true, data: { file: { s3url: `https://files.example/${a.item_id}` } } } }),
    });
    expect((await downloadBytes(item)).toString()).toBe("bytes of https://files.example/D4648F06C91D9D3D!1");
  });

  test("asks OneDrive to convert to PDF when asPdf is set", async () => {
    mockComposio({
      ONE_DRIVE_DOWNLOAD_ITEM_AS_FORMAT: (a) => ({ json: { successful: true, data: { file: { s3url: `https://files.example/${a.format}/${a.file_name}` } } } }),
    });
    expect((await downloadBytes(item, { asPdf: true })).toString()).toBe("bytes of https://files.example/pdf/Q3 Report.pdf");
    expect(executed()).toEqual(["ONE_DRIVE_DOWNLOAD_ITEM_AS_FORMAT"]);
  });

  test("fails loudly when no link comes back", async () => {
    mockComposio({ ONE_DRIVE_DOWNLOAD_FILE: () => ({ json: { successful: true, data: { name: "x" } } }) });
    await expect(downloadBytes(item)).rejects.toThrow(/didn't return a download link/);
  });

  test("names the storage host when the fetch fails", async () => {
    mockComposio({ ONE_DRIVE_DOWNLOAD_FILE: () => ({ json: { successful: true, data: { s3url: "https://files.example/missing" } } }) });
    await expect(downloadBytes(item)).rejects.toThrow(/files\.example: HTTP 403/);
  });
});
