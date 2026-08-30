import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { AgentRecord, EventRecord, InteractionRecord, TaskFileRecord, TaskRecord } from "../../shared/types.js";
import { expandHome } from "./config.js";

// Admin identity is separate from the worker's agent credential: it signs in as the Supabase
// admin user (app_metadata.role=admin) and persists only the refresh token, rotating it on use.

const adminFile = () => expandHome(process.env.AGENT_HUB_ADMIN_FILE ?? "~/.config/agent-hub/admin.json");

interface AdminSessionFile {
  hub_url: string;
  anon_key: string;
  email: string;
  refresh_token: string;
}

async function persist(session: AdminSessionFile): Promise<void> {
  const file = adminFile();
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}

export async function adminLogin(hubUrl: string, anonKey: string, email: string, password: string): Promise<void> {
  const client = createClient(hubUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`登录失败: ${error?.message ?? "no session"}`);
  if (data.session.user.app_metadata?.role !== "admin") throw new Error("该账号不是管理员 (app_metadata.role != admin)");
  await persist({ hub_url: hubUrl, anon_key: anonKey, email, refresh_token: data.session.refresh_token });
}

export async function adminClient(): Promise<{ client: SupabaseClient; email: string }> {
  let stored: AdminSessionFile;
  try {
    stored = JSON.parse(await readFile(adminFile(), "utf8")) as AdminSessionFile;
  } catch {
    throw new Error("尚未管理员登录。先运行: agenthub admin login");
  }
  const client = createClient(stored.hub_url, stored.anon_key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.refreshSession({ refresh_token: stored.refresh_token });
  if (error || !data.session) throw new Error(`管理员会话已失效,请重新 agenthub admin login (${error?.message ?? "no session"})`);
  await persist({ ...stored, refresh_token: data.session.refresh_token });
  return { client, email: stored.email };
}

// --- resolvers -------------------------------------------------------------

export async function resolveTask(client: SupabaseClient, ref: string): Promise<TaskRecord> {
  if (/^[0-9a-f-]{36}$/.test(ref)) {
    const { data, error } = await client.from("tasks").select("*").eq("id", ref).single();
    if (error) throw new Error(`task not found: ${ref}`);
    return data as TaskRecord;
  }
  const { data, error } = await client.from("tasks").select("*").order("created_at", { ascending: false }).limit(300);
  if (error) throw error;
  const matches = ((data ?? []) as TaskRecord[]).filter((task) => task.id.startsWith(ref) || task.title.includes(ref));
  if (matches.length === 1) return matches[0]!;
  if (!matches.length) throw new Error(`没有匹配 "${ref}" 的任务`);
  throw new Error(`"${ref}" 匹配到多个任务:\n${matches.slice(0, 8).map((task) => `  ${task.id.slice(0, 8)}  ${task.status.padEnd(13)} ${task.title}`).join("\n")}`);
}

export async function resolveAgent(client: SupabaseClient, ref: string): Promise<AgentRecord> {
  const { data, error } = await client.from("agents").select("*");
  if (error) throw error;
  const agents = (data ?? []) as AgentRecord[];
  const found = agents.find((agent) => agent.id === ref || agent.name === ref) ?? agents.filter((agent) => agent.name.startsWith(ref));
  const agent = Array.isArray(found) ? (found.length === 1 ? found[0] : undefined) : found;
  if (!agent) throw new Error(`没有唯一匹配 "${ref}" 的 agent`);
  return agent;
}

// --- queries ---------------------------------------------------------------

export interface TaskFilter {
  status?: string | undefined;
  agentId?: string | undefined;
  query?: string | undefined;
  limit: number;
}

export async function listTasks(client: SupabaseClient, filter: TaskFilter): Promise<TaskRecord[]> {
  let request = client.from("tasks").select("*").order("created_at", { ascending: false }).limit(filter.limit);
  if (filter.status) request = request.eq("status", filter.status);
  if (filter.agentId) request = request.eq("assigned_to", filter.agentId);
  if (filter.query) request = request.or(`title.ilike.%${filter.query}%,prompt.ilike.%${filter.query}%`);
  const { data, error } = await request;
  if (error) throw error;
  return (data ?? []) as TaskRecord[];
}

export async function taskDetail(client: SupabaseClient, taskId: string): Promise<{
  interactions: InteractionRecord[];
  files: TaskFileRecord[];
  events: EventRecord[];
}> {
  const [interactions, files, events] = await Promise.all([
    client.from("task_interactions").select("*").eq("task_id", taskId).order("asked_at"),
    client.from("task_files").select("*").eq("task_id", taskId).order("created_at"),
    client.from("events").select("*").eq("task_id", taskId).order("created_at").limit(100),
  ]);
  return {
    interactions: (interactions.data ?? []) as InteractionRecord[],
    files: (files.data ?? []) as TaskFileRecord[],
    events: (events.data ?? []) as EventRecord[],
  };
}

export interface CreateTaskInput {
  prompt: string;
  target: { type: "auto" } | { type: "agent"; name: string } | { type: "label"; labels: string[] };
  priority: number;
  timeoutMinutes: number;
  files: Array<{ name: string; data: Buffer }>;
}

export async function createTask(client: SupabaseClient, input: CreateTaskInput): Promise<string> {
  const taskId = crypto.randomUUID();
  const uploaded: Array<{ name: string; path: string; size: number }> = [];
  for (const file of input.files.slice(0, 20)) {
    const storagePath = `${taskId}/in/${file.name}`;
    const { error } = await client.storage.from("task-files").upload(storagePath, file.data, { upsert: true });
    if (error) throw new Error(`上传 ${file.name} 失败: ${error.message}`);
    uploaded.push({ name: file.name, path: storagePath, size: file.data.length });
  }
  const { error } = await client.from("tasks").insert({
    id: taskId,
    title: input.prompt.trim().split("\n")[0]!.slice(0, 100) || "新任务",
    prompt: input.prompt,
    source: "api",
    target: input.target,
    priority: input.priority,
    timeout_minutes: input.timeoutMinutes,
  });
  if (error) throw error;
  if (uploaded.length) {
    const { error: fileError } = await client.from("task_files").insert(uploaded.map((file) => ({ task_id: taskId, direction: "in", ...file })));
    if (fileError) throw new Error(`任务已创建,但登记附件失败: ${fileError.message}`);
  }
  return taskId;
}

export async function downloadTaskFile(client: SupabaseClient, file: TaskFileRecord): Promise<Buffer> {
  const { data, error } = await client.storage.from("task-files").download(file.path);
  if (error || !data) throw new Error(`下载失败: ${error?.message ?? "empty"}`);
  return Buffer.from(await data.arrayBuffer());
}
