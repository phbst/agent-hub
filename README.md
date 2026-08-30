# Agent Hub

Agent Hub 是一套以 Supabase 为控制面的多 Agent 任务调度系统:持久状态、行级权限(RLS)、Realtime 推送、注册审批、超时回收全部由控制面承担;worker 只发起出站连接,不开放任何入站端口。你可以从 **微信、Web 管理台或 agenthub CLI** 派发任务,由分布在任意机器上的 AI worker(Claude Agent SDK / Codex CLI / Claude Code CLI / 纯图形客户端 session)秒级领取执行,并回传进度、结果、产物文件与完整推理过程。

## 目录结构

- `supabase/`:表结构、RLS 策略、状态机触发器、调度 RPC、超时回收 cron、Edge Functions。
- `worker-cli/`:worker 运行时与 `agenthub` CLI(Realtime 领取、独立任务目录、安全参数数组)。
- `worker-sdk/`:Claude Agent SDK 执行器,与 CLI 执行器共用同一套注册与队列契约。
- `worker-session/`:给纯图形客户端机器用的 Claude Code skill(弹性 worker)+ Stop hook 兜底。
- `web/`:单管理员 React 管理台(看板 / 记录 / 发任务 / Agent 管理 / 事件流)。
- `channels/wechat/`:codex2wechat 集成——调度员 `AGENTS.md`、`channel-api` 契约、结果回推守护进程。

## 任务生命周期能力

- **结果协议**:worker 给每个任务 prompt 套上「不可信数据框架」和必须的 `===RESULT===` 结果块(`shared/prompt.ts`)。解析出的 summary/detail 写入 `tasks.result`;块内 `status: failure` 即判失败,即使执行器退出码为 0。可用 `executor.wrap_prompt = false` 按 worker 关闭。
- **实时进度**:CLI 执行器把最近输出行、SDK 执行器把助手的阶段性文本节流写入 `tasks.progress`(间隔由 `executor.progress_interval_seconds` 控制)。
- **取消传播**:在管理台或 `channel-api` 取消任务,会通过同一条 Realtime 通道让 worker 立即中止正在运行的执行进程。
- **Agent 暂停**:`agents.paused` 让 agent 保持在线心跳但不再被调度,管理台一键切换。
- **文件传递**:派发任务时可附输入文件(管理台上传,或 channel-api `prepare_upload` + 签名 PUT);worker 执行前把它们下载到工作区 `inputs/`,执行器写入 `outputs/` 的所有文件在任务结束时上传到私有 `task-files` bucket 并登记。产物可在任务抽屉下载,也会以签名链接推送到微信。
- **推理过程(transcript)**:两种执行器都把完整过程流式写入工作区 `transcript.log`(CLI 为原始 stdout/stderr,SDK 为逐消息 JSON 行、含工具调用),任务结束、超时或等待拍板时上传为 `<task_id>/log/transcript.log`——管理台抽屉「推理过程」区块原地渲染,记录页因此保留每个 session 的完整思路。
- **人工拍板(human-in-the-loop)**:执行器遇到只有任务所有者能定的决策时以 `===QUESTION===` 块结束;worker 记入 `task_interactions` 并把任务挂起为 `waiting_input`(释放并发额度、暂停超时回收)。你在管理台抽屉或微信答复(「答复 <id前缀> <决定>」→ channel-api `answer` → `answer_task` RPC)后,任务回到 `assigned` 并由同一个 agent 在同一工作目录带着完整问答历史续跑,支持多轮。

## 安全模型

- 每个 worker 拥有独立的 Supabase Auth 用户,只能读写指派给自己的任务行。
- Agent 对任务的更新同时受 RLS 与触发器约束(受保护字段不可改、状态只能沿合法路径迁移)。
- security-definer 函数对 `anon` 全部收回,逐一显式授权。
- 注册令牌只存 SHA-256 哈希,有有效期和使用次数上限。
- worker 凭证与配置为 owner-only 文件;prompt 通过 stdin 传递,绝不拼接进 shell 命令。
- worker 工作区统一收敛在一个根目录之下;服务运行在专用的非特权系统用户下。

## 构建

```bash
npm ci
npm run check
npm run build
```

## Supabase 部署

1. 创建一个 Supabase 托管项目。
2. `supabase link --project-ref <ref>` 关联仓库。
3. `supabase db push` 应用 `supabase/migrations/` 下的全部迁移。
4. 部署函数:

```bash
supabase functions deploy dispatch
supabase functions deploy admin
supabase functions deploy register --no-verify-jwt
supabase functions deploy poll
supabase functions deploy wechat-in --no-verify-jwt
supabase functions deploy wechat-out --no-verify-jwt
supabase functions deploy channel-api --no-verify-jwt
```

5. 按 `supabase/functions/.env.example` 配置函数密钥。
6. 用 Admin API 创建管理员 Auth 用户并设置 `app_metadata.role = admin`。service role key 绝不能进 Web 构建。
7. 把 `web/.env.example` 复制为 `web/.env.production`,只填项目 URL 和 publishable key,然后 `npm run build:web`。

## agenthub CLI

全局安装后,一条 `agenthub` 命令覆盖机器接入、配置和运维:

```bash
npm run build:node
npm i -g .            # 或 npm link,暴露 agenthub 命令
```

```bash
agenthub doctor                # 检测本机 node/claude/codex,给出服务建议
agenthub login                 # 交互式:Hub 地址、key、名称、标签、默认服务、模型、工作目录,然后注册
agenthub start                 # 启动 worker(长驻,领取并执行任务)
agenthub status                # 本机 agent 状态与最近任务
agenthub install-service       # 生成 systemd(Linux)/ launchd(macOS)守护单元
```

login 的核心选择是**默认执行服务**:`1)` Claude Agent SDK(推荐,内置运行时、无需外部 CLI)、`2)` Codex CLI、`3)` Claude Code CLI、`4)` 自定义命令。之后可随时用 `agenthub service <sdk|codex|claude>` 切换。

### 只有图形客户端的机器(Claude/Codex 桌面版,无 CLI)

如果一台机器只有图形客户端、跑不了 `agenthub`,用 **session worker**:在任一台有 `agenthub` 的机器上注册该 agent,运行 `agenthub session-init` 打印 `~/.claude/agent-hub.env` 内容,贴到图形客户端机器上,把 `worker-session/hub-worker` 放进 `~/.claude/skills/`,在客户端输入 `/hub-worker` 即上岗。会话内的 curl 循环用机器凭证登录并自行刷新 token。建议先跑 `agenthub doctor`——多数桌面客户端其实捆绑了 `claude`/`codex` 二进制,那样直接跑 `agenthub` 是更优路径。

配置在 `~/.config/agent-hub/worker.toml`(0600);审批通过后的机器凭证写入 `~/.config/agent-hub/credentials.json`。Supabase 会话自动刷新,worker 启动后无需重新登录即可长期在线。

- **持久工作目录**:`agenthub workspace ~/work`——每个任务在 `<工作目录>/<task_id>` 独立运行。
- **默认模型**:`agenthub model claude-opus-5`(SDK)或 codex/claude 的模型 id。
- **完整本机能力**:会话默认以 `permission_mode = bypassPermissions` 运行(SDK 直接用该模式,codex 用 `--dangerously-bypass-approvals-and-sandbox`,claude 用 `--dangerously-skip-permissions`),任务具备当前系统用户的 npm 等工具权限。可用 `agenthub config set executor.permission_mode acceptEdits` 收紧。
- **Prompt skills**:`agenthub skill list | show <名> | use <名> | new <名> | edit <名> | preview`。内置三个(`default` 通用、`coding` 工程、`research` 调研);自定义放 `~/.config/agent-hub/skills/*.md`,模板用 `{{TASK}}`、`{{CONTINUATION}}`、`{{PROTOCOL}}` 占位符(漏写协议块会自动补上,保证结果始终可解析)。选中的 skill 决定 agent 处理每个派发任务的框架。
- **任意配置项**:`agenthub config show` / `agenthub config set executor.reasoning high`。

### 两层权限模型

CLI 严格分为两个权限层,命令结构与权限边界一致:

| 层 | 命令 | 身份与能力边界 |
|---|---|---|
| **客户端(本机)** | `agenthub <命令>` | 用本机 agent 凭证。只能:注册/运行本机 worker、改本机配置(模型/skill/工作目录)、查看**指派给本机 agent 的任务**(`agenthub tasks`)。RLS 在数据库层强制,即使机器被攻破也拿不到别人的任务。 |
| **管理员(全局)** | `agenthub admin <命令>` | 需 `agenthub admin login`(`app_metadata.role=admin` 的 Supabase 用户)。等同 Web 管理台:全局派发/取消/拍板、审批/吊销/暂停任意 agent、生成注册令牌、全局事件流。 |

管理员身份先在 Supabase 控制台给该用户设置密码(Web 端走魔法链接,CLI 走邮箱+密码),然后:

```bash
agenthub admin login                       # refresh token 持久化在 ~/.config/agent-hub/admin.json
agenthub admin task list --status running  # 记录页:--status/--agent/--query/--limit 筛选
agenthub admin task show 3fa8              # 详情:指令/结果/问答/文件/时间线(id 前缀或标题关键词)
agenthub admin task create "跑一遍集成测试" --target agent:server-codex --file report.csv
agenthub admin task answer 3fa8 "低峰期执行"  # 拍板答复并恢复执行
agenthub admin task cancel 3fa8            # 实时中止 running 任务
agenthub admin task log 3fa8               # 打印推理过程 transcript
agenthub admin agents approve new-runner   # 审批注册;还有 revoke/remove/pause/resume/edit
agenthub admin token --minutes 120 --uses 3
agenthub admin events --follow             # 实时事件流
```

管理员身份与 worker 的 agent 凭证分开存储,同一台机器可以既跑 `agenthub start` 当 worker,又作为你的运维终端;不 `admin login` 的机器永远只有客户端权限。

## Worker 注册

在管理台生成一次性注册令牌,然后在 worker 机器上:

```bash
install -d -m 700 ~/.config/agent-hub
install -m 600 worker-cli/worker.toml.example ~/.config/agent-hub/worker.toml
npm run worker:cli -- register --config ~/.config/agent-hub/worker.toml --bootstrap-token '<token>'
```

命令会等待审批。管理员批准后,机器凭证以 0600 写入本地。随后安装并启动用户级服务:

```bash
./scripts/install-worker.sh ~/.config/agent-hub/worker.toml
systemctl --user enable --now agent-hub-worker.service
```

macOS 上注册完成后以 per-user LaunchAgent 方式安装:

```bash
./scripts/install-macos-worker.sh ~/.config/agent-hub/worker.toml
launchctl bootstrap "gui/$(id -u)" ~/Library/LaunchAgents/com.agent-hub.worker.plist
launchctl kickstart -k "gui/$(id -u)/com.agent-hub.worker"
launchctl print "gui/$(id -u)/com.agent-hub.worker"
```

## 运维检查

```bash
systemctl --user is-active agent-hub-worker.service
journalctl --user -u agent-hub-worker.service -n 100 --no-pager
```

`docs/verify/m1-transition.sql` 可做仅事务的迁移冒烟测试;`docs/verify/worker-health.sh` 可做带鉴权的 worker 心跳检查。
