import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
const manifest=JSON.parse(readFileSync(new URL('./voiceos.integration.json',import.meta.url),'utf8'));
const icon='data:image/png;base64,'+readFileSync(new URL('./icon-mark.png',import.meta.url)).toString('base64');
const writes=manifest.tools.filter((tool:any)=>tool.confirmation);
for(const tool of writes){test(`${tool.name}: brand and title share normal flow`,()=>{
 const html=tool.confirmation.root.html;
 const body=html.slice(html.indexOf('<body>'),html.indexOf('<script>'));
 expect(body).not.toContain('class="k-mkbar"');
 expect(body).toContain('<div class="cf-t"><span class="k-mk" data-k-mk>');
 expect(body).toContain(icon);
 expect(html).toContain('.cf-t{display:flex;align-items:center;gap:10px;');
 expect(html).toContain('.cf-t .k-mk-i{border-radius:0}');
});}
test('chart result never implies synthetic bars are real source data',()=>{
 const server=readFileSync(new URL('./server.ts',import.meta.url),'utf8');
 expect(server).not.toContain('viewBox="0 0 280 48"');
 expect(server).toContain('Open Excel to view the chart.');
});
