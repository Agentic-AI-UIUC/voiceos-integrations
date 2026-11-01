/**
 * Real-app QA for the error flicker (user, 2026-10-28): types prompts into
 * VoiceOS's notch the way a person would, one conversation per scenario, and
 * reads this integration's audit log for every turn.
 *
 * A turn flickers when a call returned an error card and a later call in the
 * same turn returned a result: the user saw an error that the right answer
 * replaced seconds later. VoiceOS shows exactly the card a result carries and
 * keeps the current one for a result without a card, so the audit log says
 * what the notch showed (`card: "none"` marks a failure without one).
 *
 *   bun scripts/agent-flicker-qa.ts <scenarios.json> [--only=name,name] [--out=docs/qa/<date>]
 *
 * A scenario is { "name": "...", "turns": ["prompt", "!click", "yes", ...] }.
 * "!click" presses the confirmation card's button. Each scenario starts a new
 * conversation. Needs VoiceOS running with its debugging port on 9333. Writes
 * only what the prompts ask for, so keep changes in the sandbox repository.
 *
 * --clean-screen hides every other app for the run and shows them again after.
 * VoiceOS sends the agent a screenshot of the screen with each typed prompt,
 * and a terminal full of QA output tells it the answers.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const args = process.argv.slice(2);
const flag = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const file = args.find((a) => !a.startsWith("--"));
if (!file) throw new Error("Usage: bun scripts/agent-flicker-qa.ts <scenarios.json> [--only=a,b] [--out=dir]");
const only = flag("only")?.split(",");
const out = join(ROOT, flag("out") ?? `docs/qa/${new Date().toISOString().slice(0, 10)}`);
mkdirSync(out, { recursive: true });
const scenarios: Array<{ name: string; turns: string[] }> = JSON.parse(readFileSync(file, "utf8")).filter((s: any) => !only || only.includes(s.name));
const auditPath = join(ROOT, ".state/audit.jsonl");
// Written only by a server.ts instrumented with scripts/qa-trace.ts; absent in a normal install.
const tracePath = join(ROOT, ".state/qa-calls.jsonl");
if (!readFileSync(join(ROOT, "server.ts"), "utf8").includes("qa-calls.jsonl")) {
  console.log("server.ts isn't instrumented, so only error cards are checked. For card replacements: bun scripts/qa-trace.ts, then reload GitHub in VoiceOS.");
}
const lines = (path: string) => (existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : []);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

const osa = (script: string) => execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();
const hidden: string[] = [];
let frontmost = "";
function hideOthers() {
  frontmost = osa('tell application "System Events" to get name of first process whose frontmost is true');
  const visible = osa('tell application "System Events" to get name of every process whose visible is true').split(", ").filter((n) => n && n !== "VoiceOS");
  writeFileSync(join(out, "hidden-apps.json"), JSON.stringify({ frontmost, visible }));
  for (const name of visible) {
    try {
      osa(`tell application "System Events" to set visible of process ${JSON.stringify(name)} to false`);
      hidden.push(name);
    } catch {
      // An app that can't be hidden stays as it is.
    }
  }
}
function showOthers() {
  for (const name of hidden.splice(0)) {
    try {
      osa(`tell application "System Events" to set visible of process ${JSON.stringify(name)} to true`);
    } catch {
      // Quit meanwhile.
    }
  }
  if (frontmost) try { osa(`tell application ${JSON.stringify(frontmost)} to activate`); } catch {}
}
if (args.includes("--clean-screen")) hideOthers();

/**
 * What the notch's own box sends on Enter, sent exactly once. A first prompt starts a new conversation; a
 * follow-up continues the live one. (Typing into the box and retyping when it hadn't cleared sent some
 * follow-ups twice: the second started a new session and VoiceOS hid the first one's confirmation card.)
 */
const say = (text: string, first: boolean) =>
  notch.evaluate(`window.api.send("agent-text-send", { text: ${JSON.stringify(text)}, widgetVisible: ${!first}, visibleSessionId: null })`);

async function click(): Promise<string | null> {
  // The host draws the card's confirm button itself, outside the card's iframe.
  return notch.evaluate(`(() => {
    const buttons = [...document.querySelectorAll("button")].filter((b) => /^(Post comment|Create issue|Update issue|Submit review)$/i.test((b.textContent || "").trim()));
    if (!buttons.length) return null;
    buttons[0].click();
    return buttons[0].textContent.trim();
  })()`);
}

/**
 * This step's history entry, and whether its turn is over (done, or waiting on a card). A typed prompt is
 * found by its own words; a click by the turn it continued, updated after the click. Never the turn before.
 */
async function turnSince(started: number, prompt?: string) {
  const recent: any[] = Object.values((await main.evaluate("window.api.agentHistory.getRecent()")) ?? {});
  const turn = prompt
    ? recent.find((t) => t.transcript === prompt && Date.parse(t.updated_at) >= started)
    : recent.filter((t) => Date.parse(t.updated_at) > started).sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0];
  const over = !!turn && (turn.pending_confirmation || turn.has_live_confirmation || !/running|progress|pending|active|thinking/i.test(String(turn.status)));
  return { turn, over };
}

/** Error cards the user saw that a later result in the same turn replaced. */
function flickers(calls: any[]): string[] {
  const found: string[] = [];
  calls.forEach((c, i) => {
    if (c.outcome === "ok" || c.card === "none") return;
    const later = calls.slice(i + 1).find((d) => d.outcome === "ok");
    if (later) found.push(`${c.tool}:${c.outcome} card, then ${later.tool}:ok`);
  });
  return found;
}

/**
 * Any card the user saw that a later card in the same turn replaced, such as "No more pull requests" and then
 * a list (user, 2026-10-28). Needs the card text that scripts/qa-trace.ts records. The agent's summary landing
 * under the same rows is an addition, not a replacement, and is reported separately.
 */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
function replacements(traced: any[]): { replaced: string[]; summaries: number } {
  const cards = traced.filter((t) => t.card);
  const replaced: string[] = [];
  let summaries = 0;
  cards.forEach((card, i) => {
    const before = cards[i - 1];
    if (!before) return;
    if (card.args?.summary && squash(card.card).replace(squash(card.args.summary), "") === squash(before.card)) {
      summaries++;
      return;
    }
    if (squash(card.card) === squash(before.card)) return;
    replaced.push(`"${before.card.slice(0, 90)}" → "${card.card.slice(0, 90)}"`);
  });
  return { replaced, summaries };
}

const results: any[] = [];
try {
for (const scenario of scenarios) {
  // A new conversation, the way a person starts over (what the pill's dismiss sends).
  await notch.evaluate(`window.api.send("agent-dismiss")`);
  await sleep(2000);
  for (const [n, step] of scenario.turns.entries()) {
    const auditBefore = lines(auditPath).length;
    const traceBefore = lines(tracePath).length;
    const started = Date.now();
    let clicked: string | null = null;
    if (step === "!click") {
      // The card can be drawn a moment after the turn reports it's waiting on it.
      for (let tries = 0; tries < 12 && !clicked; tries++) {
        clicked = await click();
        if (!clicked) await sleep(500);
      }
      if (!clicked) {
        results.push({ scenario: scenario.name, turn: n, step, error: "no confirm button showing" });
        console.log(`✗ ${scenario.name}#${n} ${step}: no confirm button showing`);
        break;
      }
    } else await say(step, n === 0);
    let state = { turn: undefined as any, over: false };
    let shot: string | undefined;
    for (let waited = 0; waited < 120_000 && !state.over; waited += 1000) {
      await sleep(1000);
      state = await turnSince(started, step.startsWith("!") ? undefined : step);
      if (await notch.evaluate(`[...document.querySelectorAll("iframe")].some((f) => f.offsetHeight > 40)`)) {
        shot = (await notch.send("Page.captureScreenshot", { format: "png" })).data;
      }
    }
    await sleep(1500); // calls that land just after the text
    const calls = lines(auditPath).slice(auditBefore).map((l) => JSON.parse(l)).filter((e) => e.event === "tool_call");
    const traced = lines(tracePath).slice(traceBefore).map((l) => JSON.parse(l));
    const swaps = replacements(traced);
    const png = shot ? join(out, `${scenario.name}-${n}.png`) : undefined;
    if (png && shot) writeFileSync(png, Buffer.from(shot, "base64"));
    // What the notch ended on, card or not: the agent's own answer can replace the card.
    const finalPng = join(out, `${scenario.name}-${n}-final.png`);
    writeFileSync(finalPng, Buffer.from((await notch.send("Page.captureScreenshot", { format: "png" })).data, "base64"));
    const record = {
      scenario: scenario.name,
      turn: n,
      step,
      ...(clicked ? { clicked } : {}),
      seconds: Math.round((Date.now() - started) / 100) / 10,
      status: state.turn?.status ?? "no turn found",
      answer: state.turn?.response_text ?? null,
      tools: state.turn?.tool_names ?? [],
      waiting_on_card: !!(state.turn?.pending_confirmation || state.turn?.has_live_confirmation),
      github_calls: calls.map((c) => `${c.tool}:${c.outcome}${c.field ? `(${c.field})` : ""}${c.card === "none" ? " [no card]" : ""} ${c.ms}ms`),
      ...(traced.length ? { arguments: traced.map((t) => ({ tool: t.tool, args: t.args, card: t.card })) } : {}),
      flickers: [...flickers(calls), ...swaps.replaced.map((r) => `card replaced: ${r}`)],
      summaries_added: swaps.summaries,
      ...(png ? { screenshot: png } : {}),
      final_screenshot: finalPng,
    };
    results.push(record);
    appendFileSync(join(out, "flicker-qa.jsonl"), JSON.stringify(record) + "\n");
    const mark = record.flickers.length ? "⚡" : calls.some((c) => c.outcome !== "ok" && c.card !== "none") ? "!" : "✓";
    console.log(`${mark} ${scenario.name}#${n} (${record.seconds}s) ${step}\n   calls: ${record.github_calls.join(", ") || "none"}\n   answer: ${String(record.answer ?? "").replace(/\s+/g, " ").slice(0, 300)}`);
    for (const t of traced) console.log(`   · ${t.tool} ${JSON.stringify(t.args).slice(0, 160)}\n     card: ${t.card ? t.card.slice(0, 160) : "(none)"}`);
    if (record.flickers.length) console.log(`   FLICKER: ${record.flickers.join("; ")}`);
  }
}
} finally {
  showOthers();
}
const flickered = results.filter((r) => r.flickers?.length);
console.log(`\n${results.length} turns, ${flickered.length} with a flicker${flickered.length ? `: ${flickered.map((r) => `${r.scenario}#${r.turn}`).join(", ")}` : ""}.`);
notch.close();
main.close();
process.exitCode = flickered.length ? 1 : 0;
