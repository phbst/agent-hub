# Agent Hub V2 架构蓝图

> 重构合同:每一期独立可交付、可回滚,生产系统在任何时刻保持可用。
> 原则:数据面与 worker 契约是资产,保留;暴露面与体验层是负债,重建。

## 0. 现状评估:保留什么、重建什么

**保留(已是正确架构,推倒是纯损耗):**
- Supabase 数据面:tasks/agents/events/task_interactions/task_files 表、RLS 行级权限、状态机触发器、超时回收 cron、Realtime 推送。队列语义经过生产验证。
- Worker 行为契约:注册审批 → 心跳 → Realtime 领取 → 独立工作目录 → inputs/outputs 文件约定 → RESULT/QUESTION 协议 → transcript。三种形态(SDK/CLI/session)不变。
- CLI 命令注册表架构与两层权限模型(客户端/管理员)。

**重建(V2 的主体):**
1. **身份层**:邮箱魔法链接 → Google 登录(+ 管理员白名单)。
2. **暴露面**:浏览器直连 Supabase + Edge Functions → 统一 API 网关(自有域名、自建后端)。
3. **Web**:单文件 SPA → 路由化、组件化、可视化增强的 v2 前端,同域调用网关。
4. **渠道**:channel-api Edge Function → 网关内模块(同一进程、同一审计日志)。

## 1. 目标拓扑

```
                     https://hub.<你的域名>
                              │
                    ┌─────────▼──────────┐
   浏览器(Web v2) ──▶│   Gateway 网关      │◀── wechat2codex(渠道密钥)
   agenthub CLI  ──▶│  Hono + TS, 部署于  │◀── worker(兼容期仍可直连 Supabase)
                    │  你的 VPS, Caddy TLS│
                    └─────────┬──────────┘
                              │ service key(只存在于网关)
                    ┌─────────▼──────────┐
                    │ Supabase 数据面     │  Postgres + RLS + Realtime + Storage
                    └────────────────────┘
```

- **单一入口**:`hub.<domain>` 承载 Web 静态资源 + `/api/*` + `/events`(SSE)。浏览器不再持有任何 Supabase key。
- **worker 通道不变**:worker 继续 outbound 直连 Supabase(Realtime 推送是刚需);V2.5 可选切到网关 WS。

## 2. 身份与安全模型 V2

| 主体 | 凭证 | 说明 |
|---|---|---|
| 管理员(人) | Google OAuth → 网关会话 cookie(httpOnly+Secure+SameSite=Lax) | 邮箱白名单 `ADMIN_EMAILS`;非白名单 Google 账号登录后无任何权限 |
| 渠道(wechat 等) | 渠道密钥(网关签发,可多把、可吊销、带审计标签) | 只能 create/status/cancel/answer/files |
| worker | 机器凭证(现有 Supabase Auth 用户,RLS 限权) | 不变 |

安全升级点:
- service key 从 Edge Functions 环境收敛到网关一处;网关出站仅 Supabase。
- 所有管理写操作走同域 API + CSRF token;登录会话可查看/踢出。
- 审计:网关为每个写操作落 events(含操作者身份),替代目前散落的触发器审计。
- 速率限制与请求体上限在网关统一实施。

## 3. 仓库结构 V2

```
agent-hub/
├─ shared/            # 类型、状态机、协议、skills(现状保留)
├─ supabase/          # 迁移与数据面(现状保留;Edge Functions 进入退役期)
├─ gateway/           # ★新:Hono API 网关
│  ├─ src/auth/       #   Google OAuth 回调、会话、白名单、CSRF
│  ├─ src/api/        #   tasks/agents/tokens/files/interactions REST
│  ├─ src/channel/    #   渠道端点(原 channel-api 语义)
│  ├─ src/events/     #   SSE 聚合(订阅 Supabase Realtime → 推给浏览器)
│  └─ deploy/         #   systemd unit + Caddyfile(自动 TLS)
├─ web/               # ★重建:React Router + 设计系统 + 同域 API client
├─ worker-cli/        # 现状保留(仅 API base 可配置化)
├─ worker-sdk/        # 现状保留
└─ worker-session/    # 现状保留
```

## 4. 分期计划(每期可独立上线/回滚)

| 期 | 内容 | 依赖 | 回滚方式 |
|---|---|---|---|
| **P0(已完成)** | Web 增加 Google 登录按钮(与魔法链接并存) | Supabase 开启 Google Provider(需 GCP OAuth Client) | 按钮无副作用 |
| **P1** | 网关 MVP:auth + tasks/agents 只读 + SSE;部署 VPS + Caddy + 域名;Web 指向网关 | **域名**、GCP OAuth | DNS 切回 Pages 即回滚 |
| **P2** | 管理写操作迁入网关(派发/取消/答复/审批/令牌/文件);Web v2 前端重建 | P1 | 旧 Pages 站保留为回滚入口 |
| **P3** | 渠道迁入网关,签发多把渠道密钥;退役 wechat-in/out、channel-api、admin 函数 | P2 | Edge Functions 保留但停用 |
| **P4(可选)** | worker 切网关 WS;CLI admin 走网关;退役剩余函数 | P3 | worker 配置回切 |

## 5. 阻塞项(需要用户提供)

1. **域名**:哪个域名/子域(如 `hub.example.com`)?DNS 解析到 VPS `12.219.11.201`(或 Cloudflare 代理)。
2. **Google OAuth Client**:GCP Console → APIs & Services → Credentials → OAuth client(Web),
   回调地址 `https://szeppeuewmjtubvqnxup.supabase.co/auth/v1/callback`(P1 后加网关回调);
   把 client id/secret 填入 Supabase Dashboard → Auth → Providers → Google。
3. 管理员 Google 邮箱白名单(首个 Google 登录用户需设 `app_metadata.role=admin`)。

## 6. 明确不做

- 不迁移数据库(Supabase Postgres 保留,自建 PG 无收益有运维债)。
- 不做多租户;不引入 K8s/消息中间件;worker 契约不破坏性变更。
