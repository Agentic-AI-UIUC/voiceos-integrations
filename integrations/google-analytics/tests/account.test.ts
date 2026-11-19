import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ComposioError, createGa, createServer, gaDisconnect } from "../server.ts";
import type { ComposioRequest } from "../server.ts";

/** A fake Composio REST API that records calls; `fail` makes one call throw. */
function api(accounts: { id: string }[], fail: Record<string, ComposioError> = {}) {
  const calls: string[] = [];
  const request: ComposioRequest = async (method, path) => {
    const call = `${method} ${path}`;
    calls.push(call);
    if (fail[call]) throw fail[call];
    return method === "GET" ? { items: accounts } : {};
  };
  return { request, calls };
}

test("disconnect revokes Google's access, then deletes every Google Analytics connection of this install", async () => {
  const a = api([{ id: "ca_1" }, { id: "ca_2" }]);
  expect(await gaDisconnect(a.request, "u1")).toEqual({ removed: 2, revokedAtGoogle: true });
  expect(a.calls).toEqual([
    "GET /connected_accounts?toolkit_slugs=google_analytics&user_ids=u1",
    "POST /connected_accounts/ca_1/revoke",
    "DELETE /connected_accounts/ca_1",
    "POST /connected_accounts/ca_2/revoke",
    "DELETE /connected_accounts/ca_2",
  ]);
});

test("if Composio can't revoke at Google, the connection is still deleted and the result says so", async () => {
  const a = api([{ id: "ca_1" }], { "POST /connected_accounts/ca_1/revoke": new ComposioError("cannot revoke", "composio", 400) });
  expect(await gaDisconnect(a.request, "u1")).toEqual({ removed: 1, revokedAtGoogle: false });
  expect(a.calls).toContain("DELETE /connected_accounts/ca_1");
});

test("any other revoke failure stops before deleting", async () => {
  const a = api([{ id: "ca_1" }], { "POST /connected_accounts/ca_1/revoke": new ComposioError("down", "composio", 500) });
  await expect(gaDisconnect(a.request, "u1")).rejects.toThrow("down");
  expect(a.calls).not.toContain("DELETE /connected_accounts/ca_1");
});

/** The real server with fake account functions; `asked` records whether a sign-in link was requested. */
async function connect(status: string, removed = 1) {
  const asked: string[] = [];
  const server = createServer(
    createGa(async () => ({}), "1"),
    async () => status,
    async () => (asked.push("link"), "https://connect.example/abc"),
    async () => ({ removed, revokedAtGoogle: true }),
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  const call = async (name: string) => {
    const res: any = await client.callTool({ name, arguments: {} });
    const { _voiceos_glance, ...forModel } = JSON.parse(res.content[0].text);
    return { forModel, card: JSON.stringify(_voiceos_glance ?? "") };
  };
  return { call, asked };
}

test("connect_account puts the sign-in link on the card only; the model is told to point at it", async () => {
  const { call } = await connect("NONE");
  const { forModel, card } = await call("connect_account");
  expect(forModel).toEqual({ connected: false, message: "Open Connect Google Analytics on this card to sign in to Google." });
  expect(card).toContain("https://connect.example/abc");
});

test("connect_account on a working connection says so and makes no new sign-in", async () => {
  const { call, asked } = await connect("ACTIVE");
  expect((await call("connect_account")).forModel).toEqual({ connected: true, message: "Google Analytics is connected." });
  expect(asked).toEqual([]);
});

test("connection_status reports the state and never starts a sign-in", async () => {
  const { call, asked } = await connect("EXPIRED");
  const { forModel, card } = await call("connection_status");
  expect(forModel).toMatchObject({ connected: false, status: "EXPIRED" });
  expect(forModel.message).toContain("expired");
  expect(card).toContain("Not connected");
  expect(asked).toEqual([]);
});

test("disconnect_account says what happened, including when there was nothing to disconnect", async () => {
  expect((await (await connect("ACTIVE", 1)).call("disconnect_account")).forModel.message).toStartWith("Google Analytics is disconnected.");
  expect((await (await connect("NONE", 0)).call("disconnect_account")).forModel.message).toBe("Google Analytics wasn't connected.");
});

test("only Disconnect asks first, with a plain card that has Cancel and Disconnect", () => {
  const manifest = JSON.parse(readFileSync(new URL("../voiceos.integration.json", import.meta.url), "utf8"));
  const confirmed = manifest.tools.filter((t: any) => t.confirmation);
  expect(confirmed.map((t: any) => t.name)).toEqual(["disconnect_account"]);
  const root = confirmed[0].confirmation.root;
  expect(root.type).toBe("card");
  expect(root.footer[0].items.map((i: any) => i.role)).toEqual(["cancel", "confirm"]);
});
