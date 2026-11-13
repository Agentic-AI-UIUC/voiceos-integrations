import {test,expect} from 'bun:test';
import {readFileSync} from 'node:fs';
import {parse2DArray} from './server.ts';
const manifest=JSON.parse(readFileSync(new URL('./voiceos.integration.json',import.meta.url),'utf8'));
const writes=manifest.tools.filter((t:any)=>t.confirmation);
const flatten=(block:any):any[]=>[block,...(block.children||[]).flatMap(flatten),...(block.footer||[]).flatMap(flatten)];
const editable:Record<string,string[]>={excel_create_worksheet:['name'],excel_rename_worksheet:['current_name','new_name'],excel_delete_worksheet:['worksheet_name'],excel_update_range:['range','worksheet_name','values'],excel_add_table_rows:['table_name','table_id','rows','worksheet_name'],excel_create_chart:['range','worksheet_name','chart_type','series_by']};
const summaries:Record<string,string[]>=Object.fromEntries(Object.keys(editable).map(k=>[k,['workbook_id']]));
for(const tool of writes)test(tool.name+': compact native confirmation preserves editable values and visible fixed targets',()=>{
 const root=tool.confirmation.root,blocks=flatten(root),fields=blocks.filter((b:any)=>b.bind);
 expect(root.type).toBe('card');expect(root.html).toBeUndefined();expect(root.height).toBeUndefined();
 expect(fields.map((f:any)=>f.bind.replace(/[{}]/g,''))).toEqual(editable[tool.name]);
 const readOnly=blocks.filter((b:any)=>b.type==='keyValue');const templates=readOnly.flatMap((b:any)=>b.rows.map((r:any)=>r.value)).concat(blocks.filter((b:any)=>b.type==='text').map((b:any)=>b.text)).join(' ');
 for(const key of summaries[tool.name])expect(templates).toContain('{{'+key+'}}');
 for(const field of fields)expect(tool.inputSchema.properties).toHaveProperty(field.bind.replace(/[{}]/g,''));
 const actions=root.footer.flatMap((b:any)=>b.items||[]);
 expect(actions.filter((a:any)=>a.role==='cancel')).toHaveLength(1);expect(actions.filter((a:any)=>a.role==='confirm')).toHaveLength(1);
 expect(actions.find((a:any)=>a.role==='cancel').disabledIf).toBeUndefined();
 expect(blocks.some((b:any)=>b.type==='widget')).toBe(false);
 expect(fields.some((f:any)=>['{{workbook_id}}','{{drive_id}}','{{title}}'].includes(f.bind))).toBe(false);
 expect(fields.length).toBeLessThanOrEqual(4);
 const serialized=JSON.stringify(root);for(const binding of serialized.matchAll(/\{\{([a-z_]+)\}\}/g))expect(tool.inputSchema.properties).toHaveProperty(binding[1]);
});
for(const [name,key] of [['excel_update_range','values'],['excel_add_table_rows','rows']])test(name+': matrix remains editable in a compact single-line JSON field',()=>{
 const field=flatten(writes.find((t:any)=>t.name===name).confirmation.root).find((f:any)=>f.bind==='{{'+key+'}}');expect(field.multiline).toBeUndefined();
 const matrix=[['comma,quote"','\u041b\u0438\u0441\u04421'],[null,true],[0,false]];
 expect(parse2DArray(JSON.stringify(matrix))).toEqual(matrix);expect(parse2DArray(JSON.stringify(matrix,null,2))).toEqual(matrix);
});
test('delete warns permanently, displays the exact target, and retains Cancel',()=>{
 const root=writes.find((t:any)=>t.name==='excel_delete_worksheet').confirmation.root;
 expect(JSON.stringify(root.children)).toContain('Permanently deletes');expect(root.footer[0].items[1].color).toBe('danger');
});
test('MCP package and manifest versions agree',()=>{const pkg=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8'));expect(manifest.version).toBe(pkg.version);expect(readFileSync(new URL('./server.ts',import.meta.url),'utf8')).toContain('name: "microsoft-excel", version: "'+pkg.version+'"');});
test('no review banner, optional setup inputs, spacer or guessed scrollbar setting',()=>{for(const t of writes){const root=t.confirmation.root;expect(JSON.stringify(root)).not.toContain('Review the destination and values');expect(root.icon).toStartWith('data:image/png;base64,');expect(root.scrollbar).toBeUndefined();expect(root.style).toBeUndefined();}});

test('workbook identity has its own line without setup jargon',()=>{for(const tool of writes){const blocks=flatten(tool.confirmation.root);expect(JSON.stringify(tool.confirmation.root)).not.toContain('Setup if blank');expect(blocks.find((b:any)=>b.type==='text'&&b.text==='{{workbook_id}}').variant).toBe('mono');expect(blocks.filter((b:any)=>b.type==='keyValue').some((b:any)=>b.rows.some((r:any)=>r.value==='{{workbook_id}}'))).toBe(false);}});

test('all action editors keep labels above their inputs without read-only target summaries',()=>{for(const t of writes){const root=t.confirmation.root;expect(root.children.some((b:any)=>b.type==='keyValue')).toBe(false);for(const key of editable[t.name]){const field=flatten(root).find((b:any)=>b.bind==='{{'+key+'}}');expect(field.label.length).toBeGreaterThan(0);expect(['textField','select']).toContain(field.type);}}});

test('long confirmations pair related editors to avoid redundant vertical rows',()=>{for(const name of ['excel_rename_worksheet','excel_update_range','excel_add_table_rows','excel_create_chart']){const root=writes.find((t:any)=>t.name===name).confirmation.root;const rows=root.children.filter((b:any)=>b.type==='stack'&&b.direction==='horizontal');expect(rows.length).toBeGreaterThan(0);for(const row of rows){expect(row.children).toHaveLength(2);expect(row.children.every((b:any)=>(b.bind&&b.label)||(b.type==='stack'&&b.direction==='vertical'))).toBe(true);}}});

test('matrix inputs avoid tall native textareas and append pairs compact editors',()=>{for(const name of ['excel_update_range','excel_add_table_rows']){const t=writes.find((t:any)=>t.name===name),key=name==='excel_update_range'?'values':'rows';const field=flatten(t.confirmation.root).find((b:any)=>b.bind==='{{'+key+'}}');expect(field.type).toBe('textField');expect(field.multiline).toBeUndefined();}const chart=writes.find((t:any)=>t.name==='excel_create_chart');const series=flatten(chart.confirmation.root).find((b:any)=>b.bind==='{{series_by}}');expect(series.type).toBe('textField');expect(series.label).toContain('Auto, Columns, Rows');expect(series.options).toBeUndefined();});

test('append uses exactly two editor rows and standalone workbook context',()=>{const root=writes.find((t:any)=>t.name==='excel_add_table_rows').confirmation.root;expect(root.children).toHaveLength(3);expect(root.children[0].children.map((b:any)=>b.bind)).toEqual(['{{table_name}}','{{table_id}}']);expect(root.children[1].children.map((b:any)=>b.bind)).toEqual(['{{rows}}','{{worksheet_name}}']);expect(root.children[2].direction).toBe('vertical');});
