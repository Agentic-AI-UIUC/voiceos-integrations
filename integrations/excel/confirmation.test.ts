import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parse2DArray } from './server.ts';
import { renderCustom } from './widgetKit.ts';

const manifest = JSON.parse(readFileSync(new URL('./voiceos.integration.json', import.meta.url), 'utf8'));
const writes = manifest.tools.filter((tool: any) => tool.confirmation);
const tool = (name: string) => writes.find((tool: any) => tool.name === name);

function cardHarness(html: string) {
  const fields = new Map<string, any>();
  for (const match of html.matchAll(/<(?:input|textarea|select)\b[^>]*data-voiceos-key="([^"]+)"[^>]*>/g)) {
    fields.set(match[1], { value: '', getAttribute: (name: string) => name === 'data-voiceos-key' ? match[1] : null });
  }
  const listeners: Record<string, Function> = {};
  const documentListeners: Record<string, Function> = {};
  const messages: any[] = [];
  const parent = { postMessage: (message: any) => messages.push(message) };
  const document = {
    hidden: true,
    documentElement: { setAttribute() {}, style: { setProperty() {} } },
    querySelectorAll: () => [...fields.values()],
    addEventListener: (name: string, callback: Function) => { documentListeners[name] = callback; },
  };
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!script) throw new Error('Card script missing');
  runInNewContext(script, {
    parent, window: {}, document,
    addEventListener: (name: string, callback: Function) => { listeners[name] = callback; },
    setTimeout: () => 1, clearTimeout() {},
  });
  return {
    fields, messages,
    init: (args: any) => listeners.message({ source: parent, data: { type: 'voiceos:init', args } }),
    edit: (key: string, value: string) => {
      const field = fields.get(key);
      if (!field) throw new Error('Field missing: ' + key);
      field.value = value;
      documentListeners.input({ target: field });
    },
  };
}

for (const write of writes) {
  test(`${write.name}: all approved inputs have editable confirmation fields`, () => {
    const card = cardHarness(write.confirmation.root.html);
    for (const key of Object.keys(write.inputSchema.properties)) {
      if (key === 'drive_id' || (write.name === 'excel_create_worksheet' && key === 'worksheet_name')) continue;
      expect(card.fields.has(key)).toBe(true);
    }
  });
}

test('append card hydrates and submits edits to table_name when no table_id is provided', () => {
  const card = cardHarness(tool('excel_add_table_rows').confirmation.root.html);
  card.init({ table_name: 'VoiceOSReviewTable01', rows: [['Review Marker 01', 7]] });
  expect(card.fields.get('table_name').value).toBe('VoiceOSReviewTable01');
  expect(card.fields.get('table_id').value).toBe('');
  card.edit('table_name', 'OtherApprovedTable');
  expect(card.messages.at(-1)).toEqual({ type: 'voiceos:updateInput', key: 'table_name', value: 'OtherApprovedTable' });
});

test('chart card hydrates and submits the worksheet and series grouping', () => {
  const card = cardHarness(tool('excel_create_chart').confirmation.root.html);
  card.init({ worksheet_name: 'VoiceOS Review QA Verified', series_by: 'Columns' });
  expect(card.fields.get('worksheet_name').value).toBe('VoiceOS Review QA Verified');
  expect(card.fields.get('series_by').value).toBe('Columns');
  card.edit('worksheet_name', 'Approved Sheet');
  expect(card.messages.at(-1)).toEqual({ type: 'voiceos:updateInput', key: 'worksheet_name', value: 'Approved Sheet' });
  card.edit('series_by', 'Rows');
  expect(card.messages.at(-1)).toEqual({ type: 'voiceos:updateInput', key: 'series_by', value: 'Rows' });
});

for (const [name, key] of [['excel_update_range', 'values'], ['excel_add_table_rows', 'rows']]) {
  test(`${name}: matrix rows remain readable and preserve types after editing`, () => {
    const matrix = [['Product', 'Quantity'], ['Laptop', 2], ['Mouse', 5], ['Keyboard', 3]];
    const card = cardHarness(tool(name).confirmation.root.html);
    card.init({ [key]: matrix });
    const displayed = card.fields.get(key).value;
    expect(displayed.split('\n')).toHaveLength(6);
    expect(displayed).toContain('  ["Laptop",2],\n  ["Mouse",5]');
    expect(JSON.parse(displayed)).toEqual(matrix);
    card.edit(key, displayed);
    expect(parse2DArray(card.messages.at(-1).value)).toEqual(matrix);
    const special = [['comma, quote"', 'line\nbreak'], [null, true], [0, false]];
    card.init({ [key]: special });
    expect(JSON.parse(card.fields.get(key).value)).toEqual(special);
    card.init({ [key]: 'Laptop,2\nMouse,5' });
    expect(card.fields.get(key).value).toBe('Laptop,2\nMouse,5');
  });
}

test('newly generated widget cards also serialize matrix inputs without flattening', () => {
  const widget = renderCustom({ body: '<textarea data-voiceos-key="values"></textarea>', height: 200 });
  const card = cardHarness(widget.html);
  const values = [['Name', 'Count'], ['Test', 2]];
  card.init({ values });
  expect(JSON.parse(card.fields.get('values').value)).toEqual(values);
});

test('all confirmation forms bound their scroll area above a separate footer band', () => {
  for (const write of writes) {
    const root = write.confirmation.root;
    expect(root.height).toBeLessThanOrEqual(420);
    expect(root.html).toContain('height:100%;display:flex;flex-direction:column;overflow:hidden;padding-bottom:112px');
    expect(root.html).toContain('flex:1 1 auto;min-height:0;overflow-y:auto');
  }
});