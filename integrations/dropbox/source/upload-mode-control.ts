// A native select inherits white text from VoiceOS's dark card but Windows
// paints its popup white. This small, fixed-choice control keeps both modes
// visible and sends the selected value through the card's staged-edit bridge.
export const uploadModeControl={
 type:'widget',
 label:'Upload behavior',
 height:60,
 html:`<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:#f5f5f5;font:12px system-ui,-apple-system,"Segoe UI",sans-serif}
.label{color:#a9a9ae;margin:0 0 6px}.choices{display:flex;gap:8px}
button{flex:1;min-width:0;height:34px;border:1px solid #555860;border-radius:9px;background:#25262a;color:#f5f5f5;font:600 12px system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer}
button[aria-pressed="true"]{border-color:#70a6ff;background:#164a8d;color:#fff}button:focus-visible{outline:2px solid #9ac3ff;outline-offset:2px}
</style></head><body><div class="label">Upload behavior</div><div class="choices"><button type="button" data-mode="add" aria-pressed="true">Add (no replace)</button><button type="button" data-mode="overwrite" aria-pressed="false">Overwrite</button></div><script>
const buttons=[...document.querySelectorAll('[data-mode]')];
function show(mode){for(const button of buttons)button.setAttribute('aria-pressed',String(button.dataset.mode===mode));}
window.addEventListener('message',event=>{if(event.data?.type==='voiceos:init')show(event.data.args?.mode==='overwrite'?'overwrite':'add');});
for(const button of buttons)button.addEventListener('click',()=>{show(button.dataset.mode);parent.postMessage({type:'voiceos:updateInput',key:'mode',value:button.dataset.mode},'*');});
</script></body></html>`
} as const;
