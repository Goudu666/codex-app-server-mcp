#!/usr/bin/env node
// MCP server that lets Claude (or any MCP client) drive Codex through `codex app-server`.
// stdout belongs to MCP — log only to stderr.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { log } from './lib/app-server.mjs';
import { APPROVAL_POLICIES, Bridge, SANDBOX_MODES } from './lib/bridge.mjs';

const env = (name, allowed, fallback) => {
  const v = process.env[name] || fallback;
  if (!allowed.includes(v)) throw new Error(`${name}=${v} is invalid; expected one of ${allowed.join(', ')}`);
  return v;
};

const bridge = new Bridge({
  bin: process.env.CODEX_BIN || 'codex',
  sandbox: env('CODEX_SANDBOX', SANDBOX_MODES, 'workspace-write'),
  approval: env('CODEX_APPROVAL', APPROVAL_POLICIES, 'on-request'),
  model: process.env.CODEX_MODEL || undefined, // undefined → ~/.codex/config.toml default
  effort: process.env.CODEX_EFFORT || undefined,
});

const json = (v) => ({ content: [{ type: 'text', text: JSON.stringify(v, null, 2) }] });

const known = (threadId) => {
  if (!bridge.threads.has(threadId)) {
    throw new Error(`thread ${threadId} has no turn in this bridge session — use codex_run with thread_id to continue it`);
  }
};

const waitArg = z.number().int().min(0).max(1800).default(240)
  .describe('Seconds to block before returning a progress snapshot (default 240). Returns early when the turn finishes or Codex needs an answer. The turn keeps running after this returns.');

const server = new McpServer({ name: 'codex', version: '0.2.0' });

server.registerTool(
  'codex_run',
  {
    title: 'Run a Codex task',
    description:
      'Give Codex (OpenAI coding agent) a task. Starts a new thread, or continues an existing one when thread_id is given. ' +
      'Blocks up to wait_seconds, then returns status, Codex\'s latest message, files changed and commands run. ' +
      'status "inProgress" → codex_wait; "waitingForInput" → answer pending_requests with codex_respond. ' +
      'Run several threads in parallel by calling codex_run with wait_seconds: 0 for each, then codex_wait with all thread_ids. ' +
      'Review Codex\'s changes yourself before reporting them as done.',
    inputSchema: {
      prompt: z.string().min(1).describe('Instructions for Codex. Be specific: goal, files, constraints, what "done" looks like.'),
      cwd: z.string().optional().describe('Absolute working directory. Required for a new thread.'),
      thread_id: z.string().optional().describe('Continue this existing Codex thread (keeps its context).'),
      model: z.string().optional().describe('Model override (see codex_models). Defaults to Codex config.'),
      effort: z.string().optional().describe('Reasoning effort override, e.g. low | medium | high | xhigh (see codex_models).'),
      sandbox: z.enum(SANDBOX_MODES).optional().describe(`Sandbox for a new (or resumed) thread; fixed after that. Default: ${bridge.defaults.sandbox}.`),
      approval: z.enum(APPROVAL_POLICIES).optional()
        .describe(`When Codex must ask before acting; can change between turns. "never" auto-approves everything. Default: ${bridge.defaults.approval}.`),
      worktree: z.boolean().optional().describe('New thread only: run in a fresh git worktree + branch (codex/<stamp>) of cwd\'s repo, so parallel tasks never collide. The worktree is kept for you to inspect/merge.'),
      web_search: z.boolean().optional().describe('New thread only: enable live web search for Codex.'),
      output_schema: z.record(z.string(), z.unknown()).optional().describe('JSON Schema the final message must follow (structured output).'),
      wait_seconds: waitArg,
    },
  },
  async ({ prompt, cwd, thread_id, model, effort, sandbox, approval, worktree, web_search, output_schema, wait_seconds }) => {
    let threadId = thread_id;
    if (threadId) {
      await bridge.ensureLoaded(threadId, { cwd, sandbox, approval });
    } else {
      if (!cwd) throw new Error('cwd is required when starting a new thread');
      threadId = await bridge.startThread({ cwd, sandbox, approval, worktree, web_search });
    }
    await bridge.startTurn(threadId, { prompt, model, effort, output_schema, cwd: thread_id && cwd, approval: thread_id && approval });
    await bridge.wait([threadId], wait_seconds);
    return json(bridge.report(threadId));
  },
);

server.registerTool(
  'codex_wait',
  {
    title: 'Wait for Codex',
    description:
      'Wait for turns on one or more Codex threads, then return their reports. ' +
      'mode "all" (default) returns when every thread is done or blocked on a request; "any" returns as soon as one is.',
    inputSchema: {
      thread_id: z.string().optional(),
      thread_ids: z.array(z.string()).optional().describe('Several threads (batch wait).'),
      mode: z.enum(['all', 'any']).default('all'),
      wait_seconds: waitArg,
    },
  },
  async ({ thread_id, thread_ids, mode, wait_seconds }) => {
    const ids = thread_ids ?? (thread_id ? [thread_id] : []);
    if (!ids.length) throw new Error('pass thread_id or thread_ids');
    ids.forEach(known);
    await bridge.wait(ids, wait_seconds, mode);
    return json(ids.length === 1 && !thread_ids ? bridge.report(ids[0]) : ids.map((id) => bridge.report(id)));
  },
);

server.registerTool(
  'codex_status',
  {
    title: 'Peek at Codex',
    description: 'Non-blocking snapshot of Codex threads in this session: status, what Codex is doing right now, pending requests.',
    inputSchema: { thread_ids: z.array(z.string()).optional().describe('Defaults to every thread used in this session.') },
  },
  async ({ thread_ids }) => {
    const ids = thread_ids ?? [...bridge.threads.keys()];
    ids.forEach(known);
    return json(ids.map((id) => bridge.report(id)));
  },
);

server.registerTool(
  'codex_respond',
  {
    title: 'Answer Codex',
    description:
      'Answer a request Codex is blocked on (listed in pending_requests). ' +
      'Approvals take decision: accept | acceptForSession | decline | cancel. Questions take answers: { <question id>: "answer" }. ' +
      'Ask the user first when the request is something they should decide.',
    inputSchema: {
      request_id: z.string(),
      decision: z.enum(['accept', 'acceptForSession', 'decline', 'cancel']).optional(),
      answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(),
      wait_seconds: waitArg,
    },
  },
  async ({ request_id, decision, answers, wait_seconds }) => {
    const threadId = await bridge.respond(request_id, { decision, answers });
    await bridge.wait([threadId], wait_seconds);
    return json(bridge.report(threadId));
  },
);

server.registerTool(
  'codex_steer',
  {
    title: 'Steer a running Codex turn',
    description: 'Add instructions to the turn Codex is currently working on, without stopping it.',
    inputSchema: { thread_id: z.string(), prompt: z.string().min(1), wait_seconds: waitArg },
  },
  async ({ thread_id, prompt, wait_seconds }) => {
    known(thread_id);
    await bridge.steer(thread_id, prompt);
    await bridge.wait([thread_id], wait_seconds);
    return json(bridge.report(thread_id));
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
    known(thread_id);
    await bridge.interrupt(thread_id);
    await bridge.wait([thread_id], 30);
    return json(bridge.report(thread_id));
  },
);

server.registerTool(
  'codex_review',
  {
    title: 'Codex code review',
    description:
      'Run Codex\'s native code review (read-only) in a git repo. The review text comes back in the "review" field. ' +
      'Pass focus and/or adversarial: true for a steerable review that challenges the design, not just bugs.',
    inputSchema: {
      cwd: z.string().describe('Absolute path inside the git repository.'),
      target: z.enum(['uncommitted', 'base', 'commit']).default('uncommitted')
        .describe('uncommitted changes, the branch vs base_branch, or one commit_sha.'),
      base_branch: z.string().optional(),
      commit_sha: z.string().optional(),
      focus: z.string().optional().describe('What to concentrate on, e.g. "concurrency and error handling".'),
      adversarial: z.boolean().optional().describe('Challenge the approach and assumptions, not just find bugs.'),
      model: z.string().optional(),
      effort: z.string().optional(),
      wait_seconds: waitArg,
    },
  },
  async ({ wait_seconds, ...args }) => {
    const threadId = await bridge.review(args);
    await bridge.wait([threadId], wait_seconds);
    return json(bridge.report(threadId));
  },
);

server.registerTool(
  'codex_compact',
  {
    title: 'Compact a Codex thread',
    description: 'Summarize a long Codex thread\'s history to free up its context window. Runs in the background.',
    inputSchema: { thread_id: z.string() },
  },
  async ({ thread_id }) => {
    await bridge.compact(thread_id);
    return json({ thread_id, compaction: 'started' });
  },
);

server.registerTool(
  'codex_models',
  {
    title: 'List Codex models',
    description: 'Models available to this Codex login, with supported reasoning efforts.',
    inputSchema: { include_hidden: z.boolean().optional() },
  },
  async ({ include_hidden }) => json(await bridge.models(include_hidden)),
);

server.registerTool(
  'codex_threads',
  {
    title: 'List Codex threads',
    description: 'List recent Codex threads (including ones from the Codex app/CLI), newest first. Continue one with codex_run + thread_id.',
    inputSchema: {
      cwd: z.string().optional().describe('Only threads with exactly this working directory.'),
      limit: z.number().int().min(1).max(50).default(10),
    },
  },
  async (args) => json(await bridge.listThreads(args)),
);

await server.connect(new StdioServerTransport());
log(`ready (sandbox=${bridge.defaults.sandbox}, approval=${bridge.defaults.approval})`);
