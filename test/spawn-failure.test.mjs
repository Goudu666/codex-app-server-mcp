// A Codex binary that cannot be started fails the call, not the MCP server.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const path = (p) => fileURLToPath(new URL(p, import.meta.url));
let client;

before(async () => {
  client = new Client({ name: 'test', version: '0' });
  const env = { ...process.env, CODEX_BIN: path('./does-not-exist') };
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path('../server.mjs')], env, stderr: 'ignore' }));
});
after(() => client.close());

test('a missing Codex binary returns a tool error and the server keeps serving', async () => {
  for (let i = 0; i < 2; i++) {
    const r = await client.callTool({ name: 'codex_models', arguments: {} });
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, /failed to start/);
  }
  assert.ok((await client.listTools()).tools.length > 0);
});
