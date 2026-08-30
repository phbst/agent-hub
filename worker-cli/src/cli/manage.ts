import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { expandHome, loadConfig } from "../config.js";
import {
  adminClient, adminLogin, createTask, downloadTaskFile, listTasks,
  resolveAgent, resolveTask, taskDetail,
} from "../admin.js";
import type { CliContext, CommandDefinition } from "./context.js";
import { badge, bold, dim, heading, kv, note, ok, table } from "./ui.js";

const shortId = (id: string) => id.slice(0, 8);
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "-");
const kb = (size: number | null) => (size ? `${Math.ceil(size / 1024)} KB` : "");

async function taskCommand(ctx: CliContext): Promise<void> {
  const sub = ctx.positional[1] ?? "list";
  const { client } = await adminClient();

  if (sub === "list") {
    const agentId = ctx.flags.get("agent") ? (await resolveAgent(client, ctx.flags.get("agent")!)).id : undefined;
    const tasks = await listTasks(client, {
      status: ctx.flags.get("status"),
      agentId,
      query: ctx.flags.get("query"),
      limit: Number(ctx.flags.get("limit") ?? 30) || 30,
    });
    if (!tasks.length) { ctx.out(dim("(没有匹配的任务)")); return; }
    ctx.out(table(
      [{ header: "ID" }, { header: "状态" }, { header: "P" }, { header: "创建" }, { header: "标题", max: 44 }],
      tasks.map((task) => [dim(shortId(task.id)), badge(task.status), String(task.priority), dim(when(task.created_at)), task.title]),
    ));
    return;
  }

  if (sub === "create") {
    const promptText = ctx.flags.get("prompt") ?? ctx.positional.slice(2).join(" ");
    if (!promptText) ctx.fail('用法: agenthub admin task create "<描述>" [--target agent:x|label:a,b] [--priority N] [--timeout 分钟] [--file p]...');
    const targetFlag = ctx.flags.get("target") ?? "auto";
    const target = targetFlag.startsWith("agent:")
      ? { type: "agent" as const, name: targetFlag.slice(6) }
      : targetFlag.startsWith("label:")
        ? { type: "label" as const, labels: targetFlag.slice(6).split(",").map((s) => s.trim()).filter(Boolean) }
        : { type: "auto" as const };
    const files = await Promise.all(ctx.flagAll("file").map(async (filePath) => ({
      name: path.basename(filePath),
      data: Buffer.from(await readFile(expandHome(filePath))),
    })));
    const taskId = await createTask(client, {
      prompt: promptText,
      target,
      priority: Number(ctx.flags.get("priority") ?? 0) || 0,
      timeoutMinutes: Number(ctx.flags.get("timeout") ?? 60) || 60,
      files,
    });
    ctx.out(ok(`已派发 ${bold(`#${shortId(taskId)}`)} → ${targetFlag}${files.length ? dim(` · 附件 ${files.length} 个`) : ""}`));
    return;
  }

  const ref = ctx.positional[2];
  if (!ref) ctx.fail(`用法: agenthub admin task ${sub} <id前缀|标题关键词>`);
  const task = await resolveTask(client, ref!);

  if (sub === "show") {
    const { interactions, files, events } = await taskDetail(client, task.id);
    ctx.out(`${badge(task.status)}  ${bold(task.title)}  ${dim(`#${shortId(task.id)}`)}`);
    ctx.out(kv([
      ["目标", JSON.stringify(task.target)],
      ["优先级", `${task.priority}`],
      ["超时", `${task.timeout_minutes} 分钟`],
      ["重试", `${task.retry_count}`],
      ["创建", when(task.created_at)],
      ["结束", when(task.finished_at)],
      ...(task.progress ? [["进度", task.progress] as [string, string]] : []),
    ]));
    ctx.out(heading("指令"));
    ctx.out(task.prompt);
    if (interactions.length) {
      ctx.out(heading("问答"));
      for (const item of interactions) ctx.out(`${dim("问:")} ${item.question}\n${dim(`答(${item.answered_via ?? "待答复"}):`)} ${item.answer ?? dim("<等待中>")}`);
    }
    ctx.out(heading("结果"));
    ctx.out(task.result ?? dim("尚无结果"));
    if (files.length) {
      ctx.out(heading("文件"));
      for (const file of files) ctx.out(`  ${dim(`[${file.direction}]`)} ${file.name} ${dim(kb(file.size))}`);
    }
    if (events.length) {
      ctx.out(heading("时间线"));
      for (const event of events) ctx.out(`  ${dim(when(event.created_at))}  ${event.kind}${typeof event.payload.progress === "string" ? dim(`  ${event.payload.progress}`) : ""}`);
    }
    return;
  }
  if (sub === "cancel") {
    const { error } = await client.from("tasks").update({ status: "cancelled" }).eq("id", task.id);
    if (error) throw error;
    ctx.out(ok(`已取消 #${shortId(task.id)} ${task.title}`));
    return;
  }
  if (sub === "retry") {
    const { error } = await client.from("tasks").insert({ title: task.title, prompt: task.prompt, source: "api", target: task.target, priority: task.priority, timeout_minutes: task.timeout_minutes });
    if (error) throw error;
    ctx.out(ok(`已作为新任务重新派发: ${task.title}`));
    return;
  }
  if (sub === "answer") {
    const answer = ctx.positional.slice(3).join(" ") || ctx.flags.get("text");
    if (!answer) ctx.fail("用法: agenthub admin task answer <id前缀> <答复内容>");
    const { error } = await client.rpc("answer_task", { p_task_id: task.id, p_answer: answer, p_via: "api" });
    if (error) throw error;
    ctx.out(ok(`已答复 #${shortId(task.id)},任务恢复执行`));
    return;
  }
  if (sub === "files" || sub === "log") {
    const { files } = await taskDetail(client, task.id);
    const wanted = sub === "log" ? files.filter((file) => file.direction === "log") : files;
    if (!wanted.length) { ctx.out(dim(sub === "log" ? "该任务还没有执行记录" : "该任务没有文件")); return; }
    const pick = ctx.flags.get("download") ?? (sub === "log" ? wanted[0]!.name : undefined);
    if (!pick) {
      for (const file of wanted) ctx.out(`  ${dim(`[${file.direction}]`)} ${file.name} ${dim(kb(file.size))}`);
      ctx.out(note("\n下载: agenthub admin task files <id> --download <name> [--out 目录]"));
      return;
    }
    const file = wanted.find((item) => item.name === pick);
    if (!file) ctx.fail(`文件不存在: ${pick}`);
    const data = await downloadTaskFile(client, file!);
    if (sub === "log" && !ctx.flags.get("out")) { ctx.out(data.toString("utf8")); return; }
    const dest = path.join(expandHome(ctx.flags.get("out") ?? "."), path.basename(file!.name));
    await writeFile(dest, data);
    ctx.out(ok(`已保存 ${dest} (${kb(data.length)})`));
    return;
  }
  ctx.fail(`未知 task 子命令: ${sub}`);
}

async function agentsCommand(ctx: CliContext): Promise<void> {
  const sub = ctx.positional[1] ?? "list";
  const { client } = await adminClient();
  if (sub === "list") {
    const { data, error } = await client.from("agents").select("*").order("name");
    if (error) throw error;
    ctx.out(table(
      [{ header: "AGENT" }, { header: "状态" }, { header: "模式" }, { header: "负载" }, { header: "心跳" }, { header: "标签", max: 30 }],
      (data ?? []).map((agent) => {
        const live = agent.status === "online" && Date.now() - new Date(agent.last_heartbeat ?? 0).getTime() < 90_000;
        return [
          bold(agent.name),
          badge(live ? "online" : agent.status) + (agent.paused ? dim(" 暂停") : ""),
          agent.mode,
          `${agent.running_count}/${agent.max_concurrency}`,
          dim(agent.last_heartbeat ? when(agent.last_heartbeat) : "从未"),
          (agent.labels ?? []).join(",") || dim("无"),
        ];
      }),
    ));
    return;
  }
  const ref = ctx.positional[2];
  if (!ref) ctx.fail(`用法: agenthub admin agents ${sub} <name>`);
  const agent = await resolveAgent(client, ref!);
  if (sub === "approve" || sub === "revoke") {
    const { error } = await client.functions.invoke("admin", { body: { action: sub, agent_id: agent.id } });
    if (error) throw new Error(error.message);
    ctx.out(ok(`${sub === "approve" ? "已批准" : "已吊销"} ${agent.name}`));
    return;
  }
  if (sub === "pause" || sub === "resume") {
    const { error } = await client.from("agents").update({ paused: sub === "pause" }).eq("id", agent.id);
    if (error) throw error;
    ctx.out(ok(`${agent.name} ${sub === "pause" ? "已暂停派发" : "已恢复派发"}`));
    return;
  }
  if (sub === "edit") {
    const patch: Record<string, unknown> = {};
    if (ctx.flags.get("labels")) patch.labels = ctx.flags.get("labels")!.split(",").map((s) => s.trim()).filter(Boolean);
    if (ctx.flags.get("concurrency")) patch.max_concurrency = Number(ctx.flags.get("concurrency"));
    if (!Object.keys(patch).length) ctx.fail("用法: agenthub admin agents edit <name> --labels a,b --concurrency N");
    const { error } = await client.from("agents").update(patch).eq("id", agent.id);
    if (error) throw error;
    ctx.out(ok(`已更新 ${agent.name}: ${JSON.stringify(patch)}`));
    return;
  }
  ctx.fail(`未知 agents 子命令: ${sub}`);
}

interface EventRow { task_id: string | null; agent_id: string | null; kind: string; created_at: string; payload: Record<string, unknown> }

async function tokenCommand(ctx: CliContext): Promise<void> {
  const { client } = await adminClient();
  const { data, error } = await client.functions.invoke("admin", {
    body: { action: "bootstrap", minutes: Number(ctx.flags.get("minutes") ?? 60) || 60, uses: Number(ctx.flags.get("uses") ?? 1) || 1 },
  });
  if (error) throw new Error(error.message);
  ctx.out(bold(data.token));
  ctx.out(note(`有效至 ${data.expires_at} · 可用 ${data.uses} 次`));
}

async function eventsCommand(ctx: CliContext): Promise<void> {
  const { client } = await adminClient();
  const limit = Number(ctx.flags.get("limit") ?? 30) || 30;
  const { data, error } = await client.from("events").select("*, tasks(title), agents(name)").order("id", { ascending: false }).limit(limit);
  if (error) throw error;
  const print = (event: Record<string, unknown>) => {
    const task = (event.tasks as { title?: string } | null)?.title ?? "";
    const agent = (event.agents as { name?: string } | null)?.name ?? "";
    ctx.out(`${dim(when(event.created_at as string))}  ${badge(String(event.kind).replace(/^task\./, ""))}  ${agent}  ${dim(task)}`);
  };
  for (const event of (data ?? []).reverse()) print(event as Record<string, unknown>);
  if (!ctx.flags.get("follow")) return;
  ctx.out(note("\n(实时跟踪中,Ctrl+C 退出)"));
  client.channel("cli-events").on("postgres_changes", { event: "INSERT", schema: "public", table: "events" }, async (payload) => {
    const row = payload.new as EventRow;
    const [task, agent] = await Promise.all([
      row.task_id ? client.from("tasks").select("title").eq("id", row.task_id).single() : Promise.resolve({ data: null }),
      row.agent_id ? client.from("agents").select("name").eq("id", row.agent_id).single() : Promise.resolve({ data: null }),
    ]);
    print({ ...row, tasks: task.data, agents: agent.data });
  }).subscribe();
  await new Promise(() => { /* until Ctrl+C */ });
}

// All hub-wide operations live under `agenthub admin …` — they act on every agent and task, and
// require the separate administrator identity. Machine-level commands never gain this scope.
export const manageCommands: CommandDefinition[] = [
  {
    name: "admin",
    group: "管理",
    usage: "agenthub admin <login|logout|whoami|task|agents|token|events> …",
    describe: "超级管理员:全局任务 / 所有 Agent / 令牌 / 事件(=Web 管理台)",
    run: async (ctx) => {
      const sub = ctx.positional[1] ?? "whoami";
      const shifted = { ...ctx, positional: ctx.positional.slice(1) };
      if (sub === "task") return taskCommand(shifted);
      if (sub === "agents") return agentsCommand(shifted);
      if (sub === "token") return tokenCommand(ctx);
      if (sub === "events") return eventsCommand(ctx);
      if (sub === "login") {
        const config = await loadConfig(ctx.configPath).catch(() => null);
        const hubUrl = ctx.flags.get("url") ?? config?.hub.url ?? (await ctx.ask("Hub URL"));
        const anonKey = ctx.flags.get("key") ?? config?.hub.anon_key ?? (await ctx.ask("anon key"));
        const email = ctx.flags.get("email") ?? (await ctx.ask("管理员邮箱"));
        const password = ctx.flags.get("password") ?? (await ctx.ask("密码"));
        await adminLogin(hubUrl, anonKey, email, password);
        ctx.out(ok(`管理员已登录: ${email}`));
        return;
      }
      if (sub === "logout") {
        await rm(expandHome("~/.config/agent-hub/admin.json"), { force: true });
        ctx.out(ok("已退出管理员登录。"));
        return;
      }
      if (sub === "whoami") {
        const { email } = await adminClient();
        ctx.out(`管理员: ${bold(email)}`);
        return;
      }
      ctx.fail(`未知 admin 子命令: ${sub}(可用 login|logout|whoami|task|agents|token|events)`);
    },
  },
];
