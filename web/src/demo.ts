import type { Session } from "@supabase/supabase-js";
import type { AgentRecord, EventRecord, TaskRecord } from "../../shared/types";

const now = Date.now();
const iso = (offsetMinutes: number): string => new Date(now + offsetMinutes * 60_000).toISOString();

export const demoSession = { user: { app_metadata: { role: "admin" } } } as unknown as Session;

export const demoAgents: AgentRecord[] = [
  { id: "a1000000-0000-4000-8000-000000000001", name: "server-codex", labels: ["linux", "backend"], mode: "cli", status: "online", max_concurrency: 2, running_count: 1, last_heartbeat: iso(0), auth_user_id: "u1", created_at: iso(-1440) },
  { id: "a2000000-0000-4000-8000-000000000002", name: "mac-builder", labels: ["macos", "ios-build"], mode: "sdk", status: "offline", max_concurrency: 1, running_count: 0, last_heartbeat: iso(-25), auth_user_id: "u2", created_at: iso(-720) },
  { id: "a3000000-0000-4000-8000-000000000003", name: "new-runner", labels: ["linux"], mode: "session", status: "pending_approval", max_concurrency: 1, running_count: 0, last_heartbeat: null, auth_user_id: null, created_at: iso(-8) },
];

const baseTask = { source: "web" as const, source_msg_id: null, priority: 0, timeout_minutes: 60, retry_count: 0, result: null, finished_at: null };
export const demoTasks: TaskRecord[] = [
  { ...baseTask, id: "t1000000-0000-4000-8000-000000000001", title: "检查生产服务健康状态", prompt: "检查全部 systemd 服务并汇总异常。", target: { type: "auto" }, assigned_to: demoAgents[0]!.id, status: "running", progress: "正在读取服务日志", created_at: iso(-6), claimed_at: iso(-5) },
  { ...baseTask, id: "t2000000-0000-4000-8000-000000000002", title: "构建 iOS Release", prompt: "拉取主分支并构建 Release。", target: { type: "label", labels: ["ios-build"] }, assigned_to: demoAgents[1]!.id, status: "assigned", progress: "等待 Agent 领取", priority: 10, created_at: iso(-3), claimed_at: null },
  { ...baseTask, id: "t3000000-0000-4000-8000-000000000003", title: "整理本周故障记录", prompt: "整理事件并输出 Markdown。", target: { type: "auto" }, assigned_to: null, status: "pending", progress: null, created_at: iso(-1), claimed_at: null },
  { ...baseTask, id: "t4000000-0000-4000-8000-000000000004", title: "刷新依赖锁文件", prompt: "更新依赖并运行测试。", target: { type: "agent", name: "server-codex" }, assigned_to: demoAgents[0]!.id, status: "failed", progress: "Executor failed", result: "npm test returned exit code 1", created_at: iso(-40), claimed_at: iso(-39), finished_at: iso(-31) },
];

export const demoEvents: EventRecord[] = [
  { id: 3, task_id: demoTasks[0]!.id, agent_id: demoAgents[0]!.id, kind: "task.progress", payload: { progress: "正在读取服务日志" }, created_at: iso(-1) },
  { id: 2, task_id: demoTasks[1]!.id, agent_id: demoAgents[1]!.id, kind: "task.assigned", payload: { from: "pending", to: "assigned" }, created_at: iso(-3) },
  { id: 1, task_id: demoTasks[2]!.id, agent_id: null, kind: "task.created", payload: { source: "web", status: "pending" }, created_at: iso(-5) },
];
