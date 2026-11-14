// VoiceOS's native select popup uses unreadable colors on Windows. The iframe
// select keeps both choices legible and stages edits through the host bridge.
export const uploadModeControl = {
  type: 'widget',
  label: 'Upload behavior',
  confirmLabel: 'Upload File',
  height: 60,
  html: `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;background:transparent;color:#f5f5f5;font:12px system-ui,-apple-system,"Segoe UI",sans-serif;color-scheme:dark}
label{display:block;color:#a9a9ae;margin:0 0 6px}.select-wrap{position:relative}
.select-wrap::after{content:"";position:absolute;right:12px;top:13px;width:7px;height:7px;border-right:1.5px solid #bbb;border-bottom:1.5px solid #bbb;transform:rotate(45deg);pointer-events:none}
select{width:100%;height:35px;padding:0 30px 0 10px;border:1px solid #555860;border-radius:9px;background:#25262a;color:#fff;appearance:none;font:600 12px system-ui,-apple-system,"Segoe UI",sans-serif;cursor:pointer}
select:focus-visible{outline:2px solid #9ac3ff;outline-offset:2px}option{background:#25262a;color:#fff}
</style></head><body><label for="mode">Upload behavior</label><div class="select-wrap"><select id="mode" aria-label="Upload behavior"><option value="add">Add (no replace)</option><option value="overwrite">Overwrite</option></select></div><script>
const mode=document.getElementById('mode');
window.addEventListener('message',event=>{if(event.data?.type==='voiceos:init')mode.value=event.data.args?.mode==='overwrite'?'overwrite':'add';});
mode.addEventListener('change',()=>parent.postMessage({type:'voiceos:updateInput',key:'mode',value:mode.value},'*'));
</script></body></html>`
} as const;
