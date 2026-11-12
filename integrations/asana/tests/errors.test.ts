import { expect, test } from "bun:test";
import { ComposioError, describeError } from "../server.ts";

const linkStatus = (status: string) => async () => status;
const notConnected = new ComposioError("No connected account", "composio", 404, "ActionExecute_ConnectedAccountNotFound");

test("a missing link says so and hands the user a sign-in link (issue #28: no dashboard, no curl)", async () => {
  const out = await describeError(notConnected, linkStatus("NONE"), "voiceos-1", async () => "https://connect.example/abc");
  expect(out).toEqual({
    error: "Asana isn't connected yet. Open Connect Asana on this card to sign in.",
    reconnect: true,
    connect_url: "https://connect.example/abc",
  });
});

test("without a link, the message points to a Composio menu that exists (Auth Configs), not 'Connected accounts'", async () => {
  const out = await describeError(notConnected, linkStatus("NONE"), "voiceos-1", async () => { throw new Error("no auth config"); });
  expect(out.error).toBe(
    'Asana isn\'t connected yet. Ask whoever set up this integration to add an Asana auth config in platform.composio.dev → Auth Configs (OAuth2, Composio managed). Composio user: "voiceos-1".',
  );
  expect(out.error).not.toContain("Connected accounts");
  expect(out).not.toHaveProperty("connect_url");
});

test("errors that reconnecting won't fix never ask Composio for a link", async () => {
  let asked = false;
  const badInput = new ComposioError("projects: Not a Long", "tool", 400);
  await describeError(badInput, linkStatus("ACTIVE"), "u", async () => ((asked = true), "x"));
  expect(asked).toBe(false);
});

test("an expired link and a revoked token are told apart", async () => {
  expect((await describeError(notConnected, linkStatus("EXPIRED"), "u")).error).toStartWith("The Asana connection has expired.");
  const revoked = new ComposioError("Not Authorized", "tool", 401);
  expect((await describeError(revoked, linkStatus("ACTIVE"), "u")).error).toStartWith("Asana access was revoked or disabled.");
});

test("a rejected Composio API key points at the key settings, not at reconnecting", async () => {
  const badKey = new ComposioError("Invalid API key", "composio", 401, "APIKey_InvalidAPIKey");
  expect(await describeError(badKey, linkStatus("ACTIVE"), "u")).toEqual({
    error: "The Composio API key was rejected — check the key in this integration's Setup page or .env.",
    reconnect: false,
  });
});

test("a timeout warns that the write may already have gone through", async () => {
  const timeout = Object.assign(new Error("timed out"), { name: "TimeoutError" });
  expect((await describeError(timeout, linkStatus("ACTIVE"), "u")).error).toContain("may still have gone through");
});
