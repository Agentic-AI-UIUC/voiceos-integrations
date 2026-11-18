// TKC: the confirmation cards' pure rules (plain ES5, no DOM, no imports).
// confirm-card/build.ts injects src/errors.ts PRIVACY_LABELS at the marker
// below and inlines this text into every card's <script>; tests run the same
// text with node:vm. Booleans follow TKR.normBool exactly (true or "true"), so
// what the card shows is what the receipt signs and what the server reads.
var TKC = (function (LABELS) {
  "use strict";

  var LIMITS = { caption: 2200, title: 90, description: 4000 };
  // Counters appear past 90% of the limit; the photo title's counter always shows.
  var COUNTER_FROM = { caption: 1980, title: -1, description: 3600 };
  // VoiceOS drops a staged value longer than this (UPDATE_VALUE_MAX_CHARS).
  var EDIT_MAX = 16384;
  // Most public first, as TikTok's own picker lists them.
  var ORDER = ["PUBLIC_TO_EVERYONE", "FOLLOWER_OF_CREATOR", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"];
  var GATES = { allow_comment: "comment_disabled", allow_duet: "duet_disabled", allow_stitch: "stitch_disabled" };
  // fold: the signed text field that hashtags and mentions are folded into. cover: takes cover_ms.
  var TOOLS = {
    publish_video: { noun: "video", direct: true, gated: ["allow_comment", "allow_duet", "allow_stitch"], extra: ["is_aigc"], fields: ["caption"], fold: "caption", cover: true },
    post_photos: { noun: "photo", direct: true, gated: ["allow_comment"], extra: ["auto_add_music"], fields: ["title", "description"], fold: "description", cover: false },
    upload_video: { noun: "video", direct: false, gated: [], extra: ["copy_caption"], fields: ["caption"], fold: "caption", cover: false },
    upload_photos: { noun: "photo", direct: false, gated: [], extra: [], fields: ["title", "description"], fold: "description", cover: false }
  };
  // The user's audience words, keyed as privacyCode() squashes them (case, spaces, - and _ dropped). TikTok's own
  // codes squash to keys here too, so " self_only " and "SELF_ONLY" read the same. src/tools/writes.ts AUDIENCE matches.
  var AUDIENCE = {
    publictoeveryone: "PUBLIC_TO_EVERYONE", everyone: "PUBLIC_TO_EVERYONE", "public": "PUBLIC_TO_EVERYONE", anyone: "PUBLIC_TO_EVERYONE",
    followerofcreator: "FOLLOWER_OF_CREATOR", followers: "FOLLOWER_OF_CREATOR",
    mutualfollowfriends: "MUTUAL_FOLLOW_FRIENDS", friends: "MUTUAL_FOLLOW_FRIENDS", mutualfriends: "MUTUAL_FOLLOW_FRIENDS",
    selfonly: "SELF_ONLY", onlyme: "SELF_ONLY", justme: "SELF_ONLY", me: "SELF_ONLY", "private": "SELF_ONLY", self: "SELF_ONLY"
  };
  // A hashtag keeps runs of anything but whitespace, ASCII punctuation (all but _), common Unicode punctuation and
  // symbol blocks, and characters outside the BMP (emoji). ES5 has no \p{L}, so this is the complement instead.
  var TAG_RUN = /[^\s\x00-\x2F\x3A-\x40\x5B-\x5E\x60\x7B-\xA9\xAB-\xB4\xB6-\xB9\xBB-\xBF\xD7\xF7՚-՟։־׀׃׳״،؍؛؞؟٪-٭۔।॥॰๏๚๛ -⁯₠-⃿℀-⅏←-⯿⸀-⹿　-〄〈-〠〰\uD800-\uDFFF︎️︐-︟︰-﹯！-／：-＠［-｀｛-･￰-￿]+/g;
  // A TikTok handle: ASCII letters, digits, "." and "_" (src/captions.ts MENTION); dots at either end are dropped.
  var HANDLE_RUN = /[A-Za-z0-9._]+/g;
  var COVER_UNIT = /\s*(\d+(?:\.\d*)?|\.\d+)\s*(milliseconds?|millis?|msecs?|ms|seconds?|secs?|s|minutes?|mins?|m|hours?|hrs?|h)(?![a-z])/g;
  var MAX_MS = 9007199254740991;
  var COPY = {
    pick: "Pick who can see this post",
    noOptions: "TikTok's privacy options are missing. Ask again and I'll refresh your options.",
    onlyMeBlocked: "Branded content visibility cannot be set to private.",
    brandedBlocked: "Until TikTok approves this app, posts can only be 'Only me'. Send it to drafts and post it from the TikTok app, or turn off Branded content.",
    brandedPrivate: "Branded content can't be private.",
    turnedOff: "Turned off for this account",
    disclosureHint: "You need to indicate if your content promotes yourself, a third party, or both.",
    labelFixed: "The label can't be changed after posting.",
    music: "For promotional posts, pick music from TikTok's Commercial Music Library in the app instead of recommended music.",
    consent: "By posting, you agree to TikTok's Music Usage Confirmation.",
    consentBranded: "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation.",
    tooLongEdit: "Too long to edit here."
  };

  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function missing(v) { return v === undefined || v === null; }
  function given(v) { return !missing(v) && v !== ""; }
  function isArray(v) { return Object.prototype.toString.call(v) === "[object Array]"; }
  function txt(v) { return missing(v) ? "" : String(v).replace(/^\s+|\s+$/g, ""); }
  function upper(v) { return txt(v).toUpperCase(); }
  function isOn(v) { return v === true || v === "true"; }
  function group(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }

  // TikTok's privacy code for the user's word ("only me", "Friends", "mutual-friends"), or the value trimmed and
  // upper-cased as TKR.normUpper signs it when it isn't one ("SELF_ONLY", a code TikTok adds later, "").
  function privacyCode(v) {
    var k = txt(v).toLowerCase().replace(/[\s_-]+/g, "");
    return own(AUDIENCE, k) ? AUDIENCE[k] : upper(v);
  }

  function squash(s, re) {
    var m = String(s).match(re);
    return m ? m.join("") : "";
  }
  function handle(s) { return squash(s, HANDLE_RUN).replace(/^\.+|\.+$/g, ""); }
  // The run at the very start of s ("" when s starts with a break).
  function lead(s, re) {
    re.lastIndex = 0;
    var m = re.exec(s);
    re.lastIndex = 0;
    return m && m.index === 0 ? m[0] : "";
  }

  // The tags of one kind already in the text, as a lower-cased set ("#AI" and "#ai" are the same tag).
  function tagsIn(text, mark) {
    var seen = {}, parts = String(text).split(mark), body;
    for (var i = 1; i < parts.length; i++) {
      body = mark === "#" ? lead(parts[i], TAG_RUN) : lead(parts[i], HANDLE_RUN).replace(/^\.+|\.+$/g, "");
      if (body) seen["$" + body.toLowerCase()] = 1;
    }
    return seen;
  }

  // hashtags or mentions as {mark, body} items. A list: one tag per item ("machine learning" is #machinelearning),
  // commas splitting an item too. One string: commas separate, or else spaces. An item that spells out several
  // marked words ("#ai #tech") is one per word. A word's own # or @ decides its kind; others take `mark`.
  function tagItems(v, mark) {
    var pieces = [], out = [], i, j, s, words, w, m, body;
    function plain(x) { return typeof x === "string" || (typeof x === "number" && isFinite(x)); }
    if (isArray(v)) {
      for (i = 0; i < v.length; i++) if (plain(v[i])) pieces = pieces.concat(String(v[i]).split(/[,，、;]+/));
    } else if (plain(v)) {
      s = String(v);
      pieces = /[,，、;]/.test(s) ? s.split(/[,，、;]+/) : s.split(/\s+/);
    }
    for (i = 0; i < pieces.length; i++) {
      s = txt(pieces[i]);
      if (!s) continue;
      words = /\s[#@＃＠]/.test(s) ? s.split(/\s+/) : [s];
      for (j = 0; j < words.length; j++) {
        w = words[j];
        m = /^[#＃]/.test(w) ? "#" : /^[@＠]/.test(w) ? "@" : mark;
        body = m === "#" ? squash(w, TAG_RUN) : handle(w);
        if (body) out.push({ mark: m, body: body });
      }
    }
    return out;
  }

  // The text with the hashtags, then the mentions, appended: normalized (#machinelearning, @maya.makes), each once
  // (any case), and none already in the text. Single spaces join them to the text, whose trailing spaces go; text
  // ending in a line break gets them on the next line. Nothing to add returns the text unchanged. `field` names the
  // target ("caption" or "description"); folding is the same for both, and the result may run past that field's
  // limit (TKC.textInfo(field, text).over then says so, and the server refuses it).
  function foldTags(text, hashtags, mentions, field) {
    var base = missing(text) ? "" : String(text), have = { "#": tagsIn(base, "#"), "@": tagsIn(base, "@") }, out = { "#": [], "@": [] };
    var list = tagItems(hashtags, "#").concat(tagItems(mentions, "@"));
    for (var i = 0; i < list.length; i++) {
      var key = "$" + list[i].body.toLowerCase(), seen = have[list[i].mark];
      if (seen[key]) continue;
      seen[key] = 1;
      out[list[i].mark].push(list[i].mark + list[i].body);
    }
    var add = out["#"].concat(out["@"]);
    if (!add.length) return base;
    var head = base.replace(/[ \t ]+$/, "");
    return head + (head && !/\n$/.test(head) ? " " : "") + add.join(" ");
  }

  function msText(x) { return isFinite(x) && x >= 0 && x <= MAX_MS ? String(Math.round(x)) : ""; }

  // cover_ms as a digit string of milliseconds, or "" when it can't be read. A whole number is milliseconds, as
  // before (3000, "3000"); a decimal point or a unit means seconds or that unit ("2.5", "5s", "5.5 s", "5 seconds",
  // "1 min 30 s", "500ms"); a clock is m:ss or h:mm:ss ("0:05", "1:02", "0:05.5"). A leading "at" is fine.
  function coverMs(v) {
    if (missing(v)) return "";
    if (typeof v === "number") return Math.floor(v) === v ? msText(v) : msText(v * 1000);
    if (typeof v !== "string") return "";
    var s = txt(v).toLowerCase().replace(/^at\s+/, ""), m;
    if (!s) return "";
    if (/^\d+$/.test(s)) return msText(Number(s)) && s.replace(/^0+(?=\d)/, "");
    m = /^(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(s);
    if (m) {
      var hh = m[1] ? Number(m[1]) : 0, mm = Number(m[2]), ss = Number(m[3]);
      if (ss >= 60 || (m[1] && mm >= 60)) return "";
      return msText((hh * 3600 + mm * 60 + ss) * 1000);
    }
    if (/^(\d+\.\d*|\.\d+)$/.test(s)) return msText(Number(s) * 1000);
    var rest = s.replace(/,|\band\b/g, " "), pos = 0, total = 0, n = 0, u;
    COVER_UNIT.lastIndex = 0;
    while ((m = COVER_UNIT.exec(rest)) !== null) {
      if (m.index !== pos) break;
      u = m[2];
      total += Number(m[1]) * (/^(ms|msec|milli)/.test(u) ? 1 : u.charAt(0) === "m" ? 60000 : u.charAt(0) === "s" ? 1000 : 3600000);
      pos = COVER_UNIT.lastIndex;
      n++;
    }
    COVER_UNIT.lastIndex = 0;
    return n && !/\S/.test(rest.slice(pos)) ? msText(total) : "";
  }

  // A cover time as the card shows it: "0:05", "1:02", "1:02:03", tenths when there are any ("0:05.5").
  // "Frame at 0:03", "Cover: 0:03" -> "0:03": a cover_label's time, as the card shows it beside its own "Cover".
  function coverWords(v) { return txt(v).replace(/^(?:cover|frame)(?:\s+frame)?(?:\s+at)?\s*:?\s*/i, ""); }

  function coverLabel(ms) {
    var n = Number(ms);
    if (!isFinite(n) || n < 0) return "";
    var s = Math.floor(n / 1000), tenths = Math.floor((n % 1000) / 100), h = Math.floor(s / 3600), mi = Math.floor(s / 60) % 60, se = s % 60;
    var out = (h ? h + ":" + (mi < 10 ? "0" : "") + mi : String(mi)) + ":" + (se < 10 ? "0" : "") + se;
    return tenths ? out + "." + tenths : out;
  }

  function rank(code) {
    for (var i = 0; i < ORDER.length; i++) if (ORDER[i] === code) return i;
    return -1;
  }

  // privacy_options as an array or a comma string (TKR.normOptions' parse), de-duplicated, most public first.
  function options(v) {
    var items = missing(v) ? [] : Object.prototype.toString.call(v) === "[object Array]" ? v : String(v).split(",");
    var seen = {}, known = [], other = [];
    for (var i = 0; i < items.length; i++) {
      var o = upper(items[i]);
      if (!o || seen["$" + o]) continue;
      seen["$" + o] = 1;
      (rank(o) >= 0 ? known : other).push(o);
    }
    known.sort(function (x, y) { return rank(x) - rank(y); });
    return known.concat(other);
  }

  function label(code) {
    var c = upper(code);
    if (own(LABELS, c)) return LABELS[c];
    var words = c.toLowerCase().replace(/_+/g, " ").replace(/^\s+|\s+$/g, "");
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : "";
  }

  // Display-only labels: one line of text, capped so a runaway value can't swamp the card.
  function short(v, max) {
    var s = txt(v).replace(/\s+/g, " ");
    return s.length > max ? s.slice(0, max - 1) + "…" : s;
  }

  // Lengths in UTF-16 code units, as TikTok counts them (emoji usually count as 2).
  function textInfo(field, v) {
    var value = missing(v) ? "" : String(v).replace(/\r\n/g, "\n");
    var limit = LIMITS[field], n = value.length, over = n > limit;
    return {
      length: n,
      limit: limit,
      show: over || n > COUNTER_FROM[field],
      over: over,
      counter: group(n) + " / " + group(limit),
      error: over ? "Too long for TikTok: shorten it to " + group(limit) + " characters (emoji count as 2)." : "",
      readOnly: n > EDIT_MAX
    };
  }

  // The staged corrections (key -> string) that make the arguments match what the card shows.
  // Every write: hashtags and mentions folded into the signed caption (photos: description) and
  // staged as "", so a click sends the folded text alone (the server ignores both fields); a worded
  // cover time as milliseconds, and a cover_label that shows it: one naming another second is replaced,
  // and one with no readable cover is cleared (the server refuses a label that disagrees). Direct posts only:
  // creator-disabled interactions off; brand options only with disclosure on (a disclosure the
  // agent proposed is kept, never dropped); privacy one of the creator's options (audience words
  // read as TikTok's codes), never Only me with Branded content. `changed` is the key the user just
  // edited, or null at init. Folding runs whenever hashtags or mentions hold something, which after
  // init they no longer do, so a caption the user edits stays as they wrote it.
  function settle(tool, a, changed) {
    var t = own(TOOLS, tool) ? TOOLS[tool] : null, out = {};
    a = a || {};
    if (!t) return out;
    function get(k) { return own(out, k) ? out[k] : a[k]; }
    if (given(a.hashtags) || given(a.mentions)) {
      var before = missing(a[t.fold]) ? "" : String(a[t.fold]), after = foldTags(a[t.fold], a.hashtags, a.mentions, t.fold);
      if (after !== before) out[t.fold] = after;
      if (given(a.hashtags)) out.hashtags = "";
      if (given(a.mentions)) out.mentions = "";
    }
    if (t.cover) {
      var cover = given(a.cover_ms) ? coverMs(a.cover_ms) : "";
      var whole = typeof a.cover_ms === "number" ? Math.floor(a.cover_ms) === a.cover_ms : /^\s*\d+\s*$/.test(txt(a.cover_ms));
      // A whole number stays as it came (TKR.normInt signs it as before); words and decimals become the digit string.
      if (cover && !whole) out.cover_ms = cover;
      // The cover line shows the signed time (to the second, like src/tools/writes.ts cardLabelsAreTrue).
      var shown = txt(a.cover_label) ? coverMs(coverWords(a.cover_label)) : "";
      if (cover && !(shown && Math.abs(Number(shown) - Number(cover)) < 1000)) out.cover_label = coverLabel(cover);
      else if (!cover && txt(a.cover_label)) out.cover_label = "";
    }
    if (!t.direct) return out;
    for (var i = 0; i < t.gated.length; i++) {
      var k = t.gated[i];
      if (isOn(a[GATES[k]]) && get(k) !== "false") out[k] = "false";
    }
    if (!isOn(get("commercial_disclosure")) && (isOn(get("brand_organic")) || isOn(get("brand_content")))) {
      if (changed === "commercial_disclosure") {
        if (isOn(get("brand_organic"))) out.brand_organic = "false";
        if (isOn(get("brand_content"))) out.brand_content = "false";
      } else {
        out.commercial_disclosure = "true";
      }
    }
    var opts = options(a.privacy_options), raw = get("privacy_level"), want = privacyCode(raw);
    var branded = isOn(get("commercial_disclosure")) && isOn(get("brand_content"));
    var known = false;
    for (var j = 0; j < opts.length; j++) if (opts[j] === want) known = true;
    if (want && !known) want = "";
    if (want === "SELF_ONLY" && branded) want = "";
    if (missing(raw) ? want !== "" : String(raw) !== want) out.privacy_level = want;
    return out;
  }

  function settled(tool, a) {
    var fix = settle(tool, a, null), s = {}, k;
    a = a || {};
    for (k in a) if (own(a, k)) s[k] = a[k];
    for (k in fix) if (own(fix, k)) s[k] = fix[k];
    return s;
  }

  function sw(on, disabled, note) { return { on: !!on, disabled: !!disabled, note: note || "" }; }

  // Everything the card renders for these arguments (settled first, so it never shows an impossible state).
  function view(tool, a0) {
    var t = own(TOOLS, tool) ? TOOLS[tool] : TOOLS.upload_video;
    var a = settled(tool, a0), v = { tool: tool, noun: t.noun, direct: t.direct, toggles: {}, text: {} };
    var i, k;
    for (i = 0; i < t.fields.length; i++) v.text[t.fields[i]] = textInfo(t.fields[i], a[t.fields[i]]);
    for (i = 0; i < t.extra.length; i++) v.toggles[t.extra[i]] = sw(isOn(a[t.extra[i]]), false, "");
    v.branded = false;
    if (!t.direct) return v;

    var disclose = isOn(a.commercial_disclosure);
    var brand = disclose && isOn(a.brand_organic), branded = disclose && isOn(a.brand_content);
    var p = privacyCode(a.privacy_level), opts = options(a.privacy_options), items = [], enabled = 0, hasSelf = false;
    for (i = 0; i < opts.length; i++) {
      var off = branded && opts[i] === "SELF_ONLY";
      if (opts[i] === "SELF_ONLY") hasSelf = true;
      if (!off) enabled++;
      items.push({ value: opts[i], label: label(opts[i]), checked: opts[i] === p, disabled: off });
    }
    v.privacy = {
      items: items,
      selected: p,
      prompt: !p && enabled > 0 ? COPY.pick : "",
      note: !opts.length ? COPY.noOptions : branded && hasSelf ? (enabled ? COPY.onlyMeBlocked : COPY.brandedBlocked) : ""
    };
    for (i = 0; i < t.gated.length; i++) {
      k = t.gated[i];
      var gated = isOn(a[GATES[k]]);
      v.toggles[k] = sw(!gated && isOn(a[k]), gated, gated ? COPY.turnedOff : "");
    }
    var selfOnly = p === "SELF_ONLY";
    v.toggles.commercial_disclosure = sw(disclose, false, "");
    v.toggles.brand_organic = sw(brand, false, "");
    v.toggles.brand_content = sw(branded, selfOnly && !branded, selfOnly && !branded ? COPY.brandedPrivate : "");
    var noun = "Your " + t.noun + " will be labeled ";
    v.disclosure = {
      on: disclose,
      brand: brand,
      branded: branded,
      hint: disclose && !brand && !branded ? COPY.disclosureHint : "",
      label: branded ? noun + "'Paid partnership'. " + COPY.labelFixed : brand ? noun + "'Promotional content'. " + COPY.labelFixed : "",
      music: disclose && tool === "post_photos" ? COPY.music : ""
    };
    v.branded = branded;
    v.consent = branded ? COPY.consentBranded : COPY.consent;
    return v;
  }

  return {
    LIMITS: LIMITS, EDIT_MAX: EDIT_MAX, COPY: COPY, TOOLS: TOOLS, ORDER: ORDER,
    txt: txt, upper: upper, isOn: isOn, group: group, options: options, label: label, short: short,
    textInfo: textInfo, settle: settle, view: view,
    privacyCode: privacyCode, foldTags: foldTags, coverMs: coverMs, coverLabel: coverLabel
  };
})(/*@TK_PRIVACY_LABELS@*/{});
