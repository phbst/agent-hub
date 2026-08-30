# WeChat 渠道(codex2wechat 集成)

微信渠道由三部分组成,全部隔离在本目录与两个可选 Edge Function 中;删除它们不影响调度与 worker。

```
微信消息 → codex2wechat → Codex(读本目录的 AGENTS.md,当调度员)
             │                    │ curl channel-api(create/status/cancel)
             │                    ▼
             │              Supabase Agent Hub
             │                    │ events(done/failed/timeout/cancelled)
             ▼                    ▼
        微信回复  ←  notifier.mjs 轮询 channel-api events → 本地投递端点
```

## 1. Codex 调度员

在 codex2wechat 绑定的工作区放入本目录的 `AGENTS.md`,并创建凭证文件:

```bash
install -d -m 700 ~/.agent-hub
cat > ~/.agent-hub/channel.env <<'EOF'
HUB=https://PROJECT_REF.supabase.co
CHANNEL_SECRET=<CHANNEL_API_SECRET>
EOF
chmod 600 ~/.agent-hub/channel.env
```

codex2wechat 侧要求:该工作区使用 `sandbox: workspace-write`,且 `codex.networkAccess: true`,否则 Codex 无法访问 Hub。建议这台 Codex 只保留调度这一个工作区。

## 2. channel-api

`supabase/functions/channel-api` 是渠道的唯一接口,`x-channel-secret` 鉴权(`CHANNEL_API_SECRET`,未设置时回退 `WECHAT_CHANNEL_SECRET`)。动作:

| action | 参数 | 用途 |
|---|---|---|
| `create` | prompt, title?, target?, source?, source_msg_id?, priority?, timeout_minutes? | 建任务;source_msg_id 幂等去重 |
| `status` | task_id? / limit? | 单任务详情,或任务列表 + agents 概况 |
| `cancel` | task_id | 取消;运行中的任务会被 worker 实时中止 |
| `answer` | task_id 或 task_prefix, answer, via? | 答复 `waiting_input` 任务的拍板问题并恢复执行 |
| `prepare_upload` | files(文件名数组) | 生成 task_id + 每个输入文件的签名上传 URL |
| `files` | task_id, direction?(in/out/log) | 列出任务文件并返回 24h 签名下载链接 |
| `agents` | — | Agent 清单 |
| `events` | since_id, limit?, kinds? | 终态事件游标拉取(notifier 用) |

## 3. 结果回推 notifier

`notifier.mjs` 常驻在桥所在机器,按游标拉取终态事件并 POST `{"text","source_id"}` 到 `NOTIFY_URL`:

```bash
cat > ~/.agent-hub/notifier.env <<'EOF'
HUB=https://PROJECT_REF.supabase.co
CHANNEL_SECRET=<CHANNEL_API_SECRET>
NOTIFY_URL=http://127.0.0.1:18092/notify
NOTIFY_TOKEN=<notify token>
ADMIN_URL=https://your-dashboard.example
EOF
chmod 600 ~/.agent-hub/notifier.env
```

`NOTIFY_URL` 指向 codex2wechat 增加的回环 `/notify` 端点(内部调用其 `store.enqueueReply`,复用桥自带的持久 outbox、重试与 `source_id` 去重)。桥未打补丁前,可先指向任意 webhook,或不部署 notifier——用户在微信里发「状态」即可拉取进度。

systemd 安装:把 `deploy/agent-hub-notifier.service.in` 中的 `@NOTIFIER_PATH@` 替换为 `notifier.mjs` 的绝对路径,放到 `~/.config/systemd/user/agent-hub-notifier.service`,然后 `systemctl --user enable --now agent-hub-notifier`。

## 兼容说明

`wechat-in` / `wechat-out` 两个旧函数保留用于通用 webhook 形态;codex2wechat 集成只依赖 `channel-api`。
