// @ts-nocheck: plain ES5 on purpose. The confirmation cards run the text from
// "var TKR" to the export line as a classic <script> (confirm-card/ inlines it
// at build time), and the server imports the same file as code, so the
// canonical form can never drift between what the card signs and what the
// server checks. Nothing here is compiled from a string at runtime.
//
// Receipt (plan §7.1, copied from GitHub #16's receiptCoreScript):
//   canonical = JSON.stringify([tool, [field, normalized], ...])   fixed, ordered fields per tool
//   digest    = sha256_hex("voiceos-tiktok-receipt-v1\n" + tool + "\n" + iat36 + "\n" + nonce + "\n" + canonical)
//   token     = "r1." + iat36 + "." + nonce(32 hex) + "." + digest
var TKR = (function () {
  "use strict";
  var KK = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function toArray(bytes) { return Array.prototype.slice.call(bytes); }

  function utf8(str) {
    var out = [], s = String(str);
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff) {
        c = 0x10000 + ((c - 0xd800) << 10) + (s.charCodeAt(i + 1) - 0xdc00);
        i++;
      } else if (c >= 0xd800 && c <= 0xdfff) {
        c = 0xfffd;
      }
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return out;
  }

  function sha256(bytes) {
    var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
    var m = toArray(bytes), len = m.length;
    var hi = Math.floor(len / 0x20000000), lo = (len * 8) >>> 0;
    m.push(0x80);
    while (m.length % 64 !== 56) m.push(0);
    m.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255,
      (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
    var w = new Array(64), t;
    for (var off = 0; off < m.length; off += 64) {
      for (t = 0; t < 16; t++) {
        w[t] = (m[off + 4 * t] << 24) | (m[off + 4 * t + 1] << 16) | (m[off + 4 * t + 2] << 8) | m[off + 4 * t + 3];
      }
      for (t = 16; t < 64; t++) {
        var x = w[t - 15], y = w[t - 2];
        var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
        var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
        w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (t = 0; t < 64; t++) {
        var S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
        var t1 = (h + S1 + ((e & f) ^ (~e & g)) + KK[t] + w[t]) | 0;
        var S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
        var t2 = (S0 + ((a & b) ^ (a & c) ^ (b & c))) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = [];
    for (var i = 0; i < 8; i++) out.push((H[i] >>> 24) & 255, (H[i] >>> 16) & 255, (H[i] >>> 8) & 255, H[i] & 255);
    return out;
  }

  function hex(bytes) {
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? "0" : "") + bytes[i].toString(16);
    return s;
  }

  function missing(v) { return v === undefined || v === null; }

  // Other text: trimmed.
  function normText(v) { return missing(v) ? "" : String(v).replace(/^\s+|\s+$/g, ""); }

  // Caption, title, description: verbatim except CRLF → LF (what the user approves is what TikTok gets).
  function normCaption(v) { return missing(v) ? "" : String(v).replace(/\r\n/g, "\n"); }

  // Enums (privacy_level): trimmed, upper-cased.
  function normUpper(v) { return normText(v).toUpperCase(); }

  // Toggles: "true" only for true or "true"; anything else, including missing, is "false".
  function normBool(v) { return v === true || v === "true" ? "true" : "false"; }

  // cover_ms: integers and digit strings as decimal strings.
  function normInt(v) {
    if (missing(v)) return "";
    if (typeof v === "number") return isFinite(v) && Math.floor(v) === v ? String(v) : String(v);
    var s = normText(v);
    return /^\d+$/.test(s) ? s.replace(/^0+(?=\d)/, "") : s;
  }

  // privacy_options: an array or a comma-separated string; items trimmed and upper-cased, joined with ",".
  function normOptions(v) {
    var items;
    if (missing(v)) items = [];
    else if (Object.prototype.toString.call(v) === "[object Array]") items = v;
    else items = String(v).split(",");
    var out = [];
    for (var i = 0; i < items.length; i++) {
      var t = normUpper(items[i]);
      if (t) out.push(t);
    }
    return out.join(",");
  }

  // Field order is part of the signature (plan §7.1 "Signed fields per write").
  var SPECS = {
    upload_video: [["file_token", "text"], ["caption", "caption"], ["copy_caption", "bool"]],
    publish_video: [["post_token", "text"], ["file_token", "text"], ["creator_nickname", "text"], ["privacy_options", "options"],
      ["caption", "caption"], ["privacy_level", "upper"], ["allow_comment", "bool"], ["allow_duet", "bool"], ["allow_stitch", "bool"],
      ["commercial_disclosure", "bool"], ["brand_organic", "bool"], ["brand_content", "bool"], ["is_aigc", "bool"], ["cover_ms", "int"]],
    upload_photos: [["bundle_token", "text"], ["title", "caption"], ["description", "caption"]],
    post_photos: [["bundle_token", "text"], ["post_token", "text"], ["creator_nickname", "text"], ["privacy_options", "options"],
      ["title", "caption"], ["description", "caption"], ["privacy_level", "upper"], ["allow_comment", "bool"], ["auto_add_music", "bool"],
      ["commercial_disclosure", "bool"], ["brand_organic", "bool"], ["brand_content", "bool"]]
  };

  function normalize(kind, v) {
    if (kind === "caption") return normCaption(v);
    if (kind === "upper") return normUpper(v);
    if (kind === "bool") return normBool(v);
    if (kind === "int") return normInt(v);
    if (kind === "options") return normOptions(v);
    return normText(v);
  }

  function canonical(tool, args) {
    var spec = Object.prototype.hasOwnProperty.call(SPECS, tool) ? SPECS[tool] : null;
    if (!spec) throw new Error("No canonical form for " + tool);
    var a = args || {}, parts = [tool];
    for (var i = 0; i < spec.length; i++) {
      var key = spec[i][0];
      var v = Object.prototype.hasOwnProperty.call(a, key) ? a[key] : undefined;
      parts.push([key, normalize(spec[i][1], v)]);
    }
    return JSON.stringify(parts);
  }

  // A digest of exactly what the card shows, not a secret: it proves the write came through the card's
  // button (the model never sees this script), and anyone could compute it from this text.
  function digest(tool, args, iat, nonce) {
    var msg = "voiceos-tiktok-receipt-v1\n" + tool + "\n" + iat + "\n" + nonce + "\n" + canonical(tool, args);
    return hex(sha256(utf8(msg)));
  }

  function mint(tool, args, nowMs, nonceHex) {
    var iat = Math.floor(nowMs).toString(36);
    return "r1." + iat + "." + nonceHex + "." + digest(tool, args, iat, nonceHex);
  }

  function verify(tool, args, token, nowMs, ttlMs) {
    if (token === undefined || token === null || String(token).replace(/\s+/g, "") === "") return { ok: false, reason: "missing" };
    var p = String(token).replace(/\s+/g, "").split(".");
    if (p.length !== 4 || p[0] !== "r1" || !/^[0-9a-z]{1,12}$/.test(p[1]) ||
        !/^[0-9a-f]{32}$/.test(p[2]) || !/^[0-9a-f]{64}$/.test(p[3])) return { ok: false, reason: "malformed" };
    var issued = parseInt(p[1], 36);
    if (!isFinite(issued)) return { ok: false, reason: "malformed" };
    if (issued > nowMs + 120000) return { ok: false, reason: "future" };
    if (nowMs - issued > ttlMs) return { ok: false, reason: "expired" };
    var expected;
    try { expected = digest(tool, args, p[1], p[2]); } catch (e) { return { ok: false, reason: "mismatch" }; }
    var diff = 0;
    for (var i = 0; i < 64; i++) diff |= expected.charCodeAt(i) ^ p[3].charCodeAt(i);
    return diff === 0 ? { ok: true, nonce: p[2], issuedAt: issued, digest: p[3] } : { ok: false, reason: "mismatch" };
  }

  return {
    utf8: utf8, sha256: sha256, hex: hex,
    normText: normText, normCaption: normCaption, normUpper: normUpper, normBool: normBool, normInt: normInt, normOptions: normOptions,
    SPECS: SPECS, canonical: canonical, mint: mint, verify: verify
  };
})();
export default TKR;
