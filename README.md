# codex-app-server-mcp

An MCP server that lets **Claude Code** (or any MCP client) delegate work to **OpenAI Codex** — Claude plans and reviews, Codex does the hands-on work.

Instead of shelling out to `codex exec` once per task, it keeps one long-lived [`codex app-server`](https://developers.openai.com/codex/) child process and talks its JSON protocol directly. That gives you:

- **Persistent threads** — follow-up instructions go to the same Codex thread with full context.
- **Async turns** — long Codex runs never block or time out the MCP call; poll with `codex_wait`.
- **Resume anything** — continue threads started in the Codex app or CLI, or after a restart.
- **Structured results** — status, Codex's latest message, files changed, commands run (with exit codes).
- **Interrupts** — stop a runaway turn.

[中文说明](#中文说明)

## Tools

| Tool | What it does |
|---|---|
| `codex_run` | Start a task (new thread needs `cwd`) or continue one (`thread_id`). Optional `model` / `effort`. Blocks up to `wait_seconds` (default 240), then returns a result or a progress snapshot. |
| `codex_wait` | Keep waiting on a turn that came back `"status": "inProgress"`. |
| `codex_interrupt` | Stop the running turn on a thread. |
| `codex_threads` | List recent Codex threads (including ones from the Codex app/CLI), optionally filtered by `cwd`. |

Example result:

```json
{
  "thread_id": "01a14aa3-…",
  "turn_id": "01a14aa3-…",
  "status": "completed",
  "latest_message": "done",
  "files_changed": [],
  "commands_run": 1,
  "recent_commands": [{ "command": "python3 -c …", "exitCode": 0 }],
  "other_tool_calls": []
}
```

## Install

Requires Node ≥ 20 and the Codex CLI (`npm i -g @openai/codex`, logged in).

```bash
git clone https://github.com/Goudu666/codex-app-server-mcp.git
cd codex-app-server-mcp && npm install
claude mcp add --scope user codex -e CODEX_BIN="$(which codex)" -- "$(which node)" "$PWD/server.mjs"
```

Start a new Claude Code session and ask e.g. *"Have Codex implement X in this repo, then review its diff."*

Other MCP clients: run `node server.mjs` over stdio.

### Configuration

| Env var | Default | |
|---|---|---|
| `CODEX_BIN` | `codex` | Path to the Codex CLI |
| `CODEX_MODEL` | from `~/.codex/config.toml` | Default model |
| `CODEX_EFFORT` | from `~/.codex/config.toml` | Default reasoning effort |

## ⚠️ Permissions

Threads run with **`sandbox: danger-full-access` and `approvalPolicy: never`**: Codex can read/write anything your user can and run any command without asking. Any approval request that still arrives is auto-accepted; other server-initiated requests are rejected so turns fail fast instead of hanging. Only point it at directories you're comfortable with. If you want a sandbox, change `SANDBOX` / `APPROVAL` in `server.mjs`.

## Notes

- `codex app-server` is marked **experimental** by OpenAI; the protocol may change between Codex versions. Regenerate types with `codex app-server generate-ts --out <dir>` and compare. Tested with codex-cli 0.163.0.
- `files_changed` only lists edits made through Codex's patch tool; edits made via shell commands show up in `recent_commands`. Review the actual diff.
- Each new thread starts the MCP servers configured in your Codex config, so the first turn may take a few seconds.

## Tests

```bash
node test-client.mjs /some/tmp/dir    # new thread → wait → follow-up on same thread → list threads
node test-resume.mjs <thread_id>      # continue an existing thread from a fresh process (thread/resume)
```

These run real Codex turns (small, `effort: low`) and use your Codex quota.

---

## 中文说明

让 Claude Code 通过 MCP 指挥 Codex：Claude 负责拆任务、验收，Codex 负责动手。底层不是每次起一个 `codex exec`，而是常驻一个 `codex app-server` 子进程，直接走它的 JSON 协议。这样有几个好处：

- **线程持久**：追加指令发到同一个 Codex 线程里，上下文还在。
- **异步回合**：Codex 跑很久也不会把 MCP 调用卡死或超时，用 `codex_wait` 轮询就行。
- **能续接**：Codex app / CLI 里开的线程，或者重启之后的旧线程，都能接着用。
- **结构化结果**：返回状态、最新消息、改了哪些文件、跑了哪些命令（带退出码）。
- **可中断**：跑飞了随时停。

安装方法见上面的 Install 一节。注意默认是 **full access 且不审批**，只对你放心的目录用。`codex app-server` 目前是 experimental，Codex 升级后协议可能会变。

## License

MIT
