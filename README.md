# codex-app-server-mcp

An MCP server that lets **Claude Code** (or any MCP client) delegate work to **OpenAI Codex**: Claude plans and reviews, Codex does the hands-on work.

Most Codex MCP wrappers shell out to `codex exec` once per task. This one keeps a single long-lived [`codex app-server`](https://developers.openai.com/codex/) process and speaks its JSON protocol directly, so it can do things `exec` can't:

- **Persistent threads**: follow-ups go to the same Codex thread with its full context.
- **Async, never times out**: every call returns within `wait_seconds` with a progress snapshot; keep going with `codex_wait`.
- **Two-way**: when Codex needs an approval or asks a question, the turn pauses and the request is handed to Claude (`codex_respond`) instead of hanging.
- **Steer and interrupt**: add instructions to a running turn, or stop it.
- **Native code review**, plus a steerable "adversarial" mode that challenges the design.
- **Parallel work**: many threads at once, batch `codex_wait`, optional isolated git worktree per task.
- **Resume anything**: continue threads started in the Codex app or CLI, or after a restart.
- Live status, model list, structured output, web search, context compaction.

[中文说明](#中文说明)

## Tools

| Tool | What it does |
|---|---|
| `codex_run` | Start a task (new thread needs `cwd`) or continue one (`thread_id`). Options: `model`, `effort`, `sandbox`, `approval`, `worktree`, `web_search`, `output_schema`, `wait_seconds` (default 240). |
| `codex_wait` | Wait on one thread or a batch (`thread_ids`, `mode: all \| any`). Returns early when Codex finishes or needs an answer. |
| `codex_status` | Non-blocking peek: status, what Codex is doing right now, pending requests. |
| `codex_respond` | Answer a pending request: approvals take `decision` (`accept` / `acceptForSession` / `decline` / `cancel`), questions take `answers`. |
| `codex_steer` | Add instructions to the turn that's currently running. |
| `codex_interrupt` | Stop the running turn. |
| `codex_review` | Codex's native read-only review of `uncommitted` changes, a branch vs `base_branch`, or a `commit_sha`. Add `focus` and/or `adversarial: true` for a steerable design challenge. |
| `codex_compact` | Compact a long thread's history to free up context. |
| `codex_models` | Models available to your Codex login, with supported reasoning efforts. |
| `codex_threads` | Recent Codex threads (including ones from the Codex app/CLI). |

Every task tool returns the same report:

```json
{
  "thread_id": "01a14aa3-…",
  "turn_id": "01a14aa3-…",
  "status": "waitingForInput",
  "latest_message": "I need to clear the build directory first.",
  "files_changed": [],
  "commands_run": 3,
  "recent_commands": [{ "command": "npm test", "exitCode": 1 }],
  "pending_requests": [
    { "request_id": "req_1", "type": "approve_command", "command": "rm -rf build", "cwd": "/repo", "reason": null }
  ],
  "hint": "Codex is blocked on these requests — answer each with codex_respond, then codex_wait."
}
```

`status` is `inProgress`, `waitingForInput`, `completed`, `interrupted` or `failed`. A review adds `review`, a worktree run adds `worktree: { path, branch }`, and a running turn adds `current_activity`.

## Install

Requires Node ≥ 20 and the Codex CLI (`npm i -g @openai/codex`, logged in).

```bash
claude mcp add --scope user codex -- npx -y codex-app-server-mcp
```

Then start a new Claude Code session and say something like *"Have Codex implement X in this repo, then review its diff."*

Any other MCP client: use the command `npx -y codex-app-server-mcp` (stdio). If the client can't find `codex` on its `PATH` (common with nvm), add `-e CODEX_BIN="$(which codex)"`.

From source: `git clone https://github.com/Goudu666/codex-app-server-mcp.git && cd codex-app-server-mcp && npm install`, then point your client at `node server.mjs`.

### Configuration

| Env var | Default | |
|---|---|---|
| `CODEX_SANDBOX` | `workspace-write` | Default sandbox for new threads: `read-only`, `workspace-write`, `danger-full-access` |
| `CODEX_PERMISSIONS` | unset | Default named permission profile for new threads (for example `:workspace` or a profile from your Codex config), sent instead of a sandbox. Cannot be combined with `CODEX_SANDBOX`. |
| `CODEX_APPROVAL` | `on-request` | Default approval policy: `untrusted`, `on-request`, `never` |
| `CODEX_MODEL` | from `~/.codex/config.toml` | Default model |
| `CODEX_EFFORT` | from `~/.codex/config.toml` | Default reasoning effort |
| `CODEX_BIN` | `codex` | Path to the Codex CLI |
| `CODEX_WORKTREE_ROOT` | `~/.codex-mcp/worktrees` | Where `worktree: true` creates worktrees |

## Permissions

By default Codex can write inside the working directory and **asks before** anything beyond that. Those requests come back to Claude as `pending_requests`, and Claude decides or asks you, then calls `codex_respond`.

Full autonomy, where Codex can touch anything your user can and never asks:

```bash
claude mcp add --scope user codex -e CODEX_SANDBOX=danger-full-access -e CODEX_APPROVAL=never -- npx -y codex-app-server-mcp
```

or per task: `codex_run({ ..., sandbox: "danger-full-access", approval: "never" })`. The sandbox is fixed once a thread starts; the approval policy can change between turns. MCP servers inside Codex that request a form (elicitation) are auto-declined.

Codex permission profiles work too: set `CODEX_PERMISSIONS` (or pass `permissions` to `codex_run`) to send a named profile instead of a sandbox mode. Use this when your Codex config or managed requirements define `default_permissions` or restrict `allowed_permission_profiles`, since Codex rejects a sandbox mode combined with a profile. Like the sandbox, the profile is fixed once a thread starts. With a profile default, `codex_review` uses the built-in `:read-only` profile.

## Parallel work

```text
codex_run({ cwd, prompt: "A", worktree: true, wait_seconds: 0 })  → thread a
codex_run({ cwd, prompt: "B", worktree: true, wait_seconds: 0 })  → thread b
codex_wait({ thread_ids: [a, b] })                                 → both reports
```

`worktree: true` creates `<CODEX_WORKTREE_ROOT>/<repo>-<stamp>` (default `~/.codex-mcp/worktrees`) on a new branch `codex/<stamp>`. Worktrees are kept for you to inspect and merge. Remove them with `git worktree remove <path>`.

## Notes

- `codex app-server` is marked **experimental** by OpenAI, so the protocol may change between Codex versions. Tested with codex-cli 0.163.0. To check a new version, regenerate the types with `codex app-server generate-ts --out <dir>`.
- `files_changed` lists edits made through Codex's patch tool. Edits made via shell commands show up in `recent_commands` instead. Review the actual diff.
- Each new thread starts the MCP servers from your Codex config, so the first turn may take a few seconds.
- The default `wait_seconds` of 240 has worked well in practice; raise it if your MCP client's tool-call timeout allows.

## Development

```bash
npm test                                   # offline: real MCP server against a fake app-server (test/fake-codex.mjs)
node test/e2e.mjs /tmp/scratch [repo]      # real Codex: models, run, respond, structured output, review (uses quota)
node test/resume.mjs <thread_id>           # continue an existing thread from a fresh process
```

---

## 中文说明

让 Claude Code 通过 MCP 指挥 Codex：Claude 负责拆任务、验收，Codex 负责动手。多数同类项目每个任务都起一个 `codex exec`；这个项目常驻一个 `codex app-server` 进程，直接走它的 JSON 协议，所以能做到下面这些：

- **线程持久**：追加指令发到同一个线程，上下文一直在。
- **异步、不超时**：每次调用最多阻塞 `wait_seconds` 秒，到时返回当前进度，之后用 `codex_wait` 接着等。
- **双向沟通**：Codex 要审批或者反问时，回合会暂停，请求交给 Claude 用 `codex_respond` 回答，不会一直卡着。
- **追加指令与中断**：`codex_steer` 给正在跑的回合补充指令，`codex_interrupt` 中途停下。
- **原生代码审查**：`codex_review`，加上 `adversarial: true` 会挑战设计本身，不只是找 bug。
- **并行**：可以同时开多个线程，`codex_wait` 批量等待；`worktree: true` 给每个任务一个独立的 git worktree，互不覆盖。
- **能续接**：Codex app / CLI 里开的线程，或者重启前的线程，都能接着用。
- 另外还有：实时状态、模型列表、结构化输出、联网搜索、压缩上下文。

**权限默认值**：`workspace-write` + `on-request`。Codex 只能写工作目录，超出范围要先问，问题会交给 Claude 回答。想完全放开就设 `CODEX_SANDBOX=danger-full-access` 和 `CODEX_APPROVAL=never`，具体见上面的 Permissions 一节。

安装只要一行：`claude mcp add --scope user codex -- npx -y codex-app-server-mcp`。工具列表和配置项见上文。`codex app-server` 目前是 experimental，Codex 升级后协议可能会变。

## License

MIT
