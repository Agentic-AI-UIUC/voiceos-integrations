/**
 * QA only: makes the built server.ts append every call's tool, arguments and the text of the card it
 * returned to .state/qa-calls.jsonl, which scripts/agent-flicker-qa.ts reads to see what the notch showed.
 *
 *   bun scripts/qa-trace.ts      # instrument server.ts, then reload GitHub in VoiceOS
 *   bun run build                # undo: regenerates server.ts from src/
 *
 * Never ship an instrumented server.ts: `bun run build` before any publish.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const path = join(import.meta.dir, "..", "server.ts");
const source = readFileSync(path, "utf8");
const anchor = "  async handle(tool, args, opts = {}) {\n";
if (source.split(anchor).length !== 2) throw new Error("handle() not found exactly once in server.ts");
if (source.includes("qa-calls.jsonl")) throw new Error("server.ts is already instrumented");
const wrapper = `  async handle(tool, args, opts = {}) {
    const result = await this.qaHandle(tool, args, opts);
    try {
      const { confirmation_receipt: _r, ...shown } = args ?? {};
      const body = JSON.parse(result?.content?.[0]?.text ?? "{}");
      const html = body?._voiceos_glance?.blocks?.[0]?.html;
      const card = typeof html === "string"
        ? html.replace(/<(style|script)[^>]*>[\\s\\S]*?<\\/\\1>/g, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/g, " ").replace(/\\s+/g, " ").trim().slice(0, 3000)
        : null;
      appendFileSync(this.config.stateDir + "/qa-calls.jsonl", JSON.stringify({ ts: new Date().toISOString(), tool, args: shown, ok: !result?.isError, card }) + "\\n");
    } catch {}
    return result;
  }
  async qaHandle(tool, args, opts = {}) {
`;
writeFileSync(path, source.replace(anchor, wrapper));
console.log("instrumented", path, "- reload GitHub in VoiceOS; undo with bun run build");
