import type { Session } from "@supabase/supabase-js";
import { Activity, Bot, CirclePlus, Clipboard, ListTodo, LogOut, Radio, RefreshCw, Send, ShieldCheck, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentRecord, EventRecord, TaskRecord, TaskStatus, TaskTarget } from "../../shared/types";
import { demoAgents, demoEvents, demoSession, demoTasks } from "./demo";
import { configured, supabase } from "./supabase";

type View = "tasks" | "create" | "agents" | "events";
const columns: TaskStatus[] = ["pending", "assigned", "claimed", "running", "done", "failed", "timeout", "cancelled"];
const activeColumns: TaskStatus[] = ["pending", "assigned", "claimed", "running", "failed"];
const demo = import.meta.env.DEV && new URLSearchParams(window.location.search).has("demo");

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
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.origin } });
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
    { id: "create", label: "发任务", icon: <CirclePlus size={18} /> },
    { id: "agents", label: "Agents", icon: <Bot size={18} /> },
    { id: "events", label: "事件", icon: <Radio size={18} /> },
  ];
  return <div className="app-shell"><aside><div className="brand-mark"><ShieldCheck size={22} /> Agent Hub</div><nav>{navigation.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}>{item.icon}{item.label}</button>)}</nav><button className="logout" onClick={() => void supabase.auth.signOut()}><LogOut size={17} />退出</button></aside><main className="workspace"><header><div><h1>{navigation.find((item) => item.id === view)?.label}</h1><p>{agents.filter((agent) => agent.status === "online" && Date.now() - new Date(agent.last_heartbeat ?? 0).getTime() < 90_000).length} 个在线 Agent · {tasks.filter((task) => ["assigned", "claimed", "running"].includes(task.status)).length} 个活动任务</p></div><button className="icon-button" title="刷新" onClick={() => void load()}><RefreshCw size={18} /></button></header>{error && <div className="notice error">{error}</div>}{view === "tasks" && <TaskBoard tasks={tasks} onSelect={setSelected} />}{view === "create" && <CreateTask agents={agents} onCreated={() => { setView("tasks"); void load(); }} />}{view === "agents" && <Agents agents={agents} onChange={load} />}{view === "events" && <Events events={events} agents={agents} />}</main>{selected && <TaskDetail task={selected} agent={agents.find((agent) => agent.id === selected.assigned_to)} onClose={() => setSelected(null)} onChange={load} />}</div>;
}

function TaskBoard({ tasks, onSelect }: { tasks: TaskRecord[]; onSelect: (task: TaskRecord) => void }): React.ReactElement {
  return <div className="board">{activeColumns.map((status) => <section className="column" key={status}><div className="column-head"><strong>{status}</strong><span>{tasks.filter((task) => task.status === status).length}</span></div><div className="task-list">{tasks.filter((task) => task.status === status).map((task) => <button className="task-card" key={task.id} onClick={() => onSelect(task)}><strong>{task.title}</strong><span>{task.progress ?? task.source}</span><small>P{task.priority} · {new Date(task.created_at).toLocaleString()}</small></button>)}{!tasks.some((task) => task.status === status) && <div className="empty">无任务</div>}</div></section>)}</div>;
}

function CreateTask({ agents, onCreated }: { agents: AgentRecord[]; onCreated: () => void }): React.ReactElement {
  const [prompt, setPrompt] = useState("");
  const [targetType, setTargetType] = useState<"auto" | "agent" | "label">("auto");
  const [targetValue, setTargetValue] = useState("");
  const [priority, setPriority] = useState(0);
  const [timeout, setTimeoutValue] = useState(60);
  const [error, setError] = useState("");
  const labels = useMemo(() => [...new Set(agents.flatMap((agent) => agent.labels))].sort(), [agents]);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const target: TaskTarget = targetType === "agent" ? { type: "agent", name: targetValue } : targetType === "label" ? { type: "label", labels: targetValue.split(",").map((item) => item.trim()).filter(Boolean) } : { type: "auto" };
    const { error: insertError } = await supabase.from("tasks").insert({ title: prompt.trim().split("\n")[0]?.slice(0, 100) || "新任务", prompt, source: "web", target, priority, timeout_minutes: timeout });
    if (insertError) setError(insertError.message); else onCreated();
  };
  return <form className="form-panel" onSubmit={submit}><label>任务指令<textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} rows={12} required placeholder="描述需要 Agent 完成的工作" /></label><div className="form-grid"><label>目标<select value={targetType} onChange={(event) => setTargetType(event.target.value as typeof targetType)}><option value="auto">自动调度</option><option value="agent">指定 Agent</option><option value="label">按标签</option></select></label>{targetType === "agent" && <label>Agent<select value={targetValue} onChange={(event) => setTargetValue(event.target.value)} required><option value="">请选择</option>{agents.map((agent) => <option key={agent.id} value={agent.name}>{agent.name}</option>)}</select></label>}{targetType === "label" && <label>标签<input list="agent-labels" value={targetValue} onChange={(event) => setTargetValue(event.target.value)} placeholder="gpu, ios-build" required /><datalist id="agent-labels">{labels.map((label) => <option key={label} value={label} />)}</datalist></label>}<label>优先级<input type="number" min={-100} max={100} value={priority} onChange={(event) => setPriority(Number(event.target.value))} /></label><label>超时（分钟）<input type="number" min={1} max={1440} value={timeout} onChange={(event) => setTimeoutValue(Number(event.target.value))} /></label></div>{error && <div className="notice error">{error}</div>}<button type="submit"><Send size={17} />提交任务</button></form>;
}

function Agents({ agents, onChange }: { agents: AgentRecord[]; onChange: () => Promise<void> }): React.ReactElement {
  const [bootstrap, setBootstrap] = useState("");
  const [error, setError] = useState("");
  const action = async (body: Record<string, unknown>) => {
    const { error: invokeError } = await supabase.functions.invoke("admin", { body });
    if (invokeError) setError(invokeError.message); else { setError(""); await onChange(); }
  };
  const generate = async () => {
    const { data, error: invokeError } = await supabase.functions.invoke("admin", { body: { action: "bootstrap", minutes: 60, uses: 1 } });
    if (invokeError) setError(invokeError.message); else { setError(""); setBootstrap(data?.token ?? ""); }
  };
  const revoke = (agent: AgentRecord) => {
    if (window.confirm(`确认吊销 ${agent.name}？该 Agent 将无法再领取任务。`)) void action({ action: "revoke", agent_id: agent.id });
  };
  return <><div className="toolbar"><button onClick={() => void generate()}><CirclePlus size={17} />生成注册令牌</button>{bootstrap && <div className="token-output"><code>{bootstrap}</code><button className="icon-button" title="复制" onClick={() => void navigator.clipboard.writeText(bootstrap)}><Clipboard size={16} /></button></div>}</div>{error && <div className="notice error">{error}</div>}<section className="table-panel"><div className="agent-row header"><span>Agent</span><span>模式与标签</span><span>负载</span><span>心跳</span><span>操作</span></div>{agents.map((agent) => { const live = agent.status === "online" && Date.now() - new Date(agent.last_heartbeat ?? 0).getTime() < 90_000; return <div className="agent-row" key={agent.id}><div><strong>{agent.name}</strong><span className={`status ${live ? "online" : agent.status}`}>{live ? "online" : agent.status}</span></div><div><span className="mode">{agent.mode}</span> {agent.labels.join(", ") || "无标签"}</div><div>{agent.running_count}/{agent.max_concurrency}</div><div>{age(agent.last_heartbeat)}</div><div className="actions">{agent.status === "pending_approval" && <button onClick={() => void action({ action: "approve", agent_id: agent.id })}>批准</button>}{agent.status !== "revoked" && <button className="danger" onClick={() => revoke(agent)}>吊销</button>}</div></div>; })}</section></>;
}

function Events({ events, agents }: { events: EventRecord[]; agents: AgentRecord[] }): React.ReactElement {
  const [filter, setFilter] = useState("");
  const visible = events.filter((event) => !filter || event.kind.includes(filter) || event.task_id?.includes(filter) || agents.find((agent) => agent.id === event.agent_id)?.name.includes(filter));
  return <><div className="toolbar"><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="按事件、任务或 Agent 过滤" /></div><section className="event-stream">{visible.map((event) => <article key={event.id}><time>{new Date(event.created_at).toLocaleString()}</time><strong>{event.kind}</strong><span>{agents.find((agent) => agent.id === event.agent_id)?.name ?? event.agent_id?.slice(0, 8) ?? "system"}</span><code>{JSON.stringify(event.payload)}</code></article>)}</section></>;
}

function TaskDetail({ task, agent, onClose, onChange }: { task: TaskRecord; agent?: AgentRecord; onClose: () => void; onChange: () => Promise<void> }): React.ReactElement {
  const cancel = async () => { if (!window.confirm(`确认取消任务“${task.title}”？`)) return; await supabase.from("tasks").update({ status: "cancelled" }).eq("id", task.id); onClose(); await onChange(); };
  const retry = async () => { await supabase.from("tasks").insert({ title: task.title, prompt: task.prompt, source: "web", target: task.target, priority: task.priority, timeout_minutes: task.timeout_minutes }); onClose(); await onChange(); };
  return <div className="drawer-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="drawer"><div className="drawer-head"><div><span className={`status ${task.status}`}>{task.status}</span><h2>{task.title}</h2></div><button className="icon-button" onClick={onClose}>×</button></div><dl><dt>Agent</dt><dd>{agent?.name ?? "未分配"}</dd><dt>优先级</dt><dd>{task.priority}</dd><dt>超时</dt><dd>{task.timeout_minutes} 分钟</dd><dt>进度</dt><dd>{task.progress ?? "-"}</dd></dl><h3>指令</h3><pre>{task.prompt}</pre><h3>结果</h3><pre>{task.result ?? "尚无结果"}</pre><div className="actions">{!columns.slice(4).includes(task.status) && <button className="danger" onClick={() => void cancel()}>取消</button>}<button onClick={() => void retry()}><RefreshCw size={16} />重试为新任务</button></div></section></div>;
}
