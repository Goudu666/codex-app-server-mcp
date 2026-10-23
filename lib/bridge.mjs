// Thread/turn bookkeeping on top of AppServer: accumulates items per turn, queues server-initiated
// requests (approvals, questions) for the MCP client to answer, and lets callers wait on turns.
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { AppServer, log } from './app-server.mjs';

export const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];
export const APPROVAL_POLICIES = ['untrusted', 'on-request', 'never'];

const APPROVAL_METHODS = new Set([
  'item/commandExecution/requestApproval',
  'item/fileChange/requestApproval',
  'item/permissions/requestApproval',
  'execCommandApproval',
  'applyPatchApproval',
]);

const ADVERSARIAL_PREAMBLE =
  'Act as a skeptical senior reviewer. Do not just look for bugs: challenge the chosen approach, ' +
  'question assumptions and tradeoffs, look for failure modes, and say whether a simpler or safer design exists.';

function summarizeItem(item) {
  switch (item.type) {
    case 'agentMessage':
      return { kind: 'message', text: item.text };
    case 'commandExecution':
      return { kind: 'command', command: item.command, exitCode: item.exitCode, status: item.status };
    case 'fileChange':
      return { kind: 'files', status: item.status, changes: item.changes.map((c) => ({ path: c.path, type: c.kind.type })) };
    case 'mcpToolCall':
      return { kind: 'tool', name: `${item.server}.${item.tool}`, status: item.status };
    case 'webSearch':
      return { kind: 'tool', name: 'webSearch' };
    case 'exitedReviewMode':
      return { kind: 'review', text: item.review };
    default:
      return null;
  }
}

function describeActive(item) {
  switch (item.type) {
    case 'commandExecution':
      return `running: ${item.command}`;
    case 'fileChange':
      return `editing: ${item.changes.map((c) => c.path).join(', ')}`;
    case 'mcpToolCall':
      return `tool: ${item.server}.${item.tool}`;
    case 'webSearch':
      return 'searching the web';
    case 'reasoning':
      return 'thinking';
    case 'enteredReviewMode':
      return 'reviewing';
    default:
      return null;
  }
}

function summarizeRequest(method, p) {
  switch (method) {
    case 'item/commandExecution/requestApproval':
      return { type: 'approve_command', command: p.command, cwd: p.cwd, reason: p.reason ?? null };
    case 'execCommandApproval':
      return { type: 'approve_command', command: p.command?.join?.(' ') ?? p.command, cwd: p.cwd, reason: p.reason ?? null };
    case 'item/fileChange/requestApproval':
      return { type: 'approve_file_change', reason: p.reason ?? null, grant_root: p.grantRoot ?? null };
    case 'applyPatchApproval':
      return { type: 'approve_file_change', files: Object.keys(p.fileChanges ?? {}), reason: p.reason ?? null };
    case 'item/permissions/requestApproval':
      return { type: 'approve_permissions', cwd: p.cwd, reason: p.reason, permissions: p.permissions };
    case 'item/tool/requestUserInput':
      return {
        type: 'question',
        questions: p.questions.map((q) => ({
          id: q.id,
          header: q.header,
          question: q.question,
          options: q.options?.map((o) => o.label) ?? null,
          free_text_allowed: q.isOther,
        })),
      };
  }
}

const dropNulls = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v != null));

const LEGACY_DECISIONS = {
  accept: 'approved',
  acceptForSession: 'approved_for_session',
  decline: { denied: { rejection: 'Declined by the orchestrating agent.' } },
  cancel: 'abort',
};

export class Bridge {
  threads = new Map(); // threadId → state
  requests = new Map(); // request_id → { rawId, threadId, method, params }
  listeners = new Set(); // re-evaluated on every state change
  nextRequest = 1;

  constructor({ bin, sandbox, permissions, approval, model, effort, worktreeRoot }) {
    this.defaults = { sandbox, permissions, approval, model, effort };
    this.worktreeRoot = worktreeRoot ?? join(homedir(), '.codex-mcp', 'worktrees');
    this.app = new AppServer(bin, {
      onNotification: (m, p) => this.onNotification(m, p),
      onServerRequest: (id, m, p) => this.onServerRequest(id, m, p),
      onExit: () => this.onExit(),
    });
  }

  state(threadId) {
    let s = this.threads.get(threadId);
    if (!s) {
      s = { cwd: null, approval: null, turnId: null, status: 'idle', error: null, items: [], active: new Map(), worktree: null };
      this.threads.set(threadId, s);
    }
    return s;
  }

  changed() {
    for (const l of this.listeners) l();
  }

  onNotification(method, p) {
    switch (method) {
      case 'turn/started': {
        const s = this.state(p.threadId);
        s.turnId = p.turn.id;
        s.status = 'inProgress';
        s.error = null;
        s.active.clear();
        break;
      }
      case 'item/started': {
        const d = describeActive(p.item);
        if (d) this.state(p.threadId).active.set(p.item.id, d);
        break;
      }
      case 'item/completed': {
        const s = this.state(p.threadId);
        s.active.delete(p.item.id);
        const sum = summarizeItem(p.item);
        if (sum) s.items.push({ turnId: p.turnId, ...sum });
        break;
      }
      case 'turn/completed': {
        const s = this.state(p.threadId);
        s.turnId = p.turn.id;
        s.status = p.turn.status;
        s.error = p.turn.error?.message ?? null;
        s.active.clear();
        this.changed();
        break;
      }
      case 'serverRequest/resolved':
        for (const [rid, r] of this.requests) if (r.rawId === p.requestId) this.requests.delete(rid);
        break;
      case 'error':
        log('error notification:', JSON.stringify(p));
        break;
    }
  }

  onServerRequest(rawId, method, p) {
    const threadId = p.threadId ?? p.conversationId;
    log(`server request ${method} (thread ${threadId})`);
    if (APPROVAL_METHODS.has(method) && this.threads.get(threadId)?.approval === 'never') {
      return this.app.respond(rawId, this.approvalResult(method, p, 'accept'));
    }
    if (method === 'mcpServer/elicitation/request') {
      return this.app.respond(rawId, { action: 'decline', content: null, _meta: null });
    }
    const summary = summarizeRequest(method, p);
    if (!summary) return this.app.respondError(rawId, `codex-app-server-mcp does not handle ${method}`);
    const request_id = `req_${this.nextRequest++}`;
    this.requests.set(request_id, { rawId, threadId, method, params: p, summary });
    this.changed();
  }

  approvalResult(method, p, decision) {
    switch (method) {
      case 'item/commandExecution/requestApproval':
      case 'item/fileChange/requestApproval':
        return { decision };
      case 'execCommandApproval':
      case 'applyPatchApproval':
        return { decision: LEGACY_DECISIONS[decision] };
      case 'item/permissions/requestApproval':
        return decision.startsWith('accept')
          ? { permissions: dropNulls(p.permissions), scope: decision === 'acceptForSession' ? 'session' : 'turn' }
          : { permissions: {}, scope: 'turn' };
    }
  }

  onExit() {
    for (const s of this.threads.values()) {
      if (s.status === 'inProgress') {
        s.status = 'failed';
        s.error = 'codex app-server exited mid-turn';
      }
    }
    this.requests.clear();
    this.changed();
    // keep reports readable, but force thread/resume on next use (new app-server process)
    for (const s of this.threads.values()) s.loaded = false;
  }

  pendingFor(threadId) {
    return [...this.requests].filter(([, r]) => r.threadId === threadId).map(([request_id, r]) => ({ request_id, ...r.summary }));
  }

  // Resolve when every (mode 'all') or any (mode 'any') thread has finished its turn or is waiting
  // on a request — or after `seconds`.
  wait(threadIds, seconds, mode = 'all') {
    const settled = (id) => this.threads.get(id).status !== 'inProgress' || this.pendingFor(id).length > 0;
    const done = () => (mode === 'all' ? threadIds.every(settled) : threadIds.some(settled));
    if (done() || seconds <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(t);
        this.listeners.delete(check);
        resolve();
      };
      const check = () => done() && finish();
      const t = setTimeout(finish, seconds * 1000);
      this.listeners.add(check);
    });
  }

  report(threadId) {
    const s = this.threads.get(threadId);
    const items = s.items.filter((i) => i.turnId === s.turnId);
    const messages = items.filter((i) => i.kind === 'message').map((i) => i.text);
    const files = new Map();
    for (const i of items) if (i.kind === 'files') for (const c of i.changes) files.set(c.path, c.type);
    const commands = items.filter((i) => i.kind === 'command');
    const review = items.findLast((i) => i.kind === 'review');
    const pending = this.pendingFor(threadId);
    const out = {
      thread_id: threadId,
      turn_id: s.turnId,
      status: pending.length ? 'waitingForInput' : s.status,
      ...(s.error && { error: s.error }),
      ...(s.worktree && { worktree: s.worktree }),
      ...(review && { review: review.text }),
      latest_message: review && messages.at(-1) === review.text ? undefined : messages.at(-1) ?? null,
      earlier_messages: messages.slice(0, -1),
      files_changed: [...files].map(([path, type]) => ({ path, type })),
      commands_run: commands.length,
      recent_commands: commands.slice(-8).map((c) => ({ command: c.command, exitCode: c.exitCode })),
      other_tool_calls: items.filter((i) => i.kind === 'tool').map((i) => i.name),
    };
    if (s.status === 'inProgress') out.current_activity = [...s.active.values()];
    if (pending.length) {
      out.pending_requests = pending;
      out.hint = 'Codex is blocked on these requests — answer each with codex_respond, then codex_wait.';
    } else if (s.status === 'inProgress') {
      out.hint = 'Turn still running — call codex_wait to keep waiting, or codex_steer to add instructions.';
    }
    return out;
  }

  // ---------- operations ----------

  // A thread runs under either a sandbox mode or a named permission profile, never both.
  policy({ sandbox, permissions }, fallback = this.defaults) {
    if (sandbox && permissions) throw new Error('pass sandbox or permissions, not both');
    if (sandbox) return { sandbox };
    if (permissions) return { permissions };
    return fallback.permissions ? { permissions: fallback.permissions } : { sandbox: fallback.sandbox };
  }

  async startThread({ cwd, sandbox, permissions, approval, web_search, worktree, model, effort, ephemeral = false }) {
    const policy = this.policy({ sandbox, permissions });
    approval ??= this.defaults.approval;
    let wt = null;
    if (worktree) {
      wt = createWorktree(cwd, this.worktreeRoot);
      cwd = wt.cwd;
    }
    const config = { notify: [] }; // don't fire desktop-app notifiers for bridge-driven turns
    if (web_search) config.web_search = 'live';
    if (model) config.model = model;
    if (effort) config.model_reasoning_effort = effort;
    const res = await this.app.call('thread/start', {
      cwd,
      ...policy,
      approvalPolicy: approval,
      config,
      ephemeral,
      serviceName: 'codex-app-server-mcp',
    });
    const s = this.state(res.thread.id);
    Object.assign(s, { cwd: res.cwd, policy, approval, loaded: true, worktree: wt && { path: wt.path, branch: wt.branch } });
    return res.thread.id;
  }

  async ensureLoaded(threadId, { cwd, sandbox, permissions, approval } = {}) {
    const s = this.threads.get(threadId);
    if (s?.loaded) {
      const requested = (sandbox || permissions) && this.policy({ sandbox, permissions });
      if (requested && (requested.sandbox !== s.policy.sandbox || requested.permissions !== s.policy.permissions)) {
        throw new Error(`thread ${threadId} is already running here; sandbox and permissions are fixed per thread — start a new thread to change them`);
      }
      return s; // approval/cwd changes go through turn/start
    }
    // after an app-server restart, keep the thread's own policies rather than falling back to defaults
    const policy = this.policy({ sandbox, permissions }, s?.policy ?? this.defaults);
    approval ??= s?.approval ?? this.defaults.approval;
    await this.app.call('thread/resume', {
      threadId,
      ...policy,
      approvalPolicy: approval,
      excludeTurns: true,
      ...(cwd && { cwd }),
    });
    return Object.assign(this.state(threadId), { policy, approval, loaded: true });
  }

  async startTurn(threadId, { prompt, model, effort, cwd, approval, output_schema }) {
    const s = this.threads.get(threadId);
    if (s.status === 'inProgress') {
      throw new Error(`thread ${threadId} already has a running turn — use codex_steer to add instructions, or codex_wait / codex_interrupt`);
    }
    model ??= this.defaults.model;
    effort ??= this.defaults.effort;
    // switch the local policy first: an approval request can arrive before the turn/start response
    const previousApproval = s.approval;
    if (approval) s.approval = approval;
    const res = await this.app.call('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      ...(model && { model }),
      ...(effort && { effort }),
      ...(cwd && { cwd }),
      ...(approval && { approvalPolicy: approval }),
      ...(output_schema && { outputSchema: output_schema }),
    }).catch((e) => {
      s.approval = previousApproval;
      throw e;
    });
    this.noteTurn(s, res.turn);
  }

  noteTurn(s, turn) {
    // turn/started (or even turn/completed) may have arrived before the response
    if (s.turnId !== turn.id) {
      s.turnId = turn.id;
      s.status = turn.status;
    }
  }

  async steer(threadId, prompt) {
    const s = this.threads.get(threadId);
    if (!s || s.status !== 'inProgress') throw new Error(`thread ${threadId} has no running turn — use codex_run with thread_id to send a new instruction`);
    await this.app.call('turn/steer', {
      threadId,
      expectedTurnId: s.turnId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
    });
  }

  async interrupt(threadId) {
    const s = this.threads.get(threadId);
    if (!s || s.status !== 'inProgress') throw new Error(`thread ${threadId} has no running turn`);
    await this.app.call('turn/interrupt', { threadId, turnId: s.turnId });
  }

  async review({ cwd, target, base_branch, commit_sha, focus, adversarial, model, effort }) {
    // review/start takes no model/effort, so set them on the review thread's config
    // read-only either way; profile-based setups use the built-in :read-only profile
    const readOnly = this.defaults.permissions ? { permissions: ':read-only' } : { sandbox: 'read-only' };
    const threadId = await this.startThread({
      cwd, ...readOnly, approval: 'never', model: model ?? this.defaults.model, effort: effort ?? this.defaults.effort,
    });
    const scope = {
      uncommitted: { type: 'uncommittedChanges' },
      base: { type: 'baseBranch', branch: base_branch },
      commit: { type: 'commit', sha: commit_sha, title: null },
    }[target];
    if (target === 'base' && !base_branch) throw new Error('target "base" needs base_branch');
    if (target === 'commit' && !commit_sha) throw new Error('target "commit" needs commit_sha');
    let reviewTarget = scope;
    if (focus || adversarial) {
      const what = {
        uncommitted: 'the uncommitted changes in this repository (staged, unstaged and untracked)',
        base: `the changes on the current branch compared to ${base_branch} (git diff ${base_branch}...HEAD)`,
        commit: `the changes introduced by commit ${commit_sha}`,
      }[target];
      reviewTarget = {
        type: 'custom',
        instructions: [`Review ${what}.`, adversarial && ADVERSARIAL_PREAMBLE, focus && `Focus on: ${focus}`].filter(Boolean).join(' '),
      };
    }
    const res = await this.app.call('review/start', { threadId, target: reviewTarget, delivery: 'inline' });
    this.noteTurn(this.threads.get(threadId), res.turn);
    return threadId;
  }

  async respond(request_id, { decision, answers }) {
    const r = this.requests.get(request_id);
    if (!r) throw new Error(`no pending request ${request_id} (already answered, or Codex withdrew it)`);
    let result;
    if (r.method === 'item/tool/requestUserInput') {
      if (!answers) throw new Error('this request is a question — pass answers: { <question id>: "answer" | ["answer", ...] }');
      result = {
        answers: Object.fromEntries(Object.entries(answers).map(([qid, a]) => [qid, { answers: Array.isArray(a) ? a : [a] }])),
      };
    } else {
      if (!decision) throw new Error('this request is an approval — pass decision: accept | acceptForSession | decline | cancel');
      result = this.approvalResult(r.method, r.params, decision);
    }
    this.requests.delete(request_id);
    this.app.respond(r.rawId, result);
    return r.threadId;
  }

  async compact(threadId) {
    await this.ensureLoaded(threadId);
    await this.app.call('thread/compact/start', { threadId });
  }

  async models(includeHidden) {
    const res = await this.app.call('model/list', { includeHidden: includeHidden ?? false });
    return res.data.map((m) => ({
      id: m.id,
      name: m.displayName,
      description: m.description,
      default: m.isDefault,
      default_effort: m.defaultReasoningEffort,
      efforts: m.supportedReasoningEfforts.map((e) => e.reasoningEffort),
    }));
  }

  async listThreads({ cwd, limit }) {
    const res = await this.app.call('thread/list', { limit, ...(cwd && { cwd }), useStateDbOnly: true });
    return res.data.map((t) => ({
      thread_id: t.id,
      name: t.name,
      preview: t.preview?.slice(0, 160),
      cwd: t.cwd,
      model: t.model,
      updatedAt: t.updatedAt && new Date(t.updatedAt * 1000).toISOString(),
      running_here: this.threads.get(t.id)?.status === 'inProgress',
    }));
  }
}

// Isolated git worktree for one Codex thread, so parallel threads never edit over each other.
function createWorktree(cwd, worktreeRoot) {
  const git = (...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const root = git('rev-parse', '--show-toplevel');
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14) + '-' + Math.random().toString(36).slice(2, 6);
  const branch = `codex/${stamp}`;
  const dir = join(worktreeRoot, `${basename(root)}-${stamp}`);
  mkdirSync(worktreeRoot, { recursive: true });
  git('worktree', 'add', '-b', branch, dir, 'HEAD');
  return { path: dir, branch, cwd: join(dir, relative(root, cwd)) };
}
