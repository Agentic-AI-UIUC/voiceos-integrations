// Card wiring (plain ES5; needs TK_TOOL, TKR, TKP and TKC defined before it).
// On voiceos:init: hydrate every field from args, stage the corrections TKC.settle
// asks for, render, then mint and stage confirmation_receipt. On every edit: stage
// {key, value} (checkboxes "true"/"false", privacy its value), settle dependent
// rules, re-render, re-mint over args overlaid with edits (exactly what VoiceOS
// sends on a click). Our controls carry data-tk-key, never data-voiceos-key, so
// the Widget Kit's bridge (which sets .value on keyed elements) leaves them alone.
// Text reaches the DOM only through .value and .textContent; the preview only as
// canvas pixels (TKP decodes the `preview` argument; it is never staged).
(function () {
  "use strict";
  var TOOL = TK_TOOL, EDIT_MAX = TKC.EDIT_MAX, REFRESH_MS = 120000;
  var args = {}, edits = {}, ready = false, optsSig = null, boxes = null;

  function $(id) { return document.getElementById(id); }
  function all(sel) { return document.querySelectorAll(sel); }
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function str(v) { return v === undefined || v === null ? "" : String(v); }
  function send(m) { try { parent.postMessage(m, "*"); } catch (e) {} }
  function keyOf(el) { return el && el.getAttribute ? el.getAttribute("data-tk-key") : null; }
  function setText(el, s) { if (el && el.textContent !== s) el.textContent = s; }
  function show(el, on) { if (el) el.hidden = !on; }

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
    if (!ready) return;
    send({ type: "voiceos:updateInput", key: "confirmation_receipt", value: TKR.mint(TOOL, merged(), Date.now(), nonce()) });
  }
  function stage(key, value) {
    edits[key] = value;
    send({ type: "voiceos:updateInput", key: key, value: value });
  }
  function settle(changed) {
    var fix = TKC.settle(TOOL, merged(), changed);
    for (var k in fix) if (own(fix, k)) stage(k, fix[k]);
  }

  // A text box starts one line tall and grows with its content up to data-tk-lines lines, then scrolls inside
  // itself, so a short caption is a short box and a long one never pushes the card past the notch.
  function grow(el) {
    if (!el || !el.offsetParent) return;
    var cs = getComputedStyle(el), lh = parseFloat(cs.lineHeight), pad, n, max, h;
    if (!isFinite(lh) || lh <= 0) lh = (parseFloat(cs.fontSize) || 13) * 1.42;
    pad = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    n = Number(el.getAttribute("data-tk-lines")) || 5;
    max = Math.ceil(lh * n + pad);
    el.style.height = "auto";
    h = el.scrollHeight + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    el.style.height = Math.min(h, max) + "px";
    el.style.overflowY = h > max + 1 ? "auto" : "hidden";
    sync(el);
  }
  function growAll() {
    var els = all("[data-tk-grow]");
    for (var i = 0; i < els.length; i++) grow(els[i]);
  }

  // #hashtags and @mentions tinted, as in TikTok's composer: a mirror under the (then transparent) textarea
  // draws the same text with the tags in spans. Text nodes and .textContent only; the mirror follows the
  // textarea's scroll. Read-only text (too long to edit) keeps the textarea's own colour.
  // A tag starts a word (so "me@x.com" isn't a mention): group 1 is what comes before it, group 2 the tag.
  var TAG_RE = /(^|[^A-Za-z0-9_])([#＃][^\s#＃@.,!?;:()[\]{}"'<>“”‘’]+|@[A-Za-z0-9_](?:[A-Za-z0-9._]*[A-Za-z0-9_])?)/g;
  function mirrorOf(el) {
    var id = el && el.getAttribute ? el.getAttribute("data-tk-tags") : null;
    return id ? $(id) : null;
  }
  function sync(el) {
    var hl = mirrorOf(el);
    if (hl && hl.scrollTop !== el.scrollTop) hl.scrollTop = el.scrollTop;
  }
  function paint(el) {
    var hl = mirrorOf(el), text, last = 0, m, span, wrap = el && el.parentNode;
    if (!hl || !wrap || !wrap.classList) return;
    while (hl.firstChild) hl.removeChild(hl.firstChild);
    if (el.readOnly || !document.createTextNode) {
      wrap.classList.remove("tk-tinted");
      return;
    }
    text = str(el.value);
    TAG_RE.lastIndex = 0;
    while ((m = TAG_RE.exec(text))) {
      var at = m.index + m[1].length;
      if (at > last) hl.appendChild(document.createTextNode(text.slice(last, at)));
      span = document.createElement("span");
      span.className = "tk-tag";
      span.textContent = m[2];
      hl.appendChild(span);
      last = at + m[2].length;
    }
    // The zero-width space keeps a trailing line break as tall as the textarea draws it.
    hl.appendChild(document.createTextNode(text.slice(last) + "​"));
    wrap.classList.add("tk-tinted");
    sync(el);
  }
  function paintAll() {
    var els = all("[data-tk-tags]");
    for (var i = 0; i < els.length; i++) paint(els[i]);
  }
  function boxOf(el) {
    while (el && el !== document.body && !(el.classList && el.classList.contains("tk-box"))) el = el.parentNode;
    return el && el.classList && el.classList.contains("tk-box") ? el : null;
  }

  // Content can run under the band VoiceOS's button floats over: say so instead of hiding it.
  // The hint lives in that opaque band (drafts) or on a strip the footer adds above the
  // consent line (direct posts), so it never sits over content.
  function hint() {
    var more = $("tk-more"), root = document.documentElement;
    if (!more || !root) return;
    var full = root.scrollHeight, seen = (window.scrollY || window.pageYOffset || 0) + window.innerHeight;
    var below = typeof full === "number" && isFinite(seen) && full - seen > 2;
    more.hidden = !below;
    var foot = $("tk-foot");
    if (foot) foot.classList.toggle("tk-more-on", below);
  }

  // A monogram for the account ("Tiny AI Lab" -> "TA", "@thetinyailab" -> "T").
  function initials(name) {
    var words = TKC.txt(name).replace(/^@+/, "").split(/[\s._-]+/), out = "", i, w, c;
    for (i = 0; i < words.length && out.length < 4; i++) {
      w = words[i];
      if (!w) continue;
      c = w.charCodeAt(0);
      out += c >= 0xd800 && c <= 0xdbff ? w.slice(0, 2) : w.charAt(0);
      if (out.length >= 2 && i >= 1) break;
    }
    return out.toUpperCase();
  }

  function clock(seconds) {
    var s = Math.round(seconds), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return (h ? h + ":" + (m < 10 ? "0" : "") : "") + m + ":" + (r < 10 ? "0" : "") + r;
  }

  // ---- Media: the preview's frames, decoded (TKP) and drawn as canvas pixels only.
  function still() { return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches); }
  function now() { return window.performance && performance.now ? performance.now() : Date.now(); }
  function ease(x) { return x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x); }

  // A fixed grain tile (a tiny LCG, the same every time), laid over the media very lightly (CSS overlay
  // blend) so a soft frame reads as a photograph rather than a smear.
  var noise = null;
  function grain() {
    if (noise !== null) return noise || null;
    noise = false;
    var c = document.createElement("canvas"), ctx = c.getContext ? c.getContext("2d") : null, img, d, i, v, seed = 1013904223;
    if (!ctx || !ctx.createImageData) return null;
    c.width = 128;
    c.height = 128;
    img = ctx.createImageData(128, 128);
    d = img.data;
    for (i = 0; i < d.length; i += 4) {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      v = 78 + Math.floor((seed / 4294967296) * 100);
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    try { noise = c.toDataURL("image/png"); } catch (e) { noise = false; }
    return noise || null;
  }
  function grainOn(els) {
    var url = grain(), i;
    if (!url) return;
    for (i = 0; i < els.length; i++) els[i].style.backgroundImage = "url(" + url + ")";
  }

  // Decoded rgba onto a canvas at its own size.
  function bitmap(d) {
    var c = document.createElement("canvas"), ctx = c.getContext ? c.getContext("2d") : null, img;
    if (!ctx || !ctx.createImageData) return null;
    c.width = d.w;
    c.height = d.h;
    img = ctx.createImageData(d.w, d.h);
    img.data.set(d.rgba);
    ctx.putImageData(img, 0, 0);
    return c;
  }

  // Smooth upscale in steps of at most 2x (each a high-quality resample), so a 45 x 80 frame
  // reaches the tile's pixels soft and clean instead of blocky.
  function enlarge(src, W, H) {
    var cur = src, w = src.width, h = src.height, next, ctx;
    while (w * 2 < W || h * 2 < H) {
      w *= 2;
      h *= 2;
      next = document.createElement("canvas");
      next.width = w;
      next.height = h;
      ctx = next.getContext("2d");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(cur, 0, 0, w, h);
      cur = next;
    }
    return cur;
  }

  // One frame as a W x H plate, drawn to cover. A landscape frame on a portrait plate sits centred over a
  // blurred, darkened copy of itself, the way TikTok's feed shows a landscape video.
  function plate(d, W, H) {
    var src = bitmap(d), out = document.createElement("canvas"), ctx = out.getContext ? out.getContext("2d") : null, big, k, dw, dh;
    if (!src || !ctx) return null;
    out.width = W;
    out.height = H;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    big = enlarge(src, W, H);
    k = Math.max(W / d.w, H / d.h);
    if (d.w > d.h && H > W) {
      ctx.filter = "blur(10px) saturate(1.2)";
      ctx.drawImage(big, (W - d.w * k * 1.15) / 2, (H - d.h * k * 1.15) / 2, d.w * k * 1.15, d.h * k * 1.15);
      ctx.filter = "none";
      ctx.fillStyle = "rgba(0,0,0,0.38)";
      ctx.fillRect(0, 0, W, H);
      k = Math.min(W / d.w, H / d.h);
    }
    dw = d.w * k;
    dh = d.h * k;
    ctx.drawImage(big, (W - dw) / 2, (H - dh) / 2, dw, dh);
    return out;
  }

  // ---- The video tile: up to three frames playing on one canvas. Each frame is on screen for SHOW_MS,
  // pushing in slowly (Ken Burns, a different drift each), and cross-fades into the next over FADE_MS; it
  // develops from a blur when the card opens. Hover or a click pauses; the segments show the frame playing.
  var SHOW_MS = 2600, FADE_MS = 900, DEVELOP_MS = 1000, TILE_W = 224, TILE_H = 398;
  var DRIFT = [[-0.6, 0.5], [0.6, -0.4], [0.2, 0.7]];
  var vid = { plates: [], ctx: null, segs: [], raf: 0, at: 0, last: 0, born: 0, paused: false, hover: false };

  function kenBurns(ctx, p, k, life, alpha) {
    var z = still() ? 1 : 1.02 + 0.1 * ease(life), dr = DRIFT[k % DRIFT.length];
    var sw = TILE_W / z, sh = TILE_H / z, mx = (TILE_W - sw) / 2, my = (TILE_H - sh) / 2;
    var t = still() ? 0 : ease(life) * 2 - 1;
    ctx.globalAlpha = alpha;
    ctx.drawImage(p, mx + dr[0] * mx * t, my + dr[1] * my * t, sw, sh, 0, 0, TILE_W, TILE_H);
    ctx.globalAlpha = 1;
  }

  function drawVideo() {
    var n = vid.plates.length, ctx = vid.ctx, t, i, into, life, mix, born, j, seg;
    if (!n || !ctx) return;
    born = now() - vid.born;
    if (n === 1) {
      // One frame: a slow breath in and out.
      t = (vid.at % 9000) / 9000;
      life = t < 0.5 ? t * 2 : 2 - t * 2;
      i = 0;
      into = 0;
      mix = 0;
    } else {
      t = vid.at % (n * SHOW_MS);
      i = Math.floor(t / SHOW_MS);
      into = t - i * SHOW_MS;
      life = (into + FADE_MS) / (SHOW_MS + FADE_MS);
      mix = into > SHOW_MS - FADE_MS ? (into - (SHOW_MS - FADE_MS)) / FADE_MS : 0;
    }
    if (born < DEVELOP_MS && !still()) ctx.filter = "blur(" + (5 * (1 - ease(born / DEVELOP_MS))).toFixed(2) + "px)";
    kenBurns(ctx, vid.plates[i], i, life, 1);
    if (mix > 0) kenBurns(ctx, vid.plates[(i + 1) % n], (i + 1) % n, (into - (SHOW_MS - FADE_MS)) / (SHOW_MS + FADE_MS), ease(mix));
    ctx.filter = "none";
    for (j = 0; j < vid.segs.length; j++) {
      seg = vid.segs[j];
      seg.style.transform = "scaleX(" + (j < i ? 1 : j > i ? 0 : Math.min(1, into / SHOW_MS)).toFixed(3) + ")";
    }
  }

  // Frames come from requestAnimationFrame (none in a renderer without it: the first frame stays).
  var raf = window.requestAnimationFrame ? function (fn) { return window.requestAnimationFrame(fn); } : null;
  var unraf = window.cancelAnimationFrame ? function (id) { window.cancelAnimationFrame(id); } : function () {};

  function tick() {
    var t = now();
    vid.raf = 0;
    if (!vid.paused && !vid.hover && !document.hidden) vid.at += Math.min(100, t - vid.last);
    vid.last = t;
    drawVideo();
    if (vid.plates.length && raf) vid.raf = raf(tick);
  }

  function setPaused(on) {
    vid.paused = on;
    var tile = $("tk-tile");
    if (tile) tile.classList.toggle("tk-paused", on);
  }

  // The video's tile: decoded frames (either preview version), or the designed fallback.
  function preview() {
    var tile = $("tk-tile"), box = $("tk-frames"), prog = $("tk-prog"), p = null, i, d, c, seg;
    if (!tile || !box || !tile.classList.contains("tk-tile-v")) return null;
    if (vid.raf) unraf(vid.raf);
    vid.raf = 0;
    vid.plates = [];
    vid.segs = [];
    while (box.firstChild) box.removeChild(box.firstChild);
    if (prog) while (prog.firstChild) prog.removeChild(prog.firstChild);
    tile.classList.remove("tk-has");
    setText($("tk-fb-n"), TKC.short(args.file_name, 60));
    try { p = TKP.split(str(args.preview)); } catch (e) { p = null; }
    if (!p) return null;
    for (i = 0; i < p.frames.length; i++) {
      try {
        d = TKP.frame(p.frames[i], p.version, 8);
        c = d ? plate(d, TILE_W, TILE_H) : null;
      } catch (e) { c = null; }
      if (c) vid.plates.push(c);
    }
    if (!vid.plates.length) return p;
    c = document.createElement("canvas");
    c.width = TILE_W;
    c.height = TILE_H;
    c.setAttribute("id", "tk-screen");
    c.setAttribute("aria-hidden", "true");
    vid.ctx = c.getContext("2d");
    vid.ctx.imageSmoothingEnabled = true;
    vid.ctx.imageSmoothingQuality = "high";
    box.appendChild(c);
    if (prog && vid.plates.length > 1) {
      for (i = 0; i < vid.plates.length; i++) {
        seg = document.createElement("span");
        seg.appendChild(document.createElement("i"));
        prog.appendChild(seg);
        vid.segs.push(seg.firstChild);
      }
    }
    grainOn(tile.querySelectorAll(".tk-grain"));
    tile.classList.add("tk-has");
    vid.at = 0;
    vid.born = vid.last = now();
    drawVideo();
    if (raf) vid.raf = raf(tick);
    return p;
  }

  // ---- The photo stack (photo cards): decoded frames as cards; the top one swipes away to the left and
  // tucks in at the back every STEP_MS, through the whole stack. A drag, a click, Return, Space or the arrow
  // keys move it by hand; hovering or focusing pauses the loop. Reduced motion: the photos cross-fade in
  // place. The cards carry only canvas pixels and their position ("2/6"), set with .textContent.
  var STEP_MS = 2800, OUT_MS = 340, SETTLE_MS = 860;
  var stk = { cards: [], order: [], count: 0, timer: 0, busy: false, hover: false, focus: false, drag: null, dragged: false };

  function within(el, id) {
    while (el && el !== document.body) {
      if (el.id === id) return true;
      el = el.parentNode;
    }
    return false;
  }

  function dots() {
    var box = $("tk-stk-dots"), i;
    if (box) for (i = 0; i < box.children.length; i++) box.children[i].className = i === stk.order[0] ? "tk-on" : "";
  }

  // Each card into its depth (the order's index), the dots and the label to match.
  function place() {
    var n = stk.order.length, k, card;
    for (k = 0; k < n; k++) {
      card = stk.cards[stk.order[k]];
      card.style.transform = "";
      card.className = "tk-sc tk-s" + Math.min(k, 4);
    }
    dots();
    var wrap = $("tk-stack");
    if (wrap && n) wrap.setAttribute("aria-label", "Photo " + (stk.order[0] + 1) + " of " + stk.count + ". Click or swipe to see the next one.");
  }

  function say() {
    setText($("tk-stk-live"), "Photo " + (stk.order[0] + 1) + " of " + stk.count);
  }

  function step(dir, byHand) {
    var n = stk.order.length, moving, k;
    if (stk.busy || n < 2) return;
    stk.busy = true;
    if (still()) {
      // Cross-fade: the top photo fades out over the next one, then goes to the back unseen.
      if (dir > 0) {
        moving = stk.cards[stk.order[0]];
        moving.className += " tk-fade";
        setTimeout(function () {
          stk.order.push(stk.order.shift());
          place();
          stk.busy = false;
        }, 500);
      } else {
        stk.order.unshift(stk.order.pop());
        place();
        stk.busy = false;
      }
    } else if (dir > 0) {
      // Swipe: away to the left while the rest move up a place; then it tucks in at the back.
      moving = stk.cards[stk.order[0]];
      stk.order.push(stk.order.shift());
      for (k = 0; k < n - 1; k++) stk.cards[stk.order[k]].className = "tk-sc tk-s" + Math.min(k, 4);
      moving.style.transform = "";
      moving.className = "tk-sc tk-out";
      setTimeout(function () {
        moving.className = "tk-sc tk-back tk-s" + Math.min(n - 1, 4);
      }, OUT_MS);
      setTimeout(function () {
        place();
        stk.busy = false;
      }, SETTLE_MS);
    } else {
      // Back one: the last card slips out from behind on the left, then lands on top.
      moving = stk.cards[stk.order[n - 1]];
      stk.order.unshift(stk.order.pop());
      for (k = 1; k < n; k++) stk.cards[stk.order[k]].className = "tk-sc tk-s" + Math.min(k, 4);
      moving.className = "tk-sc tk-out tk-under";
      setTimeout(function () {
        moving.className = "tk-sc tk-s0";
      }, OUT_MS + 40);
      setTimeout(function () {
        place();
        stk.busy = false;
      }, SETTLE_MS);
    }
    if (byHand) say();
    dots();
  }

  function loop() {
    clearTimeout(stk.timer);
    if (stk.cards.length < 2) return;
    stk.timer = setTimeout(function () {
      if (!stk.hover && !stk.focus && !stk.drag && !document.hidden) step(1, false);
      loop();
    }, STEP_MS);
  }

  function chip(cls, text) {
    var el = document.createElement("span");
    el.className = cls;
    el.textContent = text;
    return el;
  }

  function photoStack() {
    var host = $("tk-stk"), wrap = $("tk-stack"), box = $("tk-stk-dots"), p = null, i, d, c, card, m, tall = false, decoded = [], W, H, more;
    if (!host || !wrap) return;
    clearTimeout(stk.timer);
    stk.cards = [];
    stk.order = [];
    m = /^\s*(\d+)/.exec(TKC.txt(args.count_label));
    setText($("tk-fbc-n"), m ? m[1] + (m[1] === "1" ? " photo" : " photos") : "Photos");
    try { p = TKP.splitStack(str(args.preview)); } catch (e) { p = null; }
    if (!p) return;
    stk.count = Math.max(p.count || 0, m ? Number(m[1]) : 0, p.frames.length);
    for (i = 0; i < p.frames.length; i++) {
      try { d = TKP.frame(p.frames[i], p.version, 8); } catch (e) { d = null; }
      if (!d) continue;
      decoded.push({ d: d, at: i });
      if (d.h > d.w * 1.5) tall = true;
    }
    if (!decoded.length) return;
    W = tall ? 200 : 224;
    H = tall ? 356 : 298;
    for (i = 0; i < decoded.length; i++) {
      try { c = plate(decoded[i].d, W, H); } catch (e) { c = null; }
      if (!c) continue;
      card = document.createElement("div");
      c.setAttribute("aria-hidden", "true");
      card.appendChild(c);
      card.appendChild(chip("tk-grain", ""));
      if (stk.count > 1) card.appendChild(chip("tk-sc-p tk-num", decoded[i].at + 1 + "/" + stk.count));
      if (p.cover === decoded[i].at && stk.count > 1) card.appendChild(chip("tk-sc-cv", "Cover"));
      more = stk.count - p.frames.length;
      if (more > 0 && decoded[i].at === p.frames.length - 1) card.appendChild(chip("tk-sc-more tk-num", "+" + more + " more"));
      stk.cards.push(card);
    }
    if (!stk.cards.length) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    // Back to front in the DOM as well, so the top card is also the last painted where z-index isn't honoured.
    for (i = stk.cards.length - 1; i >= 0; i--) host.appendChild(stk.cards[i]);
    for (i = 0; i < stk.cards.length; i++) stk.order.push(i);
    grainOn(host.querySelectorAll(".tk-grain"));
    if (box) {
      while (box.firstChild) box.removeChild(box.firstChild);
      if (stk.cards.length > 1) for (i = 0; i < stk.cards.length; i++) box.appendChild(document.createElement("i"));
    }
    wrap.classList.add("tk-live");
    wrap.classList.toggle("tk-tall", tall);
    wrap.classList.toggle("tk-deep", stk.cards.length > 1);
    if (stk.cards.length > 1) wrap.setAttribute("tabindex", "0");
    place();
    loop();
  }

  // Dragging the top card: it follows the pointer (tilting as it goes); let go past a third of its width
  // and it swipes on (left: next, right: back one), else it springs back.
  function dragStart(e) {
    if (stk.busy || stk.cards.length < 2 || !within(e.target, "tk-stack")) return;
    stk.drag = { x: e.clientX, y: e.clientY, dx: 0, card: stk.cards[stk.order[0]] };
    stk.dragged = false;
  }
  function dragMove(e) {
    var g = stk.drag;
    if (!g) return;
    g.dx = e.clientX - g.x;
    if (Math.abs(g.dx) > 4) stk.dragged = true;
    if (!stk.dragged) return;
    g.card.classList.add("tk-held");
    g.card.style.transform = "translate(" + g.dx.toFixed(1) + "px," + ((e.clientY - g.y) * 0.25).toFixed(1) + "px) rotate(" + (g.dx * 0.08).toFixed(2) + "deg)";
  }
  function dragEnd() {
    var g = stk.drag;
    stk.drag = null;
    if (!g || !stk.dragged) return;
    g.card.classList.remove("tk-held");
    if (Math.abs(g.dx) > 36) {
      step(g.dx < 0 ? 1 : -1, true);
    } else {
      g.card.style.transform = "";
    }
    loop();
  }

  // The carousel order as a short line: slides named by their number, in order ("1 01 \u00b7 2 02 \u00b7 ...")
  // read "11 slides \u00b7 in order"; otherwise the names alone, without the positions.
  function orderText(label) {
    var parts = TKC.txt(label).split(/\s+\u00b7\s+/), names = [], numbered = true, rising = true, prev = -1, i, m, name, n;
    for (i = 0; i < parts.length; i++) {
      m = /^(\d+)\s+(.+)$/.exec(parts[i]);
      name = m ? m[2] : parts[i];
      if (!name) continue;
      names.push(name);
      if (/^\d+$/.test(name)) {
        n = Number(name);
        if (n <= prev) rising = false;
        prev = n;
      } else numbered = false;
    }
    if (names.length > 1 && numbered && rising) return names.length + " slides \u00b7 in order";
    return TKC.short(names.join(" \u00b7 "), 140);
  }

  function hydrate() {
    // What the card shows is what a click sends: the call's arguments with the corrections settle() staged
    // (folded hashtags, a cover time in words, a privacy word turned into TikTok's code).
    var a = merged(), i, el, key, v, m;
    var shows = all("[data-tk-show]");
    for (i = 0; i < shows.length; i++) {
      el = shows[i];
      key = el.getAttribute("data-tk-show");
      v = key === "order_label" ? orderText(a[key]) : TKC.short(a[key], 140);
      // "Frame at 0:03" reads "Cover 0:03" beside its own label.
      if (key === "cover_label") v = v.replace(/^(?:cover|frame)(?:\s+frame)?(?:\s+at)?\s*:?\s*/i, "");
      setText(el, v || el.getAttribute("data-tk-empty") || "");
      if (v) el.setAttribute("title", TKC.txt(a[key]));
      else el.removeAttribute("title");
    }
    var hides = all("[data-tk-hide-empty]");
    for (i = 0; i < hides.length; i++) show(hides[i], !!TKC.txt(a[hides[i].getAttribute("data-tk-hide-empty")]));
    el = $("tk-tile-n");
    if (el) {
      m = /^\s*(\d+)/.exec(TKC.txt(a.count_label));
      setText(el, m ? m[1] : "");
    }
    setText($("tk-av"), initials(TKC.txt(a.creator_nickname) || TKC.txt(a.account_label)));
    photoStack();
    // The length rides on the tile, as on TikTok's own thumbnails (it isn't repeated beside it).
    var p = preview(), dur = TOOL === "upload_video" ? TKC.short(a.duration_label, 12) : "";
    if (!dur && p && typeof p.seconds === "number" && isFinite(p.seconds)) dur = clock(p.seconds);
    setText($("tk-pill-t"), dur);
    if ($("tk-pill-t")) show($("tk-pill"), !!dur);
    var texts = all("[data-tk-text]");
    for (i = 0; i < texts.length; i++) {
      el = texts[i];
      key = keyOf(el);
      el.value = str(a[key]);
      // Longer than VoiceOS can carry as an edit: approve it as written, or not at all.
      el.readOnly = el.value.length > EDIT_MAX;
      show($("tk-l-" + key), el.readOnly);
    }
    paintAll();
    boxes = {};
    var keyed = all("[data-tk-box]");
    for (i = 0; i < keyed.length; i++) boxes[keyOf(keyed[i])] = keyed[i];
  }

  function buildPrivacy(items) {
    var seg = $("tk-seg"), sig = "", i;
    if (!seg) return;
    for (i = 0; i < items.length; i++) sig += items[i].value + ",";
    if (sig === optsSig) return;
    optsSig = sig;
    while (seg.firstChild) seg.removeChild(seg.firstChild);
    for (i = 0; i < items.length; i++) {
      var opt = document.createElement("label"), input = document.createElement("input");
      var dot = document.createElement("i"), name = document.createElement("span");
      opt.className = "tk-opt";
      input.type = "radio";
      input.name = "tk-privacy";
      input.value = items[i].value;
      input.setAttribute("data-tk-key", "privacy_level");
      input.setAttribute("data-tk-radio", "");
      dot.className = "tk-radio";
      dot.setAttribute("aria-hidden", "true");
      name.textContent = items[i].label;
      opt.appendChild(input);
      opt.appendChild(dot);
      opt.appendChild(name);
      seg.appendChild(opt);
    }
    seg.setAttribute("data-n", String(items.length));
    show(seg, items.length > 0);
  }

  function render() {
    var v = TKC.view(TOOL, merged()), k, t, el, i, gated = [];
    for (k in v.text) if (own(v.text, k)) {
      t = v.text[k];
      el = $("tk-n-" + k);
      // Counters only near the limit (a photo title's always, inside its line), like TikTok's composer.
      if (el) {
        setText(el, t.counter);
        show(el, !!t.show && t.length > 0);
        el.classList.toggle("tk-near", t.length > t.limit * 0.9 && !t.over);
        el.classList.toggle("tk-over", t.over);
      }
      el = $("tk-e-" + k);
      if (el) {
        setText(el, t.error);
        show(el, !!t.error);
      }
      el = $("tk-in-" + k);
      if (el) {
        el.classList.toggle("tk-over", t.over);
        if (boxOf(el)) boxOf(el).classList.toggle("tk-over", t.over);
      }
    }
    for (k in v.toggles) if (own(v.toggles, k)) {
      t = v.toggles[k];
      el = boxes && boxes[k];
      if (el) {
        el.checked = t.on;
        el.disabled = t.disabled;
      }
      el = $("tk-r-" + k);
      if (el) {
        el.classList.toggle("tk-dis", t.disabled);
        el.classList.toggle("tk-on", t.on);
        if (t.disabled && el.getAttribute("data-tk-name")) gated.push(el.getAttribute("data-tk-name"));
      }
      el = $("tk-t-" + k);
      if (el) {
        setText(el, t.note);
        show(el, !!t.note);
      }
    }
    el = $("tk-gate-note");
    if (el) {
      setText(el, gated.length ? gated.slice(0, -1).join(", ") + (gated.length > 1 ? " and " : "") + gated[gated.length - 1] +
        (gated.length > 1 ? " are" : " is") + " turned off for this account." : "");
      show(el, gated.length > 0);
    }
    if (v.privacy) {
      buildPrivacy(v.privacy.items);
      var radios = all("[data-tk-radio]");
      for (i = 0; i < radios.length && i < v.privacy.items.length; i++) {
        var item = v.privacy.items[i], r = radios[i];
        r.checked = item.checked;
        r.disabled = item.disabled;
        if (r.parentNode) {
          r.parentNode.classList.toggle("tk-sel", item.checked);
          r.parentNode.classList.toggle("tk-dis", item.disabled);
        }
      }
      el = $("tk-priv-prompt");
      show(el, !!v.privacy.prompt);
      el = $("tk-priv");
      if (el) el.classList.toggle("tk-need", !!v.privacy.prompt);
      el = $("tk-priv-note");
      setText(el, v.privacy.note);
      show(el, !!v.privacy.note);
    }
    if (v.disclosure) {
      show($("tk-disc-body"), v.disclosure.on);
      el = $("tk-disc-hint");
      setText(el, v.disclosure.hint);
      show(el, !!v.disclosure.hint);
      el = $("tk-disc-label");
      setText(el, v.disclosure.label);
      show(el, !!v.disclosure.label);
      el = $("tk-disc-music");
      show(el, !!v.disclosure.music);
      // TikTok's "Branded content can't be private" stays in sight while Only me is picked.
      el = $("tk-disc-bc");
      t = v.toggles.brand_content;
      setText(el, t && t.note ? t.note : "");
      show(el, !!(t && t.note && v.disclosure.on));
    }
    // Copy caption only means something once there's a caption.
    el = $("tk-r-copy_caption");
    if (el && v.toggles.copy_caption) show(el, !!(v.text.caption && v.text.caption.length) || v.toggles.copy_caption.on);
    show($("tk-consent-bc"), v.branded);
  }

  function edit(el, value) {
    var key = keyOf(el);
    if (!ready || !key) return;
    stage(key, value);
    settle(key);
    if (el.hasAttribute("data-tk-tags")) paint(el);
    if (el.hasAttribute("data-tk-grow")) grow(el);
    render();
    stamp();
    hint();
  }

  window.addEventListener("message", function (e) {
    if (e.source !== parent) return;
    var m = e.data;
    if (!m || m.type !== "voiceos:init") return;
    args = m.args && typeof m.args === "object" ? m.args : {};
    edits = {};
    optsSig = null;
    ready = true;
    settle(null);
    hydrate();
    render();
    growAll();
    stamp();
    hint();
    setTimeout(function () {
      growAll();
      hint();
    }, 80);
    watchWidth();
  });

  document.addEventListener("input", function (e) {
    var el = e.target;
    if (!el || !el.hasAttribute || !el.hasAttribute("data-tk-text")) return;
    if (el.hasAttribute("data-tk-line") && /[\r\n]/.test(el.value)) el.value = el.value.replace(/\s*[\r\n]+\s*/g, " ");
    edit(el, el.value);
  });
  document.addEventListener("change", function (e) {
    var el = e.target;
    if (!keyOf(el)) return;
    if (el.type === "checkbox") edit(el, el.checked ? "true" : "false");
    else if (el.type === "radio" && el.checked) edit(el, el.value);
  });
  document.addEventListener("keydown", function (e) {
    var el = e.target;
    if (e.key === "Enter" && el && el.hasAttribute && el.hasAttribute("data-tk-line")) e.preventDefault();
    if (el && el.id === "tk-stack" && stk.cards.length > 1) {
      var k = e.key, dir = k === "ArrowLeft" ? -1 : k === "ArrowRight" || k === "Enter" || k === " " ? 1 : 0;
      if (dir) {
        e.preventDefault();
        step(dir, true);
      }
    }
  });
  document.addEventListener("mouseover", function (e) {
    stk.hover = within(e.target, "tk-stack");
    vid.hover = within(e.target, "tk-tile");
  });
  document.addEventListener("mouseout", function (e) {
    if (!e.relatedTarget) stk.hover = vid.hover = false;
  });
  document.addEventListener("focusin", function (e) { stk.focus = within(e.target, "tk-stack"); });
  document.addEventListener("focusout", function () { stk.focus = false; });
  document.addEventListener("pointerdown", dragStart);
  document.addEventListener("pointermove", dragMove);
  document.addEventListener("pointerup", dragEnd);
  document.addEventListener("pointercancel", dragEnd);
  document.addEventListener("click", function (e) {
    var el = e.target;
    if (within(el, "tk-stack")) {
      if (stk.dragged) {
        stk.dragged = false;
        return;
      }
      step(1, true);
      loop();
      return;
    }
    if (within(el, "tk-tile") && vid.plates.length) {
      setPaused(!vid.paused);
      return;
    }
    while (el && el !== document.body && el.id !== "tk-more") el = el.parentNode;
    if (!el || el.id !== "tk-more") return;
    var still = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    window.scrollBy({ top: Math.round(window.innerHeight * 0.6), behavior: still ? "auto" : "smooth" });
  });
  window.addEventListener("scroll", hint, { passive: true });
  window.addEventListener("resize", function () {
    growAll();
    hint();
  });
  // A textarea that scrolls inside itself carries its tag mirror along.
  document.addEventListener("scroll", function (e) {
    var el = e.target;
    if (el && el.hasAttribute && el.hasAttribute("data-tk-tags")) sync(el);
  }, true);
  // The host can lay the card out at its final width after init (an animated notch): measure the text
  // boxes again whenever the card's width changes, so a box sized while narrow never stays tall.
  var watched = false, lastWidth = -1;
  function watchWidth() {
    var c = $("tk-c");
    if (watched || !c || !window.ResizeObserver) return;
    watched = true;
    new ResizeObserver(function () {
      var w = c.clientWidth;
      if (w === lastWidth) return;
      lastWidth = w;
      growAll();
      hint();
    }).observe(c);
  }
  // A card left open (or parked and restored) keeps a fresh receipt: re-mint while visible.
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden) stamp();
  });
  setInterval(function () {
    if (!document.hidden) stamp();
  }, REFRESH_MS);
})();
