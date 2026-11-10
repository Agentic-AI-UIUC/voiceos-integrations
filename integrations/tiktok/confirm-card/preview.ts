/**
 * Visual QA for the confirmation cards (dev only; nothing here ships).
 *
 *   bun confirm-card/preview.ts [outDir]
 *
 * Writes <outDir>/index.html: every card in a 388-px sandboxed iframe on the
 * notch's #18191C surface, the parent playing VoiceOS's part — it posts
 * voiceos:init with realistic args, honours voiceos:resize (clamped 60-420),
 * draws a stand-in for the floating confirm button (VoiceOS's own style and
 * position: 12 px from the right, 10 px from the bottom, 30 px tall), logs
 * every voiceos:updateInput, and verifies the staged receipt with the same TKR
 * the server uses. `window.__cases` exposes the staged values for automation.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodePhotoFrame, joinPhotoStack } from "../src/microPreview.ts";
import type { WriteTool } from "../src/types.ts";
import { RECEIPT_CORE_JS, buildConfirmation } from "./build.ts";

const DEFAULT_OUT =
  "/private/tmp/claude-501/-Users-m3-max-Library-Application-Support-VoiceOS-custom-mcps-tiktok-890e09f5/85d4746c-5eda-47e7-a4b6-49c197c8bf02/scratchpad/confirm-preview";
const out = process.argv[2] ?? DEFAULT_OUT;

/**
 * Real micro previews (src/microPreview.ts) of Tiny AI Lab shorts: three 18×32 frames at 15/50/85% of
 * each video (ffmpeg), plus a 16:9 crop for the landscape case. Regenerate with encodeMicroFrame.
 */
const PREVIEW = {
  speedrun:
    "p1.42~RfEXvXiQFJgSxRXD5AUkiTDYS4ohRBXIUWNIJFtExqGlxBSyjCoimRCdldKpCtsl232r_FNr4lSHaX-_csif05MrZba___-v0lVE~RfCVOXloFIUBHBCecMsPiJ4TQgmY8SnmGoQQunElCZ3xLYpjjWKUn3ZCCO8kuV8_pXM6dYlONalW-3y3NfW5KiX33__t_q8irkvQ~RfEUu3cYNiA7ONlFsNklHjZFxcojkEiRROsWUaJ3O2ISEZCK_2pFvle3y_XEPdZ05ypv_fd1d1tLsv___9-t0vr1___6-_-vyr-g",
  strawberry:
    "p1.37~RfGr0XvoaAvAjDsNBAJiggIxQIxgQJKIMhhM5xxbIJnUhCylI_CeiZzcxoTKJKtc6urvFLZtXncjaYpv_-nJVv-8y6L6y__tatbY~RfIry3yRgXCQzzjBuGwVllcJwRnElSOQPkZgpKEjYRKhLkJIIFl0rSJY0TaifJvMR5y7zLGa-fEKQv7Z-sip_6yrTv9L_vN7X65g~RfGpTH1AfBcHwvGlDIoqYVBG6wmh7GnSFiNjBRGY0JCxKOpiSRR9pqcku6nypxJ7kJiT70ZyL-XScrWp2XkdKn0trZNb_r_9V72",
  landscape:
    "p1.28~fRIjS33gWAmhEhQqPDJBAK0KIFRAUxAWczEOxYmVkbWKW2LaEi2TRm_jJbS0zLl3i-7axazet8__9y9_1oiupP313ul-_1X9P_s~fRGeS3yYERAZRzIIDcOjGcEYM0bmDIgUSiHHHlS8JRqZS-UUWmRny4m4v9MSWJryNK0stJT1USpF1_8ur3XzdO9__-117919e_9g~fREjT384CYQfAhCTw0QaEBJyDznEoxBQwspEYWdJucUw-PyiWIyHOPJlSpSlQuu9x9-s-paUqJpfH-17aesTf77xInsp_e69fP9A",
};

const words = "How AI went from chess bots to chatbots in 42 seconds: ELIZA, Deep Blue, AlphaGo, transformers. Which jump surprised you most? #ai #aihistory #tinyailab #learnontiktok ";
const caption = (n: number) => words.repeat(Math.ceil(n / words.length)).slice(0, n);

const video = {
  post_token: "pt1.mhj2k0.4f1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e.mac",
  file_token: "ft1.mhj2k0.0a1b2c3d4e5f60718293a4b5c6d7e8f9.mac",
  file_name: "ai-history-speedrun.mp4",
  preview: PREVIEW.speedrun,
  creator_nickname: "Tiny AI Lab",
  max_duration_sec: 600,
  caption: "76 years of AI in 42 seconds 🏁 Which jump surprised you most? #ai #aihistory #tinyailab",
  privacy_level: "",
  cover_label: "",
};
const unaudited = { privacy_options: ["SELF_ONLY"], comment_disabled: false, duet_disabled: true, stitch_disabled: true };
const audited = { privacy_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS"], comment_disabled: false, duet_disabled: false, stitch_disabled: false };
const drafts = {
  file_token: video.file_token,
  file_name: "ai-history-speedrun.mp4",
  preview: PREVIEW.speedrun,
  account_label: "@thetinyailab",
  duration_label: "0:42",
  size_label: "64.9 MB",
  caption: "76 years of AI in 42 seconds 🏁 #ai #aihistory #tinyailab",
  copy_caption: false,
};
/** A Tiny AI Lab carousel's stack, as prepare_photo_post makes it: 48 × 64 sources (tests/fixtures/micro) → 24 × 32 frames. */
const photoFrame = (i: number) =>
  encodePhotoFrame(new Uint8Array(readFileSync(new URL(`../tests/fixtures/micro/photo-${i}.48x64.rgb`, import.meta.url))), 48, 64);
const STACK = joinPhotoStack([1, 2, 3, 4, 5].map(photoFrame), { count: 6, cover: 0 });
const STACK_2 = joinPhotoStack([3, 6].map(photoFrame), { count: 2, cover: 1 });
const photos = {
  bundle_token: "bt1.mhj2k0.9f8e7d6c5b4a39281706f5e4d3c2b1a0.mac",
  preview: STACK,
  count_label: "6 photos · cover: photo 1",
  order_label: "1 cube-mascot · 2 eliza · 3 deep-blue · 4 alphago · 5 transformer · 6 chat",
  warning: "2 HEIC photos will be converted to JPEG, and 1 will be resized to 1080p.",
};

interface Case { id: string; title: string; tool: WriteTool; theme: "dark" | "light"; args: Record<string, unknown> }
const CASES: Case[] = [
  { id: "uv", title: "upload_video · drafts (the live path)", tool: "upload_video", theme: "dark", args: drafts },
  { id: "pv-unaudited", title: "publish_video · unaudited (Only me; Duet/Stitch off)", tool: "publish_video", theme: "dark", args: { ...video, ...unaudited } },
  { id: "uv-light", title: "upload_video · light theme", tool: "upload_video", theme: "light", args: drafts },
  { id: "pv-light", title: "publish_video · light theme (audited)", tool: "publish_video", theme: "light", args: { ...video, ...audited } },
  { id: "uv-nopreview", title: "upload_video · no preview, no account (fallback tile)", tool: "upload_video", theme: "dark", args: { ...drafts, preview: undefined, account_label: "", caption: "", file_name: "Screen Recording 2026-11-05 at 9.41.12 AM.mov", duration_label: "1:02", size_label: "48.9 MB" } },
  { id: "uv-land", title: "upload_video · landscape source", tool: "upload_video", theme: "dark", args: { ...drafts, preview: PREVIEW.landscape, file_name: "how-ai-sees-16x9.mov", duration_label: "0:28", size_label: "31.4 MB" } },
  { id: "pv-audited", title: "publish_video · audited (three options), strawberry", tool: "publish_video", theme: "dark", args: { ...video, ...audited, preview: PREVIEW.strawberry, file_name: "ep01-strawberry-tokens.mp4" } },
  {
    id: "pv-branded",
    title: "publish_video · comments disabled · disclosure + Branded · Everyone",
    tool: "publish_video",
    theme: "dark",
    args: { ...video, ...audited, comment_disabled: true, commercial_disclosure: true, brand_content: true, privacy_level: "PUBLIC_TO_EVERYONE", cover_label: "Frame at 0:03", cover_ms: 3000 },
  },
  { id: "pv-long", title: "publish_video · caption near 2,200 (2,186)", tool: "publish_video", theme: "dark", args: { ...video, ...unaudited, caption: caption(2186) } },
  { id: "pv-nopreview", title: "publish_video · no preview (fallback tile)", tool: "publish_video", theme: "dark", args: { ...video, ...unaudited, preview: undefined } },
  { id: "pp", title: "post_photos · warning · unaudited", tool: "post_photos", theme: "dark", args: { ...photos, post_token: video.post_token, creator_nickname: "Tiny AI Lab", privacy_options: ["SELF_ONLY"], comment_disabled: false, title: "76 years of AI", description: "from chess to chat #ai #aihistory", privacy_level: "" } },
  { id: "up", title: "upload_photos · warning · drafts", tool: "upload_photos", theme: "dark", args: { ...photos, account_label: "@thetinyailab", title: "76 years of AI", description: "from chess to chat #ai" } },
  { id: "up-light", title: "upload_photos · light theme, no warning", tool: "upload_photos", theme: "light", args: { ...photos, warning: "", account_label: "", title: "", description: "" } },
  { id: "up-two", title: "upload_photos · 2 photos, cover 2, no warning", tool: "upload_photos", theme: "dark", args: { ...photos, preview: STACK_2, count_label: "2 photos · cover: photo 2", order_label: "1 desk-buddy · 2 late-night-ship", warning: "", account_label: "@thetinyailab", title: "Late night at the lab", description: "" } },
  { id: "up-nopreview", title: "upload_photos · no preview (fallback stack)", tool: "upload_photos", theme: "dark", args: { ...photos, preview: undefined, warning: "", account_label: "@thetinyailab", title: "", description: "" } },
  { id: "pp-light", title: "post_photos · light theme", tool: "post_photos", theme: "light", args: { ...photos, warning: "", post_token: video.post_token, creator_nickname: "Tiny AI Lab", privacy_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE"], comment_disabled: false, title: "A day at the lab", description: "#ai #learnontiktok" } },
];

const cards = Object.fromEntries((["publish_video", "upload_video", "post_photos", "upload_photos"] as WriteTool[]).map((t) => [t, buildConfirmation(t).root]));
const json = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>TikTok confirmation cards</title>
<style>
  body{margin:0;background:#000;color:rgba(255,255,255,.8);font:12px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif}
  main{display:flex;flex-wrap:wrap;gap:28px 24px;padding:24px}
  .case{width:388px;display:flex;flex-direction:column;gap:8px}
  h2{margin:0;font-size:12px;font-weight:600;color:rgba(255,255,255,.9)}
  .surface{position:relative;width:388px;border-radius:26px;overflow:hidden;background:#18191c}
  .surface.light{background:#f2f2f4}
  iframe{display:block;width:388px;border:0;background:transparent;transition:height .16s ease}
  .vbtn{position:absolute;right:12px;bottom:10px;height:30px;padding:0 18px;font:600 13px/28px -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;letter-spacing:.01em;color:rgba(255,255,255,.96);background:rgba(17,18,21,.85);backdrop-filter:blur(10px) saturate(1.4);border:1px solid rgba(255,255,255,.22);border-radius:999px;box-shadow:0 3px 12px rgba(0,0,0,.32),0 1px 3px rgba(0,0,0,.28);box-sizing:border-box;pointer-events:none}
  .ok{color:#30d158}.bad{color:#ff453a}
  pre{margin:0;max-height:150px;overflow:auto;padding:8px;border-radius:8px;background:#111;color:rgba(255,255,255,.62);font:10.5px/1.4 ui-monospace,Menlo,monospace;white-space:pre-wrap;word-break:break-all}
</style></head><body><main id="main"></main>
<script>${RECEIPT_CORE_JS}</script>
<script>
var CARDS = ${json(cards)};
// #tall: frames grow to their full content (review only; VoiceOS clamps at 420).
var MAX_H = /tall/.test(location.hash) ? 2400 : 420;
var CASES = ${json(CASES)};
window.__cases = {};
CASES.forEach(function (c) {
  var card = CARDS[c.tool];
  var wrap = document.createElement("section"); wrap.className = "case"; wrap.id = "case-" + c.id;
  var h = document.createElement("h2"); h.textContent = c.title + " — " + card.label;
  var surface = document.createElement("div"); surface.className = "surface" + (c.theme === "light" ? " light" : "");
  var frame = document.createElement("iframe"); frame.setAttribute("sandbox", "allow-scripts"); frame.title = card.label;
  frame.style.height = card.height + "px";
  var btn = document.createElement("div"); btn.className = "vbtn"; btn.textContent = card.confirmLabel;
  var status = document.createElement("div"); status.textContent = "waiting for init…";
  var log = document.createElement("pre");
  surface.appendChild(frame); surface.appendChild(btn);
  wrap.appendChild(h); wrap.appendChild(surface); wrap.appendChild(status); wrap.appendChild(log);
  document.getElementById("main").appendChild(wrap);
  var st = window.__cases[c.id] = { tool: c.tool, args: c.args, staged: {}, log: [], height: card.height, verify: null, frame: frame };
  frame.addEventListener("load", function () {
    frame.contentWindow.postMessage({ type: "voiceos:init", data: undefined, args: c.args, theme: { mode: c.theme }, radius: 26 }, "*");
  });
  st.check = function () {
    var received = Object.assign({}, c.args, st.staged);
    st.received = received;
    st.verify = TKR.verify(c.tool, received, received.confirmation_receipt, Date.now(), 600000);
    status.className = st.verify.ok ? "ok" : "bad";
    status.textContent = st.verify.ok ? "receipt verifies against what VoiceOS would send" : "receipt: " + st.verify.reason;
  };
  st.onMessage = function (m) {
    if (m.type === "voiceos:resize" && typeof m.height === "number") {
      st.measured = m.height; st.height = Math.max(60, Math.min(MAX_H, m.height)); frame.style.height = st.height + "px";
      h.textContent = c.title + " — " + card.label + " · declared " + card.height + " / measured " + m.height + " px"; return;
    }
    if (m.type !== "voiceos:updateInput") return;
    st.staged[m.key] = m.value;
    var v = String(m.value);
    st.log.push(m.key + " = " + (v.length > 60 ? v.slice(0, 57) + "…" : v));
    log.textContent = st.log.join("\\n");
    log.scrollTop = log.scrollHeight;
    st.check();
  };
  frame.srcdoc = card.html;
});
window.addEventListener("message", function (e) {
  for (var id in window.__cases) {
    var st = window.__cases[id];
    if (st.frame.contentWindow === e.source && e.data) { st.onMessage(e.data); return; }
  }
});
</script></body></html>`;

mkdirSync(out, { recursive: true });
const file = join(out, "index.html");
writeFileSync(file, page);
console.log(file);
