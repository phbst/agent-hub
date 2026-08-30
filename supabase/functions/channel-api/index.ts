import { adminClient, errorMessage, json, options } from "../_shared/http.ts";

// Structured channel surface for external dispatchers (e.g. the WeChat Codex bridge).
// The caller resolves intent; this function only exposes typed actions guarded by a shared secret.

const terminal = ["done", "failed", "cancelled"];

function unauthorized(request: Request): boolean {
  const secret = Deno.env.get("CHANNEL_API_SECRET") ?? Deno.env.get("WECHAT_CHANNEL_SECRET");
  return !secret || request.headers.get("x-channel-secret") !== secret;
}

function normalizeTarget(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === "object") {
    const target = raw as Record<string, unknown>;
    if (target.type === "agent" && typeof target.name === "string") return { type: "agent", name: target.name };
    if (target.type === "label" && Array.isArray(target.labels)) {
      return { type: "label", labels: target.labels.filter((label) => typeof label === "string") };
    }
  }
  return { type: "auto" };
}

Deno.serve(async (request) => {
  const preflight = options(request);
  if (preflight) return preflight;
  if (unauthorized(request)) return json({ error: "invalid channel secret" }, 401);
  try {
    const body = await request.json();
    const client = adminClient();

    if (body.action === "prepare_upload") {
      const names = Array.isArray(body.files)
        ? body.files.filter((name: unknown): name is string => typeof name === "string" && name.length > 0).slice(0, 20)
        : [];
      if (!names.length) return json({ error: "files must be a non-empty array of names" }, 400);
      const taskId = crypto.randomUUID();
      const uploads = [];
      for (const rawName of names) {
        const name = rawName.split("/").pop()!.slice(0, 200);
        const filePath = `${taskId}/in/${name}`;
        const { data, error } = await client.storage.from("task-files").createSignedUploadUrl(filePath);
        if (error) throw error;
        uploads.push({ name, path: filePath, url: data.signedUrl });
      }
      return json({ task_id: taskId, uploads, note: "PUT each file to its url, then call create with this task_id and the files list" });
    }

    if (body.action === "create") {
      const prompt = String(body.prompt ?? "").trim();
      if (!prompt) return json({ error: "prompt is required" }, 400);
      const priority = Math.max(-100, Math.min(Number(body.priority ?? 0) || 0, 100));
      const timeoutMinutes = Math.max(1, Math.min(Number(body.timeout_minutes ?? 60) || 60, 1440));
      const insert = {
        ...(typeof body.task_id === "string" && /^[0-9a-f-]{36}$/.test(body.task_id) ? { id: body.task_id } : {}),
        title: String(body.title ?? "").trim().slice(0, 200) || prompt.split("\n")[0]!.slice(0, 100) || "新任务",
        prompt: prompt.slice(0, 100_000),
        source: body.source === "wechat" ? "wechat" : "api",
        source_msg_id: typeof body.source_msg_id === "string" && body.source_msg_id ? body.source_msg_id : null,
        target: normalizeTarget(body.target),
        priority,
        timeout_minutes: timeoutMinutes,
      };
      const { data, error } = await client.from("tasks").insert(insert).select("id,title,status,target").single();
      if (error?.code === "23505" && insert.source_msg_id) {
        const { data: existing } = await client.from("tasks").select("id,title,status,target").eq("source_msg_id", insert.source_msg_id).single();
        return json({ duplicate: true, task: existing });
      }
      if (error) throw error;
      if (Array.isArray(body.files) && data) {
        const rows = body.files
          .filter((file: unknown): file is { name: string; path: string; size?: number } =>
            !!file && typeof file === "object" && typeof (file as { name?: unknown }).name === "string" && typeof (file as { path?: unknown }).path === "string")
          .slice(0, 20)
          .map((file: { name: string; path: string; size?: number }) => ({
            task_id: data.id, direction: "in", name: file.name.slice(0, 255), path: file.path, size: typeof file.size === "number" ? file.size : null,
          }));
        if (rows.length) {
          const { error: fileError } = await client.from("task_files").insert(rows);
          if (fileError) return json({ task: data, files_error: fileError.message }, 202);
        }
      }
      return json({ task: data }, 202);
    }

    if (body.action === "files") {
      const taskId = String(body.task_id ?? "");
      if (!taskId) return json({ error: "task_id is required" }, 400);
      let request = client.from("task_files").select("*").eq("task_id", taskId).order("created_at");
      if (body.direction === "in" || body.direction === "out" || body.direction === "log") request = request.eq("direction", body.direction);
      const { data, error } = await request;
      if (error) throw error;
      const files = [];
      for (const file of data ?? []) {
        const { data: signed, error: signError } = await client.storage.from("task-files").createSignedUrl(file.path, 86_400);
        files.push({ name: file.name, direction: file.direction, size: file.size, url: signError ? null : signed?.signedUrl ?? null });
      }
      return json({ files });
    }

    if (body.action === "status") {
      if (typeof body.task_id === "string") {
        const { data, error } = await client.from("tasks")
          .select("id,title,status,progress,result,priority,assigned_to,created_at,finished_at")
          .eq("id", body.task_id).single();
        if (error) throw error;
        return json({ task: data });
      }
      const limit = Math.max(1, Math.min(Number(body.limit ?? 20) || 20, 100));
      const [tasks, agents] = await Promise.all([
        client.from("tasks").select("id,title,status,progress,priority,assigned_to,created_at").order("created_at", { ascending: false }).limit(limit),
        client.from("agents").select("id,name,mode,labels,status,paused,running_count,max_concurrency,last_heartbeat").order("name"),
      ]);
      if (tasks.error) throw tasks.error;
      if (agents.error) throw agents.error;
      return json({ tasks: tasks.data, agents: agents.data });
    }

    if (body.action === "cancel") {
      const taskId = String(body.task_id ?? "");
      if (!taskId) return json({ error: "task_id is required" }, 400);
      const { data: current, error: readError } = await client.from("tasks").select("id,status,title").eq("id", taskId).single();
      if (readError) throw readError;
      if (terminal.includes(current.status) || current.status === "timeout") {
        return json({ cancelled: false, reason: `task is already ${current.status}`, task: current });
      }
      const { data, error } = await client.from("tasks").update({ status: "cancelled" }).eq("id", taskId).select("id,title,status").single();
      if (error) throw error;
      return json({ cancelled: true, task: data });
    }

    if (body.action === "answer") {
      const answer = String(body.answer ?? "").trim();
      if (!answer) return json({ error: "answer is required" }, 400);
      let taskId = typeof body.task_id === "string" ? body.task_id : "";
      if (!taskId && typeof body.task_prefix === "string" && body.task_prefix) {
        const { data: waiting, error: waitError } = await client.from("tasks")
          .select("id,title").eq("status", "waiting_input").limit(50);
        if (waitError) throw waitError;
        const matches = (waiting ?? []).filter((task) => task.id.startsWith(body.task_prefix));
        if (matches.length !== 1) {
          return json({ error: matches.length ? "task prefix is ambiguous" : "no waiting task matches that prefix", candidates: matches }, 400);
        }
        taskId = matches[0]!.id;
      }
      if (!taskId) return json({ error: "task_id or task_prefix is required" }, 400);
      const { data, error } = await client.rpc("answer_task", { p_task_id: taskId, p_answer: answer, p_via: body.via === "web" ? "web" : "wechat" });
      if (error) throw error;
      const task = (Array.isArray(data) ? data[0] : data) as { id: string; title: string; status: string };
      return json({ answered: true, task: { id: task.id, title: task.title, status: task.status } });
    }

    if (body.action === "agents") {
      const { data, error } = await client.from("agents")
        .select("id,name,mode,labels,status,paused,running_count,max_concurrency,last_heartbeat").order("name");
      if (error) throw error;
      return json({ agents: data });
    }

    if (body.action === "events") {
      const sinceId = Number(body.since_id ?? 0) || 0;
      const limit = Math.max(1, Math.min(Number(body.limit ?? 50) || 50, 200));
      const kinds = Array.isArray(body.kinds) && body.kinds.length
        ? body.kinds.filter((kind: unknown): kind is string => typeof kind === "string")
        : ["task.done", "task.failed", "task.timeout", "task.cancelled", "task.question"];
      const { data, error } = await client.from("events")
        .select("id,task_id,agent_id,kind,payload,created_at, tasks(title,result,source,status), agents(name)")
        .gt("id", sinceId).in("kind", kinds).order("id").limit(limit);
      if (error) throw error;
      const events = (data ?? []).map((event) => ({
        id: event.id,
        kind: event.kind,
        created_at: event.created_at,
        task_id: event.task_id,
        task_title: (event.tasks as { title?: string } | null)?.title ?? null,
        task_source: (event.tasks as { source?: string } | null)?.source ?? null,
        task_result: ((event.tasks as { result?: string } | null)?.result ?? "").slice(0, 2000) || null,
        agent_name: (event.agents as { name?: string } | null)?.name ?? null,
        question: typeof (event.payload as Record<string, unknown>)?.question === "string" ? (event.payload as Record<string, string>).question : null,
        options: typeof (event.payload as Record<string, unknown>)?.options === "string" ? (event.payload as Record<string, string>).options : null,
      }));
      return json({ events, cursor: events.length ? events[events.length - 1]!.id : sinceId });
    }

    return json({ error: "unknown action" }, 400);
  } catch (error) {
    return json({ error: errorMessage(error) }, 400);
  }
});
