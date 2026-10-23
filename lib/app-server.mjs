// Minimal client for `codex app-server` over stdio (newline-delimited JSON, no `jsonrpc` field).
import { spawn } from 'node:child_process';

export const log = (...a) => console.error('[codex-mcp]', ...a);

export class AppServer {
  proc = null;
  nextId = 1;
  pending = new Map();
  ready = null;

  // handlers: { onNotification(method, params), onServerRequest(id, method, params), onExit() }
  constructor(bin, handlers) {
    this.bin = bin;
    this.handlers = handlers;
  }

  start() {
    if (this.ready) return this.ready;
    const proc = spawn(this.bin, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'] });
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
    // Writes to a child that failed or exited raise EPIPE here; the 'error' or
    // 'exit' handler already fails the pending requests.
    proc.stdin.on('error', (err) => log(`app-server stdin: ${err.message}`));
    // A failed spawn (missing or non-executable CODEX_BIN) emits 'error' and
    // no 'exit'; without a handler the whole MCP server would crash.
    proc.on('error', (err) => {
      log(`failed to start ${this.bin}: ${err.message}`);
      for (const { reject } of this.pending.values()) reject(new Error(`codex app-server failed to start: ${err.message}`));
      this.pending.clear();
      this.proc = null;
      this.ready = null;
    });
    proc.on('exit', (code, sig) => {
      log(`app-server exited code=${code} sig=${sig}; will respawn on next call`);
      for (const { reject } of this.pending.values()) reject(new Error('codex app-server exited'));
      this.pending.clear();
      this.proc = null;
      this.ready = null;
      this.handlers.onExit();
    });
    this.ready = this.request('initialize', {
      clientInfo: { name: 'codex-app-server-mcp', title: 'Codex app-server MCP bridge', version: '0.2.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    }).then(() => this.send({ method: 'initialized' }));
    return this.ready;
  }

  send(msg) {
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.send({ id, method, params });
    });
  }

  async call(method, params) {
    await this.start();
    return this.request(method, params);
  }

  respond(id, result) {
    this.send({ id, result });
  }

  respondError(id, message) {
    this.send({ id, error: { code: -32601, message } });
  }

  handle(msg) {
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message ?? JSON.stringify(msg.error)}`));
      else p.resolve(msg.result);
    } else if (msg.id !== undefined) {
      this.handlers.onServerRequest(msg.id, msg.method, msg.params ?? {});
    } else {
      this.handlers.onNotification(msg.method, msg.params ?? {});
    }
  }
}
