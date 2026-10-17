// Real end-to-end check against your installed Codex (uses quota; small turns at effort "low").
// Usage: node test/e2e.mjs <scratch dir> [git repo to review]
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const [scratch, repo] = process.argv.slice(2);
const client = new Client({ name: 'e2e', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [new URL('../server.mjs', import.meta.url).pathname], stderr: 'ignore' }));

async function call(name, args) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 1_900_000 });
  console.log(`--- ${name}${r.isError ? ' (ERROR)' : ''}\n${r.content[0].text}`);
  if (r.isError) process.exit(1);
  return JSON.parse(r.content[0].text);
}
async function settle(r) {
  while (r.status === 'inProgress') r = await call('codex_wait', { thread_id: r.thread_id, wait_seconds: 120 });
  return r;
}

const models = await call('codex_models', {});
console.log(`(${models.length} models)`);
let r = await settle(await call('codex_run', {
  cwd: scratch, effort: 'low', web_search: true, wait_seconds: 120,
  prompt: 'Create note.txt containing the single word ok. Then reply with exactly: done',
}));
if (r.status === 'waitingForInput') {
  r = await settle(await call('codex_respond', { request_id: r.pending_requests[0].request_id, decision: 'accept', wait_seconds: 120 }));
}
await settle(await call('codex_run', {
  thread_id: r.thread_id, effort: 'low', wait_seconds: 120,
  prompt: 'Reply with a JSON object: the name of the file you created.',
  output_schema: { type: 'object', properties: { file: { type: 'string' } }, required: ['file'], additionalProperties: false },
}));
if (repo) await settle(await call('codex_review', { cwd: repo, target: 'uncommitted', effort: 'low', wait_seconds: 600 }));
await client.close();
