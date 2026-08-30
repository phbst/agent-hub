import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { createClient } from "@supabase/supabase-js";
import { expandHome, loadConfig, type WorkerConfig } from "../config.js";
import { readCredentials } from "../credentials.js";
import { register } from "../registration.js";
import { Worker } from "../worker.js";
import { executeTask } from "../executor.js";
import { executeSdkTask } from "../../../worker-sdk/src/executor.js";
import { buildConfig, setValue, writeRaw } from "../settings.js";
import { acquireWorkerLock } from "../lock.js";
import type { CliContext, CommandDefinition } from "./context.js";
import { badge, bold, dim, heading, kv, note, ok } from "./ui.js";

function executorFor(config: WorkerConfig) {
  return config.agent.mode === "sdk" ? executeSdkTask : executeTask;
}

const services = {
  "1": { label: "Claude Agent SDK (推荐,内置运行时,无需外部 CLI)", mode: "sdk", kind: "sdk" },
  "2": { label: "Codex CLI (需本机已装 codex 并 codex login)", mode: "cli", kind: "codex" },
  "3": { label: "Claude Code CLI (需本机已装 claude 并登录)", mode: "cli", kind: "claude" },
  "4": { label: "自定义命令 (稍后在配置里填 executor.command / args)", mode: "cli", kind: "custom" },
} as const;
type Service = (typeof services)[keyof typeof services];

async function pickService(ctx: CliContext, fallback = "1"): Promise<Service> {
  ctx.out(bold("默认执行服务:"));
  for (const [key, svc] of Object.entries(services)) ctx.out(`  ${bold(key)}) ${svc.label}`);
  const choice = await ctx.ask("选择 1-4", fallback);
  return services[(choice in services ? choice : fallback) as keyof typeof services];
}

function detect(bin: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-c", `command -v ${bin}`], { stdio: ["ignore", "pipe", "ignore"] });
    let path = "";
    child.stdout.on("data", (chunk) => { path += chunk.toString(); });
    child.on("close", (code) => resolve(code === 0 ? path.trim() : null));
    child.on("error", () => resolve(null));
  });
}

export const machineCommands: CommandDefinition[] = [
  {
    name: "doctor",
    group: "机器",
    usage: "agenthub doctor",
    describe: "检测本机可用的执行器并给出建议",
    run: async (ctx) => {
      const [node, claude, codex] = await Promise.all([detect("node"), detect("claude"), detect("codex")]);
      ctx.out(bold("本机可用执行器检测"));
      ctx.out(kv([
        ["node", node ? ok(node) : dim("未找到")],
        ["claude", claude ? ok(claude) : dim("未找到")],
        ["codex", codex ? ok(codex) : dim("未找到")],
      ]));
      ctx.out("");
      if (node) {
        ctx.out("→ 建议:用 SDK 模式(agenthub login 选 1),无需外部 CLI,最稳。");
        if (codex) ctx.out(note("  也可用 Codex CLI: agenthub service codex"));
        if (claude) ctx.out(note("  也可用 Claude CLI: agenthub service claude"));
      } else {
        ctx.out("→ 本机没有 Node,无法运行 agenthub。若只有图形客户端,改用 session 形态:");
        ctx.out(note("  在有 agenthub 的机器上注册该 agent 后运行 agenthub session-init 生成 env。"));
      }
    },
  },
  {
    name: "login",
    group: "机器",
    usage: "agenthub login",
    describe: "交互式配置并注册本机 worker",
    run: async (ctx) => {
      ctx.out(note("配置 Agent Hub worker。回车接受默认值。\n"));
      const hubUrl = await ctx.ask("Hub URL (https://<ref>.supabase.co)");
      if (!hubUrl) ctx.fail("Hub URL is required");
      const anonKey = await ctx.ask("Publishable / anon key");
      if (!anonKey) ctx.fail("anon key is required");
      const name = await ctx.ask("Agent 名称 (a-z0-9-_)", "worker-1");
      const labels = (await ctx.ask("标签 (逗号分隔)", "linux")).split(",").map((s) => s.trim()).filter(Boolean);
      const service = await pickService(ctx);
      const modelDefault = service.kind === "codex" ? "gpt-5.6-sol" : service.kind === "custom" ? "" : "claude-fable-5";
      const model = await ctx.ask("默认模型 (留空用服务默认)", modelDefault);
      const maxConcurrency = Number(await ctx.ask("最大并发", "2")) || 2;
      const workspaceRoot = await ctx.ask("工作目录", "~/agent-hub-workspaces");

      const raw = buildConfig({ hubUrl, anonKey, name, labels, mode: service.mode, maxConcurrency, workspaceRoot, executorKind: service.kind, model: model || undefined });
      await writeRaw(ctx.configPath, raw);
      ctx.out(ok(`已写入配置 ${ctx.configPath}`));
      ctx.out(dim(`服务 ${service.kind} · 模型 ${model || "默认"} · 并发 ${maxConcurrency}`));

      const token = ctx.flags.get("bootstrap-token") ?? (await ctx.ask("Bootstrap token (管理台生成,可留空)"));
      if (!token) {
        ctx.out(note("未提供 token。稍后运行: agenthub register --bootstrap-token <token>"));
        return;
      }
      await register(await loadConfig(ctx.configPath), token);
    },
  },
  {
    name: "register",
    group: "机器",
    usage: "agenthub register --bootstrap-token <t>",
    describe: "用管理台令牌注册 / 上线",
    run: async (ctx) => {
      const token = ctx.flags.get("bootstrap-token") ?? process.env.AGENT_HUB_BOOTSTRAP_TOKEN;
      if (!token) ctx.fail("register requires --bootstrap-token");
      await register(await loadConfig(ctx.configPath), token!);
    },
  },
  {
    name: "start",
    group: "机器",
    usage: "agenthub start",
    describe: "启动 worker(长驻,领取并执行任务)",
    run: async (ctx) => {
      const config = await loadConfig(ctx.configPath);
      const releaseLock = await acquireWorkerLock(ctx.configPath);
      const worker = new Worker(config, await readCredentials(config.hub.credentials_file), executorFor(config));
      await worker.start();
      ctx.out(ok(`worker 已启动 · ${bold(config.agent.name)}`));
      ctx.out(dim(`模式 ${config.agent.mode} · 模型 ${config.executor.model ?? "默认"} · skill ${config.executor.skill ?? "内置 default"}`));
      await new Promise<void>((resolve) => {
        let stopping = false;
        const stop = async () => { if (stopping) return; stopping = true; try { await worker.stop(); } finally { await releaseLock(); resolve(); } };
        process.once("SIGINT", () => void stop());
        process.once("SIGTERM", () => void stop());
      });
      process.exit(0);
    },
  },
  {
    name: "status",
    group: "机器",
    usage: "agenthub status",
    describe: "查看本机 agent 与最近任务",
    run: async (ctx) => {
      const config = await loadConfig(ctx.configPath);
      const creds = await readCredentials(config.hub.credentials_file);
      const client = createClient(config.hub.url, config.hub.anon_key, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error: signInError } = await client.auth.signInWithPassword({ email: creds.email, password: creds.password });
      if (signInError) ctx.fail(`认证失败: ${signInError.message}`);
      const { data: agent } = await client.from("agents").select("*").eq("id", creds.agent_id).single();
      const { data: tasks } = await client.from("tasks").select("id,title,status,progress").eq("assigned_to", creds.agent_id).order("created_at", { ascending: false }).limit(10);
      ctx.out(kv([
        ["Agent", `${bold(agent?.name ?? "?")}  ${badge(agent?.status ?? "?")}${agent?.paused ? dim("  已暂停") : ""}`],
        ["负载", `${agent?.running_count}/${agent?.max_concurrency}`],
        ["标签", (agent?.labels ?? []).join(", ") || dim("无")],
        ["执行", `${config.agent.mode} · ${config.executor.model ?? "默认模型"} · skill ${config.executor.skill ?? "内置 default"}`],
        ["工作目录", config.agent.workspace_root],
      ]));
      ctx.out(heading(`最近任务 (${tasks?.length ?? 0})`));
      for (const task of tasks ?? []) ctx.out(`  ${badge(task.status)}  ${task.title}${task.progress ? dim(` — ${task.progress}`) : ""}`);
      if (!tasks?.length) ctx.out(dim("  (无)"));
    },
  },
  {
    name: "tasks",
    group: "机器",
    usage: "agenthub tasks [--status running] [--limit 20]",
    describe: "查看指派给本机 agent 的任务(仅本机权限)",
    run: async (ctx) => {
      const config = await loadConfig(ctx.configPath);
      const creds = await readCredentials(config.hub.credentials_file);
      const client = createClient(config.hub.url, config.hub.anon_key, { auth: { persistSession: false, autoRefreshToken: false } });
      const { error: signInError } = await client.auth.signInWithPassword({ email: creds.email, password: creds.password });
      if (signInError) ctx.fail(`认证失败: ${signInError.message}`);
      let request = client.from("tasks").select("id,title,status,progress,created_at")
        .eq("assigned_to", creds.agent_id).order("created_at", { ascending: false })
        .limit(Number(ctx.flags.get("limit") ?? 20) || 20);
      if (ctx.flags.get("status")) request = request.eq("status", ctx.flags.get("status")!);
      const { data, error } = await request;
      if (error) throw error;
      if (!data?.length) { ctx.out(dim("(本机 agent 没有匹配的任务)")); return; }
      for (const task of data) ctx.out(`${dim(task.id.slice(0, 8))}  ${badge(task.status)}  ${task.title}${task.progress ? dim(` — ${task.progress}`) : ""}`);
    },
  },
  {
    name: "logout",
    group: "机器",
    usage: "agenthub logout",
    describe: "删除本机 worker 凭证",
    run: async (ctx) => {
      const config = await loadConfig(ctx.configPath).catch(() => null);
      if (config) await rm(config.hub.credentials_file, { force: true });
      ctx.out(ok("已删除本机凭证。重新上线: agenthub register --bootstrap-token <token>"));
    },
  },
  {
    name: "session-init",
    group: "机器",
    usage: "agenthub session-init",
    describe: "为纯图形客户端机器生成 hub-worker 的 env",
    run: async (ctx) => {
      const config = await loadConfig(ctx.configPath);
      const creds = await readCredentials(config.hub.credentials_file);
      ctx.out(note("# 保存到图形客户端机器的 ~/.claude/agent-hub.env (chmod 600),"));
      ctx.out(note("# 并把 worker-session/hub-worker 放到 ~/.claude/skills/,在客户端输入 /hub-worker 上岗。\n"));
      ctx.out(`AGENT_HUB_URL=${config.hub.url}`);
      ctx.out(`AGENT_HUB_ANON_KEY=${config.hub.anon_key}`);
      ctx.out(`AGENT_HUB_AGENT_ID=${creds.agent_id}`);
      ctx.out(`AGENT_HUB_EMAIL=${creds.email}`);
      ctx.out(`AGENT_HUB_PASSWORD=${creds.password}`);
      ctx.out(`AGENT_HUB_WORKSPACE_ROOT=${config.agent.workspace_root}`);
      ctx.out(`MAX_PARALLEL=${config.agent.max_concurrency}`);
    },
  },
  {
    name: "install-service",
    group: "机器",
    usage: "agenthub install-service",
    describe: "生成 systemd / launchd 守护单元",
    run: async (ctx) => {
      const resolved = expandHome(ctx.configPath);
      const nodePath = process.execPath;
      const cliPath = new URL("../cli.js", import.meta.url).pathname;
      if (process.platform === "darwin") {
        ctx.out(note("# 保存为 ~/Library/LaunchAgents/com.agent-hub.worker.plist 后:"));
        ctx.out(note("# launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agent-hub.worker.plist\n"));
        ctx.out(`<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>\n  <key>Label</key><string>com.agent-hub.worker</string>\n  <key>ProgramArguments</key><array><string>${nodePath}</string><string>${cliPath}</string><string>start</string><string>--config</string><string>${resolved}</string></array>\n  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n</dict></plist>`);
      } else {
        ctx.out(note("# 保存为 ~/.config/systemd/user/agent-hub-worker.service 后:"));
        ctx.out(note("# systemctl --user enable --now agent-hub-worker.service\n"));
        ctx.out(`[Unit]\nDescription=Agent Hub worker\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nExecStart=${nodePath} ${cliPath} start --config ${resolved}\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target`);
      }
    },
  },
];

export { services, pickService };
