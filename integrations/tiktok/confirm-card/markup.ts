/**
 * Static markup for the four confirmation cards. Everything here is fixed copy
 * (escaped anyway); the pending call's values arrive at runtime and reach the
 * DOM only through .value / .textContent (card-dom.js), and the preview frames
 * only as canvas pixels. Ids and data-tk-* attributes are the contract with
 * card-dom.js.
 *
 * Layout (compact, so the usual card fits the notch without scrolling):
 *   - one header line: the integration's mark and the action ("Post to TikTok");
 *   - the media (a 9:16 tile, or the photo stack) with the facts beside it: file or
 *     photo count, one meta line, the account, and on direct posts who can view;
 *   - one composer box: the caption (or title + description) starts one line tall,
 *     grows to a few lines and then scrolls inside itself, with #hashtags and
 *     @mentions tinted as TikTok's own composer does;
 *   - settings as toggle chips (Allow: Comments, Duet, Stitch; then the labels);
 *   - on direct posts, the consent line TikTok requires, beside VoiceOS's Post button.
 * What happens on approval is in each card's accessible description (NOTES), not
 * printed: the controls already say it, and the completion card confirms it.
 */
import { esc, markHtml } from "../widgetKit.ts";
import type { WriteTool } from "../src/types.ts";

/** TikTok's Content Sharing Guidelines link both policy names in the consent line. */
export const POLICY_URLS = {
  music: "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en",
  branded: "https://www.tiktok.com/legal/page/global/bc-policy/en",
} as const;

/** What happens on approval: each card's accessible description (screen readers), not visible copy. */
export const NOTES = {
  publish_video: "Posts this video to your TikTok profile. Processing takes a few minutes.",
  post_photos: "Posts these photos to your TikTok profile. They're hosted briefly for TikTok to fetch, then deleted.",
  upload_video: "Sends this video to your TikTok inbox. Drafts can't carry a caption: you paste it in TikTok.",
  upload_photos: "Sends these photos to your TikTok inbox with the title and description filled in. They're hosted briefly, then deleted.",
} as const;

const svg = (path: string, cls = "tk-i", box = "0 0 16 16") =>
  `<svg class="${cls}" viewBox="${box}" width="16" height="16" fill="currentColor" aria-hidden="true">${path}</svg>`;

const ICON = {
  play: svg('<path d="M5 3.4v9.2c0 .8.9 1.3 1.6.9l7.2-4.6c.6-.4.6-1.4 0-1.8L6.6 2.5C5.9 2.1 5 2.6 5 3.4Z"/>', "tk-pl"),
  film: svg('<path d="M3.5 1.5h9A2 2 0 0 1 14.5 3.5v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2ZM3 4v1.5h1.5V4H3Zm0 3.25v1.5h1.5v-1.5H3Zm0 3.25V12h1.5v-1.5H3ZM11.5 4v1.5H13V4h-1.5Zm0 3.25v1.5H13v-1.5h-1.5Zm0 3.25V12H13v-1.5h-1.5ZM6.6 5.6v4.8c0 .4.45.65.8.43l3.6-2.4a.5.5 0 0 0 0-.86L7.4 5.17a.5.5 0 0 0-.8.43Z"/>', "tk-fb-i tk-fb-film"),
  pause: svg('<path d="M4.5 3h2a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5Zm5 0h2a.5.5 0 0 1 .5.5v9a.5.5 0 0 1-.5.5h-2a.5.5 0 0 1-.5-.5v-9a.5.5 0 0 1 .5-.5Z"/>', "tk-pl tk-pl-pause"),
  photos: svg('<path d="M4.5 2h7A2.5 2.5 0 0 1 14 4.5v5a2.5 2.5 0 0 1-2.5 2.5h-7A2.5 2.5 0 0 1 2 9.5v-5A2.5 2.5 0 0 1 4.5 2Zm0 1.5a1 1 0 0 0-1 1v4.2l2.1-2.1a1 1 0 0 1 1.4 0l1.6 1.6.6-.6a1 1 0 0 1 1.4 0l1.9 1.9V4.5a1 1 0 0 0-1-1h-7Zm6.25 1a1.25 1.25 0 1 1 0 2.5 1.25 1.25 0 0 1 0-2.5ZM4 13.25h8a.75.75 0 0 1 0 1.5H4a.75.75 0 0 1 0-1.5Z"/>', "tk-fb-i"),
  stack: svg('<path d="M3 4.5A1.5 1.5 0 0 1 4.5 3h7A1.5 1.5 0 0 1 13 4.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 3 11.5v-7Zm-2 1.25a.75.75 0 0 1 1.5 0v6.5c0 .69.56 1.25 1.25 1.25h6.5a.75.75 0 0 1 0 1.5h-6.5A2.75 2.75 0 0 1 1 12.25v-6.5Z"/>', "tk-pl"),
  alert: svg('<path d="M6.46 1.95c.68-1.2 2.4-1.2 3.08 0l5.2 9.24c.67 1.18-.18 2.65-1.54 2.65H2.8c-1.36 0-2.21-1.47-1.54-2.65l5.2-9.24ZM8 5a.75.75 0 0 0-.75.75v3a.75.75 0 0 0 1.5 0v-3A.75.75 0 0 0 8 5Zm0 6.75a.9.9 0 1 0 0-1.8.9.9 0 0 0 0 1.8Z"/>'),
  check: svg('<path d="M13.3 4.3a1 1 0 0 1 0 1.4l-6.5 6.5a1 1 0 0 1-1.4 0L2.7 9.5a1 1 0 1 1 1.4-1.4l2 2 5.8-5.8a1 1 0 0 1 1.4 0Z"/>', "tk-ck-i"),
  down: svg('<path d="M12.78 5.22a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L3.22 6.28a.75.75 0 0 1 1.06-1.06L8 8.94l3.72-3.72a.75.75 0 0 1 1.06 0Z"/>'),
  comment: svg('<path d="M8 2c3.6 0 6.5 2.4 6.5 5.4S11.6 12.8 8 12.8c-.6 0-1.2-.06-1.75-.18L3.4 14.1c-.5.25-1.07-.2-.93-.74l.6-2.3A5.06 5.06 0 0 1 1.5 7.4C1.5 4.4 4.4 2 8 2Z"/>', "tk-chip-i"),
  duet: svg('<path d="M2.5 3h4A1.5 1.5 0 0 1 8 4.5v7A1.5 1.5 0 0 1 6.5 13h-4A1.5 1.5 0 0 1 1 11.5v-7A1.5 1.5 0 0 1 2.5 3Zm7 0h4A1.5 1.5 0 0 1 15 4.5v7a1.5 1.5 0 0 1-1.5 1.5h-4A1.5 1.5 0 0 1 8 11.5v-7A1.5 1.5 0 0 1 9.5 3Zm0 1.5v7h4v-7h-4Z"/>', "tk-chip-i"),
  tag: svg('<path d="M2 3.25C2 2.56 2.56 2 3.25 2h4.13c.33 0 .65.13.88.37l5.37 5.37a1.25 1.25 0 0 1 0 1.77l-4.12 4.12a1.25 1.25 0 0 1-1.77 0L2.37 8.26A1.25 1.25 0 0 1 2 7.38V3.25Zm3 .75a1 1 0 1 0 0 2 1 1 0 0 0 0-2Z"/>', "tk-chip-i"),
  spark: svg('<path d="M7.3 1.9a.75.75 0 0 1 1.4 0l1.08 2.9a2.5 2.5 0 0 0 1.47 1.47l2.9 1.08a.75.75 0 0 1 0 1.4l-2.9 1.08a2.5 2.5 0 0 0-1.47 1.47l-1.08 2.9a.75.75 0 0 1-1.4 0l-1.08-2.9a2.5 2.5 0 0 0-1.47-1.47l-2.9-1.08a.75.75 0 0 1 0-1.4l2.9-1.08a2.5 2.5 0 0 0 1.47-1.47L7.3 1.9Z"/>', "tk-chip-i"),
  stitch: svg('<path d="M4.25 2.5a2.25 2.25 0 0 1 2.1 3.06L8 7.2l4.47-4.47a.75.75 0 1 1 1.06 1.06L9.06 8.25l4.47 4.47a.75.75 0 1 1-1.06 1.06L8 9.3l-1.65 1.65a2.25 2.25 0 1 1-1.06-1.06L6.94 8.25 5.3 6.6A2.25 2.25 0 1 1 4.25 2.5Zm0 1.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 6.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/>', "tk-chip-i"),
  music: svg('<path d="M13.5 2.1v8.4a2.25 2.25 0 1 1-1.5-2.12V5.06L6.5 6.2v6.3A2.25 2.25 0 1 1 5 10.38V4.8c0-.36.25-.67.6-.74l7-1.45a.75.75 0 0 1 .9.74v-1.25Z"/>', "tk-chip-i"),
  brand: svg('<path d="M8 1.5 9.9 5.4l4.3.6-3.1 3 .73 4.3L8 11.28 4.17 13.3l.73-4.3-3.1-3 4.3-.6L8 1.5Z"/>', "tk-chip-i"),
  cloud: svg('<path d="M4.6 13A3.6 3.6 0 0 1 4 5.85 4.5 4.5 0 0 1 12.7 6.6 3.2 3.2 0 0 1 12.2 13H4.6Zm3.1-7.3a.6.6 0 0 0-.6.6v2.9l-.98-.98a.6.6 0 1 0-.85.85l2 2c.23.23.61.23.85 0l2-2a.6.6 0 1 0-.85-.85l-.98.98V6.3a.6.6 0 0 0-.6-.6Z"/>', "tk-i"),
  hand: svg('<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h1.2L8.4 2.3a1 1 0 0 1 1.7.7V5h2.4A1.5 1.5 0 0 1 14 6.5v1.1c0 .2-.04.4-.12.58l-1.7 4A1.5 1.5 0 0 1 10.8 13H4.5A1.5 1.5 0 0 1 3 11.5v-5Z"/>', "tk-chip-i"),
};

type Mode = "direct" | "drafts";

/** The one header line: the integration's mark and the action. */
function head(text: string): string {
  return `<header class="tk-hd">${markHtml()}<h1 class="tk-h">${esc(text)}</h1></header>`;
}

/** A value from the pending call (filled in by card-dom.js through .textContent). */
function value(key: string, o: { empty?: string; cls?: string } = {}): string {
  return `<span${o.cls ? ` class="${esc(o.cls)}"` : ""} data-tk-show="${esc(key)}"${o.empty ? ` data-tk-empty="${esc(o.empty)}"` : ""}></span>`;
}

/**
 * The 9:16 preview tile. card-dom.js plays the decoded micro-preview frames on one canvas (#tk-screen): each
 * frame drifts (a slow Ken Burns push) and cross-fades into the next, developing from a blur on arrival, under
 * a fine grain so the soft frames read as film. The segments at the top show which frame is playing; hovering
 * or clicking pauses. Until then, or without a preview, the fallback shows: a gradient in the card's accent and
 * a film glyph. A landscape video is drawn the way TikTok's feed shows it, centred over a blurred fill.
 */
function tile(): string {
  const fallback = `<div class="tk-fb" aria-hidden="true"><span class="tk-fb-c">${ICON.film}</span><span class="tk-fb-n" id="tk-fb-n"></span></div>`;
  const pill = `<span class="tk-pill tk-num" id="tk-pill" hidden>${ICON.play}${ICON.pause}<span id="tk-pill-t"></span></span>`;
  return `<figure class="tk-tile tk-tile-v" id="tk-tile" aria-hidden="true">${fallback}<div class="tk-frames" id="tk-frames"></div><span class="tk-grain" aria-hidden="true"></span><span class="tk-scrim"></span><div class="tk-prog" id="tk-prog"></div>${pill}</figure>`;
}

/**
 * The photos as an iMessage-style stack: cards fanned behind each other (3:4, or 9:16 when the photos are tall
 * slides or screenshots). card-dom.js builds the cards from the `preview` stack (decoded micro frames, the first
 * five photos in carousel order): every few seconds the top card swipes away to the left and tucks in at the
 * back, through the whole stack; a drag, a click (or Return, Space, the arrow keys) moves it along by hand, and
 * hovering or focusing it pauses the loop. With reduced motion the photos cross-fade in place. Until then, or
 * without a preview, designed placeholder cards show the photos glyph and the count.
 */
function stack(): string {
  const fallback = [2, 1, 0]
    .map((slot) =>
      slot === 0
        ? `<div class="tk-sc tk-s0 tk-fbc"><span class="tk-fb-c">${ICON.photos}</span><span class="tk-fbc-n" id="tk-fbc-n"></span><span class="tk-sc-p tk-num">${ICON.stack}<b class="tk-tile-n" id="tk-tile-n"></b></span></div>`
        : `<div class="tk-sc tk-s${slot} tk-fbc"></div>`,
    )
    .join("");
  return `<div class="tk-stack" id="tk-stack" role="group" aria-label="Photos in this post" aria-roledescription="photo stack"><div class="tk-stk" id="tk-stk">${fallback}</div><div class="tk-stk-dots" id="tk-stk-dots" aria-hidden="true"></div><span class="tk-sr" id="tk-stk-live" aria-live="polite"></span></div>`;
}

/** "Tiny AI Lab" / "@maya", with a monogram (card-dom.js fills #tk-av). */
function who(key: string, optional = false): string {
  return `<div class="tk-who"${optional ? ` data-tk-hide-empty="${esc(key)}"` : ""}><span class="tk-av" id="tk-av" aria-hidden="true"></span>${value(key, {
    empty: optional ? undefined : "—",
    cls: "tk-who-t",
  })}</div>`;
}

/** Who can view: only the creator's options, none chosen until the user picks (TikTok's rule). */
function privacy(): string {
  return `<div class="tk-priv" id="tk-priv"><div class="tk-priv-h"><span class="tk-priv-l" id="tk-priv-l">Who can view</span><span class="tk-prompt" id="tk-priv-prompt" aria-live="polite" hidden>Pick one</span></div>
<div class="tk-seg" id="tk-seg" role="radiogroup" aria-labelledby="tk-priv-l"></div>
<p class="tk-msg tk-warn-t" id="tk-priv-note" aria-live="polite" hidden></p></div>`;
}

/** The media and the facts beside it. `meta` is one line of small values joined by dots. */
function top(kind: "video" | "photo", main: string, meta: string, account: string, extra = ""): string {
  return `<section class="tk-top tk-top-${kind}">${kind === "video" ? tile() : stack()}<div class="tk-facts"><div class="tk-id"><div class="tk-name">${main}</div>${
    meta ? `<div class="tk-meta tk-num">${meta}</div>` : ""
  }${account}</div>${extra}</div></section>`;
}

/**
 * Photos leave the Mac before TikTok has them: they're put on a short-lived web host for TikTok to pull. The
 * one line of fine print the photo cards keep, so nobody approves that without seeing it.
 */
export const RELAY_LINE = "Photos are hosted briefly for TikTok to fetch, then deleted.";
function relayLine(): string {
  return `<p class="tk-fine" id="tk-relay">${ICON.cloud}<span>${esc(RELAY_LINE)}</span></p>`;
}

function warning(): string {
  return `<p class="tk-warning" role="note" data-tk-hide-empty="warning" hidden>${ICON.alert}<span data-tk-show="warning"></span></p>`;
}

interface FieldOptions {
  key: "caption" | "title" | "description";
  /** The accessible name (the box shows a placeholder, not a label). */
  name: string;
  placeholder: string;
  /** One line only (a photo title): Return is ignored, the counter sits inside the line. */
  line?: boolean;
  /** Tint #hashtags and @mentions (a mirror under the text; card-dom.js paints it with text nodes). */
  tags?: boolean;
  /** Grow to this many lines, then scroll inside the box. */
  lines?: number;
}

/** One editable text inside the composer box: starts one line tall, grows with its content up to `lines`. */
function editor(o: FieldOptions): string {
  const k = esc(o.key);
  const input = `<textarea class="tk-in${o.line ? " tk-in-line" : ""}" id="tk-in-${k}" data-tk-key="${k}" data-tk-text data-tk-grow data-tk-lines="${o.line ? 1 : (o.lines ?? 5)}"${
    o.line ? " data-tk-line" : ""
  }${o.tags ? ` data-tk-tags="tk-hl-${k}"` : ""} rows="1" maxlength="16384" spellcheck="true" placeholder="${esc(o.placeholder)}" aria-label="${esc(o.name)}" aria-describedby="tk-e-${k}"></textarea>`;
  const mirror = o.tags ? `<div class="tk-hl" id="tk-hl-${k}" aria-hidden="true"></div>` : "";
  const count = `<span class="tk-count${o.line ? " tk-count-in" : ""}" id="tk-n-${k}" aria-live="polite" hidden></span>`;
  return `<div class="tk-ed tk-ed-${k}">${mirror}${input}${o.line ? count : ""}</div>`;
}

/** The errors, counters and "too long" notes under the composer, shown only when they apply. */
function notes(fields: FieldOptions[]): string {
  return `<div class="tk-f-ft">${fields
    .map((f) => {
      const k = esc(f.key);
      return `<span class="tk-long" id="tk-l-${k}" hidden>Too long to edit here.</span><span class="tk-err" id="tk-e-${k}" role="alert" hidden></span>${
        f.line ? "" : `<span class="tk-count" id="tk-n-${k}" aria-live="polite" hidden></span>`
      }`;
    })
    .join("")}</div>`;
}

/** The composer: one rounded box holding the text fields (and the drafts card's Copy caption row). */
function composer(fields: FieldOptions[], o: { label?: string; attach?: string } = {}): string {
  return `<div class="tk-f">${o.label ? `<span class="tk-f-l">${esc(o.label)}</span>` : ""}<div class="tk-box">${fields.map(editor).join("")}${o.attach ?? ""}</div>${notes(fields)}</div>`;
}

/** A settings row inside the composer box (Copy caption): a label and an iOS-style switch. */
function switchRow(key: string, label: string): string {
  const k = esc(key);
  return `<label class="tk-tg" id="tk-r-${k}"><span class="tk-tg-t">${esc(label)}</span><span class="tk-sr" id="tk-t-${k}" hidden></span><input type="checkbox" role="switch" data-tk-key="${k}" data-tk-box aria-describedby="tk-t-${k}"><span class="tk-sw" aria-hidden="true"></span></label>`;
}

interface ChipOptions {
  key: string;
  /** The short visible label ("Duet"). */
  label: string;
  /** The full name ("Allow Duet"): the control's accessible name and tooltip. */
  name: string;
  /** How the screen-reader note names it when the creator turned it off ("Comment is turned off"); the label otherwise. */
  gate?: string;
  icon: string;
  /** A checkbox inside the disclosure options rather than a switch. */
  check?: boolean;
}

/** A setting as a toggle chip: off by default, greyed and struck through when the creator turned it off. */
function chip(o: ChipOptions): string {
  const k = esc(o.key);
  return `<label class="tk-chip${o.check ? " tk-chip-ck" : ""}" id="tk-r-${k}" data-tk-name="${esc(o.gate ?? o.label)}" title="${esc(o.name)}"><input type="checkbox"${
    o.check ? "" : ' role="switch"'
  } data-tk-key="${k}" data-tk-box aria-label="${esc(o.name)}" aria-describedby="tk-t-${k}">${o.icon}<span class="tk-chip-t">${esc(o.label)}</span><span class="tk-sr" id="tk-t-${k}" hidden></span></label>`;
}

function chips(list: ChipOptions[], label?: string): string {
  const id = label ? `tk-cl-${esc(list[0].key)}` : "";
  // An unlabeled row keeps the label column empty, so its chips line up under the row above.
  return `<div class="tk-row">${label ? `<span class="tk-row-l" id="${id}">${esc(label)}</span>` : '<span class="tk-row-l" aria-hidden="true"></span>'}<div class="tk-chips" role="group"${
    id ? ` aria-labelledby="${id}"` : ' aria-label="Post settings"'
  }>${list.map(chip).join("")}</div></div>`;
}

const COMMERCIAL: ChipOptions = { key: "commercial_disclosure", label: "Commercial content", name: "Disclose commercial content", icon: ICON.tag };

/** The brand options TikTok asks for once commercial content is disclosed, and the label lines it requires. */
function brandOptions(photo: boolean): string {
  return `<div class="tk-disc" id="tk-disc-body" hidden><div class="tk-chips" role="group" aria-label="What the post promotes">${chip({
    key: "brand_organic",
    label: "Your brand",
    name: "Your brand: you're promoting yourself or your own business",
    icon: ICON.hand,
    check: true,
  })}${chip({ key: "brand_content", label: "Branded content", name: "Branded content: you're promoting another brand or a third party", icon: ICON.brand, check: true })}</div>
<p class="tk-msg tk-warn-t" id="tk-disc-hint" aria-live="polite" hidden></p>
<p class="tk-msg tk-warn-t" id="tk-disc-bc" aria-live="polite" hidden></p>
<p class="tk-msg tk-label" id="tk-disc-label" aria-live="polite" hidden></p>${
    photo ? `<p class="tk-msg" id="tk-disc-music" hidden>${esc("For promotional posts, pick music from TikTok's Commercial Music Library in the app.")}</p>` : ""
  }</div>`;
}

/** The settings: interactions (Allow …) and the labels, as two rows of chips; the brand options open under them. */
function settings(photo: boolean): string {
  const allow: ChipOptions[] = photo
    ? [{ key: "allow_comment", label: "Comments", name: "Allow comments", gate: "Comment", icon: ICON.comment }]
    : [
        { key: "allow_comment", label: "Comments", name: "Allow comments", gate: "Comment", icon: ICON.comment },
        { key: "allow_duet", label: "Duet", name: "Allow Duet", icon: ICON.duet },
        { key: "allow_stitch", label: "Stitch", name: "Allow Stitch", icon: ICON.stitch },
      ];
  const extras: ChipOptions[] = photo
    ? [{ key: "auto_add_music", label: "Add music", name: "Add recommended music (you can change it in TikTok later)", icon: ICON.music }, COMMERCIAL]
    : [{ key: "is_aigc", label: "AI-generated", name: "Label as AI-generated content", icon: ICON.spark }, COMMERCIAL];
  return `<div class="tk-set">${chips(allow, "Allow")}${chips(extras)}<p class="tk-sr" id="tk-gate-note" aria-live="polite" hidden></p>${brandOptions(photo)}</div>`;
}

/** Always visible beside VoiceOS's Post button: the declaration TikTok requires before posting. */
function consent(): string {
  return `<footer class="tk-foot" id="tk-foot"><p class="tk-consent">${esc("By posting, you agree to TikTok's")} <span id="tk-consent-bc" hidden><a href="${esc(
    POLICY_URLS.branded,
  )}">Branded Content Policy</a> and </span><a href="${esc(POLICY_URLS.music)}">Music Usage Confirmation</a>.</p></footer>`;
}

function card(tool: WriteTool, mode: Mode, inner: string, foot = ""): string {
  // Drafts cards have no consent footer; an opaque band keeps content from running under VoiceOS's button instead.
  // "More below" sits inside that band (drafts) or beside VoiceOS's button in the footer (direct), never over content.
  const band = foot ? "" : '<div class="tk-band" aria-hidden="true"></div>';
  return `<div class="tk-c tk-${mode}" id="tk-c" aria-describedby="tk-note"><p class="tk-sr" id="tk-note">${esc(NOTES[tool])}</p>${inner}</div>${foot}${band}<button type="button" class="tk-more tk-more-${mode}" id="tk-more" title="More below" hidden>${ICON.down}<span class="tk-more-t">More below</span></button>`;
}

const CAPTION: FieldOptions = { key: "caption", name: "Caption", placeholder: "Add a caption, #hashtags, @mentions", tags: true, lines: 5 };
const TITLE: FieldOptions = { key: "title", name: "Title", placeholder: "Add a title", line: true };
const DESCRIPTION: FieldOptions = { key: "description", name: "Description", placeholder: "Add a description, #hashtags, @mentions", tags: true, lines: 4 };

export function cardBody(tool: WriteTool): string {
  switch (tool) {
    case "publish_video":
      return card(
        tool,
        "direct",
        [
          head("Post to TikTok"),
          top(
            "video",
            value("file_name", { empty: "—" }),
            `<span data-tk-hide-empty="cover_label">Cover ${value("cover_label")}</span>`,
            who("creator_nickname"),
            privacy(),
          ),
          composer([CAPTION]),
          settings(false),
        ].join("\n"),
        consent(),
      );
    case "upload_video":
      return card(
        tool,
        "drafts",
        [
          head("Send to TikTok drafts"),
          top("video", value("file_name", { empty: "—" }), value("size_label"), who("account_label", true)),
          composer([{ ...CAPTION, placeholder: "Add a caption to paste in TikTok" }], {
            label: "Caption to paste in TikTok",
            attach: switchRow("copy_caption", "Copy it to my clipboard after sending"),
          }),
        ].join("\n"),
      );
    case "post_photos":
      return card(
        tool,
        "direct",
        [
          head("Post photos to TikTok"),
          top("photo", value("count_label", { empty: "—" }), value("order_label"), who("creator_nickname"), privacy()),
          relayLine(),
          warning(),
          composer([TITLE, DESCRIPTION]),
          settings(true),
        ].join("\n"),
        consent(),
      );
    case "upload_photos":
      return card(
        tool,
        "drafts",
        [
          head("Send photos to TikTok drafts"),
          top("photo", value("count_label", { empty: "—" }), value("order_label"), who("account_label", true)),
          relayLine(),
          warning(),
          composer([TITLE, DESCRIPTION]),
        ].join("\n"),
      );
  }
  throw new Error(`No confirmation card for ${String(tool)}`);
}
