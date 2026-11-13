// VoiceOS portable server: MCP tools and OAuth setup UI are bundled. Copy this entire file into Studio.

// source/widgetKit.ts
var WIDGET_KIT_LIMITS = {
  /**
   * HTML length in UTF-16 code units, matching the host validators. Result
   * envelopes also have a 300,000-character JSON budget; leave room for
   * escaping and data when constructing result cards.
   */
  maxHtmlChars: 3e5,
  /** @deprecated Use maxHtmlChars. Kept as an alias for existing integrations. */
  maxHtmlBytes: 3e5,
  minHeight: 60,
  maxHeight: 420,
  defaultHeight: 180,
  /** The bottom-right area VoiceOS's floating confirm button occupies. */
  confirmReserveHeight: 44,
  /**
   * The corner every VoiceOS card is cut at. Host geometry, exactly like
   * `confirmReserveHeight` — the surface a card lands on rounds it, so a card
   * that paints its own background or border has to use THIS radius or its
   * corners sit inside the host's arc and read as a second, misaligned edge.
   *
   * It reaches the document as `--k-radius`, and a host whose own slot cuts
   * differently overrides that variable over the bridge (VoiceOS's pill clips
   * at 25, concentric inside its shell). So card CSS says
   * `border-radius: var(--k-radius)` and is right in every surface; a literal
   * is right in one and wrong in the rest.
   */
  surfaceRadius: 26
};
var ESCAPES = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;"
};
function esc(value) {
  if (value === null || value === void 0) return "";
  return String(value).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "").replace(/[&<>"']/g, (char) => ESCAPES[char]);
}
var MAX_IMAGE_BYTES = 32768;
function safeImage(src) {
  if (typeof src !== "string") return null;
  const trimmed = src.trim();
  if (!/^data:image\//i.test(trimmed)) return null;
  return trimmed.length <= MAX_IMAGE_BYTES ? trimmed : null;
}
var INTEGRATION_MARK = "data:image/svg+xml;base64,PHN2ZyBmaWxsPSIjMDA2MWZmIiByb2xlPSJpbWciIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU+RHJvcGJveDwvdGl0bGU+PHBhdGggZD0iTTYgMS44MDdMMCA1LjYyOWw2IDMuODIyIDYuMDAxLTMuODIyTDYgMS44MDd6TTE4IDEuODA3bC02IDMuODIyIDYgMy44MjIgNi0zLjgyMi02LTMuODIyek0wIDEzLjI3NGw2IDMuODIyIDYuMDAxLTMuODIyTDYgOS40NTJsLTYgMy44MjJ6TTE4IDkuNDUybC02IDMuODIyIDYgMy44MjIgNi0zLjgyMi02LTMuODIyek02IDE4LjM3MWw2LjAwMSAzLjgyMiA2LTMuODIyLTYtMy44MjJMNiAxOC4zNzF6Ii8+PC9zdmc+";
function markSlot(o) {
  const src = safeImage(o.icon) || INTEGRATION_MARK;
  const inner = src ? `<img class="k-mk-i" src="${esc(src)}" alt="">` : o.mark === false ? "" : `<i class="k-dot"></i>`;
  return `<span class="k-mk" data-k-mk>${inner}</span>`;
}
var CSS = `*{box-sizing:border-box;margin:0;padding:0;scrollbar-width:none}
/* No scrollbar chrome, EVER — on the document or on anything an author makes
   scrollable inside it. A card is glanced at on black glass; a scrollbar is
   desktop-browser furniture that instantly breaks that. This is the same
   rule the notch window applies to itself, mirrored here because the host's
   CSS cannot reach into the sandbox. Content stays scrollable (wheel,
   trackpad, drag) — only the bar is gone. */
::-webkit-scrollbar{display:none}
:root{--ink-1:rgba(255,255,255,.95);--ink-2:rgba(255,255,255,.72);--ink-3:rgba(255,255,255,.5);--ink-4:rgba(255,255,255,.42);--line:rgba(255,255,255,.08);--fill-1:rgba(255,255,255,.06);--fill-2:rgba(255,255,255,.1);--track:rgba(255,255,255,.12);--good:#30d158;--bad:#ff453a;--accent:#3987e5;--k-radius:26px;color-scheme:dark}
html[data-k-theme=light]{--ink-1:rgba(0,0,0,.92);--ink-2:rgba(0,0,0,.66);--ink-3:rgba(0,0,0,.46);--ink-4:rgba(0,0,0,.38);--line:rgba(0,0,0,.09);--fill-1:rgba(0,0,0,.04);--fill-2:rgba(0,0,0,.07);--track:rgba(0,0,0,.1);color-scheme:light;--accent:var(--accent-light,#2563c9)}
/* A body background PROPAGATES to the frame canvas — a transparent root does
   not stop that; per spec the canvas takes body's background when the root
   has none. So an author's \`body{background:#111}\` fills the whole frame,
   square and full-height, which is the right outcome: every host clips the
   frame at the card arc, so the fill meets the corner exactly. The one trap
   is repeat — the canvas tiles a gradient sized to a short body, so any
   gradient put on body must say no-repeat (the kit's accent wash does). */
body{font:13.5px/1.45 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif;color:var(--ink-1);background:transparent;border-radius:var(--k-radius);-webkit-font-smoothing:antialiased}
.k-wrap{padding:13px 15px 14px;display:flex;flex-direction:column;gap:10px;border-radius:var(--k-radius)}
.k-wrap.k-confirm{padding-bottom:52px}
.k-num{font-variant-numeric:tabular-nums;font-feature-settings:"tnum"}
.k-hd{display:flex;align-items:center;justify-content:space-between;gap:10px}
.k-hd-l{display:flex;align-items:center;gap:7px;min-width:0}
.k-dot{width:6px;height:6px;border-radius:50%;background:var(--accent);flex:none}
.k-mk{display:flex;align-items:center;flex:none}
.k-mk:empty{display:none}
.k-mk-i{width:15px;height:15px;border-radius:4px;object-fit:contain;display:block}
.k-hd-t{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.k-hd-tr{font-size:11px;color:var(--ink-4);white-space:nowrap;flex:none}
.k-hd-sub{font-size:14.5px;font-weight:590;letter-spacing:-.01em;margin-top:-4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.k-list{display:flex;flex-direction:column}
.k-rw{display:flex;align-items:center;gap:10px;padding:7px 0;border-top:1px solid var(--line);text-decoration:none;color:inherit;min-width:0}
.k-rw:first-child{border-top:0;padding-top:1px}
a.k-rw{cursor:pointer}
a.k-rw:hover .k-rw-t{color:var(--accent)}
.k-rw-img{width:32px;height:32px;border-radius:6px;object-fit:cover;flex:none;background:var(--fill-1)}
.k-rw-m{min-width:0;flex:1}
.k-rw-t{font-size:14px;font-weight:590;letter-spacing:-.01em;line-height:1.25;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.k-rw-sub{font-size:11.5px;color:var(--ink-3);line-height:1.35;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.k-rw-tr{text-align:right;flex:none;display:flex;flex-direction:column;align-items:flex-end}
.k-rw-tr .k-num{font-size:12px;color:var(--ink-2)}
.k-rw-trs{font-size:10px;color:var(--ink-4);line-height:1.2}
.k-more{font-size:11px;color:var(--ink-4);padding-top:7px;border-top:1px solid var(--line)}
.k-chip{font-size:10.5px;font-weight:600;letter-spacing:.02em;padding:2px 7px;border-radius:999px;background:var(--fill-1);white-space:nowrap;flex:none}
.k-bdg{display:flex;gap:6px;flex-wrap:wrap}
.k-sts{display:flex;gap:18px}
.k-sts.k-ruled{padding-top:9px;border-top:1px solid var(--line)}
.k-st{min-width:0}
.k-st-v{font-size:24px;font-weight:600;letter-spacing:-.02em;line-height:1.1;font-variant-numeric:tabular-nums;white-space:nowrap}
.k-st-d{font-size:11px;font-weight:500;color:var(--ink-3);margin-left:5px;letter-spacing:0}
.k-st-l{font-size:11px;color:var(--ink-3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.k-kvs{display:flex;flex-direction:column;gap:0}
.k-kv{display:flex;align-items:baseline;justify-content:space-between;gap:14px;padding:3px 0}
.k-kv-l{font-size:12.5px;color:var(--ink-3);white-space:nowrap}
.k-kv-v{font-size:12.5px;color:var(--ink-1);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right}
.k-bars{display:flex;align-items:flex-end;gap:6px;height:72px}
.k-bar{flex:1;display:flex;flex-direction:column;align-items:center;gap:5px;min-width:0}
.k-bar-c{width:100%;height:56px;display:flex;align-items:flex-end;justify-content:center;position:relative}
.k-bar-f{width:100%;background:var(--fill-2);border-radius:4px 4px 2px 2px}
.k-bar-f.k-on{background:var(--accent)}
.k-bar-v{position:absolute;top:-2px;font-size:10px;font-weight:600;color:var(--ink-2);font-variant-numeric:tabular-nums}
.k-bar-l{font-size:10px;color:var(--ink-4);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.k-spk{width:100%;height:32px;display:block;overflow:visible}
.k-spk-x{display:flex;justify-content:space-between;font-size:10px;color:var(--ink-4);margin-top:4px;font-variant-numeric:tabular-nums}
.k-cap{font-size:10px;color:var(--ink-4);margin-top:4px}
.k-mt-h{display:flex;justify-content:space-between;gap:12px;font-size:11.5px;color:var(--ink-3);margin-bottom:6px}
.k-mt{height:5px;border-radius:5px;background:var(--track);overflow:hidden}
.k-mt-f{height:100%;border-radius:5px}
.k-hero{display:flex;align-items:center;gap:12px;min-width:0}
.k-hero-img{width:52px;height:52px;border-radius:8px;object-fit:cover;flex:none;background:var(--fill-1)}
.k-hero-m{min-width:0}
.k-hero-e{font-size:10px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--ink-4)}
.k-hero-t{font-size:17px;font-weight:640;letter-spacing:-.02em;line-height:1.2;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.k-hero-s{font-size:12.5px;color:var(--ink-3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.k-note{font-size:12.5px;line-height:1.4;color:var(--ink-2);overflow-wrap:anywhere;word-break:break-word}
.k-div{height:1px;background:var(--line);margin:4px 0}
.k-empty{text-align:center;padding:8px 0}
.k-empty-t{font-size:13px;color:var(--ink-3)}
.k-empty-h{font-size:11.5px;color:var(--ink-4);margin-top:3px}
.k-fld{display:block}
.k-fld-l{display:block;font-size:11px;color:var(--ink-3);margin-bottom:5px}
.k-in{width:100%;font:13px/1.4 inherit;color:var(--ink-1);background:var(--fill-1);border:1px solid var(--line);border-radius:7px;padding:7px 9px;outline:none;resize:none}
.k-in:focus{border-color:var(--accent)}
/* Custom-card shell (renderCustom): no padding, no gap, no layout opinion —
   the author owns the surface edge to edge. Only the confirm reserve, the
   floated mark, and the corner are the kit's.

   The corner is the kit's because it is not the author's to choose: the host
   cuts the card at --k-radius whatever this document says, so a surface drawn
   at any other radius shows a second edge inside the real one. Carrying it
   here means a card that paints a background or border on this element lands
   on the host's arc for free; a card that paints its own root still has
   var(--k-radius) to name. */
.k-cwrap{position:relative;border-radius:var(--k-radius)}
.k-cwrap.k-confirm{padding-bottom:52px}
.k-mkbar{position:absolute;top:11px;left:13px;z-index:9;display:flex}
/* ---- Surface finish (default-on) ----------------------------------------
   The liquid-glass rim: a 1px hairline with a brighter top edge, drawn as an
   INSET shadow on a fixed overlay so it (a) hugs the visible frame whatever
   height the content settles at, and (b) shares border-radius:var(--k-radius)
   with the host's clip — same arc, drawn inward, so it can neither gap nor
   get shaved by the cutout. This is the same rim recipe the notch's own
   chrome uses. */
.k-rim{position:fixed;inset:0;pointer-events:none;z-index:40;border-radius:var(--k-radius);box-shadow:inset 0 1px 0 rgba(255,255,255,.13),inset 0 0 0 1px rgba(255,255,255,.07)}
html[data-k-theme=light] .k-rim{box-shadow:inset 0 1px 0 rgba(255,255,255,.7),inset 0 0 0 1px rgba(0,0,0,.1)}
/* Brand presence (only when the integration declared an accent):
   a soft wash of the brand colour bleeding out of the top-left corner —
   colour the SURFACE, never the mark. The mark stays the bare glyph: a tile
   painted under the logo is chrome the icon didn't ask for, and it reads as
   the harness inventing a colour (see WIDGET_MARK_FLATTEN_HTML in ../ui.ts,
   which strips exactly that tile out of documents generated while the kit
   still drew one). color-mix degrades to no wash on engines without it. */
html[data-k-accent] body{background:radial-gradient(150% 120% at 0% 0%,color-mix(in srgb,var(--accent) 15%,transparent),transparent 44%) no-repeat}
html[data-k-theme=light][data-k-accent] body{background:radial-gradient(150% 120% at 0% 0%,color-mix(in srgb,var(--accent) 9%,transparent),transparent 44%) no-repeat}
/* The entrance is OPT-IN, never opt-out. Declaring \`animation: … both\` from
   opacity:0 and cancelling it under prefers-reduced-motion:reduce means any
   environment that doesn't actually run animations — a headless renderer, a
   paused compositor, a screenshotter — paints an invisible card and never
   recovers. Gating on no-preference makes the un-animated state the readable
   one, so the worst case is a card that simply appears. */
@media(prefers-reduced-motion:no-preference){
.k-wrap>*{animation:k-in .34s cubic-bezier(.22,.61,.36,1) both}
.k-wrap>*:nth-child(2){animation-delay:.04s}
.k-wrap>*:nth-child(3){animation-delay:.08s}
.k-wrap>*:nth-child(n+4){animation-delay:.12s}
}
@keyframes k-in{from{opacity:0;transform:translateY(5px)}to{opacity:1;transform:none}}`;
var JS = `(function(){
var send=function(m){try{parent.postMessage(m,'*')}catch(e){}};
/* Result-widget actions. Only the parent can advertise access or return a result.
   Confirmation is owned by VoiceOS, outside this document. Never retry a send. */
var pendingTools=new Map();
var voiceos=window.voiceos=window.voiceos||{};
voiceos.canInvokeTools=false;
voiceos.invokeTool=function(name,args,options){
  var id=options&&options.requestId;
  if(!id){var bytes=new Uint32Array(4);crypto.getRandomValues(bytes);id=Array.from(bytes,function(n){return n.toString(16)}).join('_')}
  var failure=function(status,error){return {type:'voiceos:toolResult',requestId:id,status:status,error:error}};
  if(typeof id!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(id))return Promise.resolve(failure('failed','Invalid requestId.'));
  if(!voiceos.canInvokeTools)return Promise.resolve(failure('failed','Tool actions are unavailable in this card.'));
  var signature;try{signature=JSON.stringify([name,args])}catch(e){return Promise.resolve(failure('failed','Arguments must be JSON.'))}
  var prior=pendingTools.get(id);
  if(prior)return prior.signature===signature?prior.promise:Promise.resolve(failure('failed','This requestId already has different arguments.'));
  if(pendingTools.size>=64)return Promise.resolve(failure('failed','Too many pending actions.'));
  var resolve;var promise=new Promise(function(done){resolve=done});
  var timer=setTimeout(function(){pendingTools.delete(id);resolve(failure('unknown','No final response. Check the app before trying again.'))},135000);
  pendingTools.set(id,{resolve:resolve,promise:promise,timer:timer,signature:signature});
  send({type:'voiceos:invokeTool',name:name,args:args,requestId:id});
  return promise;
};
var last=0;
var report=function(){
  /* Never report a collapsed measurement. A frame that is display:none, zero
     width, or in a hidden tab measures ~0, and since the host CLAMPS to 60 and
     we'd then consider that our last known height, one bad sample pins a
     277px card at 60px forever. Staying silent leaves the declared estimate
     in place, which is close to right by construction. */
  if(document.hidden)return;
  var el=document.documentElement;
  if(!el.offsetWidth)return;
  var h=Math.ceil(el.getBoundingClientRect().height);
  if(h<8)return;
  if(Math.abs(h-last)>1){last=h;send({type:'voiceos:resize',height:h})}
};
/* data-voiceos-key is the alias custom markup uses; data-k-key is what the
   kit's own vField emits. Same contract either way. */
var argKey=function(el){
  if(!el||!el.getAttribute)return null;
  return el.getAttribute('data-k-key')||el.getAttribute('data-voiceos-key');
};
addEventListener('message',function(e){
  if(e.source!==parent)return;
  var m=e.data;if(!m)return;
  if(m.type==='voiceos:toolResult'){
    var pending=pendingTools.get(m.requestId);
    if(pending&&['completed','failed','cancelled','unknown'].indexOf(m.status)!==-1){clearTimeout(pending.timer);pendingTools.delete(m.requestId);pending.resolve(m)}
    return;
  }
  if(m.type!=='voiceos:init')return;
  voiceos.canInvokeTools=!!(m.capabilities&&m.capabilities.invokeTool);
  if(m.theme&&m.theme.mode)document.documentElement.setAttribute('data-k-theme',m.theme.mode);
  /* The corner the HOST will actually cut this card at. Same shape as the
     theme leg: the document ships with a correct default and the surface
     corrects it, so a card is never briefly drawn at the wrong radius and
     never depends on the host to send anything. Clamped because the value
     lands in CSS. */
  if(typeof m.radius==='number'&&isFinite(m.radius))document.documentElement.style.setProperty('--k-radius',Math.max(0,Math.min(48,m.radius))+'px');
  var args=m.args||{};
  var fields=document.querySelectorAll('[data-k-key],[data-voiceos-key]');
  for(var i=0;i<fields.length;i++){
    var key=argKey(fields[i]);
    if(Object.prototype.hasOwnProperty.call(args,key)&&args[key]!=null)fields[i].value=String(args[key]);
  }
  report();
});
document.addEventListener('input',function(e){
  var key=argKey(e.target);
  if(key)send({type:'voiceos:updateInput',key:key,value:e.target.value});
});
document.addEventListener('click',function(e){
  /* Routes BOTH the kit's data-k-link rows and plain <a href="https://…">
     anchors in custom markup out through the host. The sandbox blocks
     navigation anyway, so an unrouted anchor is a click that does nothing. */
  var el=e.target;
  while(el&&el!==document.body){
    if(el.getAttribute&&(el.hasAttribute('data-k-link')||(el.tagName==='A'&&el.hasAttribute('href')))){
      e.preventDefault();
      var href=el.getAttribute('href')||'';
      if(/^https:\\/\\//i.test(href))send({type:'voiceos:openUrl',url:href});
      return;
    }
    el=el.parentNode;
  }
});
if(window.ResizeObserver){new ResizeObserver(report).observe(document.documentElement)}
addEventListener('load',report);setTimeout(report,0);setTimeout(report,120);
})()`;
function safeColor(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^#[0-9a-f]{3,8}$/i.test(trimmed) || /^(rgb|hsl)a?\([0-9a-z%.,\s/]+\)$/i.test(trimmed) ? trimmed : null;
}
var DARK_SURFACE = [10, 10, 12];
var LIGHT_SURFACE = [242, 242, 244];
var dropImages = (markup) => markup.replace(/<img\b(?![^>]*\bk-mk-i\b)[^>]*>/g, "");
function hexToRgb(hex) {
  const value = hex.replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value.slice(0, 6);
  if (full.length !== 6 || /[^0-9a-f]/i.test(full)) return null;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16)
  ];
}
var channel = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
var luminance = ([r, g, b]) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
var contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
var toHex = (rgb) => `#${rgb.map(
  (c) => Math.round(Math.max(0, Math.min(255, c))).toString(16).padStart(2, "0")
).join("")}`;
function repairAccent(hex, against) {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const target = luminance(against);
  const lighten = target < 0.5;
  let current = [...rgb];
  for (let step = 0; step < 24; step++) {
    if (contrast(luminance(current), target) >= 3) break;
    current = current.map(
      (c) => lighten ? c + (255 - c) * 0.12 : c * 0.88
    );
  }
  return toHex(current);
}
function rootAttributes(accent, theme) {
  const accentStyle = accent ? `--accent:${esc(repairAccent(accent, DARK_SURFACE))};--accent-light:${esc(
    repairAccent(accent, LIGHT_SURFACE)
  )}` : "";
  return [
    theme ? ` data-k-theme="${theme}"` : "",
    // Gates the brand treatment (the top-left wash): it derives everything
    // from --accent, so it only exists when the integration actually declared
    // one — the default blue is VoiceOS's, not a brand, and dressing it up
    // would make every unbranded card lie.
    accentStyle ? ` data-k-accent=""` : "",
    accentStyle ? ` style="${accentStyle}"` : ""
  ].join("");
}
function renderCustom(o) {
  const body = typeof o.body === "string" ? o.body : "";
  const confirm = o.mode === "confirm";
  const rootAttrs = rootAttributes(safeColor(o.accent), o.theme);
  const authorCss = typeof o.css === "string" ? o.css.replace(/<\/style/gi, "<\\/style") : "";
  const markBar = body.includes("data-k-mk") ? "" : `<div class="k-mkbar">${markSlot({ title: "", mark: false })}</div>`;
  const compose = (inner) => `<!doctype html><html${rootAttrs}><head><meta charset="utf-8"><style>${CSS}
${authorCss}</style></head><body><div class="k-cwrap${confirm ? " k-confirm" : ""}">${markBar}${inner}</div><div class="k-rim" aria-hidden="true"></div><script>${JS}</script></body></html>`;
  let html = compose(body);
  if (html.length > WIDGET_KIT_LIMITS.maxHtmlChars) {
    html = compose(dropImages(body));
  }
  const chars = html.length;
  if (chars > WIDGET_KIT_LIMITS.maxHtmlChars) {
    throw new Error(
      `Widget HTML is ${chars} characters, over the ${WIDGET_KIT_LIMITS.maxHtmlChars} limit — trim the markup, show less, or inline smaller images.`
    );
  }
  const height = Math.max(
    WIDGET_KIT_LIMITS.minHeight,
    Math.min(
      WIDGET_KIT_LIMITS.maxHeight,
      Math.round(Number(o.height) || WIDGET_KIT_LIMITS.defaultHeight)
    )
  );
  return { html, height, label: o.label };
}

// source/link-controls.ts
function safeSharedUrl(value) {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u0020<>"`]/.test(value)) return void 0;
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password && !u.port && ["dropbox.com", "www.dropbox.com"].includes(u.hostname) ? value : void 0;
  } catch {
    return void 0;
  }
}
function linkControls(value, index) {
  const url = safeSharedUrl(value);
  if (!url) return '<p class="db-detail db-link-warning">No safe shared link was returned. Inspect Dropbox before repeating the action.</p>';
  const id = "db-link-" + index;
  return `<div class="db-link-actions"><div class="db-link-buttons"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open shared link</a><button type="button" data-db-copy="${id}">Copy link</button></div><details><summary>Show link</summary><input id="${id}" type="text" readonly aria-label="Shared link URL" value="${esc(url)}" spellcheck="false"></details><span class="db-link-status" role="status" aria-live="polite"></span></div>`;
}
var LINK_CSS = `.db-link-buttons{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:8px}.db-link-buttons button{border:1px solid var(--line);border-radius:6px;background:var(--fill-2);color:var(--ink-1);padding:5px 9px;font:12px system-ui;cursor:pointer}.db-link-actions summary{margin-top:6px;font-size:11px;color:var(--ink-2);cursor:pointer}.db-link-actions input{box-sizing:border-box;width:100%;margin-top:5px;border:1px solid var(--line);border-radius:5px;background:var(--fill-1);color:var(--ink-1);padding:6px;font:11px ui-monospace,monospace}.db-link-status{display:block;font-size:11px;color:var(--ink-2);margin-top:4px}.db-link-warning{color:#d6a94a}`;
var LINK_JS = `document.querySelectorAll('[data-db-copy]').forEach(function(button){button.addEventListener('click',async function(){var row=button.closest('.db-link-actions'),input=document.getElementById(button.getAttribute('data-db-copy')),status=row.querySelector('.db-link-status');try{if(!navigator.clipboard||!navigator.clipboard.writeText)throw Error('Unavailable');await navigator.clipboard.writeText(input.value);status.textContent='Copied';}catch(e){row.querySelector('details').open=true;input.focus();input.select();status.textContent='Link selected. Use Copy from the context menu, or your system copy shortcut.';}});});`;

// source/presentation.ts
function responseGuidance(tool) {
  if (tool.name === "create_shared_link" || tool.name === "list_shared_links") return " Shared links are already available through the card Open/Copy controls. Use the returned summary for a brief reply; do not rebuild the URL or print it in a second formatted response. Reuse the exact returned URL for revocation. Never repeat a completed write because narration formatting failed.";
  if ("collection" in tool) return " The card already shows the returned items. Keep default narration brief and do not repeat the entire list unless the user explicitly asks for those details.";
  return "";
}
function compactLink(item2) {
  const out = {};
  for (const key of ["name", "id", "path_lower", "path_display", "rev", "server_modified", "client_modified", "size"]) if (["string", "number"].includes(typeof item2?.[key])) out[key] = item2[key];
  const url = safeSharedUrl(item2?.url);
  if (url) out.url = url;
  out.link_available = !!url;
  for (const key of ["resolved_visibility", "link_access_level"]) {
    const value = item2?.link_permissions?.[key];
    if (typeof value === "string") out[key] = value;
    else if (typeof value?.[".tag"] === "string") out[key] = value[".tag"];
  }
  return out;
}
function presentResult(tool, data) {
  if (tool.name === "create_shared_link") {
    const normalized = compactLink(data);
    return { data: normalized, summary: normalized.link_available ? "Shared link created. Use Open shared link or Copy link in the card." : "Dropbox completed the action but returned no usable link. Inspect Dropbox before repeating the action.", provider_data: data };
  }
  if (tool.name === "list_shared_links") {
    const links = data.links.map(compactLink), unavailable = links.filter((l) => !l.link_available).length;
    return { data: { links, has_more: data.has_more === true, ...typeof data.cursor === "string" ? { cursor: data.cursor } : {} }, summary: links.length ? `${links.length} shared link${links.length === 1 ? "" : "s"} returned. Use the Open/Copy controls in the card.${unavailable ? " Some returned links could not be displayed safely." : ""}${data.has_more === true ? " More pages are available." : ""}` : "No shared links found.", provider_data: data };
  }
  if ("collection" in tool) return { data, summary: `${data[tool.collection].length} ${tool.name === "list_revisions" ? "revisions" : "items"} returned. See the scrollable card for details.${data.has_more === true || data.more === true ? " More pages are available." : ""}` };
  return { data };
}

// source/server.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// source/catalog.ts
import { z } from "zod";
var VERSION = "20261101_00";
var BUILD = "dropbox-composio-v19-account-timeout-fix";
var INTEGRATION_VERSION = "2.0.17";
var path = z.string().refine((p) => p === "" || p.startsWith("/") && !p.endsWith("/") && !p.includes("//") && !/[\u0000-\u001f]/.test(p) && !p.split("/").some((s) => s === "." || s === ".."), "Use an absolute Dropbox path without control characters, dot segments, or a trailing slash");
var item = path.refine((p) => p.length > 1, "A file or folder path is required; root is protected");
var text = z.string().min(1);
var limit = z.number().int().min(1).max(100).optional();
var tools = [
  { name: "list_files", title: "List files in folder", slug: "DROPBOX_LIST_FILES_IN_FOLDER", schema: { path: path.default(""), limit }, collection: "entries", use: "browse a Dropbox folder", write: false },
  { name: "search_files", title: "Search files and folders", slug: "DROPBOX_FILES_SEARCH", schema: { query: text, path: path.optional(), max_results: limit }, collection: "matches", use: "find Dropbox files or folders by keyword", write: false },
  { name: "get_metadata", title: "Get file or folder metadata", slug: "DROPBOX_GET_METADATA", schema: { path: item }, use: "inspect Dropbox file or folder metadata", write: false },
  { name: "read_file", title: "Read a file", slug: "DROPBOX_READ_FILE", schema: { path: item }, use: "read a Dropbox file; Word .docx files up to 20 MiB return extracted readable text, while other binary formats return a file reference", write: false },
  { name: "upload_file", title: "Upload File", slug: "DROPBOX_UPLOAD_FILE", schema: { path: item, file: text.describe("Full existing local file path under your home Desktop, Documents, Downloads, Pictures, Movies, Videos, or Music folder, without surrounding quotes or brackets. Supports binary Word/PDF/image files up to 50 MiB; never invent a file reference."), mode: z.enum(["add", "overwrite"]).default("add") }, use: "upload an existing local file from an allowed home folder to Dropbox; overwrite requires explicit approval", write: true },
  { name: "create_folder", title: "Create folder", slug: "DROPBOX_CREATE_FOLDER", schema: { path: item }, use: "create a Dropbox folder", write: true },
  { name: "copy_item", title: "Copy file or folder", slug: "DROPBOX_COPY_FILE_OR_FOLDER", schema: { from_path: item, to_path: item }, use: "copy a Dropbox file or folder to an exact destination", write: true },
  { name: "move_item", title: "Move file or folder", slug: "DROPBOX_MOVE_FILE_OR_FOLDER", schema: { from_path: item, to_path: item }, use: "move or rename a Dropbox file or folder", write: true },
  { name: "delete_item", title: "Delete file or folder", slug: "DROPBOX_DELETE_FILE", schema: { path: item }, use: "delete a Dropbox file or folder; recovery depends on the account plan", write: true },
  { name: "list_revisions", title: "List file revisions", slug: "DROPBOX_LIST_FILE_REVISIONS", schema: { path: item, limit }, collection: "entries", use: "inspect previous versions before restoring a Dropbox file", write: false },
  { name: "restore_revision", title: "Restore file to specific revision", slug: "DROPBOX_RESTORE_FILE", schema: { path: item, rev: text }, use: "restore a Dropbox file to the exact revision the user selected", write: true },
  { name: "create_shared_link", title: "Create shared link", slug: "DROPBOX_CREATE_SHARED_LINK", schema: { path: item }, use: "create a shared link after approving the access change", write: true },
  { name: "list_shared_links", title: "List shared links", slug: "DROPBOX_LIST_SHARED_LINKS", schema: { path: item.optional(), cursor: text.optional() }, collection: "links", use: "inspect existing Dropbox shared links", write: false },
  { name: "revoke_shared_link", title: "Revoke shared link", slug: "DROPBOX_REVOKE_SHARED_LINK", schema: { url: z.string().url().refine((s) => {
    const u = new URL(s);
    return u.protocol === "https:" && (u.hostname === "dropbox.com" || u.hostname === "www.dropbox.com");
  }, "Use a Dropbox HTTPS shared link") }, use: "revoke the exact Dropbox shared link selected by the user", write: true }
];
var approved = new Set(tools.map((t) => t.slug));
function parseArgs(tool, args) {
  return z.object(tool.schema).strict().parse(args);
}

// source/provider.ts
import { Composio } from "@composio/core";
import Ajv from "ajv";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

// source/upload.ts
import { stat, realpath } from "node:fs/promises";
import { isAbsolute, posix, win32 } from "node:path";
import { homedir } from "node:os";
var MAX_LOCAL_UPLOAD_BYTES = 50 * 1024 * 1024;
function allowedUploadPath(real, home = homedir(), platform = process.platform) {
  const p = platform === "win32" ? win32 : posix;
  const relative = p.relative(p.resolve(home), p.resolve(real));
  if (!relative || relative === ".." || relative.startsWith(".." + p.sep) || p.isAbsolute(relative)) return false;
  const parts = relative.split(/[\\/]/);
  return parts.length >= 2 && (/* @__PURE__ */ new Set(["Desktop", "Documents", "Downloads", "Pictures", "Movies", "Videos", "Music"])).has(parts[0]) && parts.every((part) => part.length > 0 && !part.startsWith("."));
}
function dereference(root, value) {
  let current = value;
  for (let depth = 0; current?.$ref && depth < 8; depth++) {
    if (typeof current.$ref !== "string" || !current.$ref.startsWith("#/")) throw new Error("Upload schema has an unsupported file reference. No upload attempted.");
    const resolved = current.$ref.slice(2).split("/").reduce((v, key) => v?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], root);
    if (!resolved) throw new Error("Upload schema file reference could not be resolved. No upload attempted.");
    const { $ref, ...rest } = current;
    current = { ...resolved, ...rest };
  }
  return current;
}
function uploadField(schema) {
  if (!schema?.properties) throw new Error("Upload input schema is unavailable. No upload attempted.");
  const candidates = Object.entries(schema.properties).filter(([key, value2]) => {
    const p = dereference(schema, value2);
    return p?.file_uploadable === true || ["content", "file", "file_to_upload"].includes(key) && p?.type === "object" && p.properties?.name && p.properties?.mimetype && p.properties?.s3key;
  });
  if (candidates.length !== 1) throw new Error(`Upload schema must declare exactly one staged-file input; found ${candidates.length}. No Dropbox upload attempted.`);
  const [field, value] = candidates[0], property = dereference(schema, value);
  if (property.type && property.type !== "object") throw new Error("Upload file input is not a staged-file descriptor. No Dropbox upload attempted.");
  return field;
}
async function interruptible(operation, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error("Upload staging cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    operation.then((value) => {
      signal.removeEventListener("abort", abort);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", abort);
      reject(error);
    });
    if (signal.aborted) abort();
  });
}
async function stageLocalFile(tool, source, c, signal, notify) {
  signal.throwIfAborted();
  if (typeof source !== "string" || !source || !isAbsolute(source) || /^[\["']|[\]"']$/.test(source)) throw new Error("Choose the full local file path without surrounding brackets or quotes. No Dropbox upload attempted.");
  let path2, info;
  try {
    path2 = await realpath(source);
  } catch {
    throw new Error("The selected local file is unavailable. Check its full path and save it before uploading.");
  }
  if (!allowedUploadPath(path2)) throw new Error("Local uploads are allowed only from Desktop, Documents, Downloads, Pictures, Movies, Videos, or Music in your home folder. Move the file there and try again.");
  try {
    info = await stat(path2);
  } catch {
    throw new Error("The selected local file is unavailable. Check its full path and save it before uploading.");
  }
  if (!info.isFile()) throw new Error("Select a local file, not a folder.");
  if (info.size > MAX_LOCAL_UPLOAD_BYTES) throw new Error("This integration supports local uploads up to 50 MiB. Choose a smaller file.");
  if (typeof c.files?.upload !== "function") throw new Error("The Composio file-staging API is unavailable. Reload the integration.");
  signal.throwIfAborted();
  await notify("Staging the selected file with Composio");
  const descriptor = await interruptible(c.files.upload({ file: path2, toolSlug: tool.slug, toolkitSlug: "dropbox" }), signal);
  signal.throwIfAborted();
  if (!descriptor || !["name", "mimetype", "s3key"].every((key) => typeof descriptor[key] === "string" && descriptor[key].length > 0)) throw new Error("Composio did not return a complete staged-file descriptor. No Dropbox upload attempted.");
  return { name: descriptor.name, mimetype: descriptor.mimetype, s3key: descriptor.s3key };
}

// source/read-content.ts
import mammoth from "mammoth";
import yauzl from "yauzl";
var MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
var MAX_EXPANDED_BYTES = 64 * 1024 * 1024;
var MAX_ENTRY_BYTES = 32 * 1024 * 1024;
var MAX_TEXT_CHARS = 1e6;
function documentUrl(value) {
  let u;
  try {
    u = new URL(String(value));
  } catch {
    throw new Error("The Word document has no valid download reference. Read it again.");
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port && u.port !== "443" || !/^[-a-z0-9.]+\.r2\.cloudflarestorage\.com$/i.test(u.hostname)) throw new Error("The document download host is not an approved Composio storage host.");
  return u;
}
async function downloadDocument(reference, signal, fetcher = fetch) {
  let url = documentUrl(reference);
  for (let redirects = 0; redirects < 4; redirects++) {
    signal.throwIfAborted();
    const response = await fetcher(url.href, { method: "GET", redirect: "manual", signal, cache: "no-store" });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location) throw new Error("The document download redirect has no destination.");
      url = documentUrl(new URL(location, url).href);
      continue;
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new Error("The document download link expired or was denied. Read the file again to request a fresh link.");
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error("The Word document could not be downloaded. Read it again after checking Dropbox.");
    }
    const declared = Number(response.headers.get("content-length"));
    if (declared > MAX_DOCUMENT_BYTES) {
      await response.body?.cancel();
      throw new Error("Word text extraction supports documents up to 20 MiB.");
    }
    if (!response.body) throw new Error("The Word document download was empty.");
    const reader = response.body.getReader(), chunks = [];
    let total = 0;
    const abort = () => {
      void reader.cancel(signal.reason).catch(() => {
      });
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_DOCUMENT_BYTES) {
          await reader.cancel();
          throw new Error("Word text extraction supports documents up to 20 MiB.");
        }
        chunks.push(value);
      }
    } finally {
      signal.removeEventListener("abort", abort);
      reader.releaseLock();
    }
    signal.throwIfAborted();
    return Buffer.concat(chunks, total);
  }
  throw new Error("Too many redirects while downloading the Word document.");
}
async function validateDocxArchive(buffer, signal) {
  signal.throwIfAborted();
  if (buffer.length > MAX_DOCUMENT_BYTES) throw new Error("Word text extraction supports documents up to 20 MiB.");
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 67324752) throw new Error("The Word file is invalid, encrypted, or not a supported .docx document.");
  let zip;
  try {
    zip = await yauzl.fromBufferPromise(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true });
  } catch {
    throw new Error("The Word file is damaged or is not a valid DOCX archive.");
  }
  let count = 0, total = 0, actual = 0, main = false;
  try {
    for await (const entry of zip.eachEntry()) {
      signal.throwIfAborted();
      count++;
      total += entry.uncompressedSize;
      if (count > 2048 || !Number.isSafeInteger(total) || total > MAX_EXPANDED_BYTES || entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error("The Word document exceeds safe extraction limits.");
      if (entry.generalPurposeBitFlag & 1) throw new Error("Password-protected Word documents cannot be read. Save an unencrypted .docx copy.");
      if (entry.fileName === "word/document.xml") main = true;
      if (entry.fileName.endsWith("/")) continue;
      const stream = await zip.openReadStreamPromise(entry);
      const abort = () => stream.destroy(new Error("Document read cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      let tail = "";
      try {
        for await (const chunk of stream) {
          signal.throwIfAborted();
          actual += chunk.length;
          if (actual > MAX_EXPANDED_BYTES) throw new Error("The Word document exceeds safe extraction limits.");
          if (/\.(?:xml|rels)$/i.test(entry.fileName)) {
            const xml = tail + chunk.toString("utf8");
            if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("The Word document uses unsupported XML declarations.");
            tail = xml.slice(-40);
          }
        }
      } finally {
        signal.removeEventListener("abort", abort);
        stream.destroy();
      }
    }
    if (!main) throw new Error("This archive does not contain a Word document.");
  } finally {
    zip.close();
  }
}
async function extractDocxText(buffer, signal) {
  if (buffer.length < 4) throw new Error("The Word document is empty or damaged.");
  await validateDocxArchive(buffer, signal);
  signal.throwIfAborted();
  let result;
  try {
    result = await mammoth.extractRawText({ buffer });
  } catch {
    throw new Error("The Word document was retrieved but its text could not be extracted. It may be damaged or unsupported.");
  }
  signal.throwIfAborted();
  const text2 = String(result.value || "").replace(/\r\n?/g, "\n").trim();
  if (text2.length > MAX_TEXT_CHARS) throw new Error("The Word document has too much text for one read. Split it into smaller documents.");
  return text2;
}
async function readDocumentContent(data, path2, signal, notify = async () => {
}, fetcher = fetch) {
  const name = data?.file_name || data?.metadata?.name || path2;
  const docx = /\.docx$/i.test(name) || data?.content?.mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (!docx) return data;
  const reference = data?.content?.s3url || data?.content?.s3Url;
  if (!reference) throw new Error("The Word document was retrieved without a downloadable file reference. Read it again.");
  await notify("Downloading Word document for text extraction");
  const buffer = await downloadDocument(reference, signal, fetcher);
  await notify("Extracting text from Word document");
  const text2 = await extractDocxText(buffer, signal);
  return { ...data, download: data.content, content: text2, extracted_text: text2, extraction: { format: "docx", status: "completed", character_count: text2.length, empty: text2.length === 0 } };
}

// source/provider.ts
var client = (key = process.env.COMPOSIO_API_KEY) => {
  if (!key?.trim()) throw new Error("Set COMPOSIO_API_KEY in VoiceOS Setup.");
  return new Composio({ apiKey: key.trim(), baseUrl: "https://backend.composio.dev", disableVersionCheck: true, logLevel: "error" });
};
function connection() {
  let saved = {};
  try {
    saved = JSON.parse(readFileSync(new URL("./connection.json", import.meta.url), "utf8")) || {};
  } catch (e) {
    if (e.code !== "ENOENT") throw new Error("Saved Dropbox connection is unreadable. Reconnect using Setup.");
  }
  const manual = process.env.COMPOSIO_CONNECTED_ACCOUNT_ID?.trim() || "";
  const account = saved.account || (manual && manual !== saved.disconnectedAccountId ? manual : "");
  return { user: saved.account ? saved.user || "" : process.env.COMPOSIO_USER_ID?.trim() || "", account };
}
function checkAccount(a, id, user, active = true) {
  if (!user || a?.id !== id || a?.user_id !== user) throw new Error("Cannot verify account ownership. Check COMPOSIO_USER_ID and connected account ID.");
  if (a.toolkit?.slug !== "dropbox") throw new Error("Selected account is not Dropbox.");
  if (a.auth_config?.auth_scheme !== "OAUTH2" && a.authScheme !== "OAUTH2") throw new Error("Selected Dropbox account must use OAuth2.");
  if (active && a.status !== "ACTIVE") throw new Error("Dropbox OAuth connection is inactive, expired, or revoked. Ask VoiceOS to connect Dropbox again, or use Setup.");
}
function unwrap(value, depth = 0) {
  if (depth > 8) throw new Error("Malformed Composio result: excessive wrapper nesting.");
  if (value == null) throw new Error("Composio returned no result.");
  if (typeof value === "object") {
    if (value.successful === false || value.success === false || value.error) throw new Error(typeof value.error === "string" ? value.error : JSON.stringify(value.error || "Provider reported failure"));
    if (value.data !== void 0 && value.response_data !== void 0 && !isDeepStrictEqual(value.data, value.response_data)) throw new Error("Conflicting Composio result envelopes.");
    if (value.data !== void 0) return unwrap(value.data, depth + 1);
    if (value.response_data !== void 0) return unwrap(value.response_data, depth + 1);
  }
  return value;
}
function readCollection(data, key, allowMoreWithoutCursor = false) {
  if (!data || typeof data !== "object" || !Array.isArray(data[key])) throw new Error(`Malformed Dropbox response: missing ${key} array. No empty result inferred.`);
  if (data.has_more === true && typeof data.cursor !== "string" && !allowMoreWithoutCursor) throw new Error("Incomplete Dropbox page: continuation cursor missing.");
  if (data[key].some((row) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) return true;
    const item2 = row.metadata?.metadata || row.metadata || row;
    return ![item2?.name, item2?.url, item2?.rev, item2?.id, item2?.path_display].some((v) => typeof v === "string" && v.length > 0);
  })) throw new Error("Malformed Dropbox collection item.");
  return data[key];
}
function mapArgs(tool, input, schema) {
  if (!schema?.properties || schema.type !== "object") throw new Error("Pinned Composio input schema unavailable. No execution attempted.");
  const p = schema.properties, args = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === void 0) continue;
    if (key === "file" && tool.name === "upload_file") {
      args[uploadField(schema)] = value;
    } else if (tool.name === "search_files" && (key === "path" || key === "max_results") && !(key in p) && "options" in p) {
      args.options = { ...args.options, [key]: value };
    } else {
      if (!(key in p)) throw new Error(`Pinned ${tool.slug} schema does not accept ${key}; no execution attempted.`);
      args[key] = value;
    }
  }
  for (const key of ["autorename", "allow_ownership_transfer", "allow_shared_folder"]) if (key in p) args[key] = false;
  if (tool.name === "upload_file" && "strict_conflict" in p) args.strict_conflict = input.mode !== "overwrite";
  if (input.from_path && input.to_path) {
    const from = input.from_path.toLowerCase(), to = input.to_path.toLowerCase();
    if (from === to || to.startsWith(from + "/")) throw new Error("Destination must differ from the source and cannot be inside it.");
  }
  const validate = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(schema);
  if (!validate(args)) throw new Error(`Pinned ${tool.slug} input validation failed: ${JSON.stringify(validate.errors)}. No execution attempted.`);
  return args;
}
function errorMessage(error, write = false, started = false, action) {
  const m = String(error?.message || error);
  if (/^The selected local file is unavailable|^The Composio file-staging API is unavailable/.test(m)) return m;
  if (/cancelled|canceled/i.test(m)) return write && started ? "Dropbox write outcome is unknown after cancellation. Inspect Dropbox before retrying." : "Dropbox request was cancelled before completion.";
  if (/abort|timeout|timed out|ECONNRESET|fetch failed/i.test(m)) return write && started ? "Dropbox write outcome is unknown. Inspect the destination before retrying; no automatic retry was made." : "Dropbox request timed out. Try again after checking the connection.";
  if (/invalid.*api.?key|APIKey_Invalid|missing.*api.?key/i.test(m)) return "Composio API key is missing or invalid. Update it in VoiceOS Setup and reload.";
  if (/401|invalid_access_token|expired.*token|revoked|reauth/i.test(m)) return "Dropbox OAuth token expired or was revoked. Ask VoiceOS to connect Dropbox again, or use Setup.";
  if (/403|permission|insufficient_scope|no_permission/i.test(m)) return "Dropbox denied permission. Check file access and reconnect with the required scopes.";
  if (/too_large|file.size|payload.*large|413/i.test(m)) return "File exceeds the supported transfer size. Choose a smaller file; this integration does not start multipart upload sessions.";
  if (/conflict|already_exists|409/i.test(m)) return action === "upload_file" ? "Dropbox destination conflicts with an existing item. Choose another destination, or explicitly approve Overwrite to replace an existing file. Overwrite cannot replace a folder." : "Dropbox destination already exists or conflicts with another item. Choose another destination.";
  if (/not_found|404|not_file|unavailable/i.test(m)) return "Dropbox file or folder is unavailable. Check the exact path and account.";
  return m.replace(/https?:\/\/[^\s"'<>]+/gi, (raw) => {
    try {
      const u = new URL(raw);
      u.username = "";
      u.password = "";
      if (/signature|credential|token|key|code/i.test(u.search)) u.search = "?[redacted]";
      return u.href;
    } catch {
      return "[URL redacted]";
    }
  }).replace(/Bearer\s+[^\s",}]+|(?:api[_-]?key|access_token|refresh_token)["']?\s*[:=]\s*["']?[^\s"',}]+/gi, "[redacted]").slice(0, 500);
}
async function execute(tool, input, c = client(), config = connection(), notify = async () => {
}, externalSignal) {
  if (!approved.has(tool.slug)) throw new Error("Unapproved Dropbox action.");
  if (!config.account) throw new Error("Save the active Dropbox connected account ID in VoiceOS Setup, then Reload.");
  if (config.account.startsWith("pg-test-")) throw new Error("This is a Composio playground test ID, not a Dropbox connected account ID. Use the active Dropbox connection ID (normally ca_...) from Composio.");
  let started = false;
  const deadline = AbortSignal.timeout(45e3);
  const signal = externalSignal ? AbortSignal.any([deadline, externalSignal]) : deadline;
  try {
    signal.throwIfAborted();
    await notify("Checking Dropbox account");
    const account = await c.client.connectedAccounts.retrieve(config.account, { signal, maxRetries: 0 });
    const userId = config.user || account?.user_id;
    if (typeof userId !== "string" || !userId.trim()) throw new Error("Composio did not return an account owner. Set COMPOSIO_USER_ID to the exact owner shown in Composio.");
    checkAccount(account, config.account, userId);
    const raw = await c.tools.getRawComposioToolBySlug(tool.slug, { version: VERSION }, { signal, maxRetries: 0 });
    let prepared = input;
    if (tool.name === "upload_file") {
      const field = uploadField(raw.inputParameters);
      const { file, ...other } = input;
      const preflight = { ...raw.inputParameters, required: (raw.inputParameters.required || []).filter((key) => key !== field) };
      mapArgs(tool, other, preflight);
      prepared = { ...input, file: await stageLocalFile(tool, file, c, signal, notify) };
    }
    const args = mapArgs(tool, prepared, raw.inputParameters);
    await notify(tool.name === "upload_file" ? "Uploading the staged file to Dropbox" : "Running Dropbox action");
    signal.throwIfAborted();
    started = true;
    const result = await c.tools.execute(tool.slug, { userId, connectedAccountId: config.account, arguments: args, version: VERSION }, { signal, maxRetries: 0 });
    const data = unwrap(result);
    if ("collection" in tool) readCollection(data, tool.collection, tool.name === "list_revisions");
    return tool.name === "read_file" ? await readDocumentContent(data, input.path, signal, notify) : data;
  } catch (e) {
    if (externalSignal?.aborted) throw new Error(errorMessage(new Error("Request cancelled"), tool.write, started, tool.name));
    if (signal.aborted) throw new Error(errorMessage(new Error("Request timed out"), tool.write, started));
    throw new Error(errorMessage(e, tool.write, started));
  }
}

// source/setup.ts
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
async function startSetup() {
  const csrf = randomBytes(32).toString("hex");
  const configUrl = new URL("./connection.json", import.meta.url);
  let selected2;
  let pending;
  let busy = false;
  try {
    const saved = JSON.parse(await readFile(configUrl, "utf8"));
    if (saved?.account) selected2 = saved;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const html = true ? `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect Dropbox · VoiceOS</title>
<style>body{font:16px/1.5 system-ui;background:#f3f6fc;color:#172b4d;margin:8vh auto;padding:24px;max-width:560px}main{background:white;padding:32px;border-radius:20px;box-shadow:0 12px 48px #0061ff14}h1{margin-top:0;color:#0061ff}label{display:block;margin:16px 0}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #b9c5dc;border-radius:8px;font:inherit}button,a{font:inherit}button{background:#0061ff;color:white;border:0;border-radius:8px;padding:10px 14px;cursor:pointer;margin:5px 3px}button:disabled{opacity:.5;cursor:wait}.secondary{background:#edf2fb;color:#172b4d}.danger{background:#b42318}#toast{padding:12px;border-radius:8px;margin-top:20px;overflow-wrap:anywhere}#toast.error{background:#fff0ee;color:#9c2019}#toast.ok{background:#e9f8ef;color:#126438}progress{width:100%}small{color:#52657e}</style>
<main><h1>Connect Dropbox</h1><p>Link your account through Composio OAuth2. Your Dropbox password and tokens stay with Dropbox and Composio.</p>
<label>Composio API key<input id="key" type="password" autocomplete="off"></label><small>Used in memory for setup. Save this key separately in VoiceOS integration preferences.</small>
<label>Composio user ID (optional)<input id="user" autocomplete="off" placeholder="Leave blank to create one for this connection"></label>
<label>Existing auth config ID (optional)<input id="authConfig" placeholder="Leave blank to create a Dropbox OAuth2 config"></label>
<button id="connect">Connect Dropbox</button><button id="check" class="secondary">Check connection</button><button id="audit" class="secondary">Audit tool schemas</button><button id="disconnect" class="danger">Disconnect</button>
<p><a id="authorize" hidden target="_blank" rel="noopener noreferrer">Continue to Dropbox authorization</a></p><progress hidden></progress><div id="toast" role="status" aria-live="polite"></div><p id="accountRow" hidden>Connected account ID: <output id="account"></output></p><small>No credentials are stored in this page. Disconnect removes the saved Composio connection; revoke app access in Dropbox settings if needed.</small></main>
<script>const token='CSRF_TOKEN';for(const action of ['connect','check','audit','disconnect'])document.getElementById(action).onclick=async()=>{if(action==='disconnect'&&!confirm('Disconnect this Dropbox account from Composio? VoiceOS will lose access.'))return;const buttons=[...document.querySelectorAll('button')],progress=document.querySelector('progress'),toast=document.getElementById('toast');buttons.forEach(b=>b.disabled=true);progress.hidden=false;toast.className='';toast.textContent=action==='check'?'Checking Dropbox authorization…':'Contacting Composio…';try{const response=await fetch('/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Setup-Token':token},body:JSON.stringify(Object.fromEntries(['key','user','authConfig'].map(id=>[id,document.getElementById(id).value])))});const result=await response.json();if(!response.ok)throw Error(result.error||'Setup request failed');toast.textContent=result.message;toast.className='ok';if(result.account){document.getElementById('account').textContent=result.account;document.getElementById('accountRow').hidden=false;}if(action==='disconnect')document.getElementById('accountRow').hidden=true;if(result.url){const a=document.getElementById('authorize');a.href=result.url;a.hidden=false;a.click();}if(action==='check'||action==='disconnect')document.getElementById('authorize').hidden=true;}catch(e){toast.textContent=e.message;toast.className='error';}finally{buttons.forEach(b=>b.disabled=false);progress.hidden=true;}};</script></html>
` : await readFile(new URL("./setup.html", import.meta.url), "utf8");
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    if (req.headers.host !== `127.0.0.1:${port}`) {
      res.writeHead(403).end();
      return;
    }
    if (req.method === "GET" && req.url === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(html.replace("CSRF_TOKEN", csrf));
      return;
    }
    if (req.method !== "POST" || req.headers["x-setup-token"] !== csrf || req.headers.origin !== `http://127.0.0.1:${port}`) {
      res.writeHead(403).end();
      return;
    }
    if (busy) {
      res.setHeader("Content-Type", "application/json");
      res.writeHead(409).end(JSON.stringify({ error: "A setup operation is still running. Please wait." }));
      return;
    }
    busy = true;
    res.setHeader("Content-Type", "application/json");
    try {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (body.length > 8192) throw new Error("Request too large");
      }
      const args = JSON.parse(body), c = client(args.key || process.env.COMPOSIO_API_KEY);
      const options = { signal: AbortSignal.timeout(25e3), maxRetries: 0 };
      if (req.url === "/connect") {
        const user = typeof args.user === "string" && args.user.trim() ? args.user.trim() : selected2?.user || `voiceos-${randomUUID()}`;
        let authConfig = args.authConfig?.trim() || selected2?.authConfig;
        if (!authConfig) {
          const config2 = await c.authConfigs.create("dropbox", { type: "use_composio_managed_auth", name: "VoiceOS Dropbox", credentials: { scopes: ["files.metadata.read", "files.metadata.write", "files.content.read", "files.content.write", "sharing.read", "sharing.write"] }, toolAccessConfig: { toolsForConnectedAccountCreation: [...approved] } }, options);
          if (config2.toolkit !== "dropbox" || config2.authScheme !== "OAUTH2") throw new Error("Created config was not Dropbox OAuth2.");
          authConfig = config2.id;
        }
        const config = await c.authConfigs.get(authConfig, options);
        if (config.toolkit.slug !== "dropbox" || config.authScheme !== "OAUTH2") throw new Error("Auth config must be Dropbox OAuth2.");
        const request = await c.connectedAccounts.link(user, authConfig, {}, options);
        const url = new URL(request.redirectUrl);
        if (url.protocol !== "https:") throw new Error("Composio returned an insecure authorization URL.");
        pending = { user, authConfig, request };
        res.end(JSON.stringify({ url: url.href, message: "Authorize Dropbox in the opened tab, then select Check connection." }));
      } else if (req.url === "/check") {
        if (pending) {
          const account = await pending.request.waitForConnection(15e3);
          const raw = await c.client.connectedAccounts.retrieve(account.id, options);
          checkAccount(raw, account.id, pending.user);
          selected2 = { user: pending.user, account: account.id, authConfig: pending.authConfig };
          await writeFile(configUrl, JSON.stringify(selected2, null, 2), { mode: 384 });
          pending = void 0;
        } else if (selected2) {
          const raw = await c.client.connectedAccounts.retrieve(selected2.account, options);
          checkAccount(raw, selected2.account, selected2.user);
        } else throw new Error("Start Connect first.");
        res.end(JSON.stringify({ message: "Dropbox is connected. Copy the account ID below into VoiceOS Setup, save the API key there, then Reload.", account: selected2.account }));
      } else if (req.url === "/disconnect") {
        if (!selected2) throw new Error("No saved Dropbox connection.");
        const raw = await c.client.connectedAccounts.retrieve(selected2.account, options);
        checkAccount(raw, selected2.account, selected2.user, false);
        const result = await c.connectedAccounts.delete(selected2.account, options);
        if (result.success === false) throw new Error("Composio did not delete the connection.");
        await writeFile(configUrl, JSON.stringify({ disconnectedAccountId: selected2.account, user: selected2.user, authConfig: selected2.authConfig }, null, 2), { mode: 384 });
        selected2 = void 0;
        pending = void 0;
        res.end(JSON.stringify({ message: "Disconnected from Composio. You can also revoke app access in Dropbox settings. Clear any account ID override in VoiceOS Setup." }));
      } else if (req.url === "/audit") {
        const schemas = {};
        for (const slug of approved) schemas[slug] = await c.tools.getRawComposioToolBySlug(slug, { version: VERSION }, options);
        await writeFile(new URL("./catalog-snapshot.json", import.meta.url), JSON.stringify(schemas, null, 2));
        res.end(JSON.stringify({ message: "Saved all 14 pinned catalog schemas for review. No Dropbox files were changed." }));
      } else {
        res.writeHead(404).end("{}");
      }
    } catch (e) {
      res.writeHead(400).end(JSON.stringify({ error: errorMessage(e) }));
    } finally {
      busy = false;
    }
  });
  let port = 0;
  server.listen(0, "127.0.0.1", () => {
    port = server.address().port;
    console.error(`Dropbox setup: http://127.0.0.1:${port}
Press Ctrl+C when finished.`);
  });
}

// source/scroll-controls.ts
var SCROLL_CSS = `.db-scroll-shell{position:relative;min-width:0}.db-scroll-shell[data-overflow=true]{padding-right:18px}.db-scroll-rail{position:absolute;right:-4px;top:0;bottom:0;width:14px;border:1px solid rgba(200,215,235,.12);border-radius:8px;background:rgba(170,190,215,.16);backdrop-filter:blur(8px);overflow:hidden}.db-scroll-rail[hidden],.db-more[hidden]{display:none!important}.db-scroll-rail input{display:block;box-sizing:border-box;margin:0;width:14px;height:100%;writing-mode:vertical-lr;direction:ltr;appearance:none;-webkit-appearance:none;background:transparent;cursor:pointer;touch-action:none}.db-scroll-rail input::-webkit-slider-runnable-track{background:transparent}.db-scroll-rail input::-webkit-slider-thumb{appearance:none;-webkit-appearance:none;width:12px;height:28px;background:rgba(225,235,248,.72);border:1px solid rgba(255,255,255,.3);border-radius:7px}.db-scroll-rail input:focus-visible{outline:2px solid var(--accent);outline-offset:-2px}.db-scroll-shell[data-enhanced=true] .db-scroll{scrollbar-width:none!important}.db-scroll-shell[data-enhanced=true] .db-scroll::-webkit-scrollbar{display:none!important}.db-more{position:absolute;bottom:0;left:0;right:18px;height:30px;display:flex;align-items:flex-end;justify-content:center;padding-bottom:3px;background:linear-gradient(transparent,rgba(17,20,26,.9));color:var(--ink-2);font:11px system-ui;pointer-events:none}html[data-k-theme=light] .db-scroll-rail{background:rgba(45,65,90,.15)}html[data-k-theme=light] .db-scroll-rail input::-webkit-slider-thumb{background:rgba(65,85,115,.65)}html[data-k-theme=light] .db-more{background:linear-gradient(transparent,rgba(242,244,248,.94))}`;
function scrollControls(content) {
  return `<div class="db-scroll-shell" data-overflow="false"><div class="db-scroll" id="db-results" tabindex="0" aria-label="Dropbox results">${content}</div><div class="db-scroll-rail" hidden><input type="range" min="0" max="1000" step="1" value="0" aria-label="Scroll card results" aria-controls="db-results"></div><div class="db-more" hidden aria-hidden="true">More below ↓</div></div>`;
}
var SCROLL_JS = `(function(){var shell=document.querySelector('.db-scroll-shell');if(!shell)return;var content=shell.querySelector('.db-scroll'),rail=shell.querySelector('.db-scroll-rail'),range=rail.querySelector('input'),cue=shell.querySelector('.db-more');function update(){if(!content.clientHeight)return;var overflow=content.scrollHeight>content.clientHeight+1;shell.dataset.overflow=String(overflow);rail.hidden=!overflow;shell.dataset.enhanced='true';var max=Math.max(0,content.scrollHeight-content.clientHeight),value=max?Math.round(content.scrollTop/max*1000):0;range.value=String(value);range.disabled=!overflow;range.setAttribute('aria-valuetext',Math.round(value/10)+'% scrolled');cue.hidden=!overflow||max-content.scrollTop<2;}range.addEventListener('input',function(){content.scrollTop=(content.scrollHeight-content.clientHeight)*Number(range.value)/1000;update();});range.addEventListener('keydown',function(e){var max=content.scrollHeight-content.clientHeight,delta={ArrowDown:40,ArrowUp:-40,PageDown:content.clientHeight*.8,PageUp:-content.clientHeight*.8};if(e.key==='Home')content.scrollTop=0;else if(e.key==='End')content.scrollTop=max;else if(Object.prototype.hasOwnProperty.call(delta,e.key))content.scrollTop+=delta[e.key];else return;e.preventDefault();update();});content.addEventListener('scroll',update,{passive:true});if(window.ResizeObserver)new ResizeObserver(update).observe(content);if(window.MutationObserver)new MutationObserver(update).observe(content,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['open']});window.addEventListener('resize',update);requestAnimationFrame(update);setTimeout(update,100);})();`;

// source/brand.ts
var DROPBOX_MARK = "data:image/svg+xml;base64,PHN2ZyBmaWxsPSIjMDA2MWZmIiByb2xlPSJpbWciIHZpZXdCb3g9IjAgMCAyNCAyNCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48dGl0bGU+RHJvcGJveDwvdGl0bGU+PHBhdGggZD0iTTYgMS44MDdMMCA1LjYyOWw2IDMuODIyIDYuMDAxLTMuODIyTDYgMS44MDd6TTE4IDEuODA3bC02IDMuODIyIDYgMy44MjIgNi0zLjgyMi02LTMuODIyek0wIDEzLjI3NGw2IDMuODIyIDYuMDAxLTMuODIyTDYgOS40NTJsLTYgMy44MjJ6TTE4IDkuNDUybC02IDMuODIyIDYgMy44MjIgNi0zLjgyMi02LTMuODIyek02IDE4LjM3MWw2LjAwMSAzLjgyMiA2LTMuODIyLTYtMy44MjJMNiAxOC4zNzF6Ii8+PC9zdmc+";
var BRAND_CSS = ".db-brand{position:static!important;display:inline-flex!important;flex:none;width:22px;height:22px;align-items:center;justify-content:center}.db-brand .k-mk-i{display:block;width:20px;height:20px;object-fit:contain;border-radius:0;background:none}";
function brandMark() {
  return '<span class="k-mk db-brand" data-k-mk><img class="k-mk-i" src="' + DROPBOX_MARK + '" alt="Dropbox"></span>';
}

// source/cards.ts
var CSS2 = BRAND_CSS + LINK_CSS + SCROLL_CSS + `.db-card{padding:14px 16px;font:13px/1.4 system-ui;color:var(--ink-1)}.db-card header{display:flex;align-items:center;gap:9px;margin-bottom:10px}.db-card header svg{flex:none}.db-card strong{font-size:13px;flex:1;min-width:0;overflow-wrap:anywhere}.db-state{display:inline-flex;align-items:center;gap:5px;font-size:11px;flex:none;color:#30d158}.db-scroll{max-height:258px;overflow:auto;overscroll-behavior:contain;scrollbar-width:auto!important;scrollbar-color:#999 transparent}.db-scroll::-webkit-scrollbar{display:block!important;width:7px}.db-scroll::-webkit-scrollbar-thumb{background:#999;border-radius:5px}.db-item{padding:7px 0;border-top:1px solid var(--line);overflow-wrap:anywhere}.db-item:first-child{border-top:0}.db-detail{margin:5px 0;color:var(--ink-2);font-size:11px;overflow-wrap:anywhere}.db-meta{color:var(--ink-3);font-size:11px;display:block}.db-card a{color:var(--accent);overflow-wrap:anywhere}.db-card pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.4 ui-monospace,monospace;margin:0}.db-error{color:var(--bad,#ff453a)}`;
function icon(ok) {
  return `<svg role="img" aria-label="${ok ? "Succeeded" : "Failed"}" width="22" height="22" viewBox="0 0 24 24"><circle cx="12" cy="12" r="11" fill="${ok ? "#30d158" : "#ff453a"}"/><path d="${ok ? "m6.5 12 3.5 3.5 7.5-7.5" : "m8 8 8 8m0-8-8 8"}" fill="none" stroke="#071b0d" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}
function size(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "";
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
function readableDate(value) {
  if (typeof value !== "string") return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}
function successCard(tool, data, args) {
  const entries = "collection" in tool ? data[tool.collection] : void 0;
  let content = "", shown = 0, budget = 0, textLength = 0;
  if (entries) {
    const empty = tool.name === "search_files" ? "No matches found" : tool.name === "list_files" ? "Folder is empty" : tool.name === "list_revisions" ? "No revisions found" : "No shared links found";
    if (!entries.length) content = `<p class="db-detail">${empty}</p>`;
    for (const row of entries) {
      const item2 = row.metadata?.metadata || row.metadata || row;
      const name = item2.name || item2.path_display || (item2.rev ? "File revision" : void 0) || item2.id;
      const details = [item2[".tag"] === "folder" ? "Folder" : size(item2.size), readableDate(item2.server_modified)].filter(Boolean).join(" · ");
      const link = tool.name === "list_shared_links" ? linkControls(item2.url, shown) : "";
      const fragment = `<div class="db-item"><span>${esc(String(name || "Unlabelled returned item").slice(0, 180))}</span>${item2.path_display ? `<span class="db-meta">${esc(item2.path_display.slice(0, 220))}</span>` : ""}${details ? `<span class="db-meta">${esc(details)}</span>` : ""}${link}</div>`;
      if (budget + fragment.length > 14e4) break;
      content += fragment;
      budget += fragment.length;
      shown++;
    }
  } else {
    const item2 = data?.metadata || data;
    const detail = item2?.path_display || data?.file_name || item2?.name || args.to_path || args.path;
    if (detail) content += `<div class="db-item">${esc(String(detail).slice(0, 300))}</div>`;
    const pairs = [["Size", size(item2?.size)], ["Modified", readableDate(item2?.server_modified)]].filter(([, v]) => v);
    for (const [label, value] of pairs) content += `<p class="db-detail">${label}: ${esc(String(value))}</p>`;
    if (tool.name === "create_shared_link") content += linkControls(data?.url, 0);
    const text2 = typeof data?.extracted_text === "string" ? data.extracted_text : typeof data?.content === "string" ? data.content : typeof data === "string" ? data : void 0;
    if (data?.extraction?.status === "completed") content += `<p class="db-detail">${text2 ? "Text extracted from Word document" : "No extractable text found in the Word document."}</p>`;
    if (text2 !== void 0) {
      textLength = text2.length;
      content += `<pre>${esc(text2.slice(0, 2e4))}</pre>`;
      if (text2.length > 2e4) content += '<p class="db-detail">Text preview shortened; full content is returned to the agent.</p>';
    }
    if (tool.name === "read_file" && data?.content?.s3url && data?.extraction?.status !== "completed") content += '<p class="db-detail">File retrieved. Binary content requires a compatible file reader.</p>';
  }
  const count = entries ? `<p class="db-detail">${shown} of ${entries.length} returned items${shown < entries.length ? " shown; full data is returned to the agent" : ""}${data.has_more === true || data.more === true ? " · More pages available" : ""}</p>` : "";
  const card = renderCustom({ accent: "#0061ff", label: `${tool.title}: completed`, height: entries?.length ? Math.min(380, 116 + shown * (tool.name === "list_shared_links" ? 160 : 55)) : textLength ? Math.min(380, 190 + Math.ceil(textLength / 70) * 18) : tool.name === "create_shared_link" ? 280 : 180, css: CSS2, body: `<section class="db-card" data-status="completed"><header>${brandMark()}<strong>${esc(tool.title)}</strong><span class="db-state">${icon(true)}Completed</span></header>${count}${scrollControls(content)}</section><script>${SCROLL_JS}${LINK_JS}</script>` });
  return { blocks: [{ type: "widget", html: card.html, height: card.height }] };
}
function failureCard(tool, message, status = "failed") {
  const label = status === "unknown" ? "Outcome unknown" : status === "cancelled" ? "Cancelled" : "Failed";
  const card = renderCustom({ accent: "#0061ff", height: 200, css: CSS2, body: `<section class="db-card" data-status="${esc(status)}"><header>${brandMark()}<strong>${esc(tool.title)}</strong><span class="db-state db-error">${icon(false)}${label}</span></header><p>${esc(message)}</p></section>` });
  return { blocks: [{ type: "widget", html: card.html, height: card.height }] };
}

// source/server.ts
import { pathToFileURL } from "node:url";

// source/account-catalog.ts
var accountTools = [
  { name: "connect_account", title: "Connect Dropbox", description: "Connect Dropbox through Composio OAuth2. Use when the user asks to connect or authorize their Dropbox account. Opens browser consent and verifies the connection; does not change Dropbox files.", write: true },
  { name: "connection_status", title: "Dropbox account status", description: "Check this Dropbox OAuth2 connection. Use when the user asks whether Dropbox is connected or needs reauthorization. Read only; does not start OAuth or change files.", write: false },
  { name: "disconnect_account", title: "Disconnect Dropbox", description: "Disconnect the saved Dropbox account in Composio. Use only when the user explicitly asks to disconnect or unlink Dropbox. Does not delete Dropbox files.", write: true }
];

// source/account.ts
import { randomUUID as randomUUID2 } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile as readFile2, writeFile as writeFile2 } from "node:fs/promises";
var stateUrl = new URL("./connection.json", import.meta.url);
var accountRequestOptions = () => ({ signal: AbortSignal.timeout(25e3), maxRetries: 0 });
async function loadState(file = stateUrl) {
  try {
    return JSON.parse(await readFile2(file, "utf8")) || {};
  } catch (e) {
    if (e.code === "ENOENT") return {};
    throw new Error("Saved Dropbox connection is unreadable. Reconnect using Setup.");
  }
}
async function saveState(state, file = stateUrl) {
  await writeFile2(file, JSON.stringify(state, null, 2), { mode: 384 });
}
function openAuthorization(url) {
  const target = new URL(url);
  if (target.protocol !== "https:") throw new Error("Composio returned an insecure authorization URL.");
  const command = process.platform === "win32" ? "rundll32.exe" : process.platform === "darwin" ? "/usr/bin/open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", target.href] : [target.href];
  return new Promise((resolve, reject) => execFile(command, args, { timeout: 8e3, windowsHide: true }, (e) => e ? reject(new Error("Could not open the authorization browser. Use the saved authorization link or local setup page.")) : resolve()));
}
function accountResult(status, message, extra = {}) {
  const tone = status === "connected" ? "good" : status === "error" ? "bad" : "neutral";
  return { status, message, ...extra, _voiceos_glance: { blocks: [{ type: "header", title: "Dropbox account", trailing: status === "connected" ? "Connected" : status === "pending" ? "Authorization pending" : status === "disconnected" ? "Disconnected" : "Needs attention" }, { type: "badges", items: [{ text: message.slice(0, 100), tone }] }] } };
}
async function verified(c, id, user, active = true) {
  const raw = await c.client.connectedAccounts.retrieve(id, accountRequestOptions());
  const owner = user || raw?.user_id;
  checkAccount(raw, id, owner, active);
  return raw;
}
function selected(state) {
  const manual = process.env.COMPOSIO_CONNECTED_ACCOUNT_ID?.trim() || "";
  return { account: state.account || (manual && manual !== state.disconnectedAccountId ? manual : ""), user: state.account ? state.user : process.env.COMPOSIO_USER_ID?.trim() || void 0 };
}
async function connectionStatus(c = client(), file = stateUrl) {
  const state = await loadState(file), config = selected(state);
  if (state.pending) {
    try {
      const raw = await c.client.connectedAccounts.retrieve(state.pending.id, accountRequestOptions());
      if (raw?.status === "ACTIVE") {
        checkAccount(raw, raw.id, state.pending.user);
        state.account = raw.id;
        state.user = state.pending.user;
        state.authConfig = state.pending.authConfig;
        delete state.pending;
        delete state.disconnectedAccountId;
        await saveState(state, file);
        return accountResult("connected", "Dropbox is connected and ready to use.");
      }
    } catch (e) {
      if (e.status !== 404 && e.cause?.status !== 404) throw e;
    }
    return accountResult("pending", "Finish Dropbox authorization in your browser, then check status again.", { authorization_url: state.pending.url });
  }
  if (!config.account) return accountResult("disconnected", "Dropbox is not connected. Ask to connect Dropbox or use Setup.");
  try {
    const raw = await verified(c, config.account, config.user, false);
    if (raw.status === "ACTIVE" && !raw.isDisabled) return accountResult("connected", "Dropbox is connected and ready to use.");
    return accountResult("error", "Dropbox authorization expired or was revoked. Ask to connect Dropbox again.");
  } catch (e) {
    if (e.status === 404 || e.cause?.status === 404) return accountResult("error", "Dropbox connection was removed. Ask to connect Dropbox again.");
    throw e;
  }
}
async function connectAccount(c = client(), file = stateUrl, open = openAuthorization) {
  const state = await loadState(file), config = selected(state);
  if (config.account) {
    try {
      const raw = await verified(c, config.account, config.user);
      if (raw.status === "ACTIVE") return accountResult("connected", "Dropbox is already connected and ready to use.");
    } catch {
    }
  }
  if (!state.pending) {
    const user = state.user || `voiceos-${randomUUID2()}`;
    let authConfig = state.authConfig;
    if (!authConfig) {
      const created = await c.authConfigs.create("dropbox", { type: "use_composio_managed_auth", name: "VoiceOS Dropbox", credentials: { scopes: ["files.metadata.read", "files.metadata.write", "files.content.read", "files.content.write", "sharing.read", "sharing.write"] }, toolAccessConfig: { toolsForConnectedAccountCreation: [...approved] } }, accountRequestOptions());
      if (created.toolkit !== "dropbox" || created.authScheme !== "OAUTH2") throw new Error("Created config was not Dropbox OAuth2.");
      authConfig = created.id;
    }
    const checked = await c.authConfigs.get(authConfig, accountRequestOptions());
    if (checked.toolkit?.slug !== "dropbox" || checked.authScheme !== "OAUTH2") throw new Error("Auth config must be Dropbox OAuth2.");
    const request = await c.connectedAccounts.link(user, authConfig, {}, accountRequestOptions());
    if (!request.id || !request.redirectUrl || new URL(request.redirectUrl).protocol !== "https:") throw new Error("Composio did not return a secure authorization link.");
    state.pending = { id: request.id, url: request.redirectUrl, user, authConfig };
    state.authConfig = authConfig;
    state.user = user;
    await saveState(state, file);
  }
  const pending = state.pending;
  await open(pending.url);
  try {
    const account = await c.connectedAccounts.waitForConnection(pending.id, 9e4);
    await verified(c, account.id, pending.user);
    state.account = account.id;
    delete state.pending;
    delete state.disconnectedAccountId;
    await saveState(state, file);
    return accountResult("connected", "Dropbox authorization verified. Your account is ready to use.");
  } catch (e) {
    if (/timed?\s*out|pending/i.test(String(e?.message))) return accountResult("pending", "Finish Dropbox authorization in your browser, then ask for connection status.", { authorization_url: pending.url });
    throw e;
  }
}
async function disconnectAccount(c = client(), file = stateUrl) {
  const state = await loadState(file), config = selected(state), id = state.account || config.account;
  if (state.pending && state.pending.id !== id) {
    try {
      const pending = await c.client.connectedAccounts.retrieve(state.pending.id, accountRequestOptions());
      if (pending?.toolkit?.slug && pending.toolkit.slug !== "dropbox") throw new Error("Refusing to disconnect a non-Dropbox connection.");
      await c.connectedAccounts.delete(state.pending.id, accountRequestOptions());
    } catch (e) {
      if (e.status !== 404 && e.cause?.status !== 404) throw e;
    }
  }
  if (!id) {
    delete state.pending;
    await saveState(state, file);
    return accountResult("disconnected", "Dropbox is disconnected. Your files were not deleted.");
  }
  const raw = await verified(c, id, state.user || config.user, false);
  const result = await c.connectedAccounts.delete(raw.id, accountRequestOptions());
  if (result?.success === false) throw new Error("Composio did not disconnect Dropbox.");
  state.disconnectedAccountId = id;
  delete state.account;
  delete state.pending;
  await saveState(state, file);
  return accountResult("disconnected", "Dropbox was disconnected in Composio. Your files were not deleted.");
}
function accountError(error) {
  return errorMessage(error, false, false);
}

// source/server.ts
function createServer2(run = execute) {
  const server = new McpServer({ name: "dropbox", version: INTEGRATION_VERSION });
  let accountMutation;
  for (const tool of tools) server.registerTool(tool.name, {
    title: tool.title,
    description: `${tool.title} via Composio OAuth2. Use when the user asks to ${tool.use}. Returns provider data including pagination; never infer all pages were read.${responseGuidance(tool)}`,
    inputSchema: tool.schema,
    annotations: { readOnlyHint: !tool.write, destructiveHint: tool.write, idempotentHint: !tool.write, openWorldHint: true }
  }, async (args, extra) => {
    let progress = 0;
    const notify = async (message) => {
      const token = extra?._meta?.progressToken;
      if (token !== void 0) await extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: ++progress, message } }).catch(() => {
      });
    };
    try {
      const data = await run(tool, parseArgs(tool, args), void 0, void 0, notify, extra?.signal);
      let glance;
      try {
        glance = successCard(tool, data, args);
      } catch {
        glance = { blocks: [{ type: "header", title: tool.title, trailing: "Completed" }, { type: "badges", items: [{ text: "Succeeded", tone: "good" }] }] };
      }
      let presented = { data };
      try {
        presented = presentResult(tool, data);
      } catch {
      }
      const payload = { data: presented.data, status: "completed", ...presented.summary ? { summary: presented.summary } : {}, _voiceos_glance: glance };
      return { ...presented.provider_data ? { structuredContent: { status: "completed", provider_data: presented.provider_data, summary: presented.summary } } : {}, content: [{ type: "text", text: JSON.stringify(payload) }] };
    } catch (e) {
      const message = errorMessage(e, tool.write, false, tool.name);
      const status = /outcome is unknown/i.test(message) ? "unknown" : /request was cancelled/i.test(message) ? "cancelled" : "failed";
      const payload = { status, error: message, _voiceos_glance: failureCard(tool, message, status) };
      return { isError: true, structuredContent: payload, content: [{ type: "text", text: `${tool.title}: ${message}` }] };
    }
  });
  for (const accountTool of accountTools) server.registerTool(accountTool.name, {
    title: accountTool.title,
    description: accountTool.description,
    inputSchema: {},
    annotations: { readOnlyHint: !accountTool.write, destructiveHint: accountTool.name === "disconnect_account", idempotentHint: accountTool.name === "connection_status", openWorldHint: true }
  }, async () => {
    try {
      let result;
      if (accountTool.write) {
        if (accountMutation) throw new Error("Another Dropbox account operation is still running. Wait for it to finish.");
        const task = accountTool.name === "connect_account" ? connectAccount() : disconnectAccount();
        accountMutation = task;
        try {
          result = await task;
        } finally {
          accountMutation = void 0;
        }
      } else result = await connectionStatus();
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      const message = accountError(e);
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ status: "failed", error: message, _voiceos_glance: { blocks: [{ type: "header", title: accountTool.title, trailing: "Failed" }, { type: "badges", items: [{ text: message.slice(0, 100), tone: "bad" }] }] } }) }] };
    }
  });
  return server;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes("--setup")) await startSetup();
  else {
    console.error(`[dropbox] Loaded ${BUILD}; version ${INTEGRATION_VERSION}; 14 approved tools`);
    await createServer2().connect(new StdioServerTransport());
  }
}
export {
  createServer2 as createServer
};
