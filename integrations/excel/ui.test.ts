import {expect,test} from 'bun:test';
import {readFileSync} from 'node:fs';
const manifest=JSON.parse(readFileSync(new URL('./voiceos.integration.json',import.meta.url),'utf8'));
const icon='data:image/png;base64,'+readFileSync(new URL('./icon-mark.png',import.meta.url)).toString('base64');
const writes=manifest.tools.filter((tool:any)=>tool.confirmation);
for(const tool of writes)test(tool.name+': title and actions use native host layout',()=>{expect(tool.confirmation.root.type).toBe('card');expect(tool.confirmation.root.title).toBe(tool.title);expect(tool.confirmation.root.html).toBeUndefined();});

test('chart result never implies synthetic bars are real source data',()=>{
 const server=readFileSync(new URL('./server.ts',import.meta.url),'utf8');
 expect(server).not.toContain('viewBox="0 0 280 48"');
 expect(server).toContain('Open Excel to view the chart.');
});

import { renderRangeGrid } from './server.ts';
test('range cards retain rows, columns and long cell text beyond the old preview limits', () => {
 const values=Array.from({length:30},(_,r)=>Array.from({length:8},(_,c)=>'row-'+r+'-col-'+c));
 values[29][7]='<script>long text & final cell</script>';
 const html=renderRangeGrid(values,10,25,8);
 expect((html.match(/class="xr-rw"/g)||[]).length).toBe(30);
 expect((html.match(/<td class="xr-cell/g)||[]).length).toBe(240);
 expect(html).toContain('&lt;script&gt;long text &amp; final cell&lt;/script&gt;');
 expect(html).toContain('>Z</th>');expect(html).toContain('>AG</th>');expect(html).toContain('>39</td>');
 expect(html).toContain('tabindex="0"');
 expect(renderRangeGrid([],0,0,0)).toContain('Empty range');
});
