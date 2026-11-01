/**
 * Ask the real VoiceOS Agent Mode one thing and record what happened: the
 * answer it wrote, the tools it used, this integration's tool calls from the
 * audit log, and a screenshot of the notch.
 *
 *   bun scripts/agent-qa.ts "<prompt>" [--name=slug] [--out=docs/qa/<date>]
 *   bun scripts/agent-qa.ts --click     # click the confirm button on the card showing now
 *
 * Needs VoiceOS running with its debugging port on 9333 (it types into the
 * notch the way a person would). Writes only what the prompt asks for.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const prompt = args.find((a) => !a.startsWith("--"));
const click = args.includes("--click");
const out = join(ROOT, flag("out") ?? `docs/qa/${new Date().toISOString().slice(0, 10)}`);
const name = flag("name") ?? (click ? "click" : (prompt ?? "turn").toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40));
mkdirSync(out, { recursive: true });

async function page(hash: string) {
  const targets: any[] = await (await fetch("http://127.0.0.1:9333/json")).json();
  const t = targets.find((x) => x.type === "page" && x.url.includes(`index.html${hash}`));
  if (!t) throw new Error(`VoiceOS page ${hash || "main"} not found on port 9333.`);
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const send = (method: string, params: object) =>
    new Promise<any>((resolve) => {
      const n = ++id;
      const onMessage = (e: MessageEvent) => {
        const m = JSON.parse(String(e.data));
        if (m.id === n) {
          ws.removeEventListener("message", onMessage);
          resolve(m.result);
        }
      };
      ws.addEventListener("message", onMessage);
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  const evaluate = async (expression: string) => (await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }))?.result?.value;
  return { evaluate, send, close: () => ws.close() };
}

const notch = await page("#/agent-notch");
const main = await page("");
const auditPath = join(ROOT, ".state/audit.jsonl");
const auditBefore = readFileSync(auditPath, "utf8").split("\n").filter(Boolean).length;
const started = Date.now();

if (click) {
  // The host draws the card's confirm button itself (outside the card's iframe).
  const clicked = await notch.evaluate(`(() => {
    // The notch may have collapsed while the card waits (the button is then visibility:hidden); click() still sends the approval.
    const buttons = [...document.querySelectorAll("button")].filter((b) => /^(Post comment|Create issue|Update issue|Submit review)$/i.test((b.textContent || "").trim()));
    if (!buttons.length) return null;
    buttons[0].click();
    return buttons[0].textContent.trim();
  })()`);
  if (!clicked) throw new Error("No confirm button is showing in the notch.");
  console.error(`clicked "${clicked}"`);
} else {
  if (!prompt) throw new Error('Usage: bun scripts/agent-qa.ts "<prompt>"');
  const sent = await notch.evaluate(`(() => {
    const ta = document.querySelector("textarea");
    if (!ta) return false;
    ta.focus();
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(ta, ${JSON.stringify(prompt)});
    ta.dispatchEvent(new Event("input", { bubbles: true }));
    const k = { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true };
    ta.dispatchEvent(new KeyboardEvent("keydown", k));
    return true;
  })()`);
  if (!sent) throw new Error("The notch's text box isn't there.");
}

// Wait for the turn to settle: done, failed, or waiting on a confirmation card.
// The notch closes a few seconds after answering, so keep the latest frame that shows a card.
let turn: any;
let cardShot: string | undefined;
const grabCard = async () => {
  const showing = await notch.evaluate(`[...document.querySelectorAll("iframe")].some((f) => f.offsetHeight > 40)`);
  if (showing) cardShot = (await notch.send("Page.captureScreenshot", { format: "png" })).data;
};
for (let waited = 0; waited < 120_000; waited += 1500) {
  await new Promise((r) => setTimeout(r, 1500));
  await grabCard();
  const recent: any[] = Object.values((await main.evaluate("window.api.agentHistory.getRecent()")) ?? {});
  // A new prompt starts a turn; a "yes" or a click continues the turn that is waiting on a card.
  const touched = recent.filter((t) => Date.parse(t.updated_at) >= started - 2000);
  turn = touched.find((t) => t.transcript === prompt && Date.parse(t.created_at) >= started - 2000)
    ?? touched.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
  if (turn && (turn.pending_confirmation || turn.has_live_confirmation || !/running|progress|pending|active|thinking/i.test(String(turn.status)))) {
    await new Promise((r) => setTimeout(r, 1200)); // let the notch finish drawing
    await grabCard();
    const again: any[] = Object.values((await main.evaluate("window.api.agentHistory.getRecent()")) ?? {});
    turn = again.find((t) => t.id === turn.id) ?? turn;
    break;
  }
}

const audit = readFileSync(auditPath, "utf8").split("\n").filter(Boolean).slice(auditBefore).map((l) => JSON.parse(l));
const png = join(out, `${name}.png`);
writeFileSync(png, Buffer.from(cardShot ?? (await notch.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
const record = {
  at: new Date(started).toISOString(),
  prompt: click ? "(clicked the card's confirm button)" : prompt,
  seconds: Math.round((Date.now() - started) / 100) / 10,
  status: turn?.status ?? "no turn found",
  answer: turn?.response_text ?? null,
  tools_used: turn?.tool_names ?? [],
  pending_confirmation: turn?.pending_confirmation ?? null,
  github_calls: audit.map((a) => `${a.tool ?? a.event}:${a.outcome ?? ""}${a.ms !== undefined ? ` ${a.ms}ms` : ""}`),
  screenshot: png,
};
appendFileSync(join(out, "turns.jsonl"), JSON.stringify(record) + "\n");
console.log(JSON.stringify(record, null, 2));
notch.close();
main.close();
