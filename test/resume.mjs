// Continue an existing thread from a fresh bridge process (exercises thread/resume). Usage: node test/resume.mjs <thread_id>
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client({ name: 'smoke', version: '0' });
await client.connect(new StdioClientTransport({ command: 'node', args: [new URL('../server.mjs', import.meta.url).pathname], stderr: 'inherit' }));
const r = await client.callTool(
  { name: 'codex_run', arguments: { thread_id: process.argv[2], effort: 'low', wait_seconds: 120, prompt: 'Without running any command: what was in a.txt? One line.' } },
  undefined,
  { timeout: 600_000 },
);
console.log(r.isError ? 'ERROR' : '', r.content[0].text);
await client.close();
