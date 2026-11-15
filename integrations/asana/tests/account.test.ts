import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { ComposioError, asanaDisconnect, connectAccount, connectionStatus, disconnectAccount } from "../server.ts";
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

/** What the model reads, and the card's HTML. */
const split = ({ _voiceos_glance, ...forModel }: any) => ({ forModel, card: JSON.stringify(_voiceos_glance ?? "") });

test("disconnect revokes Asana's token, then deletes every Asana connection of this install", async () => {
  const a = api([{ id: "ca_1" }, { id: "ca_2" }]);
  expect(await asanaDisconnect(a.request, "u1")).toEqual({ removed: 2, revokedAtAsana: true });
  expect(a.calls).toEqual([
    "GET /connected_accounts?toolkit_slugs=asana&user_ids=u1",
    "POST /connected_accounts/ca_1/revoke",
    "DELETE /connected_accounts/ca_1",
    "POST /connected_accounts/ca_2/revoke",
    "DELETE /connected_accounts/ca_2",
  ]);
});

test("if Composio can't revoke at Asana, the connection is still deleted and the result says so", async () => {
  const a = api([{ id: "ca_1" }], { "POST /connected_accounts/ca_1/revoke": new ComposioError("cannot revoke", "composio", 400) });
  expect(await asanaDisconnect(a.request, "u1")).toEqual({ removed: 1, revokedAtAsana: false });
  expect(a.calls).toContain("DELETE /connected_accounts/ca_1");
});

test("any other revoke failure stops before deleting", async () => {
  const a = api([{ id: "ca_1" }], { "POST /connected_accounts/ca_1/revoke": new ComposioError("down", "composio", 500) });
  await expect(asanaDisconnect(a.request, "u1")).rejects.toThrow("down");
  expect(a.calls).not.toContain("DELETE /connected_accounts/ca_1");
});

test("connect_account puts the sign-in link on the card only; the model is told to point at it", async () => {
  const { forModel, card } = split(await connectAccount(async () => "NONE", async () => "https://connect.example/abc"));
  expect(forModel).toEqual({ connected: false, message: "Open Connect Asana on this card to sign in." });
  expect(card).toContain("https://connect.example/abc");
  expect(card).toContain("Connect Asana");
});

test("connect_account on a working connection says so and makes no new sign-in", async () => {
  const asked: string[] = [];
  const { forModel, card } = split(await connectAccount(async () => "ACTIVE", async () => (asked.push("link"), "https://x")));
  expect(forModel).toEqual({ connected: true, message: "Asana is connected." });
  expect(card).toContain("Connected");
  expect(asked).toEqual([]);
});

test("connection_status reports the state and has no sign-in link", async () => {
  const { forModel, card } = split(await connectionStatus(async () => "EXPIRED"));
  expect(forModel).toMatchObject({ connected: false, status: "EXPIRED" });
  expect(forModel.message).toContain("expired");
  expect(card).toContain("Not connected");
  expect(card).not.toContain("Connect Asana");
});

test("disconnect_account says what happened, including when there was nothing to disconnect", async () => {
  expect(split(await disconnectAccount(async () => ({ removed: 1, revokedAtAsana: true }))).forModel.message)
    .toBe("Asana is disconnected. Nothing in Asana was changed.");
  expect(split(await disconnectAccount(async () => ({ removed: 1, revokedAtAsana: false }))).forModel.message)
    .toContain("Apps in your Asana settings");
  expect(split(await disconnectAccount(async () => ({ removed: 0, revokedAtAsana: true }))).forModel.message)
    .toBe("Asana wasn't connected.");
});

test("disconnect asks first with a plain card that has Cancel and Disconnect; connect and status don't ask", () => {
  const manifest = JSON.parse(readFileSync(new URL("../voiceos.integration.json", import.meta.url), "utf8"));
  const tool = (name: string) => manifest.tools.find((t: any) => t.name === name);
  const root = tool("disconnect_account").confirmation.root;
  expect(root.type).toBe("card");
  expect(root.footer[0].items.map((i: any) => i.role)).toEqual(["cancel", "confirm"]);
  expect(tool("connect_account").confirmation).toBeUndefined();
  expect(tool("connection_status").confirmation).toBeUndefined();
});
