#!/usr/bin/env node
// Stand-in for `codex app-server` used by the offline tests. Behaviour is driven by the prompt:
//   "echo <text>"  reply with <text>
//   "approve"      ask for command approval, then run (or not) depending on the answer
//   "ask"          ask a question, then echo the answer
//   "slow"         keep the turn running until steered (finishes with the steer text) or interrupted
//   "crash"        exit the process mid-turn
if (process.argv[2] !== 'app-server') process.exit(2);

let buf = '';
let nextId = 1000;
let threadSeq = 0;
const waitingOn = new Map(); // server request id → callback(result)
const turns = new Map(); // threadId → { id, onSteer }

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const notify = (method, params) => send({ method, params });
const ask = (method, params, cb) => {
  const id = nextId++;
  waitingOn.set(id, cb);
  send({ id, method, params });
};

const turn = (id, status = 'inProgress') => ({ id, items: [], status, error: null });
let itemSeq = 0;
function item(threadId, turnId, it) {
  it.id = `item_${itemSeq++}`;
  notify('item/started', { threadId, turnId, item: it, startedAtMs: 0 });
  notify('item/completed', { threadId, turnId, item: it, completedAtMs: 0 });
}
const message = (threadId, turnId, text) => item(threadId, turnId, { type: 'agentMessage', text });
function complete(threadId, turnId, status = 'completed') {
  turns.delete(threadId);
  notify('turn/completed', { threadId, turn: turn(turnId, status) });
}

function startTurn(threadId, text) {
  const turnId = `turn_${itemSeq++}`;
  setImmediate(() => {
    notify('turn/started', { threadId, turn: turn(turnId) });
    if (text.startsWith('echo ')) {
      message(threadId, turnId, text.slice(5));
      complete(threadId, turnId);
    } else if (text === 'approve') {
      ask('item/commandExecution/requestApproval', { threadId, turnId, itemId: 'x', command: 'rm -rf build', cwd: '/tmp', startedAtMs: 0 }, ({ decision }) => {
        if (decision === 'accept') item(threadId, turnId, { type: 'commandExecution', command: 'rm -rf build', exitCode: 0, status: 'completed' });
        message(threadId, turnId, `decision=${decision}`);
        complete(threadId, turnId);
      });
    } else if (text === 'ask') {
      const questions = [{ id: 'color', header: 'Color', question: 'Which color?', isOther: true, isSecret: false, options: [{ label: 'red', description: '' }] }];
      ask('item/tool/requestUserInput', { threadId, turnId, itemId: 'q', questions, isBlocking: true }, ({ answers }) => {
        message(threadId, turnId, `answer=${answers.color.answers.join(',')}`);
        complete(threadId, turnId);
      });
    } else if (text === 'slow') {
      item(threadId, turnId, { type: 'commandExecution', command: 'sleep 999', exitCode: null, status: 'inProgress' });
      notify('item/started', { threadId, turnId, item: { type: 'commandExecution', id: 'live', command: 'make build' }, startedAtMs: 0 });
      turns.get(threadId).onSteer = (t) => {
        message(threadId, turnId, `steered=${t}`);
        complete(threadId, turnId);
      };
    } else if (text === 'crash') {
      process.exit(1);
    }
  });
  turns.set(threadId, { id: turnId });
  return turnId;
}

const handlers = {
  initialize: () => ({ userAgent: 'fake', codexHome: '/tmp', platformFamily: 'unix', platformOs: 'macos' }),
  'thread/start': (p) => {
    const id = `thread_${threadSeq++}`;
    return { thread: { id }, cwd: p.cwd, model: 'fake-model', sandbox: p.sandbox, approvalPolicy: p.approvalPolicy };
  },
  'thread/resume': (p) => ({ thread: { id: p.threadId } }),
  'turn/start': (p) => ({ turn: turn(startTurn(p.threadId, p.input[0].text)) }),
  'turn/steer': (p) => {
    const t = turns.get(p.threadId);
    if (!t || t.id !== p.expectedTurnId) throw new Error('expectedTurnId mismatch');
    setImmediate(() => t.onSteer(p.input[0].text));
    return { turnId: t.id };
  },
  'turn/interrupt': (p) => {
    setImmediate(() => complete(p.threadId, p.turnId, 'interrupted'));
    return {};
  },
  'review/start': (p) => {
    const turnId = `turn_${itemSeq++}`;
    setImmediate(() => {
      notify('turn/started', { threadId: p.threadId, turn: turn(turnId) });
      item(p.threadId, turnId, { type: 'exitedReviewMode', review: `REVIEW ${JSON.stringify(p.target)}` });
      complete(p.threadId, turnId);
    });
    return { turn: turn(turnId), reviewThreadId: p.threadId };
  },
  'thread/compact/start': () => ({}),
  'model/list': () => ({
    data: [{ id: 'fake-model', displayName: 'Fake', description: 'd', isDefault: true, defaultReasoningEffort: 'medium', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] }],
    nextCursor: null,
  }),
  'thread/list': () => ({ data: [{ id: 'thread_0', name: null, preview: 'hi', cwd: '/tmp', model: 'fake-model', updatedAt: 0 }], nextCursor: null }),
};

process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const msg = JSON.parse(buf.slice(0, i));
    buf = buf.slice(i + 1);
    if (msg.method === undefined) {
      waitingOn.get(msg.id)(msg.result);
      waitingOn.delete(msg.id);
      notify('serverRequest/resolved', { threadId: null, requestId: msg.id });
    } else if (msg.id !== undefined) {
      try {
        send({ id: msg.id, result: handlers[msg.method](msg.params) });
      } catch (e) {
        send({ id: msg.id, error: { code: -1, message: e.message } });
      }
    }
  }
});
