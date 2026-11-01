/**
 * Confirmation cards for the four write tools.
 *
 * VoiceOS renders these from the manifest before any integration code runs,
 * so they are static documents that learn the pending call from the bridge's
 * `args`. Each one leads with the consequence in plain words, shows the exact
 * outgoing text (editable), the facts that make it safe, and — because the
 * host gives integrations no approval signal — stages a confirmation receipt:
 * a digest of the exact arguments on screen, re-minted on every edit. The
 * handler refuses any write that arrives without a valid one.
 *
 * Untrusted text (titles, bodies) only ever reaches the DOM via textContent
 * or input values, never as markup.
 */
import { esc, markHtml, renderCustom } from "../widgetKit.ts";
import { CARD_CSS } from "./cards.ts";
import type { Facade } from "./catalog.ts";
import { readFileSync } from "node:fs";

/**
 * The receipt core's exact source, for each card's <script>: the server runs
 * the same file as code. Only the build and tests read it; the shared package
 * holds server.ts and the manifest, not src/.
 */
const receiptFile = readFileSync(new URL("./receiptCoreScript.ts", import.meta.url), "utf8");
const receiptStart = receiptFile.indexOf("var GHR = (function () {");
const receiptEnd = receiptFile.lastIndexOf("\nexport default GHR;");
if (receiptStart < 0 || receiptEnd < receiptStart) throw new Error("src/receiptCoreScript.ts must hold the GHR script followed by its export line.");
export const RECEIPT_CORE_JS = receiptFile.slice(receiptStart, receiptEnd);

/** Pure display logic, shared verbatim with tests (same pattern as the receipt core). */
export const CONFIRM_LOGIC_JS = String.raw`var GHC = (function () {
  "use strict";
  function txt(v) { return v === undefined || v === null ? "" : String(v).replace(/^\s+|\s+$/g, ""); }
  function has(a, k) { return Object.prototype.hasOwnProperty.call(a, k) && a[k] !== undefined && a[k] !== null; }
  function toList(v) {
    var items = Object.prototype.toString.call(v) === "[object Array]" ? v : (v === undefined || v === null ? [] : String(v).split(/[,\r\n]/));
    var out = [], seen = {};
    for (var i = 0; i < items.length; i++) {
      var t = txt(items[i]);
      if (!t) continue;
      var k = "$" + t.toLowerCase();
      if (seen[k]) continue;
      seen[k] = 1;
      out.push(t);
    }
    return out;
  }
  function num(a, k) { var n = txt(a[k]).replace(/^0+(?=\d)/, ""); return "#" + (n || "?"); }
  function closedAs(a) {
    var why = txt(a.state_reason);
    return why === "completed" ? " as completed" : why === "not_planned" ? " as not planned" : "";
  }

  function headline(tool, a) {
    a = a || {};
    if (tool === "create_pull_request_review") {
      var ev = txt(a.event).toUpperCase(), n = num(a, "pull_number");
      if (ev === "REQUEST_CHANGES") return "Request changes on " + n;
      if (ev === "APPROVE") return "Approve PR " + n;
      if (ev === "COMMENT") return "Post review comment on " + n;
      return "Choose a review outcome for " + n;
    }
    if (tool === "update_issue") {
      var n2 = num(a, "issue_number"), st = txt(a.state);
      if (st === "closed") return "Close issue " + n2 + closedAs(a);
      if (st === "open") return "Reopen issue " + n2;
      return "Update issue " + n2;
    }
    if (tool === "create_issue") return "New issue in " + txt(a.owner) + "/" + txt(a.repo);
    if (tool === "create_issue_comment") return "Comment on " + num(a, "issue_number");
    return "Confirm";
  }

  function listChange(a, field, whole, add, remove, words) {
    if (has(a, whole)) {
      var l = toList(a[whole]);
      return l.length ? { field: field, text: words.exact + l.join(", ") } : { field: field, text: words.none, tone: "danger" };
    }
    var parts = [];
    if (has(a, add) && toList(a[add]).length) parts.push(words.add + toList(a[add]).join(", ") + ".");
    if (has(a, remove) && toList(a[remove]).length) parts.push(words.remove + toList(a[remove]).join(", ") + ".");
    return parts.length ? { field: field, text: parts.join(" ") } : null;
  }

  function changes(a) {
    a = a || {};
    var out = [], c;
    if (has(a, "state")) out.push({ field: "State", text: txt(a.state) === "closed" ? "Closed" + closedAs(a) : "Reopened" });
    c = listChange(a, "Labels", "labels", "add_labels", "remove_labels", { exact: "Set to exactly: ", none: "Remove every label", add: "Add ", remove: "Remove " });
    if (c) out.push(c);
    c = listChange(a, "Assignees", "assignees", "add_assignees", "remove_assignees", { exact: "Assign exactly: ", none: "Unassign everyone", add: "Assign ", remove: "Unassign " });
    if (c) out.push(c);
    if (has(a, "title")) out.push({ field: "Title", text: "Rename" });
    if (has(a, "body")) out.push(txt(a.body) ? { field: "Body", text: "Replace the description" } : { field: "Body", text: "Clear the description", tone: "danger" });
    return out;
  }

  // A label the model named with a comma or line break: the card's comma text can't show it as one.
  function splits(v) {
    if (Object.prototype.toString.call(v) !== "[object Array]") return false;
    for (var i = 0; i < v.length; i++) if (/[,\r\n]/.test(String(v[i]))) return true;
    return false;
  }

  function problems(tool, a) {
    a = a || {};
    var out = [];
    if (tool === "create_issue" && !txt(a.title)) out.push("Add a title before creating the issue.");
    if (tool === "create_issue_comment" && !txt(a.body)) out.push("Write the comment before posting.");
    if (tool === "create_pull_request_review") {
      var ev = txt(a.event).toUpperCase();
      if (ev !== "COMMENT" && ev !== "APPROVE" && ev !== "REQUEST_CHANGES") out.push("Choose Comment, Approve, or Request changes.");
      else if (ev !== "APPROVE" && !txt(a.body)) out.push("Write the review text first.");
      if (!txt(a.pr_title)) out.push("The pull request's title is missing.");
    }
    if (tool === "update_issue" && has(a, "title") && !txt(a.title)) out.push("The new title can't be empty.");
    if (splits(a.labels) || splits(a.add_labels) || splits(a.remove_labels)) out.push("Label names can't contain commas or line breaks.");
    return out;
  }

  return { txt: txt, has: has, toList: toList, headline: headline, changes: changes, problems: problems };
})();`;

/**
 * VoiceOS silently drops a staged edit longer than this (ConfirmationWidget's
 * UPDATE_VALUE_MAX_CHARS), which would leave the call carrying older text
 * than the card shows.
 */
export const HOST_EDIT_MAX = 16_384;

/** Bridge wiring: hydrate from args, stage edits, re-mint the receipt. */
const CONFIRM_DOM_JS = String.raw`(function () {
  "use strict";
  var EDIT_MAX = ${HOST_EDIT_MAX};
  var args = {}, edits = {};
  function $(id) { return document.getElementById(id); }
  function send(m) { try { parent.postMessage(m, "*"); } catch (e) {} }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function merged() {
    var o = {}, k;
    for (k in args) if (own(args, k)) o[k] = args[k];
    for (k in edits) if (own(edits, k)) o[k] = edits[k];
    delete o.confirmation_receipt;
    return o;
  }
  function nonce() {
    var b = new Uint8Array(16), s = "";
    crypto.getRandomValues(b);
    for (var i = 0; i < b.length; i++) s += (b[i] < 16 ? "0" : "") + b[i].toString(16);
    return s;
  }
  function stamp() {
    send({ type: "voiceos:updateInput", key: "confirmation_receipt", value: GHR.mint(GH_TOOL, merged(), Date.now(), nonce()) });
  }
  function setText(id, text) { var el = $(id); if (el) el.textContent = text; }
  function show(id, on) { var el = $(id); if (el) el.hidden = !on; }
  function fmt(v) {
    if (Object.prototype.toString.call(v) === "[object Array]") return GHC.toList(v).join(", ");
    return v === undefined || v === null ? "" : String(v);
  }
  function grow(el) {
    if (!el.offsetParent) return;
    var cs = getComputedStyle(el);
    el.style.height = "auto";
    el.style.height = el.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth) + "px";
  }
  function growAll() {
    var els = document.querySelectorAll("[data-gh-grow]");
    for (var i = 0; i < els.length; i++) grow(els[i]);
  }

  function hydrate() {
    var els = document.querySelectorAll("[data-gh-key]");
    for (var i = 0; i < els.length; i++) {
      var el = els[i], key = el.getAttribute("data-gh-key");
      if (el.type === "radio") el.checked = GHC.txt(args[key]).toUpperCase() === el.value;
      else {
        el.value = fmt(args[key]);
        // Longer than VoiceOS can carry as an edit: approve it as written, or not at all.
        el.readOnly = el.value.length > EDIT_MAX;
        var why = el.parentNode && el.parentNode.querySelector ? el.parentNode.querySelector("[data-gh-long]") : null;
        if (why) why.hidden = !el.readOnly;
      }
      var wrap = el.closest ? el.closest("[data-gh-optional]") : null;
      if (wrap) wrap.hidden = !GHC.has(args, key);
    }
    var pairs = document.querySelectorAll(".gh-pair");
    for (var j = 0; j < pairs.length; j++) pairs[j].hidden = !pairs[j].querySelector("[data-gh-optional]:not([hidden])");
    growAll();
  }

  function render() {
    var a = merged();
    setText("gh-h", GHC.headline(GH_TOOL, a));
    var where = GHC.txt(a.owner) + "/" + GHC.txt(a.repo);
    var n = GHC.txt(a.issue_number || a.pull_number).replace(/^0+(?=\d)/, "");
    setText("gh-where", n ? where + "#" + n : where);
    var title = GHC.txt(a.issue_title || a.pr_title);
    setText("gh-ttl", title);
    show("gh-ttl", !!title);

    if (GH_TOOL === "create_pull_request_review") {
      var sha = GHC.txt(a.commit_id).toLowerCase();
      setText("gh-sha", sha ? sha.slice(0, 7) : "missing");
      var shaEl = $("gh-sha");
      if (shaEl) shaEl.title = sha;
    }
    if (GH_TOOL === "update_issue") {
      var list = $("gh-chg");
      if (list) {
        while (list.firstChild) list.removeChild(list.firstChild);
        var ch = GHC.changes(a);
        for (var i = 0; i < ch.length; i++) {
          var li = document.createElement("li");
          var b = document.createElement("b");
          b.textContent = ch[i].field;
          var s = document.createElement("span");
          s.textContent = ch[i].text;
          if (ch[i].tone === "danger") s.className = "danger";
          li.appendChild(b);
          li.appendChild(s);
          list.appendChild(li);
        }
        show("gh-chg", ch.length > 0);
      }
    }

    var probs = GHC.problems(GH_TOOL, a), box = $("gh-prob");
    if (box) {
      while (box.firstChild) box.removeChild(box.firstChild);
      for (var j = 0; j < probs.length; j++) {
        var p = document.createElement("li");
        p.textContent = probs[j];
        box.appendChild(p);
      }
      box.hidden = probs.length === 0;
    }
    var body = GHC.txt(a.body);
    var count = $("gh-count"), bodyEl = document.querySelector('[data-gh-key="body"]');
    if (count) {
      count.textContent = body.length.toLocaleString() + " / " + EDIT_MAX.toLocaleString();
      count.hidden = !!(bodyEl && bodyEl.readOnly) || body.length < EDIT_MAX - 1500;
    }
  }

  // The card can be taller than the notch allows. When content reaches the band
  // VoiceOS's confirm button floats over, say there's more instead of hiding it.
  function hint() {
    var more = $("gh-more"), card = document.querySelector(".gh-c");
    if (!more || !card) return;
    var bottom = card.getBoundingClientRect().bottom - parseFloat(getComputedStyle(card).paddingBottom);
    more.hidden = bottom <= window.innerHeight - 44 + 1;
  }
  addEventListener("scroll", hint, { passive: true });
  addEventListener("resize", function () {
    growAll();
    hint();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && e.target && e.target.hasAttribute && e.target.hasAttribute("data-gh-line")) e.preventDefault();
  });
  document.addEventListener("click", function (e) {
    if (!e.target || !e.target.closest || !e.target.closest("#gh-more")) return;
    var still = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollBy({ top: Math.round(window.innerHeight * 0.6), behavior: still ? "auto" : "smooth" });
  });

  addEventListener("message", function (e) {
    if (e.source !== parent) return;
    var m = e.data;
    if (!m || m.type !== "voiceos:init") return;
    args = m.args && typeof m.args === "object" ? m.args : {};
    edits = {};
    hydrate();
    render();
    stamp();
    hint();
  });

  document.addEventListener("input", function (e) {
    var el = e.target, key = el && el.getAttribute ? el.getAttribute("data-gh-key") : null;
    if (!key || (el.type === "radio" && !el.checked)) return;
    if (el.hasAttribute("data-gh-line") && /[\r\n]/.test(el.value)) el.value = el.value.replace(/\s*[\r\n]+\s*/g, " ");
    if (el.hasAttribute("data-gh-grow")) grow(el);
    edits[key] = el.value;
    send({ type: "voiceos:updateInput", key: key, value: el.value });
    render();
    stamp();
    hint();
  });
})();`;

const CONFIRM_CSS = `
.gh-c{padding:13px 15px 6px;display:flex;flex-direction:column;gap:8px;min-width:0}
.gh-h{font-size:15px;font-weight:600;letter-spacing:-.01em;line-height:1.3;overflow-wrap:anywhere}
.gh-ttl{font-size:12.5px;color:var(--ink-2);margin-top:-5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.gh-f{display:flex;flex-direction:column;gap:4px;min-width:0}
.gh-f>span{font-size:11.5px;color:var(--ink-3)}
.gh-in{display:block;width:100%;font:13px/1.4 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;color:var(--ink-1);background:var(--fill-1);border:1px solid var(--line);border-radius:8px;padding:7px 9px;outline:none;resize:none;overflow:hidden;overflow-wrap:anywhere}
.gh-in:focus{border-color:var(--gh-link);box-shadow:0 0 0 3px color-mix(in srgb,var(--gh-link) 25%,transparent)}
.gh-in[readonly]{color:var(--ink-2);background:transparent}
.k-hd{align-items:flex-start}
.k-hd-l{flex:none}
#gh-where{white-space:normal;overflow-wrap:anywhere;text-align:right;min-width:0;flex:0 1 auto;line-height:1.35}
.gh-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.gh-two{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.gh-pair{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px}
.gh-seg{display:flex;gap:3px;padding:3px;border-radius:10px;background:var(--fill-1);border:1px solid var(--line)}
.gh-seg label{position:relative;flex:1 1 auto;display:flex;align-items:center;justify-content:center;gap:5px;height:28px;padding:0 10px;border-radius:7px;font-size:12px;font-weight:600;color:var(--ink-3);cursor:pointer;white-space:nowrap}
.gh-seg input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer}
.gh-seg .gh-i{width:13px;height:13px}
.gh-seg label:has(input:checked){color:var(--ink-1);background:var(--fill-2);box-shadow:inset 0 0 0 1px var(--line)}
.gh-seg label.ok:has(input:checked){background:color-mix(in srgb,var(--gh-open) 24%,transparent)}
.gh-seg label.ok:has(input:checked) .gh-i{color:var(--gh-open)}
.gh-seg label.no:has(input:checked){background:color-mix(in srgb,var(--gh-closed) 24%,transparent)}
.gh-seg label.no:has(input:checked) .gh-i{color:var(--gh-closed)}
.gh-seg label:has(input:focus-visible){outline:2px solid var(--gh-link);outline-offset:1px}
.gh-facts{display:flex;flex-wrap:wrap;align-items:center;gap:4px 12px;font-size:11.5px;color:var(--ink-3)}
.gh-facts .gh-mono{color:var(--ink-1)}
.gh-chg{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:12.5px}
.gh-chg li{display:contents}
.gh-chg b{font-weight:400;color:var(--ink-3)}
.gh-chg span{overflow-wrap:anywhere}
.gh-chg .danger{color:var(--gh-closed);font-weight:600}
.gh-prob{list-style:none;margin:0;padding:0;font-size:12px;color:var(--gh-closed);line-height:1.4}
.gh-note{font-size:11px;color:var(--ink-3);line-height:1.4}
.gh-count{font-size:11px;color:var(--gh-warn);text-align:right;margin-top:-4px}
.gh-morehint{position:fixed;left:12px;bottom:12px;z-index:30;display:flex;align-items:center;gap:4px;height:26px;padding:0 11px 0 8px;border:0;border-radius:999px;font:600 11.5px/1 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;color:var(--ink-1);background:rgba(44,44,48,.96);box-shadow:inset 0 0 0 1px var(--line),0 2px 10px rgba(0,0,0,.35);cursor:pointer}
html[data-k-theme=light] .gh-morehint{background:rgba(252,252,253,.97);box-shadow:inset 0 0 0 1px var(--line),0 2px 10px rgba(0,0,0,.12)}
.gh-morehint .gh-i{width:12px;height:12px}
.gh-morehint:focus-visible{outline:2px solid var(--gh-link);outline-offset:2px}
[hidden]{display:none!important}
`;

const ICONS = {
  down:
    '<svg class="gh-i" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M12.78 5.22a.749.749 0 0 1 0 1.06l-4.25 4.25a.749.749 0 0 1-1.06 0L3.22 6.28a.749.749 0 1 1 1.06-1.06L8 8.939l3.72-3.719a.749.749 0 0 1 1.06 0Z"/></svg>',
  alert:
    '<svg class="gh-i" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6.457 1.047c.659-1.234 2.427-1.234 3.086 0l6.082 11.378A1.75 1.75 0 0 1 14.082 15H1.918a1.75 1.75 0 0 1-1.543-2.575Zm1.763.707a.25.25 0 0 0-.44 0L1.698 13.132a.25.25 0 0 0 .22.368h12.164a.25.25 0 0 0 .22-.368Zm.53 3.996v2.5a.75.75 0 0 1-1.5 0v-2.5a.75.75 0 0 1 1.5 0ZM9 11a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z"/></svg>',
  check:
    '<svg class="gh-i" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.751.751 0 0 1 .018-1.042.751.751 0 0 1 1.042-.018L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0Z"/></svg>',
  stop:
    '<svg class="gh-i" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M4.47.22A.749.749 0 0 1 5 0h6c.199 0 .389.079.53.22l4.25 4.25c.141.14.22.331.22.53v6a.749.749 0 0 1-.22.53l-4.25 4.25A.749.749 0 0 1 11 16H5a.749.749 0 0 1-.53-.22L.22 11.53A.749.749 0 0 1 0 11V5c0-.199.079-.389.22-.53Zm.84 1.28L1.5 5.31v5.38l3.81 3.81h5.38l3.81-3.81V5.31L10.69 1.5ZM8 4a.75.75 0 0 1 .75.75v3.5a.75.75 0 0 1-1.5 0v-3.5A.75.75 0 0 1 8 4Zm0 8a1 1 0 1 1 0-2 1 1 0 0 1 0 2Z"/></svg>',
  comment:
    '<svg class="gh-i" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>',
};

const header = `<div class="k-hd"><div class="k-hd-l">${markHtml()}<span class="k-hd-t">GitHub</span></div><span class="k-hd-tr" id="gh-where"></span></div>`;
const problems = `<ul class="gh-prob" id="gh-prob" role="alert" hidden></ul>`;

/**
 * Every field is a textarea that grows with its content, so the card never
 * hides text the user approves, and none takes more than VoiceOS can carry as
 * an edit (titles stop at their own 240-character limit).
 */
function field(
  label: string,
  key: string,
  opts: { multiline?: boolean; optional?: boolean; placeholder?: string; rows?: number; quietLabel?: boolean; max?: number } = {},
) {
  const rows = opts.multiline ? (opts.rows ?? 4) : 1;
  const control = `<textarea class="gh-in" data-gh-key="${key}" rows="${rows}" maxlength="${opts.max ?? HOST_EDIT_MAX}" data-gh-grow${opts.multiline ? "" : " data-gh-line"}${
    opts.placeholder ? ` placeholder="${esc(opts.placeholder)}"` : ""
  }></textarea>`;
  // Said above the text, where it's seen first: a body this long scrolls far past the card.
  const tooLong = opts.multiline
    ? `<span class="gh-note" data-gh-long hidden>Too long to edit here.</span>`
    : "";
  return `<label class="gh-f"${opts.optional ? " data-gh-optional" : ""}><span${opts.quietLabel ? ' class="gh-sr"' : ""}>${esc(label)}</span>${tooLong}${control}</label>`;
}

export type WriteTool = Extract<Facade, "create_issue" | "update_issue" | "create_issue_comment" | "create_pull_request_review">;

const VIEWS: Record<WriteTool, { label: string; confirmLabel: string; height: number; body: () => string }> = {
  create_issue: {
    label: "Confirm new GitHub issue",
    confirmLabel: "Create issue",
    height: 344,
    body: () => `${header}<div class="gh-h" id="gh-h"></div>
      ${field("Title", "title", { max: 240 })}
      ${field("Description", "body", { multiline: true, placeholder: "Optional", rows: 3 })}
      <div class="gh-count" id="gh-count" hidden></div>
      <div class="gh-two">${field("Labels", "labels", { placeholder: "None" })}${field("Assignees", "assignees", { placeholder: "None" })}</div>
      ${problems}`,
  },
  update_issue: {
    label: "Confirm GitHub issue change",
    confirmLabel: "Update issue",
    height: 300,
    body: () => `${header}<div class="gh-h" id="gh-h"></div><div class="gh-ttl" id="gh-ttl" hidden></div>
      <ul class="gh-chg" id="gh-chg"></ul>
      ${field("New title", "title", { optional: true, max: 240 })}
      ${field("New description", "body", { multiline: true, optional: true, rows: 3 })}
      <div class="gh-count" id="gh-count" hidden></div>
      <div class="gh-pair">${field("Labels (replace all)", "labels", { optional: true, placeholder: "None" })}${field("Assignees (replace all)", "assignees", { optional: true, placeholder: "None" })}</div>
      <div class="gh-pair">${field("Add labels", "add_labels", { optional: true })}${field("Remove labels", "remove_labels", { optional: true })}</div>
      <div class="gh-pair">${field("Assign", "add_assignees", { optional: true })}${field("Unassign", "remove_assignees", { optional: true })}</div>
      ${problems}`,
  },
  create_issue_comment: {
    label: "Confirm GitHub comment",
    confirmLabel: "Post comment",
    height: 276,
    body: () => `${header}<div class="gh-h" id="gh-h"></div><div class="gh-ttl" id="gh-ttl" hidden></div>
      ${field("Comment", "body", { multiline: true, rows: 5 })}
      <div class="gh-count" id="gh-count" hidden></div>
      ${problems}`,
  },
  create_pull_request_review: {
    label: "Confirm GitHub pull request review",
    confirmLabel: "Submit review",
    height: 300,
    body: () => `${header}<div class="gh-h" id="gh-h"></div><div class="gh-ttl" id="gh-ttl" hidden></div>
      <div class="gh-facts"><span>Commit <span class="gh-mono" id="gh-sha"></span></span></div>
      <div class="gh-seg" role="radiogroup" aria-label="Review outcome">
        <label>${ICONS.comment}<input type="radio" name="gh-ev" value="COMMENT" data-gh-key="event" aria-label="Comment">Comment</label>
        <label class="ok">${ICONS.check}<input type="radio" name="gh-ev" value="APPROVE" data-gh-key="event" aria-label="Approve">Approve</label>
        <label class="no">${ICONS.stop}<input type="radio" name="gh-ev" value="REQUEST_CHANGES" data-gh-key="event" aria-label="Request changes">Request changes</label>
      </div>
      ${field("Review", "body", { multiline: true, rows: 3, placeholder: "Review text", quietLabel: true })}
      <div class="gh-count" id="gh-count" hidden></div>
      ${problems}
`,
  },
};

export interface ConfirmationView {
  schemaVersion: 1;
  root: { type: "widget"; html: string; height: number; confirmLabel: string; label: string };
}

export function buildConfirmation(tool: WriteTool): ConfirmationView {
  const view = VIEWS[tool];
  const script = `<script>var GH_TOOL = "${tool}";\n${RECEIPT_CORE_JS}\n${CONFIRM_LOGIC_JS}\n${CONFIRM_DOM_JS}</script>`;
  const card = renderCustom({
    mode: "confirm",
    css: `${CARD_CSS}\n${CONFIRM_CSS}`,
    body: `<div class="gh-c">${view.body()}</div><button type="button" class="gh-morehint" id="gh-more" hidden>${ICONS.down}More below</button>${script}`,
    height: view.height,
    label: view.label,
  });
  return { schemaVersion: 1, root: { type: "widget", html: card.html, height: card.height, confirmLabel: view.confirmLabel, label: view.label } };
}
