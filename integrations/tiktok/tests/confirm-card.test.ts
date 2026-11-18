import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import TKR from "../src/receiptCoreScript.ts";
import { PRIVACY_LABELS } from "../src/errors.ts";
import type { WriteTool } from "../src/types.ts";
import { esc } from "../widgetKit.ts";
import { CARD_DOM_JS, CARD_KEYS, CARD_LOGIC_JS, RECEIPT_CORE_JS, buildConfirmation } from "../confirm-card/build.ts";
import {
  MICRO_PREVIEW_DECODER_JS,
  encodeMicroFrame,
  encodePhotoFrame,
  encodeStackFrame,
  encodeVideoFrame,
  joinMicroPreview,
  joinPhotoStack,
  joinStack,
  joinVideoPreview,
} from "../src/microPreview.ts";
import { NOTES, POLICY_URLS } from "../confirm-card/markup.ts";

const TOOLS: WriteTool[] = ["publish_video", "upload_video", "post_photos", "upload_photos"];
const TTL = 600_000;

/** The contract's inputSchema properties for the four writes (contract.md, "The 12 tools"). */
const SCHEMA_PROPS: Record<WriteTool, string[]> = {
  upload_video: ["file_token", "confirmation_receipt", "file_name", "account_label", "duration_label", "size_label", "preview", "caption", "copy_caption", "hashtags", "mentions"],
  publish_video: [
    "post_token", "file_token", "confirmation_receipt", "file_name", "preview", "creator_nickname", "privacy_options", "comment_disabled",
    "duet_disabled", "stitch_disabled", "max_duration_sec", "caption", "privacy_level", "allow_comment", "allow_duet", "allow_stitch",
    "commercial_disclosure", "brand_organic", "brand_content", "is_aigc", "cover_ms", "cover_label", "hashtags", "mentions",
  ],
  upload_photos: ["bundle_token", "confirmation_receipt", "preview", "count_label", "order_label", "warning", "account_label", "title", "description", "hashtags", "mentions"],
  post_photos: [
    "bundle_token", "post_token", "confirmation_receipt", "preview", "count_label", "order_label", "warning", "creator_nickname", "privacy_options",
    "comment_disabled", "title", "description", "privacy_level", "allow_comment", "auto_add_music", "commercial_disclosure",
    "brand_organic", "brand_content", "hashtags", "mentions",
  ],
};

const SPEC: Record<WriteTool, { confirmLabel: string; label: string; height: number }> = {
  // Measured in the preview harness, both themes: the compact cards fit the notch without scrolling.
  publish_video: { confirmLabel: "Post", label: "Confirm posting a video to TikTok", height: 376 },
  upload_video: { confirmLabel: "Send to drafts", label: "Confirm sending a video to TikTok drafts", height: 340 },
  post_photos: { confirmLabel: "Post", label: "Confirm posting photos to TikTok", height: 415 },
  upload_photos: { confirmLabel: "Send to drafts", label: "Confirm sending photos to TikTok drafts", height: 342 },
};

type View = any;
const TKC = vm.runInNewContext(`${CARD_LOGIC_JS}\n;TKC`) as {
  LIMITS: Record<string, number>;
  COPY: Record<string, string>;
  options(v: unknown): string[];
  label(code: string): string;
  textInfo(field: string, v: unknown): { length: number; limit: number; show: boolean; over: boolean; counter: string; error: string; readOnly: boolean };
  settle(tool: string, a: Record<string, unknown>, changed: string | null): Record<string, string>;
  view(tool: string, a: Record<string, unknown>): View;
};
const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x));
/** The card's markup without any <script> (the inlined scripts carry copy and comments of their own). */
const markupOf = (html: string) => html.slice(html.indexOf("<body>"), html.lastIndexOf("</body>")).replace(/<script>[\s\S]*?<\/script>/g, "");

describe("built confirmation views", () => {
  for (const tool of TOOLS) {
    test(`${tool}: one widget with the brief's labels and its measured height`, () => {
      const view = buildConfirmation(tool);
      expect(view.schemaVersion).toBe(1);
      expect(view.root.type).toBe("widget");
      expect(view.root.confirmLabel).toBe(SPEC[tool].confirmLabel);
      expect(view.root.label).toBe(SPEC[tool].label);
      expect(view.root.height).toBe(SPEC[tool].height);
      expect(view.root.height).toBeGreaterThanOrEqual(60);
      expect(view.root.height).toBeLessThanOrEqual(420);
      expect(view.root.confirmLabel.length).toBeLessThanOrEqual(60);
      expect(view.root.label.length).toBeLessThanOrEqual(60);
      expect(view.root.html.length).toBeLessThanOrEqual(300_000);
      expect(view.root.html.startsWith("<!doctype html>")).toBe(true);
      expect(view.root.html).toContain('class="k-cwrap k-confirm"');
    });
  }

  test("an unknown tool has no card", () => {
    expect(() => buildConfirmation("get_user_stats" as WriteTool)).toThrow();
  });
});

describe("receipt core and keys", () => {
  test("RECEIPT_CORE_JS is the exact text of src/receiptCoreScript.ts between the markers", () => {
    const file = readFileSync(new URL("../src/receiptCoreScript.ts", import.meta.url), "utf8");
    const start = file.indexOf("var TKR = (function () {");
    expect(start).toBeGreaterThan(-1);
    expect(RECEIPT_CORE_JS).toBe(file.slice(start, file.lastIndexOf("\nexport default TKR;")));
    expect(RECEIPT_CORE_JS.endsWith("})();")).toBe(true);
    // The inlined text behaves exactly like the module the server imports.
    const card = vm.runInNewContext(`${RECEIPT_CORE_JS}\n;TKR`) as typeof TKR;
    const a = { file_token: "ft1.a", caption: "hi\r\nthere", copy_caption: "true" };
    const nonce = "0123456789abcdef0123456789abcdef";
    expect(card.mint("upload_video", a, 1_762_000_000_000, nonce)).toBe(TKR.mint("upload_video", a, 1_762_000_000_000, nonce));
  });

  for (const tool of TOOLS) {
    test(`${tool}: inlines the receipt core and only touches its own arguments`, () => {
      const html = buildConfirmation(tool).root.html;
      expect(html).toContain(RECEIPT_CORE_JS);
      expect(html).toContain(MICRO_PREVIEW_DECODER_JS);
      expect(html).toContain(CARD_LOGIC_JS);
      expect(html).toContain(CARD_DOM_JS);
      expect(html).toContain("voiceos-tiktok-receipt-v1");
      expect(html).toContain(`var TK_TOOL = "${tool}";`);

      const keys = CARD_KEYS[tool];
      expect(keys).toContain("confirmation_receipt");
      for (const k of keys) expect(SCHEMA_PROPS[tool]).toContain(k);
      // The receipt signs these, so the card must read every one of them.
      for (const [field] of (TKR.SPECS as Record<string, [string, string][]>)[tool]) expect(keys).toContain(field);
      const used = [...html.matchAll(/data-tk-(?:key|show|hide-empty)="([^"]+)"/g)].map((m) => m[1]);
      expect(used.length).toBeGreaterThan(0);
      for (const k of used) expect(keys).toContain(k);
      // The Widget Kit's bridge sets .value on these attributes (wrong for checkboxes): never use them.
      expect(html).not.toMatch(/data-(?:voiceos|k)-key="/);
    });
  }
});

describe("share-review and sandbox rules", () => {
  for (const tool of TOOLS) {
    test(`${tool}: no code from strings, no markup injection, no network`, () => {
      const html = buildConfirmation(tool).root.html;
      expect(html).not.toMatch(/(?<![\w$])eval\s*\(|new\s+Function\b|(?<![\w.$])Function\s*\(|set(?:Timeout|Interval)\s*\(\s*["'`]/);
      for (const js of [CARD_LOGIC_JS, CARD_DOM_JS]) expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\b/);
      expect(html).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|@import|url\(\s*["']?https?:|src="https?:/i);
      const hrefs = [...markupOf(html).matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
      expect(hrefs.length).toBe(tool === "publish_video" || tool === "post_photos" ? 2 : 0);
      for (const h of hrefs) expect([POLICY_URLS.music, POLICY_URLS.branded]).toContain(h as never);
      // VoiceOS owns approval: the only button is the "More below" hint, and there's no Cancel.
      expect([...html.matchAll(/<button\b/g)].length).toBe(1);
      expect(html).toContain('id="tk-more"');
      expect(html).not.toMatch(/>\s*Cancel\s*</);
    });
  }

  test("card scripts are plain ES5", () => {
    for (const js of [CARD_LOGIC_JS, CARD_DOM_JS]) {
      new vm.Script(js); // parses
      const code = js.replace(/\/\/[^\n]*/g, "").replace(/"(?:[^"\\\n]|\\.)*"/g, '""');
      expect(code).not.toMatch(/=>|`|\blet\b|\bconst\b|\bclass\b|\.\.\.|\basync\b|\bawait\b|for\s*\([^)]*\bof\b/);
    }
    for (const tool of TOOLS) {
      const scripts = [...buildConfirmation(tool).root.html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
      expect(scripts.length).toBe(2); // ours, then the Widget Kit's bridge
      for (const s of scripts) new vm.Script(s);
    }
  });
});

describe("TKC: privacy options", () => {
  test("only the creator's options, most public first, with plain labels", () => {
    expect(TKC.options(["SELF_ONLY", "PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS"])).toEqual(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"]);
    expect(TKC.options(["SELF_ONLY", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR"])).toEqual(["FOLLOWER_OF_CREATOR", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"]);
    expect(TKC.options(" self_only , SELF_ONLY,,public_to_everyone")).toEqual(["PUBLIC_TO_EVERYONE", "SELF_ONLY"]);
    expect(TKC.options(["NEW_AUDIENCE", "SELF_ONLY"])).toEqual(["SELF_ONLY", "NEW_AUDIENCE"]);
    expect(TKC.options(undefined)).toEqual([]);
    for (const [code, label] of Object.entries(PRIVACY_LABELS)) expect(TKC.label(code)).toBe(label);
    expect(TKC.label("NEW_AUDIENCE")).toBe("New audience");
    const v = TKC.view("publish_video", { privacy_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS"] });
    expect(v.privacy.items.map((i: { label: string }) => i.label)).toEqual(["Everyone", "Friends", "Only me"]);
  });

  test("nothing is selected by default, and the card asks until the user picks", () => {
    const v = TKC.view("publish_video", { privacy_options: ["SELF_ONLY"] });
    expect(plain(v.privacy.items)).toEqual([{ value: "SELF_ONLY", label: "Only me", checked: false, disabled: false }]);
    expect(v.privacy.prompt).toBe("Pick who can see this post");
    const picked = TKC.view("post_photos", { privacy_options: ["SELF_ONLY"], privacy_level: "SELF_ONLY" });
    expect(picked.privacy.items[0].checked).toBe(true);
    expect(picked.privacy.prompt).toBe("");
  });

  test("a privacy level that isn't one of the options is cleared, a valid one canonicalized", () => {
    const a = { privacy_options: ["SELF_ONLY"], privacy_level: "PUBLIC_TO_EVERYONE" };
    expect(TKC.settle("publish_video", a, null)).toEqual({ privacy_level: "" });
    expect(TKC.view("publish_video", a).privacy.selected).toBe("");
    expect(TKC.settle("post_photos", { privacy_options: "SELF_ONLY", privacy_level: " self_only " }, null)).toEqual({ privacy_level: "SELF_ONLY" });
    expect(TKC.settle("publish_video", { privacy_options: ["SELF_ONLY"], privacy_level: "" }, null)).toEqual({});
    expect(TKC.settle("publish_video", { privacy_options: ["SELF_ONLY"] }, null)).toEqual({});
  });

  test("missing options say how to recover", () => {
    const v = TKC.view("publish_video", {});
    expect(v.privacy.items).toEqual([]);
    expect(v.privacy.prompt).toBe("");
    expect(v.privacy.note).toBe("TikTok's privacy options are missing. Ask again and I'll refresh your options.");
  });
});

describe("TKC: interactions", () => {
  test("off by default; creator-disabled ones are greyed out and staged off", () => {
    const a = { comment_disabled: false, duet_disabled: true, stitch_disabled: "true", allow_duet: true };
    expect(TKC.settle("publish_video", a, null)).toEqual({ allow_duet: "false", allow_stitch: "false" });
    const v = TKC.view("publish_video", a);
    expect(plain(v.toggles.allow_comment)).toEqual({ on: false, disabled: false, note: "" });
    expect(plain(v.toggles.allow_duet)).toEqual({ on: false, disabled: true, note: "Turned off for this account" });
    expect(plain(v.toggles.allow_stitch)).toEqual({ on: false, disabled: true, note: "Turned off for this account" });
    expect(TKC.view("publish_video", { allow_comment: "true" }).toggles.allow_comment.on).toBe(true);
    // Toggles read exactly like the receipt core: true or "true".
    expect(TKC.view("publish_video", { allow_comment: "TRUE" }).toggles.allow_comment.on).toBe(false);
    expect(TKC.view("publish_video", { is_aigc: true }).toggles.is_aigc.on).toBe(true);
  });

  test("photos get only Allow comments and recommended music; no Duet, Stitch or AI", () => {
    const v = TKC.view("post_photos", { comment_disabled: true, allow_comment: "true" });
    expect(Object.keys(v.toggles).sort()).toEqual(["allow_comment", "auto_add_music", "brand_content", "brand_organic", "commercial_disclosure"]);
    expect(plain(v.toggles.allow_comment)).toEqual({ on: false, disabled: true, note: "Turned off for this account" });
    expect(TKC.settle("post_photos", { comment_disabled: true, allow_comment: "true" }, null)).toEqual({ allow_comment: "false" });
    expect(TKC.view("upload_video", { copy_caption: "true" }).toggles.copy_caption.on).toBe(true);
    expect(TKC.settle("upload_video", { copy_caption: "true" }, null)).toEqual({});
  });
});

describe("TKC: commercial content disclosure", () => {
  const audited = { privacy_options: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"] };

  test("on with nothing picked shows TikTok's hint; label prompts follow the choice", () => {
    let v = TKC.view("publish_video", { ...audited, commercial_disclosure: "true" });
    expect(v.disclosure.hint).toBe("You need to indicate if your content promotes yourself, a third party, or both.");
    expect(v.disclosure.label).toBe("");
    v = TKC.view("publish_video", { ...audited, commercial_disclosure: "true", brand_organic: "true" });
    expect(v.disclosure.hint).toBe("");
    expect(v.disclosure.label).toBe("Your video will be labeled 'Promotional content'. The label can't be changed after posting.");
    v = TKC.view("publish_video", { ...audited, commercial_disclosure: "true", brand_content: "true" });
    expect(v.disclosure.label).toBe("Your video will be labeled 'Paid partnership'. The label can't be changed after posting.");
    v = TKC.view("post_photos", { ...audited, commercial_disclosure: "true", brand_organic: "true", brand_content: "true" });
    expect(v.disclosure.label).toBe("Your photo will be labeled 'Paid partnership'. The label can't be changed after posting.");
    expect(v.disclosure.music).toBe("For promotional posts, pick music from TikTok's Commercial Music Library in the app instead of recommended music.");
    expect(TKC.view("publish_video", { ...audited, commercial_disclosure: "true" }).disclosure.music).toBe("");
    expect(TKC.view("post_photos", audited).disclosure.music).toBe("");
  });

  test("the consent line switches only for Branded content", () => {
    const plainLine = "By posting, you agree to TikTok's Music Usage Confirmation.";
    const branded = "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation.";
    for (const tool of ["publish_video", "post_photos"]) {
      expect(TKC.view(tool, audited).consent).toBe(plainLine);
      expect(TKC.view(tool, { ...audited, commercial_disclosure: "true", brand_organic: "true" }).consent).toBe(plainLine);
      expect(TKC.view(tool, { ...audited, commercial_disclosure: "true", brand_content: "true" }).consent).toBe(branded);
      expect(TKC.view(tool, { ...audited, commercial_disclosure: "true", brand_organic: true, brand_content: true }).consent).toBe(branded);
    }
    expect(TKC.view("upload_video", {}).consent).toBeUndefined();
  });

  test("Branded content and Only me exclude each other", () => {
    // Branded first: Only me is disabled with TikTok's text.
    let v = TKC.view("publish_video", { ...audited, commercial_disclosure: "true", brand_content: "true" });
    expect(v.privacy.items.find((i: { value: string }) => i.value === "SELF_ONLY").disabled).toBe(true);
    expect(v.privacy.items.filter((i: { disabled: boolean }) => i.disabled).length).toBe(1);
    expect(v.privacy.note).toBe("Branded content visibility cannot be set to private.");
    // Only me first: Branded content is disabled.
    v = TKC.view("publish_video", { ...audited, privacy_level: "SELF_ONLY", commercial_disclosure: "true" });
    expect(plain(v.toggles.brand_content)).toEqual({ on: false, disabled: true, note: "Branded content can't be private." });
    // Unaudited (Only me is the only option) with Branded content on: say why nothing can be picked.
    v = TKC.view("post_photos", { privacy_options: ["SELF_ONLY"], commercial_disclosure: "true", brand_content: "true" });
    expect(v.privacy.prompt).toBe("");
    expect(v.privacy.note).toBe("Until TikTok approves this app, posts can only be 'Only me'. Send it to drafts and post it from the TikTok app, or turn off Branded content.");
  });

  test("a disclosure the agent proposed is kept, never silently dropped", () => {
    // Brand options without the switch: the switch comes on.
    expect(TKC.settle("publish_video", { brand_content: true }, null)).toEqual({ commercial_disclosure: "true" });
    // Branded content with Only me: privacy is cleared rather than the disclosure.
    expect(TKC.settle("publish_video", { ...audited, privacy_level: "SELF_ONLY", commercial_disclosure: "true", brand_content: "true" }, null)).toEqual({ privacy_level: "" });
    // The user switching disclosure off clears both options.
    expect(TKC.settle("post_photos", { commercial_disclosure: "false", brand_organic: "true", brand_content: "true" }, "commercial_disclosure")).toEqual({ brand_organic: "false", brand_content: "false" });
    // Settling is idempotent.
    const a: Record<string, unknown> = { ...audited, privacy_level: "SELF_ONLY", brand_content: "true", duet_disabled: true, allow_duet: "true" };
    Object.assign(a, TKC.settle("publish_video", a, null));
    expect(TKC.settle("publish_video", a, null)).toEqual({});
    // Drafts have no privacy or disclosure rules.
    expect(TKC.settle("upload_photos", { privacy_level: "PUBLIC_TO_EVERYONE" }, null)).toEqual({});
  });
});

describe("TKC: text limits (UTF-16, as TikTok counts)", () => {
  test("caption counter past 1,980 and an error past 2,200", () => {
    expect(TKC.textInfo("caption", "a".repeat(1980)).show).toBe(false);
    const near = TKC.textInfo("caption", "a".repeat(1981));
    expect([near.show, near.over, near.counter]).toEqual([true, false, "1,981 / 2,200"]);
    const over = TKC.textInfo("caption", "a".repeat(2201));
    expect([over.over, over.counter, over.error]).toEqual([true, "2,201 / 2,200", "Too long for TikTok: shorten it to 2,200 characters (emoji count as 2)."]);
    expect(TKC.textInfo("caption", "🎉".repeat(1100)).length).toBe(2200);
    expect(TKC.textInfo("caption", "🎉".repeat(1101)).over).toBe(true);
    expect(TKC.textInfo("caption", "a\r\nb").length).toBe(3);
    expect(TKC.textInfo("caption", undefined).length).toBe(0);
  });

  test("photo title (90, counter always) and description (4,000)", () => {
    expect([TKC.textInfo("title", "").show, TKC.textInfo("title", "").counter]).toEqual([true, "0 / 90"]);
    expect(TKC.textInfo("title", "x".repeat(91)).error).toBe("Too long for TikTok: shorten it to 90 characters (emoji count as 2).");
    expect(TKC.textInfo("description", "x".repeat(3600)).show).toBe(false);
    expect(TKC.textInfo("description", "x".repeat(3601)).counter).toBe("3,601 / 4,000");
    expect(TKC.textInfo("description", "x".repeat(4001)).over).toBe(true);
    expect(TKC.textInfo("description", "x".repeat(16_385)).readOnly).toBe(true);
    expect(TKC.LIMITS).toEqual({ caption: 2200, title: 90, description: 4000 });
  });
});

describe("copy on the cards", () => {
  const html = (tool: WriteTool) => buildConfirmation(tool).root.html;
  test("direct-post cards", () => {
    for (const tool of ["publish_video", "post_photos"] as WriteTool[]) {
      const h = html(tool);
      for (const s of ["Allow comments", "Disclose commercial content", "Commercial content", "Your brand", "Branded content", "Who can view", "Pick one"]) expect(h).toContain(esc(s));
      // What happens on approval is the card's accessible description, not printed copy under the title.
      expect(h).toContain(`aria-describedby="tk-note"><p class="tk-sr" id="tk-note">${esc(NOTES[tool])}</p>`);
      expect(markupOf(h)).not.toContain("tk-lede");
      expect(h).toContain(`By posting, you agree to TikTok&#39;s <span id="tk-consent-bc" hidden><a href="${POLICY_URLS.branded}">Branded Content Policy</a> and </span><a href="${POLICY_URLS.music}">Music Usage Confirmation</a>.`);
    }
    const v = html("publish_video");
    for (const s of ["Post to TikTok", "Allow Duet", "Allow Stitch", "AI-generated", "Label as AI-generated content", 'data-tk-show="file_name"', 'data-tk-show="creator_nickname"', 'data-tk-hide-empty="cover_label"']) expect(v).toContain(s);
    const p = html("post_photos");
    for (const s of ["Post photos to TikTok", "Add music", esc("Add recommended music (you can change it in TikTok later)"), 'data-tk-show="creator_nickname"', 'data-tk-show="count_label"', 'data-tk-show="order_label"', 'data-tk-show="warning"']) expect(p).toContain(s);
    for (const s of ["Allow Duet", "Allow Stitch", "AI-generated", "is_aigc"]) expect(markupOf(p)).not.toContain(s);
  });

  test("drafts cards promise no caption or privacy in TikTok", () => {
    const v = html("upload_video");
    // The one line that matters on a video draft: the caption isn't sent, it's for pasting in TikTok.
    for (const s of ["Send to TikTok drafts", "Caption to paste in TikTok", "Copy it to my clipboard after sending", 'data-tk-show="size_label"', 'data-tk-hide-empty="account_label"']) expect(v).toContain(s);
    expect(v).toContain(`<p class="tk-sr" id="tk-note">${esc(NOTES.upload_video)}</p>`);
    const p = html("upload_photos");
    for (const s of ["Send photos to TikTok drafts", 'aria-label="Title"', 'aria-label="Description"', 'data-tk-show="warning"']) expect(p).toContain(s);
    expect(p).toContain(`<p class="tk-sr" id="tk-note">${esc(NOTES.upload_photos)}</p>`);
    for (const h of [markupOf(v), markupOf(p)]) {
      // No consent footer; a fade band keeps content from running hard under VoiceOS's button.
      expect(h).toContain('class="tk-band"');
      expect(h).not.toContain("tk-foot");
      expect(h).not.toContain("Who can view");
      expect(h).not.toContain("By posting");
    }
  });
});

// ---------------------------------------------------------------------------
// End to end: the card's own scripts against a small fake DOM built from its markup.
// ---------------------------------------------------------------------------

const VOID = new Set(["input", "img", "br", "meta", "hr", "link", "source"]);
const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) => ENTITY[e]);

class FakeText {
  parentNode: FakeEl | null = null;
  constructor(public data: string) {}
  get textContent() {
    return this.data;
  }
}

class FakeEl {
  attrs = new Map<string, string>();
  children: Array<FakeEl | FakeText> = [];
  parentNode: FakeEl | null = null;
  style: Record<string, unknown> = { setProperty: () => {} };
  private _checked = false;
  private _value: string | undefined;
  constructor(public tag: string) {}
  get tagName() {
    return this.tag.toUpperCase();
  }
  getAttribute(n: string) {
    return this.attrs.has(n) ? (this.attrs.get(n) as string) : null;
  }
  setAttribute(n: string, v: unknown) {
    this.attrs.set(n, String(v));
    if (n === "checked") this._checked = true;
  }
  removeAttribute(n: string) {
    this.attrs.delete(n);
  }
  hasAttribute(n: string) {
    return this.attrs.has(n);
  }
  private flag(n: string, on: boolean) {
    if (on) this.attrs.set(n, "");
    else this.attrs.delete(n);
  }
  get hidden() {
    return this.attrs.has("hidden");
  }
  set hidden(v: boolean) {
    this.flag("hidden", !!v);
  }
  get disabled() {
    return this.attrs.has("disabled");
  }
  set disabled(v: boolean) {
    this.flag("disabled", !!v);
  }
  get readOnly() {
    return this.attrs.has("readonly");
  }
  set readOnly(v: boolean) {
    this.flag("readonly", !!v);
  }
  get id() {
    return this.getAttribute("id") ?? "";
  }
  get type() {
    return (this.getAttribute("type") ?? (this.tag === "input" ? "text" : this.tag === "textarea" ? "textarea" : "")).toLowerCase();
  }
  set type(v: string) {
    this.setAttribute("type", v);
  }
  get name() {
    return this.getAttribute("name") ?? "";
  }
  set name(v: string) {
    this.setAttribute("name", v);
  }
  get className() {
    return this.getAttribute("class") ?? "";
  }
  set className(v: string) {
    this.setAttribute("class", v);
  }
  get checked() {
    return this._checked;
  }
  set checked(v: boolean) {
    this._checked = !!v;
  }
  get value() {
    if (this.tag === "input" && (this.type === "checkbox" || this.type === "radio")) return this.getAttribute("value") ?? "on";
    if (this._value !== undefined) return this._value;
    return this.tag === "textarea" ? this.textContent : (this.getAttribute("value") ?? "");
  }
  set value(v: string) {
    if (this.tag === "input" && (this.type === "checkbox" || this.type === "radio")) this.setAttribute("value", v);
    else this._value = String(v).replace(/\r\n?/g, "\n");
  }
  get classList() {
    const get = () => this.className.split(/\s+/).filter(Boolean);
    const set = (l: string[]) => this.setAttribute("class", l.join(" "));
    return {
      contains: (c: string) => get().includes(c),
      add: (c: string) => !get().includes(c) && set([...get(), c]),
      remove: (c: string) => set(get().filter((x) => x !== c)),
      toggle: (c: string, force?: boolean) => {
        const on = force === undefined ? !get().includes(c) : !!force;
        set(on ? [...get().filter((x) => x !== c), c] : get().filter((x) => x !== c));
        return on;
      },
    };
  }
  get textContent(): string {
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(v: string) {
    this.children = [];
    if (v !== "") this.appendChild(new FakeText(String(v)));
  }
  get firstChild() {
    return this.children[0] ?? null;
  }
  appendChild<T extends FakeEl | FakeText>(c: T): T {
    c.parentNode = this;
    this.children.push(c);
    return c;
  }
  removeChild<T extends FakeEl | FakeText>(c: T): T {
    this.children = this.children.filter((x) => x !== c);
    c.parentNode = null;
    return c;
  }
  get offsetParent() {
    return null;
  }
  get offsetWidth() {
    return 0;
  }
  getBoundingClientRect() {
    return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
  }
  focus() {}
  /** A recording 2D context for <canvas> (the preview tile); null for anything else. */
  getContext(kind: string) {
    if (this.tag !== "canvas" || kind !== "2d") return null;
    const el = this;
    return {
      createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
      putImageData: (img: { data: Uint8ClampedArray }) => {
        (el as unknown as { pixels: Uint8ClampedArray }).pixels = img.data;
      },
      drawImage: (...a: unknown[]) => {
        ((el as unknown as { draws: unknown[][] }).draws ??= []).push(a);
      },
      fillRect: () => {},
      filter: "none",
      fillStyle: "",
      imageSmoothingEnabled: false,
      imageSmoothingQuality: "low",
    };
  }
  *walk(): Generator<FakeEl> {
    for (const c of this.children) {
      if (c instanceof FakeEl) {
        yield c;
        yield* c.walk();
      }
    }
  }
  querySelectorAll(sel: string) {
    return [...this.walk()].filter((el) => matches(el, sel));
  }
  querySelector(sel: string) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
}

function matches(el: FakeEl, sel: string): boolean {
  return sel.split(",").some((part) => {
    const m = /^([a-z][\w-]*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:="[^"]*")?\])*)$/i.exec(part.trim());
    if (!m) throw new Error(`fake DOM: unsupported selector ${part}`);
    if (m[1] && el.tag !== m[1].toLowerCase()) return false;
    for (const p of m[2].matchAll(/#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:="([^"]*)")?\]/g)) {
      if (p[1] && el.id !== p[1]) return false;
      if (p[2] && !el.classList.contains(p[2])) return false;
      if (p[3] && (!el.hasAttribute(p[3]) || (p[4] !== undefined && el.getAttribute(p[3]) !== p[4]))) return false;
    }
    return true;
  });
}

/** Parses the card's <body> (our own regular markup) into fake elements; returns the scripts in order. */
function parseBody(html: string) {
  const body = new FakeEl("body");
  const scripts: string[] = [];
  const src = html.slice(html.indexOf("<body>") + 6, html.lastIndexOf("</body>"));
  const TOKEN = /<script\b[^>]*>([\s\S]*?)<\/script>|<!--[\s\S]*?-->|<\/([a-z][\w-]*)\s*>|<([a-z][\w-]*)((?:\s+[^\s=>\/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>"']+))?)*)\s*(\/?)>|([^<]+)/gi;
  let cur = body;
  for (const t of src.matchAll(TOKEN)) {
    if (t[1] !== undefined) scripts.push(t[1]);
    else if (t[2]) {
      while (cur !== body && cur.tag !== t[2].toLowerCase()) cur = cur.parentNode as FakeEl;
      if (cur !== body) cur = cur.parentNode as FakeEl;
    } else if (t[3]) {
      const el = new FakeEl(t[3].toLowerCase());
      for (const a of (t[4] ?? "").matchAll(/([^\s=>\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+)))?/g)) {
        el.setAttribute(a[1], decode(a[2] ?? a[3] ?? a[4] ?? ""));
      }
      cur.appendChild(el);
      if (!VOID.has(el.tag) && !t[5]) cur = el;
    } else if (t[6] && t[6].trim()) cur.appendChild(new FakeText(decode(t[6])));
  }
  return { body, scripts };
}

interface Card {
  tool: WriteTool;
  args: Record<string, unknown>;
  posted: Array<{ type: string; key: string; value: unknown }>;
  doc: { getElementById(id: string): FakeEl | null; querySelectorAll(s: string): FakeEl[]; documentElement: FakeEl };
  el(id: string): FakeEl;
  key(k: string): FakeEl;
  radio(value: string): FakeEl;
  type(k: string, text: string): void;
  click(k: string): void;
  pick(value: string): void;
  staged(): Record<string, unknown>;
  received(): Record<string, unknown>;
  verify(at?: number): { ok: boolean; reason?: string };
  intervals: Array<() => void>;
  /** Dispatch a document-level event (click, keydown, …) at an element. */
  fire(type: string, target: FakeEl, extra?: Record<string, unknown>): void;
}

function mount(tool: WriteTool, args: Record<string, unknown>, theme: "dark" | "light" = "dark"): Card {
  const { body, scripts } = parseBody(buildConfirmation(tool).root.html);
  const html = new FakeEl("html");
  html.appendChild(body);
  const docListeners: Record<string, Array<(e: unknown) => void>> = {};
  const winListeners: Record<string, Array<(e: unknown) => void>> = {};
  const posted: Card["posted"] = [];
  const intervals: Array<() => void> = [];
  const parent = { postMessage: (m: Card["posted"][number]) => posted.push(m) };
  const doc = {
    body,
    documentElement: html,
    hidden: false,
    visibilityState: "visible",
    getElementById: (id: string) => html.querySelector(`#${id}`),
    querySelectorAll: (s: string) => html.querySelectorAll(s),
    querySelector: (s: string) => html.querySelector(s),
    createElement: (tag: string) => new FakeEl(tag.toLowerCase()),
    createTextNode: (text: string) => new FakeText(text),
    addEventListener: (t: string, fn: (e: unknown) => void) => (docListeners[t] ??= []).push(fn),
  };
  const ctx: Record<string, unknown> = {
    document: doc,
    parent,
    crypto: {
      getRandomValues: (a: Uint8Array) => {
        const b = randomBytes(a.length);
        for (let i = 0; i < a.length; i++) a[i] = b[i];
        return a;
      },
    },
    getComputedStyle: () => ({ paddingBottom: "4px", borderTopWidth: "1px", borderBottomWidth: "1px" }),
    innerHeight: 420,
    matchMedia: () => ({ matches: false }),
    scrollBy: () => {},
    setTimeout: (fn: () => void) => (typeof fn === "function" ? 0 : (() => { throw new Error("string timer"); })()),
    clearTimeout: () => {},
    setInterval: (fn: () => void) => {
      if (typeof fn !== "function") throw new Error("string timer");
      intervals.push(fn);
      return intervals.length;
    },
    addEventListener: (t: string, fn: (e: unknown) => void) => (winListeners[t] ??= []).push(fn),
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const s of scripts) vm.runInContext(s, ctx);
  for (const fn of winListeners.message ?? []) fn({ source: parent, data: { type: "voiceos:init", data: undefined, args, theme: { mode: theme }, radius: 26 } });

  const fire = (type: string, target: FakeEl, extra: Record<string, unknown> = {}) => {
    for (const fn of docListeners[type] ?? []) fn({ target, key: undefined, preventDefault() {}, ...extra });
  };
  const card: Card = {
    tool,
    args,
    posted,
    doc,
    intervals,
    fire,
    el(id) {
      const e = doc.getElementById(id);
      if (!e) throw new Error(`no #${id}`);
      return e;
    },
    key(k) {
      const e = html.querySelector(`[data-tk-key="${k}"]`);
      if (!e) throw new Error(`no control for ${k}`);
      return e;
    },
    radio(value) {
      const e = html.querySelectorAll("[data-tk-radio]").find((r) => r.value === value);
      if (!e) throw new Error(`no privacy option ${value}`);
      return e;
    },
    type(k, text) {
      const e = card.key(k);
      e.value = text;
      fire("input", e);
    },
    click(k) {
      const e = card.key(k);
      if (e.disabled) return;
      e.checked = !e.checked;
      fire("change", e);
    },
    pick(value) {
      const e = card.radio(value);
      if (e.disabled) return;
      for (const r of html.querySelectorAll("[data-tk-radio]")) r.checked = r === e;
      fire("change", e);
    },
    staged() {
      const out: Record<string, unknown> = {};
      for (const m of posted) if (m.type === "voiceos:updateInput") out[m.key] = m.value;
      return out;
    },
    // What VoiceOS sends on a click: the agent's arguments with every staged value on top.
    received() {
      return { ...args, ...card.staged() };
    },
    verify(at = Date.now()) {
      const r = card.received();
      return TKR.verify(tool, r, r.confirmation_receipt, at, TTL);
    },
  };
  return card;
}

const VIDEO = {
  post_token: "pt1.lz2.0123456789abcdef.mac",
  file_token: "ft1.lz2.fedcba9876543210.mac",
  file_name: "day3-final-export.mp4",
  creator_nickname: "Maya Makes",
  privacy_options: ["SELF_ONLY"],
  comment_disabled: false,
  duet_disabled: true,
  stitch_disabled: true,
  max_duration_sec: 600,
  caption: "day 3 of building VoiceOS #buildinpublic",
  privacy_level: "",
  cover_label: "",
};

describe("end to end: the card stages what it shows, and the server accepts its receipt", () => {
  test("publish_video, unaudited: hydrate, force creator-disabled toggles off, pick, edit, re-mint", () => {
    const c = mount("publish_video", VIDEO);
    expect(c.staged()).toMatchObject({ allow_duet: "false", allow_stitch: "false" });
    expect(c.verify().ok).toBe(true);
    expect(c.el("tk-c").querySelector('[data-tk-show="creator_nickname"]')?.textContent).toBe("Maya Makes");
    // No cover picked: the meta line says nothing about it (TikTok uses its default frame).
    expect(c.el("tk-c").querySelector('[data-tk-hide-empty="cover_label"]')?.hidden).toBe(true);
    expect(c.key("caption").value).toBe(VIDEO.caption);
    expect(c.doc.querySelectorAll("[data-tk-radio]").map((r) => [r.value, r.checked])).toEqual([["SELF_ONLY", false]]);
    expect(c.el("tk-priv-prompt").hidden).toBe(false);
    expect(c.key("allow_duet").disabled).toBe(true);
    expect(c.el("tk-t-allow_duet").textContent).toBe("Turned off for this account");
    expect(c.el("tk-r-allow_duet").classList.contains("tk-dis")).toBe(true);
    expect(c.key("allow_comment").disabled).toBe(false);
    expect(c.el("tk-consent-bc").hidden).toBe(true);
    expect(c.el("tk-disc-body").hidden).toBe(true);

    c.pick("SELF_ONLY");
    expect(c.staged().privacy_level).toBe("SELF_ONLY");
    expect(c.el("tk-priv-prompt").hidden).toBe(true);
    expect(c.radio("SELF_ONLY").parentNode?.classList.contains("tk-sel")).toBe(true);
    expect(c.key("brand_content").disabled).toBe(true);
    expect(c.el("tk-t-brand_content").textContent).toBe("Branded content can't be private.");
    expect(c.verify().ok).toBe(true);

    c.click("allow_comment");
    c.type("caption", "day 3: shipped the notch cards 🎉");
    expect(c.staged()).toMatchObject({ allow_comment: "true", caption: "day 3: shipped the notch cards 🎉" });
    expect(c.verify().ok).toBe(true);
    // The receipt covers what the user saw: any other caption is refused.
    const r = c.received();
    expect(TKR.verify("publish_video", { ...r, caption: "something else" }, r.confirmation_receipt, Date.now(), TTL)).toEqual({ ok: false, reason: "mismatch" });
    // Every staged value is a string VoiceOS can carry, for an argument in the schema.
    for (const m of c.posted) {
      expect(m.type).toBe("voiceos:updateInput");
      expect(typeof m.value).toBe("string");
      expect((m.value as string).length).toBeLessThanOrEqual(16_384);
      expect(CARD_KEYS.publish_video).toContain(m.key);
    }
    expect(c.doc.documentElement.getAttribute("data-k-theme")).toBe("dark");
  });

  test("publish_video, audited: disclosure, Branded content ↔ Only me, consent line, switching off", () => {
    const c = mount("publish_video", { ...VIDEO, privacy_options: ["SELF_ONLY", "PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS"], duet_disabled: false, stitch_disabled: false });
    expect(c.staged().allow_duet).toBeUndefined();
    expect(c.doc.querySelectorAll("[data-tk-radio]").map((r) => r.value)).toEqual(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"]);
    expect(c.doc.querySelectorAll("[data-tk-radio]").map((r) => r.parentNode?.textContent)).toEqual(["Everyone", "Friends", "Only me"]);
    c.pick("PUBLIC_TO_EVERYONE");
    c.click("commercial_disclosure");
    expect(c.el("tk-disc-body").hidden).toBe(false);
    expect(c.el("tk-disc-hint").textContent).toBe("You need to indicate if your content promotes yourself, a third party, or both.");
    c.click("brand_content");
    expect(c.el("tk-disc-hint").hidden).toBe(true);
    expect(c.el("tk-disc-label").textContent).toBe("Your video will be labeled 'Paid partnership'. The label can't be changed after posting.");
    expect(c.radio("SELF_ONLY").disabled).toBe(true);
    expect(c.el("tk-priv-note").textContent).toBe("Branded content visibility cannot be set to private.");
    expect(c.el("tk-consent-bc").hidden).toBe(false);
    c.pick("SELF_ONLY"); // disabled: nothing happens
    expect(c.staged().privacy_level).toBe("PUBLIC_TO_EVERYONE");
    expect(c.verify().ok).toBe(true);

    c.click("commercial_disclosure");
    expect(c.staged()).toMatchObject({ commercial_disclosure: "false", brand_content: "false" });
    expect(c.el("tk-consent-bc").hidden).toBe(true);
    expect(c.radio("SELF_ONLY").disabled).toBe(false);
    expect(c.verify().ok).toBe(true);
  });

  test("conflicting proposals settle on init without dropping the disclosure", () => {
    const c = mount("publish_video", { ...VIDEO, privacy_options: "PUBLIC_TO_EVERYONE,SELF_ONLY", privacy_level: "SELF_ONLY", brand_content: true });
    expect(c.staged()).toMatchObject({ commercial_disclosure: "true", privacy_level: "" });
    expect(c.key("commercial_disclosure").checked).toBe(true);
    expect(c.key("brand_content").checked).toBe(true);
    expect(c.radio("SELF_ONLY").disabled).toBe(true);
    expect(c.verify().ok).toBe(true);
  });

  test("upload_video: no account row when empty, caption and copy staged", () => {
    const c = mount("upload_video", { file_token: "ft1.x", file_name: "demo.mov", account_label: "", duration_label: "0:23", size_label: "18.2 MB", caption: "", copy_caption: false });
    expect(c.doc.querySelector('[data-tk-hide-empty="account_label"]')?.hidden).toBe(true);
    // The length rides on the tile (not repeated beside it).
    expect(c.el("tk-pill-t").textContent).toBe("0:23");
    expect(c.verify().ok).toBe(true);
    c.type("caption", "day 3 of building VoiceOS");
    c.click("copy_caption");
    expect(c.staged()).toMatchObject({ caption: "day 3 of building VoiceOS", copy_caption: "true" });
    expect(c.verify().ok).toBe(true);
  });

  test("post_photos and upload_photos: warning line, one-line titles, counters", () => {
    const base = { bundle_token: "bt1.x", count_label: "6 photos · cover: photo 1", order_label: "1 beach · 2 sunset · 3 tram", warning: "2 photos will be resized to 1080p." };
    const p = mount("post_photos", { ...base, post_token: "pt1.y", creator_nickname: "Jordan", privacy_options: ["SELF_ONLY"], comment_disabled: true, title: "Lisbon", description: "" });
    expect(p.doc.querySelector('[data-tk-hide-empty="warning"]')?.hidden).toBe(false);
    expect(p.doc.querySelector('[data-tk-show="warning"]')?.textContent).toBe(base.warning);
    expect(p.el("tk-tile-n").textContent).toBe("6");
    expect(p.staged().allow_comment).toBe("false");
    expect(p.el("tk-n-title").textContent).toBe("6 / 90");
    p.type("title", "Lisbon\nweekend");
    expect(p.staged().title).toBe("Lisbon weekend");
    p.type("description", "x".repeat(4001));
    expect(p.el("tk-e-description").hidden).toBe(false);
    p.click("commercial_disclosure");
    p.click("brand_organic");
    expect(p.el("tk-disc-label").textContent).toBe("Your photo will be labeled 'Promotional content'. The label can't be changed after posting.");
    expect(p.el("tk-disc-music").hidden).toBe(false);
    expect(p.verify().ok).toBe(true);

    const u = mount("upload_photos", { ...base, warning: "", account_label: "@jordan.trips", title: "", description: "best 3 days #travel" });
    expect(u.doc.querySelector('[data-tk-hide-empty="warning"]')?.hidden).toBe(true);
    expect(u.key("description").value).toBe("best 3 days #travel");
    u.type("title", "Lisbon weekend");
    expect(u.verify().ok).toBe(true);
  });

  test("the receipt is re-minted while the card stays open, and goes stale only after 10 minutes", () => {
    const c = mount("upload_photos", { bundle_token: "bt1.x", title: "t" });
    expect(c.verify(Date.now() + TTL + 1000)).toEqual({ ok: false, reason: "expired" });
    const before = c.staged().confirmation_receipt;
    expect(c.intervals.length).toBe(1);
    c.intervals[0]();
    expect(c.staged().confirmation_receipt).not.toBe(before);
    expect(c.verify().ok).toBe(true);
  });
});

describe("the preview tile (micro preview frames from find_recent_videos)", () => {
  const MICRO = new URL("./fixtures/micro/", import.meta.url);
  const frame = (name: string, w = 18, h = 32) => encodeMicroFrame(new Uint8Array(readFileSync(new URL(name, MICRO))), w, h);
  const PREVIEW = joinMicroPreview(
    ["speedrun-1950.18x32.rgb", "speedrun-1966.18x32.rgb", "strawberry-mascot.18x32.rgb"].map((n) => frame(n)),
    { durationSec: 42 },
  );
  const DRAFTS = { file_token: "ft1.x", file_name: "ai-history-speedrun.mp4", account_label: "@thetinyailab", duration_label: "0:42", size_label: "64.9 MB", caption: "", copy_caption: false };
  const canvases = (c: Card) => c.el("tk-frames").querySelectorAll("canvas");

  test("all four cards read `preview`: the video's frames, or the photos' stack", () => {
    for (const tool of TOOLS) expect(CARD_KEYS[tool]).toContain("preview");
  });

  /** Version 2, what find_recent_videos mints now: three 45 × 80 Tiny AI Lab frames. */
  const v2 = (n: string) => encodeVideoFrame(new Uint8Array(readFileSync(new URL(`v2-${n}.45x80.rgb`, MICRO))), 45, 80);
  const PREVIEW2 = joinVideoPreview(["speedrun", "token", "museum"].map(v2), { durationSec: 42 });
  const screen = (c: Card) => c.el("tk-frames").querySelector("canvas");
  type Drawn = { draws?: unknown[][]; width?: number; height?: number; tag?: string };
  /** The frame plates the player draws on its screen (offscreen canvases, one per decoded frame). */
  const plates = (c: Card) => ((screen(c) as unknown as Drawn).draws ?? []).map((d) => d[0] as Drawn);

  test("upload_video plays the frames on one canvas with a segment each, and never stages the preview", () => {
    for (const preview of [PREVIEW2, PREVIEW]) {
      const c = mount("upload_video", { ...DRAFTS, preview });
      expect(canvases(c).length).toBe(1);
      expect(screen(c)!.id).toBe("tk-screen");
      expect(screen(c)!.getAttribute("aria-hidden")).toBe("true");
      expect(c.el("tk-tile").classList.contains("tk-has")).toBe(true);
      expect(c.el("tk-prog").querySelectorAll("span").length).toBe(3);
      // The first paint is frame 1 (a 224 × 398 plate, the tile at 2x), before any animation runs.
      const first = plates(c)[0]!;
      expect(first.tag).toBe("canvas");
      expect([first.width, first.height]).toEqual([224, 398]);
      expect(c.el("tk-pill").hidden).toBe(false);
      expect(c.el("tk-pill-t").textContent).toBe("0:42");
      expect(c.el("tk-av").textContent).toBe("T");
      expect(c.staged().preview).toBeUndefined();
      expect(c.verify().ok).toBe(true);
    }
    expect(PREVIEW2.length).toBeLessThanOrEqual(1_100);
  });

  test("a landscape source sits centred over a blurred fill, as TikTok's feed shows it", () => {
    const wide = encodeVideoFrame(new Uint8Array(readFileSync(new URL("v2-slide.90x160.rgb", MICRO))).slice(0, 80 * 45 * 3), 80, 45);
    for (const land of [joinVideoPreview([wide], { durationSec: 28 }), joinMicroPreview([frame("how-ai-sees-landscape.32x18.rgb", 32, 18)], { durationSec: 28 })]) {
      const c = mount("upload_video", { ...DRAFTS, preview: land, duration_label: "" });
      expect(canvases(c).length).toBe(1);
      const draws = plates(c)[0]!.draws!;
      expect(draws.length).toBe(2); // the blurred fill (covering, oversized), then the frame (fitted)
      expect(Number(draws[0][3])).toBeGreaterThan(224);
      expect(Number(draws[1][3])).toBe(224);
      // One frame: no segments. No duration_label: the pill reads the preview's own (server-minted) duration.
      expect(c.el("tk-prog").querySelectorAll("span").length).toBe(0);
      expect(c.el("tk-pill-t").textContent).toBe("0:28");
    }
  });

  test("publish_video takes its duration from the preview and names the creator", () => {
    const c = mount("publish_video", { ...VIDEO, creator_nickname: "Tiny AI Lab", preview: PREVIEW2 });
    expect(canvases(c).length).toBe(1);
    expect(c.el("tk-pill-t").textContent).toBe("0:42");
    expect(c.el("tk-av").textContent).toBe("TA");
    expect(c.staged().preview).toBeUndefined();
    expect(c.verify().ok).toBe(true);
  });

  test("a click on the tile pauses and resumes it", () => {
    const c = mount("upload_video", { ...DRAFTS, preview: PREVIEW2 });
    c.fire("click", screen(c)!);
    expect(c.el("tk-tile").classList.contains("tk-paused")).toBe(true);
    c.fire("click", screen(c)!);
    expect(c.el("tk-tile").classList.contains("tk-paused")).toBe(false);
    expect(c.verify().ok).toBe(true);
  });

  test("no preview, or a mangled one, keeps the designed fallback (with the file's name) and changes nothing else", () => {
    const parts = PREVIEW2.split("~");
    const mangled = [parts[0], parts[1], parts[2].slice(0, 60) + (parts[2][60] === "x" ? "y" : "x") + parts[2].slice(61), parts[3]].join("~");
    for (const preview of [undefined, "", "p1~not a frame", "p2~not a frame", mangled]) {
      const c = mount("upload_video", { ...DRAFTS, preview });
      if (preview === mangled) expect(c.el("tk-prog").querySelectorAll("span").length).toBe(2); // the damaged frame fails its check and is dropped
      else {
        expect(canvases(c).length).toBe(0);
        expect(c.el("tk-tile").classList.contains("tk-has")).toBe(false);
      }
      expect(c.el("tk-fb-n").textContent).toBe("ai-history-speedrun.mp4");
      expect(c.el("tk-pill-t").textContent).toBe("0:42");
      expect(c.verify().ok).toBe(true);
    }
    const p = mount("publish_video", { ...VIDEO });
    expect(canvases(p).length).toBe(0);
    expect(p.el("tk-pill").hidden).toBe(true);
  });

  test("the preview is display-only: the server binds it to the file_token, like file_name", () => {
    // The receipt signs TKR.SPECS only; `preview`, like the other labels, isn't one of them.
    for (const tool of ["upload_video", "publish_video"] as WriteTool[]) {
      expect((TKR.SPECS as Record<string, [string, string][]>)[tool].map(([f]) => f)).not.toContain("preview");
    }
  });
});

describe("the photo stack (prepare_photo_post's preview)", () => {
  const MICRO = new URL("./fixtures/micro/", import.meta.url);
  const photo = (i: number) => encodePhotoFrame(new Uint8Array(readFileSync(new URL(`photo-${i}.48x64.rgb`, MICRO))), 48, 64);
  const STACK = joinPhotoStack([1, 2, 3, 4, 5].map(photo), { count: 6, cover: 2 });
  const BASE = { bundle_token: "bt1.x", count_label: "6 photos · cover: photo 3", order_label: "1 a · 2 b · 3 c · 4 d · 5 e · 6 f", account_label: "@thetinyailab", title: "", description: "" };
  const cards = (c: Card) => c.el("tk-stk").querySelectorAll(".tk-sc");
  const front = (c: Card) => cards(c).find((el) => el.classList.contains("tk-s0"))!;

  test("five frames become five 3:4 cards fanned in carousel order, the first on top", () => {
    const c = mount("upload_photos", { ...BASE, preview: STACK });
    expect(STACK.length).toBeLessThanOrEqual(720);
    const list = cards(c);
    expect(list.length).toBe(5);
    expect(c.el("tk-stack").classList.contains("tk-live")).toBe(true);
    expect(c.el("tk-stack").classList.contains("tk-deep")).toBe(true);
    expect(c.el("tk-stack").getAttribute("tabindex")).toBe("0");
    // Painted back to front, each card a canvas and its place in the post.
    expect(list.map((el) => el.querySelector(".tk-sc-p")!.textContent)).toEqual(["5/6", "4/6", "3/6", "2/6", "1/6"]);
    expect(front(c).querySelector(".tk-sc-p")!.textContent).toBe("1/6");
    expect(list.map((el) => el.className.match(/tk-s\d/)![0])).toEqual(["tk-s4", "tk-s3", "tk-s2", "tk-s1", "tk-s0"]);
    for (const el of list) expect(el.querySelectorAll("canvas").length).toBe(1);
    // The cover says so; the dots follow the top card.
    expect(c.el("tk-stk").querySelectorAll(".tk-sc-cv").length).toBe(1);
    expect(list[2].querySelector(".tk-sc-cv")!.textContent).toBe("Cover");
    expect(c.el("tk-stk-dots").querySelectorAll("i").length).toBe(5);
    expect(c.el("tk-stk-dots").querySelectorAll("i")[0].className).toBe("tk-on");
    expect(c.staged().preview).toBeUndefined();
    expect(c.verify().ok).toBe(true);
  });

  test("a click flicks the top card away; the next one is on top and the dots follow", () => {
    const c = mount("post_photos", { ...BASE, preview: STACK, post_token: "pt1.y", creator_nickname: "Tiny AI Lab", privacy_options: ["SELF_ONLY"], comment_disabled: false });
    const first = front(c);
    c.fire("click", first.querySelector("canvas")!);
    expect(first.classList.contains("tk-out")).toBe(true);
    expect(front(c).querySelector(".tk-sc-p")!.textContent).toBe("2/6");
    expect(c.el("tk-stk-dots").querySelectorAll("i")[1].className).toBe("tk-on");
    expect(c.el("tk-stk-live").textContent).toBe("Photo 2 of 6");
    // Moving the stack is display only: nothing is staged, the receipt still holds.
    expect(Object.keys(c.staged()).every((k) => k !== "preview")).toBe(true);
    expect(c.verify().ok).toBe(true);
  });

  test("the keyboard moves it too, when the stack has focus", () => {
    const c = mount("upload_photos", { ...BASE, preview: STACK });
    c.fire("keydown", c.el("tk-stack"), { key: "ArrowRight" });
    expect(front(c).querySelector(".tk-sc-p")!.textContent).toBe("2/6");
    expect(c.el("tk-stk-live").textContent).toBe("Photo 2 of 6");
  });

  test("two photos fan as two cards; one photo is a single card with no position or dots", () => {
    const two = mount("upload_photos", { ...BASE, count_label: "2 photos · cover: photo 2", preview: joinPhotoStack([photo(3), photo(6)], { count: 2, cover: 1 }) });
    expect(cards(two).length).toBe(2);
    expect(front(two).querySelector(".tk-sc-p")!.textContent).toBe("1/2");
    const one = mount("upload_photos", { ...BASE, count_label: "1 photo", preview: joinPhotoStack([photo(4)], { count: 1 }) });
    expect(cards(one).length).toBe(1);
    expect(one.el("tk-stk").querySelectorAll(".tk-sc-p").length).toBe(0);
    expect(one.el("tk-stk-dots").querySelectorAll("i").length).toBe(0);
    expect(one.el("tk-stack").classList.contains("tk-deep")).toBe(false);
    expect(one.el("tk-stack").hasAttribute("tabindex")).toBe(false);
  });

  test("no preview, a video preview or a mangled stack keeps the plain stack with the count", () => {
    const mangled = STACK.slice(0, 40) + (STACK[40] === "A" ? "B" : "A") + STACK.slice(41);
    for (const preview of [undefined, "", "s1~not a frame", joinMicroPreview([encodeMicroFrame(new Uint8Array(18 * 32 * 3), 18, 32)])]) {
      const c = mount("upload_photos", { ...BASE, preview });
      expect(c.el("tk-stack").classList.contains("tk-live")).toBe(false);
      expect(cards(c).every((el) => el.classList.contains("tk-fbc"))).toBe(true);
      expect(c.el("tk-tile-n").textContent).toBe("6");
      expect(c.verify().ok).toBe(true);
    }
    // One damaged frame fails its check and is left out; the rest still stack.
    const c = mount("upload_photos", { ...BASE, preview: mangled });
    expect(cards(c).length).toBe(4);
  });

  test("version 2 stacks: sharper 3:4 cards, 9:16 cards for tall slides, and a '+N more' on the last one", () => {
    const sharp = (i: number) => encodeStackFrame(new Uint8Array(readFileSync(new URL(`photo-${i}.48x64.rgb`, MICRO))), 48, 64);
    const s2 = joinStack([1, 2, 3, 4, 5].map(sharp), { count: 6, cover: 2 });
    expect(s2.length).toBeLessThanOrEqual(1_500);
    const c = mount("upload_photos", { ...BASE, preview: s2 });
    expect(cards(c).length).toBe(5);
    expect(c.el("tk-stack").classList.contains("tk-tall")).toBe(false);
    expect(front(c).querySelector(".tk-sc-p")!.textContent).toBe("1/6");
    // Five frames of six photos: the fifth says one more follows.
    const more = c.el("tk-stk").querySelectorAll(".tk-sc-more");
    expect(more.map((el) => el.textContent)).toEqual(["+1 more"]);
    expect(more[0].parentNode!.querySelector(".tk-sc-p")!.textContent).toBe("5/6");
    const slide = new Uint8Array(readFileSync(new URL("v2-slide.90x160.rgb", MICRO)));
    const tall = mount("post_photos", { ...BASE, preview: joinStack([encodeStackFrame(slide, 90, 160, true)], { count: 1 }), count_label: "1 photo", post_token: "pt1.y", creator_nickname: "Tiny AI Lab", privacy_options: ["SELF_ONLY"], comment_disabled: false });
    expect(tall.el("tk-stack").classList.contains("tk-tall")).toBe(true);
    expect(cards(tall).length).toBe(1);
    expect(tall.verify().ok).toBe(true);
  });

  test("the order line: numbered slides read 'N slides · in order', named photos drop their positions", () => {
    const numbered = mount("upload_photos", { ...BASE, count_label: "11 photos · cover: photo 1", order_label: Array.from({ length: 11 }, (_, i) => `${i + 1} ${String(i + 1).padStart(2, "0")}`).join(" · ") });
    expect(numbered.doc.querySelector("[data-tk-show]") && numbered.doc.querySelectorAll("[data-tk-show]").find((el) => el.getAttribute("data-tk-show") === "order_label")!.textContent).toBe("11 slides · in order");
    const named = mount("upload_photos", { ...BASE });
    expect(named.doc.querySelectorAll("[data-tk-show]").find((el) => el.getAttribute("data-tk-show") === "order_label")!.textContent).toBe("a · b · c · d · e · f");
    const shuffled = mount("upload_photos", { ...BASE, order_label: "1 03 · 2 01 · 3 02" });
    expect(shuffled.doc.querySelectorAll("[data-tk-show]").find((el) => el.getAttribute("data-tk-show") === "order_label")!.textContent).toBe("03 · 01 · 02");
    for (const c of [numbered, named, shuffled]) expect(c.verify().ok).toBe(true);
  });

  test("a drag past a third of the card swipes it on; a short one springs back", () => {
    const c = mount("upload_photos", { ...BASE, preview: STACK });
    const top = front(c);
    c.fire("pointerdown", top.querySelector("canvas")!, { clientX: 100, clientY: 50 });
    c.fire("pointermove", top, { clientX: 85, clientY: 50 });
    expect(String(top.style.transform)).toContain("translate(-15");
    c.fire("pointerup", top);
    expect(top.style.transform).toBe("");
    expect(front(c)).toBe(top);
    c.fire("pointerdown", top.querySelector("canvas")!, { clientX: 100, clientY: 50 });
    c.fire("pointermove", top, { clientX: 30, clientY: 55 });
    c.fire("pointerup", top);
    expect(front(c).querySelector(".tk-sc-p")!.textContent).toBe("2/6");
    // The click that ends a drag doesn't step again.
    c.fire("click", top.querySelector("canvas")!);
    expect(front(c).querySelector(".tk-sc-p")!.textContent).toBe("2/6");
  });

  test("the stack is display-only, like the video preview: the receipt never signs it", () => {
    for (const tool of ["upload_photos", "post_photos"] as WriteTool[]) {
      expect((TKR.SPECS as Record<string, [string, string][]>)[tool].map(([f]) => f)).not.toContain("preview");
    }
  });
});

describe("presentation details", () => {
  test("interaction chips: off by default, struck through and explained when the creator turned them off", () => {
    const c = mount("publish_video", VIDEO);
    expect(c.el("tk-r-allow_comment").classList.contains("tk-on")).toBe(false);
    expect(c.el("tk-r-allow_duet").classList.contains("tk-dis")).toBe(true);
    expect(c.el("tk-gate-note").textContent).toBe("Duet and Stitch are turned off for this account.");
    expect(c.el("tk-gate-note").hidden).toBe(false);
    c.click("allow_comment");
    expect(c.el("tk-r-allow_comment").classList.contains("tk-on")).toBe(true);
    const one = mount("publish_video", { ...VIDEO, duet_disabled: false, stitch_disabled: false, comment_disabled: true });
    expect(one.el("tk-gate-note").textContent).toBe("Comment is turned off for this account.");
    const none = mount("publish_video", { ...VIDEO, duet_disabled: false, stitch_disabled: false });
    expect(none.el("tk-gate-note").hidden).toBe(true);
  });

  test("counters show near the limit (a photo title's always, once typed); amber near it, red over it", () => {
    const c = mount("publish_video", VIDEO);
    expect(c.el("tk-n-caption").hidden).toBe(true);
    expect(c.el("tk-n-caption").textContent).toBe(`${VIDEO.caption.length} / 2,200`);
    expect(c.el("tk-n-caption").classList.contains("tk-near")).toBe(false);
    c.type("caption", "a".repeat(2000));
    expect(c.el("tk-n-caption").hidden).toBe(false);
    expect(c.el("tk-n-caption").classList.contains("tk-near")).toBe(true);
    c.type("caption", "a".repeat(2201));
    expect([c.el("tk-n-caption").classList.contains("tk-near"), c.el("tk-n-caption").classList.contains("tk-over")]).toEqual([false, true]);
    const p = mount("upload_photos", { bundle_token: "bt1.x", title: "Lisbon" });
    expect(p.el("tk-n-title").hidden).toBe(false);
    expect(p.el("tk-n-title").classList.contains("tk-near")).toBe(false);
    const empty = mount("upload_photos", { bundle_token: "bt1.x" });
    expect(empty.el("tk-n-title").hidden).toBe(true);
  });

  test("#hashtags and @mentions are tinted in the caption, as typed (text nodes only)", () => {
    const caption = "Day 3 #ai #buildinpublic, thanks @maya.makes. Email me@x? No.";
    const c = mount("publish_video", { ...VIDEO, caption });
    const hl = c.el("tk-hl-caption");
    const tags = () => hl.querySelectorAll(".tk-tag").map((t) => t.textContent);
    expect(tags()).toEqual(["#ai", "#buildinpublic", "@maya.makes"]);
    expect(hl.textContent).toBe(`${caption}\u200b`);
    expect(hl.parentNode?.classList.contains("tk-tinted")).toBe(true);
    c.type("caption", "new take #tinyailab");
    expect(tags()).toEqual(["#tinyailab"]);
    // The staged caption is the text as typed; the tint is display only.
    expect(c.staged().caption).toBe("new take #tinyailab");
    expect(c.verify().ok).toBe(true);
    // Photo descriptions are tinted too; titles aren't (TikTok shows them plain).
    const p = mount("post_photos", { bundle_token: "bt1.x", post_token: "pt1.x", creator_nickname: "Tiny AI Lab", privacy_options: ["SELF_ONLY"], title: "#notatag", description: "Lisbon #travel" });
    expect(p.el("tk-hl-description").querySelectorAll(".tk-tag").map((t) => t.textContent)).toEqual(["#travel"]);
    expect(p.doc.getElementById("tk-hl-title")).toBeNull();
  });

  test("the user's extra words land on the card as what a click sends: tags in the caption, audience, cover", () => {
    const c = mount("publish_video", {
      ...VIDEO,
      privacy_options: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
      caption: "day 3 of the build",
      hashtags: ["ai", "build in public"],
      mentions: "maya.makes",
      privacy_level: "friends",
      cover_ms: "0:05",
    });
    const shown = c.el("tk-in-caption").value;
    expect(shown).toBe("day 3 of the build #ai #buildinpublic @maya.makes");
    expect(c.staged().caption).toBe(shown);
    expect(c.el("tk-hl-caption").querySelectorAll(".tk-tag").map((t) => t.textContent)).toEqual(["#ai", "#buildinpublic", "@maya.makes"]);
    expect(c.doc.querySelectorAll("[data-tk-radio]").filter((r) => r.checked).map((r) => r.value)).toEqual(["MUTUAL_FOLLOW_FRIENDS"]);
    expect(c.staged().cover_ms).toBe("5000");
    expect(c.el("tk-c").querySelector('[data-tk-hide-empty="cover_label"]')?.hidden).toBe(false);
    expect(c.el("tk-c").querySelector('[data-tk-show="cover_label"]')?.textContent).toBe("0:05");
    expect(c.verify().ok).toBe(true);
    // Drafts fold too: the caption to paste carries the tags.
    const d = mount("upload_video", { file_token: "ft1.x", file_name: "a.mp4", caption: "hi", hashtags: "#ai, tech" });
    expect(d.el("tk-in-caption").value).toBe("hi #ai #tech");
    expect(d.verify().ok).toBe(true);
  });

  test("the composer starts one line tall and caps how far each text grows", () => {
    for (const tool of TOOLS) {
      const h = markupOf(buildConfirmation(tool).root.html);
      expect(h).not.toMatch(/<textarea[^>]*rows="[2-9]"/);
      for (const m of h.matchAll(/<textarea[^>]*data-tk-lines="(\d+)"/g)) expect(Number(m[1])).toBeLessThanOrEqual(5);
    }
  });

  test("the commercial disclosure chip opens TikTok's brand options", () => {
    const c = mount("publish_video", { ...VIDEO, privacy_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"] });
    expect(c.el("tk-disc-body").hidden).toBe(true);
    c.click("commercial_disclosure");
    expect(c.el("tk-r-commercial_disclosure").classList.contains("tk-on")).toBe(true);
    expect(c.el("tk-disc-body").hidden).toBe(false);
    expect(c.verify().ok).toBe(true);
  });

  test("“More below” sits beside the Post button or in the band, never floating over content", () => {
    for (const tool of TOOLS) {
      const css = buildConfirmation(tool).root.html;
      // Direct posts: a round chevron beside VoiceOS's Post button (no extra row); drafts: a pill in the band.
      expect(css).not.toContain(".tk-foot.tk-more-on{padding-top:");
      expect(css).toContain(".tk-more-direct{left:auto;right:84px;bottom:12px;width:26px;height:26px;");
      expect(css).toContain(".tk-more-drafts{left:14px;bottom:14px}");
    }
    // In the fake DOM nothing scrolls, so the hint stays hidden and the footer has no strip.
    const c = mount("publish_video", VIDEO);
    expect(c.el("tk-more").hidden).toBe(true);
    expect(c.el("tk-foot").classList.contains("tk-more-on")).toBe(false);
  });
});
