import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ComposioError, createGa, createServer } from "../server.ts";

const manifest = JSON.parse(readFileSync(new URL("../voiceos.integration.json", import.meta.url), "utf8"));

/** A client connected to the real server, backed by a fake Composio `execute`. */
async function connect(execute: (slug: string, args: any) => Promise<any> = async () => ({})) {
  const server = createServer(createGa(execute, "1"), async () => "ACTIVE");
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  return client;
}

test("the manifest and the server declare the same tools with the same input schemas", async () => {
  const { tools } = await (await connect()).listTools();
  const fromServer = Object.fromEntries(tools.map((t) => [t.name, t.inputSchema]));
  const fromManifest = Object.fromEntries(manifest.tools.map((t: any) => [t.name, t.inputSchema]));
  expect(fromManifest).toEqual(fromServer);
});

test("only the three approved tools exist, and none has a confirmation card (all read-only)", () => {
  expect(manifest.tools.map((t: any) => t.name)).toEqual(["run_report", "run_realtime_report", "get_metadata"]);
  expect(manifest.tools.filter((t: any) => t.confirmation)).toEqual([]);
});

test("Actions panel descriptions are short enough for two lines", () => {
  for (const t of manifest.tools) expect(t.description.length).toBeLessThanOrEqual(80);
});

test("the network permission lists only the domain the code calls", () => {
  expect(manifest.permissions).toEqual([{ kind: "network", domains: ["backend.composio.dev"] }]);
});

test("a tool call returns the query's JSON; a failure comes back as plain words with isError", async () => {
  const ok = await connect(async () => ({ metricHeaders: [{ name: "activeUsers" }], rowCount: 0, rows: [] }));
  const res: any = await ok.callTool({ name: "run_realtime_report", arguments: {} });
  expect(JSON.parse(res.content[0].text)).toMatchObject({ property_id: "1", row_count: 0 });

  const denied = await connect(async () => { throw new ComposioError("no access", "tool", 403); });
  const err: any = await denied.callTool({ name: "run_report", arguments: { metrics: ["sessions"] } });
  expect(err.isError).toBe(true);
  expect(JSON.parse(err.content[0].text).error).toStartWith("The connected Google account can't access this GA4 property.");
});

test("every Studio preview sample passes the real input schemas (Studio calls the tools with them)", async () => {
  const meta = JSON.parse(readFileSync(new URL("../studio-meta.json", import.meta.url), "utf8"));
  const client = await connect(async () => ({ metricHeaders: [], rows: [], rowCount: 0 }));
  for (const t of meta.preview.toolPreviews) {
    for (const args of [t.sampleArgs, ...t.stressCases.map((c: any) => c.sampleArgs)]) {
      const res: any = await client.callTool({ name: t.tool, arguments: args ?? {} });
      expect(res.isError ? res.content[0].text : "ok").not.toMatch(/validation|invalid_type/i);
    }
  }
});

test("a reconnect link goes only on the card: the model gets reconnect: true, never the link", async () => {
  const server = createServer(
    createGa(async () => { throw new ComposioError("revoked", "tool", 401); }, "1"),
    async () => "ACTIVE",
    async () => "https://connect.example/abc",
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "test", version: "1" });
  await client.connect(clientSide);
  const res: any = await client.callTool({ name: "run_realtime_report", arguments: {} });
  const { _voiceos_glance, ...forModel } = JSON.parse(res.content[0].text);
  expect(forModel).toEqual({ error: "Google Analytics access was revoked. Open the reconnect link on this card to sign in to Google.", reconnect: true });
  expect(JSON.stringify(_voiceos_glance)).toContain("https://connect.example/abc");
});
