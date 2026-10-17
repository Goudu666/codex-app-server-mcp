#!/usr/bin/env node
// MCP server that lets Claude drive Codex through `codex app-server` (stdio, newline-delimited JSON).
// stdout belongs to MCP — log only to stderr.
import { spawn } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const log = (...a) => console.error('[codex-mcp]', ...a);
const CODEX_BIN = process.env.CODEX_BIN || 'codex';
const DEFAULT_MODEL = process.env.CODEX_MODEL || undefined;   // undefined → config.toml default
const DEFAULT_EFFORT = process.env.CODEX_EFFORT || undefined;

// ---------- app-server client ----------

class AppServer {
  proc = null;
  nextId = 1;
  pending = new Map();
  ready = null;

  constructor(onNotification) {
    this.onNotification = onNotification;
  }

  start() {
    if (this.ready) return this.ready;
    const proc = spawn(CODEX_BIN, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = proc;
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) this.handle(JSON.parse(line));
      }
    });
    proc.stderr.on('data', (d) => process.stderr.write(d));
    proc.on('exit', (code, sig) => {
      log(`app-server exited code=${code} sig=${sig}; will respawn on next call`);
      for (const { reject } of this.pending.values()) reject(new Error('codex app-server exited'));
      this.pending.clear();
      this.proc = null;
      this.ready = null;
      this.onExit?.();
    });
    this.ready = this.request('initialize', {
      clientInfo: { name: 'claude-codex-mcp', title: 'Claude → Codex bridge', version: '0.1.0' },
      capabilities: null,
    }).then(() => this.send({ method: 'initialized' }));
    return this.ready;
  }

  send(msg) {
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  async call(method, params) {
    await this.start();
    return this.request(method, params);
  }

  handle(msg) {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.message ?? JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
    } else if (msg.id !== undefined) {
      this.answerServerRequest(msg);
    } else {
      this.onNotification(msg.method, msg.params);
    }
  }

  // Codex asking us something. Full access is the intended mode, so approvals are accepted;
  // anything else gets an error so the turn fails fast instead of hanging.
  answerServerRequest({ id, method, params }) {
    log(`server request: ${method}`);
    const approvals = {
      'item/commandExecution/requestApproval': { decision: 'accept' },
      'item/fileChange/requestApproval': { decision: 'accept' },
      execCommandApproval: { decision: 'approved' },
      applyPatchApproval: { decision: 'approved' },
    };
    if (method in approvals) this.send({ id, result: approvals[method] });
    else this.send({ id, error: { code: -32601, message: `claude-codex-mcp does not handle ${method}` } });
  }
}

// ---------- thread / turn state ----------

// threadId → { cwd, turnId, status, error, items: [{turnId, ...summary}], waiters: Set<fn> }
const threads = new Map();

function threadState(threadId) {
  let s = threads.get(threadId);
  if (!s) {
    s = { cwd: null, turnId: null, status: 'idle', error: null, items: [], waiters: new Set() };
    threads.set(threadId, s);
  }
  return s;
}

function summarizeItem(item) {
  switch (item.type) {
    case 'agentMessage':
      return { kind: 'message', text: item.text };
    case 'commandExecution':
      return { kind: 'command', command: item.command, exitCode: item.exitCode, status: item.status };
    case 'fileChange':
      return { kind: 'files', status: item.status, changes: item.changes.map((c) => ({ path: c.path, type: c.kind.type })) };
    case 'mcpToolCall':
      return { kind: 'mcp', tool: `${item.server}.${item.tool}`, status: item.status };
    case 'webSearch':
      return { kind: 'webSearch' };
    default:
      return null;
  }
}

function wake(s) {
  for (const w of s.waiters) w();
  s.waiters.clear();
}

const app = new AppServer((method, p) => {
  switch (method) {
    case 'turn/started': {
      const s = threadState(p.threadId);
      s.turnId = p.turn.id;
      s.status = 'inProgress';
      s.error = null;
      break;
    }
    case 'item/completed': {
      const sum = summarizeItem(p.item);
      if (sum) threadState(p.threadId).items.push({ turnId: p.turnId, ...sum });
      break;
    }
    case 'turn/completed': {
      const s = threadState(p.threadId);
      s.turnId = p.turn.id;
      s.status = p.turn.status;
      s.error = p.turn.error?.message ?? null;
      wake(s);
      break;
    }
    case 'error':
      log('error notification:', JSON.stringify(p));
      break;
  }
});
app.onExit = () => {
  for (const s of threads.values()) {
    if (s.status === 'inProgress') {
      s.status = 'failed';
      s.error = 'codex app-server exited mid-turn';
      wake(s);
    }
  }
  threads.clear(); // loaded-thread bookkeeping is per app-server process
};

function waitForTurn(s, seconds) {
  if (s.status !== 'inProgress' || seconds <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(t);
      s.waiters.delete(done);
      resolve();
    };
    const t = setTimeout(done, seconds * 1000);
    s.waiters.add(done);
  });
}

function report(threadId) {
  const s = threads.get(threadId);
  const items = s.items.filter((i) => i.turnId === s.turnId);
  const messages = items.filter((i) => i.kind === 'message').map((i) => i.text);
  const files = new Map();
  for (const i of items.filter((i) => i.kind === 'files')) for (const c of i.changes) files.set(c.path, c.type);
  const commands = items.filter((i) => i.kind === 'command');
  const out = {
    thread_id: threadId,
    turn_id: s.turnId,
    status: s.status,
    ...(s.error && { error: s.error }),
    latest_message: messages.at(-1) ?? null,
    earlier_messages: messages.slice(0, -1),
    files_changed: [...files].map(([path, type]) => ({ path, type })),
    commands_run: commands.length,
    recent_commands: commands.slice(-8).map((c) => ({ command: c.command, exitCode: c.exitCode })),
    other_tool_calls: items.filter((i) => i.kind === 'mcp').map((i) => i.tool),
  };
  if (s.status === 'inProgress') out.hint = 'Turn still running — call codex_wait with this thread_id to keep waiting.';
  return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
}

const SANDBOX = 'danger-full-access';
const APPROVAL = 'never';

async function ensureThread({ thread_id, cwd }) {
  if (thread_id) {
    if (!threads.has(thread_id)) {
      await app.call('thread/resume', { threadId: thread_id, sandbox: SANDBOX, approvalPolicy: APPROVAL, excludeTurns: true, ...(cwd && { cwd }) });
      threadState(thread_id);
    }
    return thread_id;
  }
  const res = await app.call('thread/start', {
    cwd,
    sandbox: SANDBOX,
    approvalPolicy: APPROVAL,
    config: { notify: [] }, // don't fire the desktop app's notifier for bridge-driven turns
    serviceName: 'claude-codex-mcp',
  });
  threadState(res.thread.id).cwd = res.cwd;
  return res.thread.id;
}

// ---------- MCP tools ----------

const server = new McpServer({ name: 'codex', version: '0.1.0' });

const waitArg = z.number().int().min(0).max(1800).default(240)
  .describe('Seconds to block waiting for the turn to finish before returning a progress snapshot (default 240). The turn keeps running after this returns.');

server.registerTool(
  'codex_run',
  {
    title: 'Run a Codex task',
    description:
      'Give Codex (OpenAI coding agent, full disk access, no approvals) a task. Starts a new thread, or continues an existing one when thread_id is given. ' +
      'Blocks up to wait_seconds, then returns status + Codex\'s final message, files changed and commands run. ' +
      'If status is "inProgress", call codex_wait with the same thread_id. Review Codex\'s changes yourself before reporting them as done.',
    inputSchema: {
      prompt: z.string().describe('Instructions for Codex. Be specific: goal, files, constraints, what "done" looks like.'),
      cwd: z.string().optional().describe('Absolute working directory. Required when starting a new thread.'),
      thread_id: z.string().optional().describe('Continue this existing Codex thread (keeps its context).'),
      model: z.string().optional().describe('Model override, e.g. "gpt-6-astra". Defaults to Codex config.'),
      effort: z.string().optional().describe('Reasoning effort override: low | medium | high | xhigh | ultra | max.'),
      wait_seconds: waitArg,
    },
  },
  async ({ prompt, cwd, thread_id, model, effort, wait_seconds }) => {
    if (!thread_id && !cwd) throw new Error('cwd is required when starting a new thread');
    const threadId = await ensureThread({ thread_id, cwd });
    const s = threadState(threadId);
    if (s.status === 'inProgress') throw new Error(`thread ${threadId} already has a running turn; codex_wait or codex_interrupt it first`);
    model ??= DEFAULT_MODEL;
    effort ??= DEFAULT_EFFORT;
    const res = await app.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      ...(model && { model }),
      ...(effort && { effort }),
      ...(thread_id && cwd && { cwd }),
    });
    // turn/started may already have arrived; only fill in if it hasn't completed meanwhile
    if (s.turnId !== res.turn.id) {
      s.turnId = res.turn.id;
      s.status = res.turn.status;
    }
    await waitForTurn(s, wait_seconds);
    return report(threadId);
  },
);

server.registerTool(
  'codex_wait',
  {
    title: 'Wait for a Codex turn',
    description: 'Wait (up to wait_seconds) for the current turn on a Codex thread started by codex_run, then return its status and results.',
    inputSchema: { thread_id: z.string(), wait_seconds: waitArg },
  },
  async ({ thread_id, wait_seconds }) => {
    const s = threads.get(thread_id);
    if (!s) throw new Error(`thread ${thread_id} has no turn in this bridge session; use codex_run with thread_id to continue it`);
    await waitForTurn(s, wait_seconds);
    return report(thread_id);
  },
);

server.registerTool(
  'codex_interrupt',
  {
    title: 'Interrupt a Codex turn',
    description: 'Stop the running turn on a Codex thread.',
    inputSchema: { thread_id: z.string() },
  },
  async ({ thread_id }) => {
    const s = threads.get(thread_id);
    if (!s || s.status !== 'inProgress') throw new Error(`thread ${thread_id} has no running turn`);
    await app.call('turn/interrupt', { threadId: thread_id, turnId: s.turnId });
    await waitForTurn(s, 30);
    return report(thread_id);
  },
);

server.registerTool(
  'codex_threads',
  {
    title: 'List Codex threads',
    description: 'List recent Codex threads (including ones from the Codex app/CLI), newest first. Use a thread id with codex_run to continue it.',
    inputSchema: {
      cwd: z.string().optional().describe('Only threads with exactly this working directory.'),
      limit: z.number().int().min(1).max(50).default(10),
    },
  },
  async ({ cwd, limit }) => {
    const res = await app.call('thread/list', { limit, ...(cwd && { cwd }), useStateDbOnly: true });
    const rows = res.data.map((t) => ({
      thread_id: t.id,
      name: t.name,
      preview: t.preview?.slice(0, 160),
      cwd: t.cwd,
      model: t.model,
      updatedAt: t.updatedAt && new Date(t.updatedAt * 1000).toISOString(),
      running_here: threads.get(t.id)?.status === 'inProgress',
    }));
    return { content: [{ type: 'text', text: JSON.stringify(rows, null, 2) }] };
  },
);

await server.connect(new StdioServerTransport());
log('ready');
