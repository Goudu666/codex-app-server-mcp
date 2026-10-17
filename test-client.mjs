// Smoke test: spawn server.mjs over stdio and drive a tiny Codex task. Usage: node test-client.mjs <cwd>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const cwd = process.argv[2];
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(new StdioClientTransport({ command: 'node', args: [new URL('./server.mjs', import.meta.url).pathname], stderr: 'inherit' }));
console.log('tools:', (await client.listTools()).tools.map((t) => t.name));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 1_900_000 });
  console.log(`--- ${name}`, r.isError ? '(ERROR)' : '', r.content[0].text);
  return r.isError ? null : JSON.parse(r.content[0].text);
};
const r1 = await call('codex_run', { cwd, effort: 'low', wait_seconds: 5, prompt: 'Create b.txt containing the uppercase contents of a.txt. Then reply with exactly: done' });
let r = r1;
while (r.status === 'inProgress') r = await call('codex_wait', { thread_id: r1.thread_id, wait_seconds: 60 });
await call('codex_run', { thread_id: r1.thread_id, effort: 'low', wait_seconds: 120, prompt: 'What file did you just create? One line.' });
await call('codex_threads', { cwd, limit: 3 });
await client.close();
