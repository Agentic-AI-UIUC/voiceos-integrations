/**
 * The four confirmation cards (plan §7.1–7.7; Studio brief "Confirmation cards").
 *
 * VoiceOS renders a write's confirmation from the manifest before any of our
 * code runs, so each card is a static widget that learns the pending call from
 * the bridge (`voiceos:init` → args). It shows what will be sent, lets the user
 * edit it, and stages `confirmation_receipt`: a digest of the arguments VoiceOS
 * will send on a click, re-minted on every edit. The server refuses any write
 * without a valid one. VoiceOS owns the button (bottom right, `confirmLabel`);
 * a widget has no Cancel and can't disable that button.
 *
 * Build-time only (scripts/build.ts embeds the result in the manifest): this
 * module reads card-logic.js, card-dom.js, card.css and the receipt core's exact
 * text from disk, and inlines the micro-preview decoder (src/microPreview.ts)
 * that draws the `preview` argument's frames.
 */
import { readFileSync } from "node:fs";
import { renderCustom } from "../widgetKit.ts";
import { ACCENT } from "../src/config.ts";
import { PRIVACY_LABELS } from "../src/errors.ts";
import { MICRO_PREVIEW_DECODER_JS } from "../src/microPreview.ts";
import type { WriteTool } from "../src/types.ts";
import { cardBody } from "./markup.ts";

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

/** src/receiptCoreScript.ts between "var TKR = (function () {" and its export line: the server runs the same text as code. */
const receiptFile = read("../src/receiptCoreScript.ts");
const receiptStart = receiptFile.indexOf("var TKR = (function () {");
const receiptEnd = receiptFile.lastIndexOf("\nexport default TKR;");
if (receiptStart < 0 || receiptEnd < receiptStart) {
  throw new Error("src/receiptCoreScript.ts must hold the TKR script followed by its export line.");
}
export const RECEIPT_CORE_JS = receiptFile.slice(receiptStart, receiptEnd);

const LABELS_MARK = "/*@TK_PRIVACY_LABELS@*/{}";
const logicFile = read("./card-logic.js");
if (logicFile.split(LABELS_MARK).length !== 2) throw new Error(`confirm-card/card-logic.js must contain ${LABELS_MARK} exactly once.`);

/** The cards' pure ES5 rules (TKC), with src/errors.ts PRIVACY_LABELS inlined. Tests run it with node:vm. */
export const CARD_LOGIC_JS = logicFile.replace(LABELS_MARK, JSON.stringify(PRIVACY_LABELS)).trim();
/** The cards' DOM wiring (ES5): hydrate, stage edits, re-mint the receipt. */
export const CARD_DOM_JS = read("./card-dom.js").trim();
export const CARD_CSS = read("./card.css");

/** Every argument a card reads or stages; each is in that tool's inputSchema. hashtags and mentions are staged as "" once folded (TKC.settle). */
export const CARD_KEYS: Record<WriteTool, string[]> = {
  upload_video: ["file_token", "confirmation_receipt", "file_name", "account_label", "duration_label", "size_label", "preview", "caption", "copy_caption", "hashtags", "mentions"],
  publish_video: [
    "post_token", "file_token", "confirmation_receipt", "file_name", "preview", "creator_nickname", "privacy_options",
    "comment_disabled", "duet_disabled", "stitch_disabled", "caption", "privacy_level",
    "allow_comment", "allow_duet", "allow_stitch", "commercial_disclosure", "brand_organic", "brand_content", "is_aigc",
    "cover_ms", "cover_label", "hashtags", "mentions",
  ],
  upload_photos: ["bundle_token", "confirmation_receipt", "preview", "count_label", "order_label", "warning", "account_label", "title", "description", "hashtags", "mentions"],
  post_photos: [
    "bundle_token", "post_token", "confirmation_receipt", "preview", "count_label", "order_label", "warning",
    "creator_nickname", "privacy_options", "comment_disabled", "title", "description", "privacy_level",
    "allow_comment", "auto_add_music", "commercial_disclosure", "brand_organic", "brand_content", "hashtags", "mentions",
  ],
};

export interface ConfirmationView {
  schemaVersion: 1;
  root: { type: "widget"; html: string; height: number; confirmLabel: string; label: string };
}

const VIEWS: Record<WriteTool, { confirmLabel: string; label: string; height: number }> = {
  // Heights are the rendered heights (measured in the preview harness, both themes), so the card doesn't jump on arrival.
  // The compact layout fits the notch's 420 px: only a long caption (5+ lines), the brand options or a photo warning scroll.
  publish_video: { confirmLabel: "Post", label: "Confirm posting a video to TikTok", height: 376 }, // 376 px with a 1-2 line caption and 1-3 privacy options
  upload_video: { confirmLabel: "Send to drafts", label: "Confirm sending a video to TikTok drafts", height: 340 }, // 340 px with a 1-line caption (306 with none)
  post_photos: { confirmLabel: "Post", label: "Confirm posting photos to TikTok", height: 415 }, // 415 px with the hosting line; 470 with a warning line (then it scrolls)
  upload_photos: { confirmLabel: "Send to drafts", label: "Confirm sending photos to TikTok drafts", height: 342 }, // 342 px with the hosting line; 397 with a warning line
};

for (const [name, text] of Object.entries({ RECEIPT_CORE_JS, MICRO_PREVIEW_DECODER_JS, CARD_LOGIC_JS, CARD_DOM_JS })) {
  if (/<\/script|<!--/i.test(text)) throw new Error(`${name} can't be inlined in a <script>.`);
}

export function buildConfirmation(tool: WriteTool): ConfirmationView {
  const view = Object.prototype.hasOwnProperty.call(VIEWS, tool) ? VIEWS[tool] : undefined;
  if (!view) throw new Error(`No confirmation card for ${String(tool)}`);
  const script = `<script>var TK_TOOL = ${JSON.stringify(tool)};\n${RECEIPT_CORE_JS}\n${MICRO_PREVIEW_DECODER_JS}\n${CARD_LOGIC_JS}\n${CARD_DOM_JS}</script>`;
  const card = renderCustom({
    mode: "confirm",
    accent: ACCENT,
    css: CARD_CSS,
    body: cardBody(tool) + script,
    height: view.height,
    label: view.label,
  });
  return {
    schemaVersion: 1,
    root: { type: "widget", html: card.html, height: card.height, confirmLabel: view.confirmLabel, label: view.label },
  };
}
