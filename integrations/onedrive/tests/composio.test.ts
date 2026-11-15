import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import "./no-connect.ts";
import { COMPOSIO_TOOLKIT_VERSION, composio, downloadBytes, findItems, linkScope, resetAccountCache, resolveItem, runWithBudget, stageForComposio } from "../server.ts";

type Call = { url: string; body: any };
let calls: Call[] = [];
const realFetch = globalThis.fetch;

const oneDrive = (id: string, user_id: string, extra: Record<string, unknown> = {}) => ({
  id, user_id, status: "ACTIVE", toolkit: { slug: "one_drive" }, ...extra,
});
/** Every connected account in the mocked Composio project, across all users. */
let projectAccounts: any[] = [];

/** Answers connected-account lookups the way Composio does: by ID, or filtered by `user_ids`. */
function accountsReply(url: string): Response {
  const u = new URL(url);
  const byId = u.pathname.match(/\/connected_accounts\/([^/]+)$/);
  if (byId) {
    const acc = projectAccounts.find((a) => a.id === decodeURIComponent(byId[1]));
    return acc ? Response.json(acc) : Response.json({ error: "not found" }, { status: 404 });
  }
  const users = u.searchParams.get("user_ids")?.split(",");
  return Response.json({ items: projectAccounts.filter((a) => !users || users.includes(a.user_id)) });
}

/** Routes each Composio tool slug to a canned { status, json } reply. */
function mockComposio(routes: Record<string, (args: any) => { status?: number; json: any }>) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (url.startsWith("https://files.example/")) {
      return url.endsWith("/missing") ? new Response("gone", { status: 403 }) : new Response(`bytes of ${url}`);
    }
    if (url.includes("/connected_accounts")) return accountsReply(url);
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
  projectAccounts = [oneDrive("ca_mine", "u1"), oneDrive("ca_theirs", "u2")];
  process.env.COMPOSIO_API_KEY = "ak_test_key";
  process.env.COMPOSIO_USER_ID = "u1";
  delete process.env.COMPOSIO_CONNECTED_ACCOUNT_ID;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const root = { ONE_DRIVE_GET_ROOT: () => ({ json: { successful: true, data: {} } }) };

describe("composio()", () => {
  test("sends the user's account and the pinned toolkit version, and returns unwrapped data", async () => {
    mockComposio({ ONE_DRIVE_GET_ROOT: () => ({ json: { successful: true, data: { response_data: { id: "root" } } } }) });
    expect(await composio("ONE_DRIVE_GET_ROOT", {})).toEqual({ id: "root" });
    const exec = calls.find((c) => c.url.includes("/tools/execute/"))!;
    expect(exec.body).toMatchObject({ user_id: "u1", connected_account_id: "ca_mine", arguments: {} });
    expect(exec.body.version).toBe(COMPOSIO_TOOLKIT_VERSION);
    expect(COMPOSIO_TOOLKIT_VERSION).toMatch(/^\d{8}_\d{2}$/);
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

describe("connected account", () => {
  test("auto-detect only considers the configured user's accounts", async () => {
    mockComposio(root);
    await composio("ONE_DRIVE_GET_ROOT", {});
    const lookup = new URL(calls.find((c) => c.url.includes("/connected_accounts"))!.url);
    expect(lookup.searchParams.get("user_ids")).toBe("u1");
    expect(calls.at(-1)!.body.connected_account_id).toBe("ca_mine");
  });

  test("ignores another user's account even if the lookup returns it", async () => {
    mockComposio(root);
    const mocked = globalThis.fetch;
    globalThis.fetch = ((input: any, init?: any) =>
      String(input).includes("/connected_accounts")
        ? Promise.resolve(Response.json({ items: [oneDrive("ca_theirs", "u2")] }))
        : mocked(input, init)) as typeof fetch;
    await expect(composio("ONE_DRIVE_GET_ROOT", {})).rejects.toThrow(/No active OneDrive connection for Composio user "u1"/);
    expect(executed()).toEqual([]);
  });

  test("refuses when the user has no OneDrive connection", async () => {
    process.env.COMPOSIO_USER_ID = "nobody";
    mockComposio(root);
    await expect(composio("ONE_DRIVE_GET_ROOT", {})).rejects.toThrow(/No active OneDrive connection for Composio user "nobody"/);
    expect(executed()).toEqual([]);
  });

  test("refuses to pick between several of the user's connections", async () => {
    projectAccounts.push(oneDrive("ca_mine_2", "u1"));
    mockComposio(root);
    await expect(composio("ONE_DRIVE_GET_ROOT", {})).rejects.toThrow(/2 active OneDrive connections \(ca_mine, ca_mine_2\)/);
    expect(executed()).toEqual([]);
  });

  test("skips inactive, disabled, and non-OneDrive accounts", async () => {
    projectAccounts.push(
      oneDrive("ca_expired", "u1", { status: "EXPIRED" }),
      oneDrive("ca_off", "u1", { is_disabled: true }),
      oneDrive("ca_outlook", "u1", { toolkit: { slug: "outlook" } }),
    );
    mockComposio(root);
    await composio("ONE_DRIVE_GET_ROOT", {});
    expect(calls.at(-1)!.body.connected_account_id).toBe("ca_mine");
  });

  test("uses a configured account after checking it belongs to the user", async () => {
    process.env.COMPOSIO_CONNECTED_ACCOUNT_ID = "ca_mine";
    mockComposio(root);
    await composio("ONE_DRIVE_GET_ROOT", {});
    expect(calls[0].url).toEndWith("/connected_accounts/ca_mine");
    expect(calls.at(-1)!.body.connected_account_id).toBe("ca_mine");
  });

  test("refuses a configured account that belongs to another user", async () => {
    process.env.COMPOSIO_CONNECTED_ACCOUNT_ID = "ca_theirs";
    mockComposio(root);
    await expect(composio("ONE_DRIVE_GET_ROOT", {})).rejects.toThrow(/belongs to a different Composio user than "u1"/);
    expect(executed()).toEqual([]);
  });

  test("refuses a configured account that isn't OneDrive or doesn't exist", async () => {
    projectAccounts.push(oneDrive("ca_outlook", "u1", { toolkit: { slug: "outlook" } }));
    process.env.COMPOSIO_CONNECTED_ACCOUNT_ID = "ca_outlook";
    mockComposio(root);
    await expect(composio("ONE_DRIVE_GET_ROOT", {})).rejects.toThrow(/isn't an active OneDrive connection/);
    resetAccountCache();
    process.env.COMPOSIO_CONNECTED_ACCOUNT_ID = "ca_missing";
    await expect(composio("ONE_DRIVE_GET_ROOT", {})).rejects.toThrow(/isn't in this Composio project/);
    expect(executed()).toEqual([]);
  });

  test("refuses rather than guessing when the lookup fails", async () => {
    globalThis.fetch = (async (input: any) => {
      calls.push({ url: String(input), body: undefined });
      return String(input).includes("/connected_accounts") ? new Response("down", { status: 500 }) : Response.json({ successful: true, data: {} });
    }) as typeof fetch;
    await expect(composio("ONE_DRIVE_GET_ROOT", {})).rejects.toThrow(/connected-account lookup failed \(HTTP 500\)/);
    expect(executed()).toEqual([]);
  });
});

describe("write outcome", () => {
  const write = { write: 'created the folder "VoiceOS Test" in /' };

  test("a write whose answer never arrives is reported as unknown, not failed", async () => {
    globalThis.fetch = ((input: any, init?: any) => {
      if (String(input).includes("/connected_accounts")) return Promise.resolve(accountsReply(String(input)));
      return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal.reason)));
    }) as typeof fetch;
    const err = await runWithBudget(1_500, () => composio("ONE_DRIVE_ONEDRIVE_CREATE_FOLDER", {}, write)).catch((e) => e);
    expect(err.message).toMatch(/Couldn't confirm whether OneDrive created the folder "VoiceOS Test" in \//);
    expect(err.message).toMatch(/Check OneDrive before trying again/);
    expect(err.message).not.toMatch(/Couldn't reach Composio/);
  });

  test("a gateway error on a write is unknown too", async () => {
    mockComposio({ ONE_DRIVE_ONEDRIVE_CREATE_FOLDER: () => ({ status: 504, json: { error: "Gateway Timeout" } }) });
    await expect(composio("ONE_DRIVE_ONEDRIVE_CREATE_FOLDER", {}, write)).rejects.toThrow(/may have gone through/);
  });

  test("a definite rejection on a write stays a plain error", async () => {
    mockComposio({ ONE_DRIVE_ONEDRIVE_CREATE_FOLDER: () => ({ json: { successful: false, error: "nameAlreadyExists" } }) });
    await expect(composio("ONE_DRIVE_ONEDRIVE_CREATE_FOLDER", {}, write)).rejects.toThrow(/^nameAlreadyExists$/);
  });
});

describe("linkScope()", () => {
  test("is always explicit, with blank meaning anyone", () => {
    expect(linkScope(undefined)).toBe("anonymous");
    expect(linkScope("")).toBe("anonymous");
    expect(linkScope("anyone")).toBe("anonymous");
    expect(linkScope("Organization")).toBe("organization");
    expect(() => linkScope("everyone at work")).toThrow(/Unknown link audience/);
  });
});

describe("resolveItem()", () => {
  const notFound = () => ({ json: { successful: false, error: "itemNotFound: The resource could not be found." } });

  test("looks up IDs directly", async () => {
    mockComposio({ ONE_DRIVE_GET_ITEM: (a) => ({ json: { successful: true, data: { id: a.item_id, name: "x" } } }) });
    expect((await resolveItem("0123456789ABCDEF!54927", false)).id).toBe("0123456789ABCDEF!54927");
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

  const searchReturns = (...items: any[]) => ({
    ONE_DRIVE_GET_ITEM_BY_PATH: notFound,
    ONE_DRIVE_SEARCH_ITEMS: () => ({ json: { successful: true, data: { value: items } } }),
  });
  const at = (dir: string, name: string, id = name) => ({ id, name, parentReference: { path: `/drive/root:${dir ? "/" + dir : ""}` } });

  test("matches a spoken name without its extension or with a type word", async () => {
    mockComposio(searchReturns(at("", "Getting started with OneDrive.pdf", "pdf"), at("", "Getting started notes.md", "md")));
    expect((await resolveItem("Getting started with OneDrive PDF", true)).id).toBe("pdf");
    expect((await resolveItem("getting started with onedrive", true)).id).toBe("pdf");
  });

  test("prefers an exact name over a looser match", async () => {
    mockComposio(searchReturns(at("", "Budget.xlsx", "exact"), at("", "Budget 2026.xlsx", "longer")));
    expect((await resolveItem("Budget.xlsx", true)).id).toBe("exact");
  });

  test("accepts a unique name prefix but refuses an ambiguous one", async () => {
    mockComposio(searchReturns(at("", "Quarterly review 2026.pptx", "q"), at("", "Roadmap.pptx", "r")));
    expect((await resolveItem("quarterly", true)).id).toBe("q");
    mockComposio(searchReturns(at("A", "Plan v1.docx"), at("B", "Plan v2.docx")));
    await expect(resolveItem("plan", true)).rejects.toThrow(/2 OneDrive items match "plan" \(A\/Plan v1.docx, B\/Plan v2.docx\)/);
  });

  test("keeps a named folder when matching loosely", async () => {
    mockComposio(searchReturns(at("Other", "notes.md", "other"), at("VoiceOS Test", "notes.md", "mine")));
    expect((await resolveItem("VoiceOS Test/notes", true)).id).toBe("mine");
  });

  test("reports no match instead of guessing", async () => {
    mockComposio(searchReturns(at("", "Roadmap.pptx")));
    await expect(resolveItem("budget", true)).rejects.toThrow(/No OneDrive item matches "budget"/);
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
  const item = { id: "0123456789ABCDEF!1", name: "Q3 Report.doc" };

  test("downloads the original file from Composio's staged URL", async () => {
    mockComposio({
      ONE_DRIVE_DOWNLOAD_FILE: (a) => ({ json: { successful: true, data: { file: { s3url: `https://files.example/${a.item_id}` } } } }),
    });
    expect((await downloadBytes(item)).toString()).toBe("bytes of https://files.example/0123456789ABCDEF!1");
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

describe("downloadBytes() response shapes", () => {
  test("handles a message-only `data` with the file alongside it", async () => {
    mockComposio({
      ONE_DRIVE_DOWNLOAD_FILE: () => ({
        json: { successful: true, data: { data: "File downloaded successfully", file: { s3url: "https://files.example/sibling" } } },
      }),
    });
    expect((await downloadBytes({ id: "x", name: "a.txt" })).toString()).toBe("bytes of https://files.example/sibling");
  });

  test("falls back to Graph's pre-authenticated link", async () => {
    mockComposio({ ONE_DRIVE_DOWNLOAD_FILE: () => ({ json: { successful: true, data: "Downloaded" } }) });
    const item = { id: "x", name: "a.txt", "@microsoft.graph.downloadUrl": "https://files.example/graph" };
    expect((await downloadBytes(item)).toString()).toBe("bytes of https://files.example/graph");
  });

  test("reports the response shape, not its values, when there is no link", async () => {
    mockComposio({ ONE_DRIVE_DOWNLOAD_FILE: () => ({ json: { successful: true, data: { status: "ok", meta: { size: 4 } } } }) });
    await expect(downloadBytes({ id: "x", name: "a.txt" })).rejects.toThrow("Response shape: {status: string, meta: {size: number}}");
  });
});

describe("time budget", () => {
  /** A Composio that never answers, so only the abort signal can end the request. */
  function hangingComposio() {
    globalThis.fetch = ((input: any, init?: any) => {
      if (String(input).includes("/connected_accounts")) return Promise.resolve(accountsReply(String(input)));
      return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal.reason)));
    }) as typeof fetch;
  }

  test("caps a hanging request at the time left in the tool's budget", async () => {
    hangingComposio();
    const started = Date.now();
    await expect(runWithBudget(1_500, () => composio("ONE_DRIVE_GET_ROOT", {}))).rejects.toThrow(/Couldn't reach Composio/);
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  test("refuses to start a request once the budget is spent", async () => {
    hangingComposio();
    await expect(runWithBudget(500, () => composio("ONE_DRIVE_GET_ROOT", {}))).rejects.toThrow(/taking too long/);
  });
});

describe("findItems() when OneDrive's search index comes back empty", () => {
  const ROOT = { id: "R", name: "root", root: {}, folder: {}, parentReference: { driveId: "d1" } };
  const node = (id: string, name: string, parent: string, extra: Record<string, unknown> = {}) => ({ id, name, parentReference: { id: parent }, ...extra });
  const scanRoutes = (pages: any[][], search: any[] = []) => {
    let page = 0;
    return {
      ONE_DRIVE_SEARCH_ITEMS: () => ({ json: { successful: true, data: { value: search } } }),
      ONE_DRIVE_GET_ROOT: () => ({ json: { successful: true, data: ROOT } }),
      ONE_DRIVE_LIST_ALL_DRIVE_ITEMS: (a: any) => {
        if (!a.page_token) page = 0;
        const i = page++;
        expect(a.drive_id).toBe("d1");
        if (i > 0) expect(a.page_token).toBe(`t${i}`);
        const last = i === pages.length - 1;
        return { json: { successful: true, data: { items: pages[i], sync_complete: last, ...(last ? {} : { next_page_token: `t${i + 1}` }) } } };
      },
    };
  };

  test("returns search hits without scanning when the index has them", async () => {
    mockComposio(scanRoutes([], [{ id: "x", name: "Book 1.xlsx" }]));
    const r = await findItems("Book 1.xlsx", 10);
    expect(r).toMatchObject({ via: "search", items: [{ id: "x" }] });
    expect(executed()).toEqual(["ONE_DRIVE_SEARCH_ITEMS"]);
  });

  test("retries with the meaningful words, then scans every page by name with paths", async () => {
    mockComposio(scanRoutes([
      [ROOT, node("F", "Reading", "R", { folder: {} }), node("1", "Book 1.xlsx", "R")],
      [node("2", "book-club notes.md", "F"), node("3", "Budget.xlsx", "R"), node("4", "Book old.xlsx", "R", { deleted: {} })],
    ]));
    const r = await findItems("find a book", 10);
    expect(r.via).toBe("name_scan");
    expect(r.items.map((i: any) => i.id)).toEqual(["1", "2"]);
    expect(r.items[1].parentReference.path).toBe("/drive/root:/Reading");
    expect(executed()).toEqual(["ONE_DRIVE_SEARCH_ITEMS", "ONE_DRIVE_SEARCH_ITEMS", "ONE_DRIVE_GET_ROOT", "ONE_DRIVE_LIST_ALL_DRIVE_ITEMS", "ONE_DRIVE_LIST_ALL_DRIVE_ITEMS"]);
    const retry = calls.filter((c) => c.url.endsWith("ONE_DRIVE_SEARCH_ITEMS"))[1];
    expect(retry.body.arguments.q).toBe("book");
  });

  test("falls back to the names holding the most words", async () => {
    mockComposio(scanRoutes([[ROOT, node("1", "groceries.txt", "R"), node("2", "todo list.md", "R"), node("3", "Groceries list 2025.txt", "R")]]));
    expect((await findItems("groceries list", 10)).items.map((i: any) => i.id)).toEqual(["3"]);
    mockComposio(scanRoutes([[ROOT, node("1", "groceries.txt", "R"), node("2", "todo.md", "R")]]));
    expect((await findItems("find a groceries list", 10)).items.map((i: any) => i.id)).toEqual(["1"]);
  });

  test("resolveItem finds an exact name the index can't", async () => {
    mockComposio({ ONE_DRIVE_GET_ITEM_BY_PATH: () => ({ json: { successful: false, error: "itemNotFound: The resource could not be found." } }), ...scanRoutes([[ROOT, node("F", "School", "R", { folder: {} }), node("1", "Book 1.xlsx", "F"), node("2", "Book 10.xlsx", "F")]]) });
    expect((await resolveItem("Book 1.xlsx", true)).id).toBe("1");
    expect((await resolveItem("School/Book 1.xlsx", true)).id).toBe("1");
  });

  test("says both lookups failed when the scan errors", async () => {
    mockComposio({ ...scanRoutes([]), ONE_DRIVE_LIST_ALL_DRIVE_ITEMS: () => ({ json: { successful: false, error: "Forbidden drive" } }) });
    await expect(findItems("budget", 10)).rejects.toThrow(/search found nothing for "budget", and scanning the drive by name failed too: Forbidden drive/);
  });
});

describe("stageForComposio()", () => {
  test("requests a slot with the file's MD5, then PUTs the bytes", async () => {
    const seen: any[] = [];
    globalThis.fetch = (async (input: any, init?: any) => {
      seen.push({ url: String(input), method: init?.method, body: init?.body });
      if (String(input).endsWith("/files/upload/request")) return Response.json({ key: "k/1.pdf", new_presigned_url: "https://store.example/put", type: "new" });
      return new Response("", { status: 200 });
    }) as typeof fetch;
    expect(await stageForComposio("a.pdf", "application/pdf", Buffer.from("hello"))).toBe("k/1.pdf");
    expect(JSON.parse(seen[0].body)).toMatchObject({ toolkit_slug: "one_drive", tool_slug: "ONE_DRIVE_ONEDRIVE_UPLOAD_FILE", filename: "a.pdf", md5: "5d41402abc4b2a76b9719d911017c592" });
    expect(seen[1]).toMatchObject({ url: "https://store.example/put", method: "PUT" });
  });

  test("skips the PUT when Composio already has the bytes", async () => {
    let puts = 0;
    globalThis.fetch = (async (input: any, init?: any) => {
      if (init?.method === "PUT") puts++;
      return Response.json({ key: "k/1.pdf", new_presigned_url: "https://store.example/put", type: "existing" });
    }) as typeof fetch;
    expect(await stageForComposio("a.pdf", "application/pdf", Buffer.from("hello"))).toBe("k/1.pdf");
    expect(puts).toBe(0);
  });

  test("fails loudly when the storage PUT is refused", async () => {
    globalThis.fetch = (async (input: any, init?: any) =>
      init?.method === "PUT" ? new Response("no", { status: 403 }) : Response.json({ key: "k", new_presigned_url: "https://store.example/put", type: "new" })) as typeof fetch;
    await expect(stageForComposio("a.pdf", "application/pdf", Buffer.from("x"))).rejects.toThrow(/Couldn't send "a.pdf" to Composio's storage \(store.example\): HTTP 403/);
  });
});
