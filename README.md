# Agent Hub

Agent Hub is a Supabase-controlled task scheduler for independent AI workers. Supabase owns durable state, RLS, Realtime delivery, registration, and timeout recovery. Workers only make outbound connections and never expose an inbound port.

## Components

- `supabase/`: tables, RLS, state-machine triggers, dispatch RPC, cron recovery, and Edge Functions.
- `worker-cli/`: Realtime Codex/Claude CLI worker with safe argument arrays and per-task directories.
- `worker-sdk/`: Claude Agent SDK executor using the same registration and queue contract.
- `worker-session/`: elastic Claude Code skill and Stop-hook fallback.
- `web/`: responsive single-admin React dashboard.
- `channels/wechat/`: normalized optional webhook boundary. The Web task form is the default simulator.

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
```

5. Set function secrets from `supabase/functions/.env.example`.
6. Create the administrator Auth user and set `app_metadata.role` to `admin` with the Admin API. Never place the service role key in the Web build.
7. Copy `web/.env.example` to `web/.env.production`, set only the project URL and publishable key, then run `npm run build:web`.

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
