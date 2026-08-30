# Agent Hub

Agent Hub is a Supabase-controlled task scheduler for independent AI workers. Supabase owns durable state, RLS, Realtime delivery, registration, and timeout recovery. Workers only make outbound connections and never expose an inbound port.

## Components

- `supabase/`: tables, RLS, state-machine triggers, dispatch RPC, cron recovery, and Edge Functions.
- `worker-cli/`: Realtime Codex/Claude CLI worker with safe argument arrays and per-task directories.
- `worker-sdk/`: Claude Agent SDK executor using the same registration and queue contract.
- `worker-session/`: elastic Claude Code skill and Stop-hook fallback.
- `web/`: responsive single-admin React dashboard.
- `channels/wechat/`: codex2wechat integration — dispatcher `AGENTS.md`, `channel-api` contract, and the result notifier daemon.

## Task lifecycle features

- **Result protocol**: workers wrap every prompt with an untrusted-data frame and a mandatory `===RESULT===` block (`shared/prompt.ts`). The parsed summary/detail becomes `tasks.result`, and `status: failure` marks the task failed even when the executor exits 0. Disable per worker with `executor.wrap_prompt = false`.
- **Live progress**: CLI workers stream the executor's latest output line and SDK workers stream assistant milestones into `tasks.progress`, throttled by `executor.progress_interval_seconds`.
- **Cancellation propagation**: cancelling a task (dashboard or `channel-api`) aborts the running executor process on the worker via the same Realtime channel.
- **Agent pause**: `agents.paused` keeps an agent online but excluded from dispatch; toggled from the dashboard.
- **File transfer**: operators attach input files when creating a task (dashboard upload or channel-api `prepare_upload` + signed PUT); workers download them into the workspace `inputs/` directory before executing, and everything the executor writes into `outputs/` is uploaded to the private `task-files` bucket and registered in `task_files` when the task finishes. Delivered files are downloadable from the task drawer and pushed to WeChat as signed links.
- **Execution transcript**: both executors stream their full output to `transcript.log` in the workspace (CLI: raw stdout/stderr; SDK: one JSON line per message, tool calls included). The worker uploads it as `<task_id>/log/transcript.log` on finish, timeout, or a human-input pause — the task drawer's 推理过程 section renders it in place, so the 记录 view gives the full reasoning trail of every session.
- **Human-in-the-loop**: an executor that hits a decision only the operator can make ends with a `===QUESTION===` block; the worker records it in `task_interactions` and parks the task as `waiting_input` (slot freed, timeout recovery paused). The operator answers from the dashboard drawer or WeChat (`答复 <id前缀> <决定>` → channel-api `answer` → `answer_task` RPC); the task returns to `assigned` for the same agent, which resumes in the same workspace with the full Q&A history in the prompt. Multiple rounds are supported.

## Security model

- Every worker has its own Supabase Auth user and can only see tasks assigned to its agent row.
- Agent task updates are constrained by both RLS and a trigger that rejects changes to protected fields.
- Security-definer functions are revoked from `anon` and granted explicitly.
- Bootstrap tokens are stored as SHA-256 hashes, expire, and have bounded uses.
- Worker credentials and configuration are owner-only files. Prompts are passed over stdin, never interpolated into a shell command.
- Worker workspaces are children of one configured root. Services run under dedicated unprivileged OS users.

## Build

```bash
npm ci
npm run check
npm run build
```

## Supabase deployment

1. Create a hosted Supabase project.
2. Link the repository with `supabase link --project-ref <ref>`.
3. Apply `supabase/migrations/202608280001_agent_hub.sql` with `supabase db push`.
4. Deploy functions:

```bash
supabase functions deploy dispatch
supabase functions deploy admin
supabase functions deploy register --no-verify-jwt
supabase functions deploy poll
supabase functions deploy wechat-in --no-verify-jwt
supabase functions deploy wechat-out --no-verify-jwt
supabase functions deploy channel-api --no-verify-jwt
```

5. Set function secrets from `supabase/functions/.env.example`.
6. Create the administrator Auth user and set `app_metadata.role` to `admin` with the Admin API. Never place the service role key in the Web build.
7. Copy `web/.env.example` to `web/.env.production`, set only the project URL and publishable key, then run `npm run build:web`.

## agenthub CLI

Install the worker CLI globally, then drive everything from `agenthub`:

```bash
npm run build:node
npm i -g .            # or: npm link — exposes the `agenthub` command
```

```bash
agenthub doctor                # detect node/claude/codex on this machine and recommend a service
agenthub login                 # interactive: hub URL, key, name, labels, default service, model, workspace, then register
agenthub start                 # run the worker (long-lived; picks up and executes tasks)
agenthub status                # this machine's agent + recent tasks
agenthub install-service       # print a systemd (Linux) or launchd (macOS) unit
```

Login's key choice is the **default execution service**: `1)` Claude Agent SDK (recommended — built-in
runtime, no external CLI), `2)` Codex CLI, `3)` Claude Code CLI, `4)` custom command. Switch later with
`agenthub service <sdk|codex|claude>`.

### GUI-only machines (Claude/Codex desktop, no CLI)

If a machine only has a graphical Claude/Codex client and can't run `agenthub`, use the **session worker**:
register the agent from any machine that has `agenthub`, run `agenthub session-init` to print the
`~/.claude/agent-hub.env` block, paste it on the GUI machine, drop `worker-session/hub-worker` into
`~/.claude/skills/`, and type `/hub-worker` in the client. The in-session curl loop signs in with the
machine credential and refreshes its own token. Run `agenthub doctor` first — most desktop clients bundle
the `claude`/`codex` binary, in which case the machine can just run `agenthub` directly (the better path).

Configuration lives in `~/.config/agent-hub/worker.toml` (mode `0600`); the machine credential from
approval is written to `~/.config/agent-hub/credentials.json`. The Supabase session auto-refreshes, so
a started worker stays online indefinitely without re-login.

- **Persistent workspace**: `agenthub workspace ~/work` — every task runs in `<workspace>/<task_id>`.
- **Default model**: `agenthub model claude-opus-5` (SDK) or a codex/claude model id.
- **Full local capability**: sessions run with `permission_mode = bypassPermissions` (SDK) or the
  executor's bypass flag (`--dangerously-bypass-approvals-and-sandbox` for codex,
  `--dangerously-skip-permissions` for claude), so tasks have this OS user's npm/tooling rights.
  Change it with `agenthub config set executor.permission_mode acceptEdits`.
- **Prompt skills**: `agenthub skill list | show <name> | use <name> | new <name> | edit <name> | preview`.
  Three ship built in (`default`, `coding`, `research`); custom ones live in `~/.config/agent-hub/skills/*.md`
  as templates with `{{TASK}}`, `{{CONTINUATION}}`, `{{PROTOCOL}}` placeholders (a missing protocol block is
  appended automatically so results stay parseable). The selected skill frames how the agent tackles every
  dispatched task.
- **Any config key**: `agenthub config show` / `agenthub config set executor.reasoning high`.

### Admin from the CLI (dashboard parity)

Every dashboard capability is also a CLI command. Sign in once as the admin user
(the same Supabase user with `app_metadata.role=admin`; give it a password via the Supabase
dashboard or Admin API — the web login uses magic links, the CLI uses email+password):

```bash
agenthub admin login                 # persists a refresh token in ~/.config/agent-hub/admin.json
agenthub task list --status running  # 记录页: filters --status/--agent/--query/--limit
agenthub task show 3fa8              # 详情: prompt/result/Q&A/files/timeline (id prefix or title keyword)
agenthub task create "跑一遍集成测试" --target agent:server-codex --file report.csv
agenthub task answer 3fa8 "低峰期执行"   # 拍板答复并恢复
agenthub task cancel 3fa8            # 实时中止 running 任务
agenthub task log 3fa8               # 打印推理过程 transcript
agenthub agents approve new-runner   # 审批注册; 还有 revoke/pause/resume/edit
agenthub token --minutes 120 --uses 3
agenthub events --follow             # 实时事件流
```

The admin identity is stored separately from the worker's agent credential, so one machine can be
both a worker (`agenthub start`) and your operations console.

## Worker registration

From the dashboard, generate a one-use bootstrap token. On the worker host:

```bash
install -d -m 700 ~/.config/agent-hub
install -m 600 worker-cli/worker.toml.example ~/.config/agent-hub/worker.toml
npm run worker:cli -- register --config ~/.config/agent-hub/worker.toml --bootstrap-token '<token>'
```

The command waits for approval. After the administrator approves the pending row, it receives a dedicated machine credential and writes it with mode `0600`. Then install and start the user service:

```bash
./scripts/install-worker.sh ~/.config/agent-hub/worker.toml
systemctl --user enable --now agent-hub-worker.service
```

On macOS, install the worker as a per-user LaunchAgent after registration:

```bash
./scripts/install-macos-worker.sh ~/.config/agent-hub/worker.toml
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.agent-hub.worker.plist
launchctl kickstart -k "gui/$(id -u)/com.agent-hub.worker"
launchctl print "gui/$(id -u)/com.agent-hub.worker"
```

## Operational checks

```bash
systemctl --user is-active agent-hub-worker.service
journalctl --user -u agent-hub-worker.service -n 100 --no-pager
```

Use `docs/verify/m1-transition.sql` for a transaction-only migration smoke test and `docs/verify/worker-health.sh` for an authenticated worker heartbeat check.
