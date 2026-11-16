import { test, expect } from 'bun:test';
import { Composio } from '@composio/core';

test('pinned SDK exposes the account, schema, and execution APIs used by Excel', () => {
  const client = new Composio({ apiKey: 'offline-sdk-shape-check', disableVersionCheck: true });
  expect(typeof client.client.connectedAccounts.retrieve).toBe('function');
  expect(typeof client.tools.getRawComposioToolBySlug).toBe('function');
  expect(typeof client.tools.execute).toBe('function');
});

import {readFileSync} from 'node:fs';
test('SDK declaration and lockfile retain the exact reviewed pin',()=>{const p=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8'));expect(p.dependencies['@composio/core']).toBe('0.28.0');const lock=readFileSync(new URL('./bun.lock',import.meta.url),'utf8');expect(lock).toContain('"@composio/core": "0.28.0"');expect(lock).toContain('@composio/core@0.28.0');});
test('resolved SDK matches the package declaration instead of a stale latest install',()=>{const p=JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8'));const installed=JSON.parse(readFileSync(new URL('../package.json',import.meta.resolve('@composio/core')),'utf8'));expect(installed.version).toBe(p.dependencies['@composio/core']);});
