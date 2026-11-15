import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync(new URL("../voiceos.integration.json", import.meta.url), "utf8"));
const tool = (name: string) => manifest.tools.find((t: any) => t.name === name);

/** Every block in a confirmation view, depth first. */
function blocks(node: any): any[] {
  if (!node || typeof node !== "object") return [];
  return [node, ...[...(node.children ?? []), ...(node.footer ?? [])].flatMap(blocks)];
}

// VoiceOS draws only a floating Confirm on "widget" confirmations, with no Cancel (issue #34),
// so the cards without dynamic pickers use "card" confirmations, which get a real Cancel.
const CARD_CONFIRMATIONS = ["delete_project", "add_comment", "complete_task"];

test.each(CARD_CONFIRMATIONS)("%s confirms with a card that has exactly one Cancel and one Confirm", (name) => {
  const root = tool(name).confirmation.root;
  expect(root.type).toBe("card");
  const roles = blocks(root).filter((b) => b.type === "actions").flatMap((b) => b.items.map((i: any) => i.role));
  expect(roles.sort()).toEqual(["cancel", "confirm"]);
});

test.each(CARD_CONFIRMATIONS)("every {{binding}} on the %s card is one of the tool's arguments", (name) => {
  const t = tool(name);
  const used = [...JSON.stringify(t.confirmation).matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
  expect(used.length).toBeGreaterThan(0);
  for (const arg of used) expect(Object.keys(t.inputSchema.properties)).toContain(arg);
});

test("the delete button is the danger color, and the card says the deletion can't be undone", () => {
  const root = tool("delete_project").confirmation.root;
  const confirm = blocks(root).flatMap((b) => b.items ?? []).find((i: any) => i.role === "confirm");
  expect(confirm.color).toBe("danger");
  expect(JSON.stringify(root)).toContain("can't be undone");
});

test.each(CARD_CONFIRMATIONS)("the %s card title has no {{binding}}: VoiceOS shows card titles as written", (name) => {
  expect(tool(name).confirmation.root.title).not.toMatch(/\{\{/);
});
