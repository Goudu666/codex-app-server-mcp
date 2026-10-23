// Offline tests for a bridge whose default is a named permission profile (CODEX_PERMISSIONS).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const path = (p) => fileURLToPath(new URL(p, import.meta.url));
let client;

before(async () => {
  client = new Client({ name: 'test', version: '0' });
  const env = { ...process.env, CODEX_BIN: path('./fake-codex.mjs'), CODEX_PERMISSIONS: 'ops', CODEX_APPROVAL: 'never' };
  delete env.CODEX_SANDBOX;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path('../server.mjs')], env, stderr: 'ignore' }));
});
after(() => client.close());

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args });
  if (r.isError) throw new Error(r.content[0].text);
  return JSON.parse(r.content[0].text);
}

test('new threads use the default profile and never send a sandbox', async () => {
  const r = await call('codex_run', { cwd: '/tmp', prompt: 'policy', wait_seconds: 5 });
  assert.equal(r.latest_message, 'permissions=ops');
});

test('a sandbox can still be chosen per thread', async () => {
  const r = await call('codex_run', { cwd: '/tmp', prompt: 'policy', sandbox: 'read-only', wait_seconds: 5 });
  assert.equal(r.latest_message, 'sandbox=read-only');
});

test('reviews use the built-in :read-only profile', async () => {
  const r = await call('codex_review', { cwd: '/tmp', wait_seconds: 5 });
  assert.equal(r.review, 'REVIEW permissions=:read-only {"type":"uncommittedChanges"}');
});

test('threads keep their profile across an app-server restart', async () => {
  const r = await call('codex_run', { cwd: '/tmp', prompt: 'echo first', wait_seconds: 5 });
  await call('codex_run', { cwd: '/tmp', prompt: 'crash', wait_seconds: 5 });
  const resumed = await call('codex_run', { thread_id: r.thread_id, prompt: 'policy', wait_seconds: 5 });
  assert.equal(resumed.latest_message, 'permissions=ops');
});
