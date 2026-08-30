import type { Session } from "@supabase/supabase-js";
import { Activity, Bot, CirclePlus, Clipboard, History, ListTodo, LogOut, Radio, RefreshCw, Send, ShieldCheck, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentRecord, EventRecord, InteractionRecord, TaskFileRecord, TaskRecord, TaskStatus, TaskTarget } from "../../shared/types";
import { demoAgents, demoEvents, demoSession, demoTasks } from "./demo";
import { configured, supabase } from "./supabase";

type View = "tasks" | "history" | "create" | "agents" | "events";
const columns: TaskStatus[] = ["pending", "assigned", "claimed", "running", "waiting_input", "done", "failed", "timeout", "cancelled"];
const activeColumns: TaskStatus[] = ["pending", "assigned", "claimed", "running", "waiting_input", "failed"];
const terminalStatuses: TaskStatus[] = ["done", "failed", "timeout", "cancelled"];
const demo = import.meta.env.DEV && new URLSearchParams(window.location.search).has("demo");

function loginRedirectUrl(): string {
  return new URL(window.location.pathname, window.location.origin).toString();
}

function age(timestamp: string | null): string {
  if (!timestamp) return "从未";
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(timestamp).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function Login(): React.ReactElement {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: loginRedirectUrl() } });
    setMessage(error ? error.message : "登录链接已发送，请检查邮箱。");
  };
  return <main className="login-shell"><section className="login-panel"><div className="brand-mark"><ShieldCheck size={22} /> Agent Hub</div><h1>管理员登录</h1><p>使用白名单邮箱接收一次性登录链接。</p><form onSubmit={submit}><label>邮箱<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" /></label><button type="submit"><Send size={17} />发送登录链接</button></form>{message && <div className="notice">{message}</div>}</section></main>;
}

export function App(): React.ReactElement {
  const [session, setSession] = useState<Session | null>(demo ? demoSession : null);
  const [view, setView] = useState<View>("tasks");
  const [tasks, setTasks] = useState<TaskRecord[]>(demo ? demoTasks : []);
  const [agents, setAgents] = useState<AgentRecord[]>(demo ? demoAgents : []);
  const [events, setEvents] = useState<EventRecord[]>(demo ? demoEvents : []);
  const [selected, setSelected] = useState<TaskRecord | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    if (demo) return;
    const [taskResult, agentResult, eventResult] = await Promise.all([
      supabase.from("tasks").select("*").order("created_at", { ascending: false }).limit(300),
      supabase.from("agents").select("*").order("name"),
      supabase.from("events").select("*").order("created_at", { ascending: false }).limit(200),
    ]);
    const firstError = taskResult.error ?? agentResult.error ?? eventResult.error;
    if (firstError) setError(firstError.message);
    else {
      setTasks((taskResult.data ?? []) as TaskRecord[]);
      setAgents((agentResult.data ?? []) as AgentRecord[]);
      setEvents((eventResult.data ?? []) as EventRecord[]);
      setError("");
    }
  }, []);

  useEffect(() => {
    if (demo) return;
    void supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (demo || !session) return;
    void load();
    const channel = supabase.channel("admin-live")
      .on("postgres_changes", { event: "*", schema: "public", table: "tasks" }, () => void load())
      .on("postgres_changes", { event: "*", schema: "public", table: "agents" }, () => void load())
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "events" }, () => void load())
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [session, load]);

  if (!configured && !demo) return <main className="login-shell"><section className="login-panel"><div className="brand-mark"><ShieldCheck size={22} /> Agent Hub</div><h1>等待 Supabase 配置</h1><p>服务器端页面已部署，但尚未注入项目 URL 和 publishable key。</p></section></main>;
  if (!session) return <Login />;
  if (session.user.app_metadata?.role !== "admin") return <main className="login-shell"><section className="login-panel"><h1>没有管理员权限</h1><p>该账号未设置 app_metadata.role=admin。</p><button onClick={() => void supabase.auth.signOut()}><LogOut size={17} />退出</button></section></main>;

  const navigation: Array<{ id: View; label: string; icon: React.ReactNode }> = [
    { id: "tasks", label: "任务", icon: <ListTodo size={18} /> },
    { id: "history", label: "记录", icon: <History size={18} /> },
    { id: "create", label: "发任务", icon: <CirclePlus size={18} /> },
    { id: "agents", label: "Agents", icon: <Bot size={18} /> },
    { id: "events", label: "事件", icon: <Radio size={18} /> },
  ];
  return <div className="app-shell"><aside><div className="brand-mark"><ShieldCheck size={22} /> Agent Hub</div><nav>{navigation.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}>{item.icon}{item.label}</button>)}</nav><button className="logout" onClick={() => void supabase.auth.signOut()}><LogOut size={17} />退出</button></aside><main className="workspace"><header><div><h1>{navigation.find((item) => item.id === view)?.label}</h1><p>{agents.filter((agent) => agent.status === "online" && Date.now() - new Date(agent.last_heartbeat ?? 0).getTime() < 90_000).length} 个在线 Agent · {tasks.filter((task) => ["assigned", "claimed", "running"].includes(task.status)).length} 个活动任务</p></div><button className="icon-button" title="刷新" onClick={() => void load()}><RefreshCw size={18} /></button></header>{error && <div className="notice error">{error}</div>}{view === "tasks" && <TaskBoard tasks={tasks} onSelect={setSelected} />}{view === "history" && <TaskHistory agents={agents} liveTasks={tasks} onSelect={setSelected} />}{view === "create" &&<CreateTask agents={agents} onCreated={() => { setView("tasks"); void load(); }} />}{view === "agents" && <Agents agents={agents} onChange={load} />}{view === "events" && <Events events={events} agents={agents} />}</main>{selected && <TaskDetail task={selected} agent={agents.find((agent) => agent.id === selected.assigned_to)} onClose={() => setSelected(null)} onChange={load} />}</div>;
}

function TaskBoard({ tasks, onSelect }: { tasks: TaskRecord[]; onSelect: (task: TaskRecord) => void }): React.ReactElement {
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const visibleColumns = showAll ? columns : activeColumns;
  const matches = (task: TaskRecord): boolean => !query || task.title.toLowerCase().includes(query.toLowerCase()) || task.prompt.toLowerCase().includes(query.toLowerCase()) || task.id.startsWith(query);
  const filtered = tasks.filter(matches);
  return <><div className="toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索任务标题、内容或 ID 前缀" /><label className="toggle"><input type="checkbox" checked={showAll} onChange={(event) => setShowAll(event.target.checked)} />显示已结束</label></div><div className="board" style={{ gridTemplateColumns: `repeat(${visibleColumns.length},minmax(220px,1fr))` }}>{visibleColumns.map((status) => <section className="column" key={status}><div className="column-head"><strong>{status}</strong><span>{filtered.filter((task) => task.status === status).length}</span></div><div className="task-list">{filtered.filter((task) => task.status === status).map((task) => <button className="task-card" key={task.id} onClick={() => onSelect(task)}><strong>{task.title}</strong><span>{task.progress ?? task.source}</span><small>P{task.priority} · {new Date(task.created_at).toLocaleString()}</small></button>)}{!filtered.some((task) => task.status === status) && <div className="empty">无任务</div>}</div></section>)}</div></>;
}

const pageSize = 50;

function duration(task: TaskRecord): string {
  const start = task.claimed_at ?? task.created_at;
  const end = task.finished_at;
  if (!end) return "-";
  const seconds = Math.max(0, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60 ? `${seconds % 60}s` : ""}`;
  return `${Math.floor(seconds / 3600)}h${Math.floor((seconds % 3600) / 60)}m`;
}

function TaskHistory({ agents, liveTasks, onSelect }: { agents: AgentRecord[]; liveTasks: TaskRecord[]; onSelect: (task: TaskRecord) => void }): React.ReactElement {
  const [rows, setRows] = useState<TaskRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [status, setStatus] = useState<"" | TaskStatus>("");
  const [agentId, setAgentId] = useState("");
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const agentName = useCallback((id: string | null) => agents.find((agent) => agent.id === id)?.name ?? (id ? id.slice(0, 8) : "未分配"), [agents]);

  const fetchPage = useCallback(async () => {
    if (demo) {
      const filtered = demoTasks.filter((task) => (!status || task.status === status) && (!agentId || task.assigned_to === agentId) && (!query || task.title.includes(query) || task.prompt.includes(query)));
      setRows(filtered); setTotal(filtered.length); return;
    }
    let request = supabase.from("tasks").select("*", { count: "exact" }).order("created_at", { ascending: false }).range(page * pageSize, page * pageSize + pageSize - 1);
    if (status) request = request.eq("status", status);
    if (agentId) request = request.eq("assigned_to", agentId);
    if (query.trim()) request = request.or(`title.ilike.%${query.trim()}%,prompt.ilike.%${query.trim()}%`);
    const { data, count, error: fetchError } = await request;
    if (fetchError) setError(fetchError.message);
    else { setRows((data ?? []) as TaskRecord[]); setTotal(count ?? 0); setError(""); }
  }, [status, agentId, query, page]);

  useEffect(() => { void fetchPage(); }, [fetchPage, liveTasks]);
  useEffect(() => { setPage(0); }, [status, agentId, query]);
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const finished = rows.filter((task) => task.status === "done").length;

  return <><div className="toolbar"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标题或指令内容" /><select value={status} onChange={(event) => setStatus(event.target.value as "" | TaskStatus)}><option value="">全部状态</option>{columns.map((item) => <option key={item} value={item}>{item}</option>)}</select><select value={agentId} onChange={(event) => setAgentId(event.target.value)}><option value="">全部 Agent</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></div>{error && <div className="notice error">{error}</div>}<p className="history-meta">共 {total} 条记录{status || agentId || query ? "（已过滤）" : ""} · 本页 done {finished} 条</p><section className="table-panel"><div className="history-row header"><span>状态</span><span>任务</span><span>Agent</span><span>来源</span><span>创建时间</span><span>耗时</span></div>{rows.map((task) => <button className="history-row" key={task.id} onClick={() => onSelect(task)}><span><span className={`status ${task.status}`}>{task.status}</span></span><span className="history-title"><strong>{task.title}</strong><small>{task.status === "done" || task.status === "failed" ? (task.result ?? "").split("\n")[0]?.slice(0, 90) : task.progress ?? ""}</small></span><span>{agentName(task.assigned_to)}</span><span>{task.source}</span><span>{new Date(task.created_at).toLocaleString()}</span><span>{duration(task)}</span></button>)}{rows.length === 0 && <div className="empty">没有匹配的记录</div>}</section>{pages > 1 && <div className="pager"><button disabled={page === 0} onClick={() => setPage(page - 1)}>上一页</button><span>{page + 1} / {pages}</span><button disabled={page + 1 >= pages} onClick={() => setPage(page + 1)}>下一页</button></div>}</>;
}

function CreateTask({ agents, onCreated }: { agents: AgentRecord[]; onCreated: () => void }): React.ReactElement {
  const [prompt, setPrompt] = useState("");
  const [targetType, setTargetType] = useState<"auto" | "agent" | "label">("auto");
  const [targetValue, setTargetValue] = useState("");
  const [priority, setPriority] = useState(0);
  const [timeout, setTimeoutValue] = useState(60);
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const labels = useMemo(() => [...new Set(agents.flatMap((agent) => agent.labels))].sort(), [agents]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const target: TaskTarget = targetType === "agent" ? { type: "agent", name: targetValue } : targetType === "label" ? { type: "label", labels: targetValue.split(",").map((item) => item.trim()).filter(Boolean) } : { type: "auto" };
      const taskId = crypto.randomUUID();
      const uploaded: Array<{ name: string; path: string; size: number; mime: string }> = [];
      for (const file of files.slice(0, 20)) {
        const path = `${taskId}/in/${file.name}`;
        const { error: uploadError } = await supabase.storage.from("task-files").upload(path, file, { upsert: true });
        if (uploadError) { setError(`上传 ${file.name} 失败：${uploadError.message}`); return; }
        uploaded.push({ name: file.name, path, size: file.size, mime: file.type });
      }
      const { error: insertError } = await supabase.from("tasks").insert({ id: taskId, title: prompt.trim().split("\n")[0]?.slice(0, 100) || "新任务", prompt, source: "web", target, priority, timeout_minutes: timeout });
      if (insertError) { setError(insertError.message); return; }
      if (uploaded.length) {
        const { error: fileError } = await supabase.from("task_files").insert(uploaded.map((file) => ({ task_id: taskId, direction: "in", ...file })));
        if (fileError) { setError(`任务已创建，但登记附件失败：${fileError.message}`); return; }
      }
      onCreated();
    } finally {
      setBusy(false);
    }
  };
  return <form className="form-panel" onSubmit={submit}><label>任务指令<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={12} required placeholder="描述需要 Agent 完成的工作" /></label><div className="form-grid"><label>目标<select value={targetType} onChange={(event) => setTargetType(event.target.value as typeof targetType)}><option value="auto">自动调度</option><option value="agent">指定 Agent</option><option value="label">按标签</option></select></label>{targetType === "agent" && <label>Agent<select value={targetValue} onChange={(event) => setTargetValue(event.target.value)} required><option value="">请选择</option>{agents.map((agent) => <option key={agent.id} value={agent.name}>{agent.name}</option>)}</select></label>}{targetType === "label" && <label>标签<input list="agent-labels" value={targetValue} onChange={(event) => setTargetValue(event.target.value)} placeholder="gpu, ios-build" required /><datalist id="agent-labels">{labels.map((label) => <option key={label} value={label} />)}</datalist></label>}<label>优先级<input type="number" min={-100} max={100} value={priority} onChange={(event) => setPriority(Number(event.target.value))} /></label><label>超时（分钟）<input type="number" min={1} max={1440} value={timeout} onChange={(event) => setTimeoutValue(Number(event.target.value))} /></label></div><label>附件（可选，交给 Agent 的输入文件，最多 20 个）<input type="file" multiple onChange={(event) => setFiles(Array.from(event.target.files ?? []))} />{files.length > 0 && <small className="history-meta">{files.map((file) => file.name).join(", ")}</small>}</label>{error && <div className="notice error">{error}</div>}<button type="submit" disabled={busy}><Send size={17} />{busy ? "提交中…" : "提交任务"}</button></form>;
}

function Agents({ agents, onChange }: { agents: AgentRecord[]; onChange: () => Promise<void> }): React.ReactElement {
  const [bootstrap, setBootstrap] = useState("");
  const [minutes, setMinutes] = useState(60);
  const [uses, setUses] = useState(1);
  const [editing, setEditing] = useState<AgentRecord | null>(null);
  const [error, setError] = useState("");
  const action = async (body: Record<string, unknown>) => {
    const { error: invokeError } = await supabase.functions.invoke("admin", { body });
    if (invokeError) setError(invokeError.message); else { setError(""); await onChange(); }
  };
  const generate = async () => {
    const { data, error: invokeError } = await supabase.functions.invoke("admin", { body: { action: "bootstrap", minutes, uses } });
    if (invokeError) setError(invokeError.message); else { setError(""); setBootstrap(data?.token ?? ""); }
  };
  const revoke = (agent: AgentRecord) => {
    if (window.confirm(`确认吊销 ${agent.name}？该 Agent 将无法再领取任务。`)) void action({ action: "revoke", agent_id: agent.id });
  };
  const togglePause = async (agent: AgentRecord) => {
    const { error: updateError } = await supabase.from("agents").update({ paused: !agent.paused }).eq("id", agent.id);
    if (updateError) setError(updateError.message); else { setError(""); await onChange(); }
  };
  return <><div className="toolbar"><button onClick={() => void generate()}><CirclePlus size={17} />生成注册令牌</button><label className="inline-field">有效<input type="number" min={5} max={1440} value={minutes} onChange={(event) => setMinutes(Number(event.target.value))} />分钟</label><label className="inline-field">可用<input type="number" min={1} max={100} value={uses} onChange={(event) => setUses(Number(event.target.value))} />次</label>{bootstrap && <div className="token-output"><code>{bootstrap}</code><button className="icon-button" title="复制" onClick={() => void navigator.clipboard.writeText(bootstrap)}><Clipboard size={16} /></button></div>}</div>{error && <div className="notice error">{error}</div>}<section className="table-panel"><div className="agent-row header"><span>Agent</span><span>模式与标签</span><span>负载</span><span>心跳</span><span>操作</span></div>{agents.map((agent) => { const live = agent.status === "online" && Date.now() - new Date(agent.last_heartbeat ?? 0).getTime() < 90_000; return <div className="agent-row" key={agent.id}><div><strong>{agent.name}</strong><span className={`status ${live ? "online" : agent.status}`}>{live ? "online" : agent.status}</span>{agent.paused && <span className="status pending">已暂停</span>}</div><div><span className="mode">{agent.mode}</span> {agent.labels.join(", ") || "无标签"}</div><div>{agent.running_count}/{agent.max_concurrency}</div><div>{age(agent.last_heartbeat)}</div><div className="actions">{agent.status === "pending_approval" && <button onClick={() => void action({ action: "approve", agent_id: agent.id })}>批准</button>}{agent.status !== "revoked" && agent.status !== "pending_approval" && <button onClick={() => void togglePause(agent)}>{agent.paused ? "恢复" : "暂停"}</button>}{agent.status !== "revoked" && <button onClick={() => setEditing(agent)}>编辑</button>}{agent.status !== "revoked" && <button className="danger" onClick={() => revoke(agent)}>吊销</button>}</div></div>; })}</section>{editing && <EditAgent agent={editing} onClose={() => setEditing(null)} onSaved={async () => { setEditing(null); await onChange(); }} />}</>;
}

function EditAgent({ agent, onClose, onSaved }: { agent: AgentRecord; onClose: () => void; onSaved: () => Promise<void> }): React.ReactElement {
  const [labels, setLabels] = useState(agent.labels.join(", "));
  const [concurrency, setConcurrency] = useState(agent.max_concurrency);
  const [error, setError] = useState("");
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    const nextLabels = labels.split(",").map((label) => label.trim()).filter(Boolean);
    const { error: updateError } = await supabase.from("agents").update({ labels: nextLabels, max_concurrency: concurrency }).eq("id", agent.id);
    if (updateError) setError(updateError.message); else await onSaved();
  };
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="drawer"><div className="drawer-head"><h2>编辑 {agent.name}</h2><button className="icon-button" onClick={onClose}>×</button></div><form onSubmit={save} className="form-panel" style={{ border: 0, padding: 0 }}><label>标签（逗号分隔）<input value={labels} onChange={(event) => setLabels(event.target.value)} placeholder="linux, gpu" /></label><div className="form-grid"><label>最大并发<input type="number" min={1} max={32} value={concurrency} onChange={(event) => setConcurrency(Number(event.target.value))} /></label></div>{error && <div className="notice error">{error}</div>}<button type="submit">保存</button></form></section></div>;
}

function Events({ events, agents }: { events: EventRecord[]; agents: AgentRecord[] }): React.ReactElement {
  const [filter, setFilter] = useState("");
  const visible = events.filter((event) => !filter || event.kind.includes(filter) || event.task_id?.includes(filter) || agents.find((agent) => agent.id === event.agent_id)?.name.includes(filter));
  return <><div className="toolbar"><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="按事件、任务或 Agent 过滤" /></div><section className="event-stream">{visible.map((event) => <article key={event.id}><time>{new Date(event.created_at).toLocaleString()}</time><strong>{event.kind}</strong><span>{agents.find((agent) => agent.id === event.agent_id)?.name ?? event.agent_id?.slice(0, 8) ?? "system"}</span><code>{JSON.stringify(event.payload)}</code></article>)}</section></>;
}

function TaskDetail({ task, agent, onClose, onChange }: { task: TaskRecord; agent?: AgentRecord; onClose: () => void; onChange: () => Promise<void> }): React.ReactElement {
  const [timeline, setTimeline] = useState<EventRecord[]>([]);
  const [interactions, setInteractions] = useState<InteractionRecord[]>([]);
  const [files, setFiles] = useState<TaskFileRecord[]>([]);
  const [transcript, setTranscript] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [answerError, setAnswerError] = useState("");
  useEffect(() => {
    if (demo) return;
    void supabase.from("events").select("*").eq("task_id", task.id).order("created_at").limit(100)
      .then(({ data }) => setTimeline((data ?? []) as EventRecord[]));
    void supabase.from("task_interactions").select("*").eq("task_id", task.id).order("asked_at")
      .then(({ data }) => setInteractions((data ?? []) as InteractionRecord[]));
    void supabase.from("task_files").select("*").eq("task_id", task.id).order("created_at")
      .then(({ data }) => setFiles((data ?? []) as TaskFileRecord[]));
    setTranscript(null);
  }, [task.id, task.status, task.progress]);
  const download = async (file: TaskFileRecord) => {
    const { data, error } = await supabase.storage.from("task-files").createSignedUrl(file.path, 600);
    if (error || !data) setAnswerError(error?.message ?? "无法生成下载链接");
    else window.open(data.signedUrl, "_blank", "noopener");
  };
  const logFile = files.find((file) => file.direction === "log");
  const loadTranscript = async () => {
    if (!logFile) return;
    const { data, error } = await supabase.storage.from("task-files").download(logFile.path);
    if (error || !data) { setTranscript(`加载失败：${error?.message ?? "未知错误"}`); return; }
    const text = await data.text();
    setTranscript(text.length > 400_000 ? `${text.slice(-400_000)}\n\n（超长，仅显示末尾 400K 字符，完整文件可下载）` : text);
  };
  const openQuestion = task.status === "waiting_input" ? [...interactions].reverse().find((interaction) => !interaction.answer) : undefined;
  const submitAnswer = async (event: React.FormEvent) => {
    event.preventDefault();
    const { error } = await supabase.rpc("answer_task", { p_task_id: task.id, p_answer: answer, p_via: "web" });
    if (error) setAnswerError(error.message); else { setAnswer(""); setAnswerError(""); onClose(); await onChange(); }
  };
  const cancel = async () => { if (!window.confirm(`确认取消任务“${task.title}”？`)) return; await supabase.from("tasks").update({ status: "cancelled" }).eq("id", task.id); onClose(); await onChange(); };
  const retry = async () => { await supabase.from("tasks").insert({ title: task.title, prompt: task.prompt, source: "web", target: task.target, priority: task.priority, timeout_minutes: task.timeout_minutes }); onClose(); await onChange(); };
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="drawer"><div className="drawer-head"><div><span className={`status ${task.status}`}>{task.status}</span><h2>{task.title}</h2></div><button className="icon-button" onClick={onClose}>×</button></div><dl><dt>Agent</dt><dd>{agent?.name ?? "未分配"}</dd><dt>优先级</dt><dd>{task.priority}</dd><dt>超时</dt><dd>{task.timeout_minutes} 分钟</dd><dt>重试</dt><dd>{task.retry_count}</dd><dt>进度</dt><dd>{task.progress ?? "-"}</dd><dt>创建</dt><dd>{new Date(task.created_at).toLocaleString()}</dd>{task.finished_at && <><dt>结束</dt><dd>{new Date(task.finished_at).toLocaleString()}</dd></>}</dl>{openQuestion && <section className="question-panel"><h3>等待拍板</h3><p className="question-text">{openQuestion.question}</p>{openQuestion.options && <p className="question-meta">选项:{openQuestion.options}</p>}{openQuestion.context && <pre>{openQuestion.context}</pre>}<form onSubmit={submitAnswer}><textarea value={answer} onChange={(event) => setAnswer(event.target.value)} rows={3} required placeholder="输入你的决定，任务将立即恢复执行" />{answerError && <div className="notice error">{answerError}</div>}<button type="submit"><Send size={16} />提交答复并恢复</button></form></section>}{interactions.some((interaction) => interaction.answer) && <><h3>问答记录</h3><ol className="timeline">{interactions.filter((interaction) => interaction.answer).map((interaction) => <li key={interaction.id}><time>{new Date(interaction.asked_at).toLocaleTimeString()}</time><span><strong>问:</strong>{interaction.question}<br /><strong>答({interaction.answered_via}):</strong>{interaction.answer}</span></li>)}</ol></>}<h3>指令</h3><pre>{task.prompt}</pre>{files.some((file) => file.direction === "in") && <><h3>输入文件</h3><ul className="file-list">{files.filter((file) => file.direction === "in").map((file) => <li key={file.id}><span>{file.name}</span><small>{file.size ? `${Math.ceil(file.size / 1024)} KB` : ""}</small><button onClick={() => void download(file)}>下载</button></li>)}</ul></>}<h3>结果</h3><pre>{task.result ?? "尚无结果"}</pre>{task.result && <div className="actions"><button onClick={() => void navigator.clipboard.writeText(task.result ?? "")}><Clipboard size={16} />复制结果</button></div>}{files.some((file) => file.direction === "out") && <><h3>交付文件</h3><ul className="file-list">{files.filter((file) => file.direction === "out").map((file) => <li key={file.id}><span>{file.name}</span><small>{file.size ? `${Math.ceil(file.size / 1024)} KB` : ""}</small><button onClick={() => void download(file)}>下载</button></li>)}</ul></>}{logFile && <><h3>推理过程</h3>{transcript === null ? <div className="actions"><button onClick={() => void loadTranscript()}><Activity size={16} />查看执行记录</button><button onClick={() => void download(logFile)}>下载日志</button></div> : <pre className="transcript">{transcript}</pre>}</>}{timeline.length > 0 && <><h3>时间线</h3><ol className="timeline">{timeline.map((event) => <li key={event.id}><time>{new Date(event.created_at).toLocaleTimeString()}</time><strong>{event.kind}</strong>{typeof event.payload.progress === "string" && <span>{event.payload.progress}</span>}{typeof event.payload.question === "string" && <span>{event.payload.question}</span>}</li>)}</ol></>}<div className="actions">{!terminalStatuses.includes(task.status) && <button className="danger" onClick={() => void cancel()}>取消</button>}<button onClick={() => void retry()}><RefreshCw size={16} />重试为新任务</button></div></section></div>;
}
