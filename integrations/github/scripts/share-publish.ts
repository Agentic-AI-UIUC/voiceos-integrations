/**
 * Publishes this folder to its existing VoiceOS share link: VoiceOS's own share review, then publish to the same
 * link teammates install from. Runs through VoiceOS's API on its debugging port (9333), with nothing on screen.
 *
 *   bun scripts/share-publish.ts                  # submit this folder for review, then publish
 *   bun scripts/share-publish.ts --review=<id>    # wait on a review already submitted, then publish
 *
 * Refuses a server.ts instrumented for QA (scripts/qa-trace.ts) or one that differs from what VoiceOS packages.
 * A review that comes back without a usable answer can be resubmitted by running this again.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ID = "com.voiceos.generated.github-composio";
const ROOT = join(import.meta.dir, "..");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const resume = process.argv.find((a) => a.startsWith("--review="))?.slice("--review=".length);
// reviewStatus answers { success, state: { reviewId, status, ... } }.
const verdictOf = (r: any) => String(r?.state?.status ?? r?.status ?? "").toLowerCase();

const targets: any[] = await (await fetch("http://127.0.0.1:9333/json")).json();
// Any of VoiceOS's renderer pages carries the API; the main window is often closed, the pill never is.
const target = targets.find((t) => t.type === "page" && t.url.includes("/renderer/index.html"));
if (!target) throw new Error("No VoiceOS page on port 9333. Is VoiceOS running?");
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
let seq = 0;
const evaluate = (expression: string) =>
  new Promise<any>((resolve) => {
    const n = ++seq;
    const onMessage = (e: MessageEvent) => {
      const m = JSON.parse(String(e.data));
      if (m.id !== n) return;
      ws.removeEventListener("message", onMessage);
      resolve(m.result?.result?.value);
    };
    ws.addEventListener("message", onMessage);
    ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
const share = (call: string) => evaluate(`window.api.integrationShare.${call}.then((r) => r, (e) => ({ error: String(e) }))`);

try {
  const server = readFileSync(join(ROOT, "server.ts"), "utf8");
  if (server.includes("qa-calls.jsonl")) throw new Error("server.ts is instrumented for QA. Run bun run build first.");
  const manifest = JSON.parse(readFileSync(join(ROOT, "voiceos.integration.json"), "utf8"));
  const preview = (await share(`preview(${JSON.stringify(ID)})`))?.preview;
  const packaged = preview?.files?.find((f: any) => f.name === "server.ts")?.bytes;
  if (preview?.version !== manifest.version || packaged !== statSync(join(ROOT, "server.ts")).size) {
    throw new Error(`VoiceOS would package version ${preview?.version} with a ${packaged}-byte server.ts; this folder is ${manifest.version}. Reload GitHub in VoiceOS first.`);
  }
  console.log(`Packaging ${preview.integrationName} ${preview.version}: ${preview.files.map((f: any) => f.name).join(", ")} (${preview.totalBytes} bytes, sha256 ${preview.sha256})`);
  const before = (await share(`publishState(${JSON.stringify(ID)})`))?.state;
  console.log(`Link now serves ${before?.version ?? "nothing"}: ${before?.url ?? "(not published yet)"}`);

  const submitted = resume ? undefined : await share(`submitReview(${JSON.stringify(ID)})`);
  const reviewId: string | undefined = resume ?? (typeof submitted === "string" ? submitted : submitted?.reviewId ?? submitted?.state?.reviewId ?? submitted?.id);
  if (!reviewId) throw new Error(`The review wasn't started: ${JSON.stringify(submitted).slice(0, 500)}`);
  console.log(resume ? `Waiting on review ${reviewId}.` : `Review ${reviewId} submitted.`);

  let status: any;
  for (let waited = 0; waited < 15 * 60_000; waited += 10_000) {
    status = await share(`reviewStatus(${JSON.stringify(reviewId)})`);
    if (status?.state?.sha256 && status.state.sha256 !== preview.sha256) throw new Error(`Review ${reviewId} is for a different package (${status.state.sha256}).`);
    if (!/pending|queued|running|reviewing/.test(verdictOf(status))) break;
    await sleep(10_000);
  }
  console.log(`Review result: ${JSON.stringify(status).slice(0, 2000)}`);
  const verdict = verdictOf(status);
  if (!/approved|passed|accepted/.test(verdict)) throw new Error(`Not published: the review came back "${verdict || "without a verdict"}".`);

  const published = await share(`publish(${JSON.stringify(ID)}, ${JSON.stringify(reviewId)})`);
  console.log(`Publish: ${JSON.stringify(published).slice(0, 800)}`);
  const after = (await share(`publishState(${JSON.stringify(ID)})`))?.state;
  if (after?.version !== manifest.version) throw new Error(`The link still serves ${after?.version}.`);
  console.log(`Published ${after.version} at ${after.url} (sha256 ${after.sha256}, ${after.publishedAt}).`);
} finally {
  ws.close();
}
