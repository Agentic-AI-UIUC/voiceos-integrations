import { test, expect } from 'bun:test';
import { Composio } from '@composio/core';

test('pinned SDK exposes the account, schema, and execution APIs used by Excel', () => {
  const client = new Composio({ apiKey: 'offline-sdk-shape-check' });
  expect(typeof client.client.connectedAccounts.retrieve).toBe('function');
  expect(typeof client.tools.getRawComposioToolBySlug).toBe('function');
  expect(typeof client.tools.execute).toBe('function');
});
