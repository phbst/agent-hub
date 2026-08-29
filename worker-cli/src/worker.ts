import { mkdir } from "node:fs/promises";
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import type { TaskRecord } from "../../shared/types.js";
import { log } from "../../shared/log.js";
import type { WorkerConfig } from "./config.js";
import type { WorkerCredentials } from "./credentials.js";
import { executeTask } from "./executor.js";

type TaskExecutor = typeof executeTask;
type RunningTask = { controller: AbortController; promise: Promise<void> };

export class Worker {
  readonly #config: WorkerConfig;
  readonly #credentials: WorkerCredentials;
  readonly #client: SupabaseClient;
  readonly #executor: TaskExecutor;
  readonly #running = new Map<string, RunningTask>();
  #channel: RealtimeChannel | null = null;
  #heartbeat: NodeJS.Timeout | null = null;
  #stopping = false;

  constructor(config: WorkerConfig, credentials: WorkerCredentials, executor: TaskExecutor = executeTask) {
    this.#config = config;
    this.#credentials = credentials;
    this.#client = createClient(config.hub.url, config.hub.anon_key, { auth: { persistSession: false, autoRefreshToken: true } });
    this.#executor = executor;
  }

  async start(): Promise<void> {
    await mkdir(this.#config.agent.workspace_root, { recursive: true, mode: 0o700 });
    const { data, error } = await this.#client.auth.signInWithPassword({ email: this.#credentials.email, password: this.#credentials.password });
    if (error || !data.session) throw error ?? new Error("agent login failed");
    const confirmation = await fetch(`${this.#config.hub.url}/functions/v1/register`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: this.#config.hub.anon_key, authorization: `Bearer ${data.session.access_token}` },
      body: JSON.stringify({ action: "confirm" }),
    });
    if (!confirmation.ok) throw new Error(`registration confirmation failed: ${confirmation.status} ${await confirmation.text()}`);
    await this.#heartbeatNow();
    this.#heartbeat = setInterval(() => void this.#heartbeatNow(), this.#config.agent.heartbeat_seconds * 1000);
    this.#channel = this.#client
      .channel(`agent-tasks-${this.#credentials.agent_id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "tasks", filter: `assigned_to=eq.${this.#credentials.agent_id}` }, (payload) => {
        const task = payload.new as TaskRecord;
        if (task.status === "assigned") void this.#accept(task);
      })
      .subscribe((status) => {
        log("realtime.status", { status });
        if (status === "SUBSCRIBED") void this.#catchUp();
      });
    await this.#catchUp();
    log("worker.started", { agentId: this.#credentials.agent_id, name: this.#config.agent.name });
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    if (this.#channel) {
      await Promise.race([
        this.#client.removeChannel(this.#channel),
        new Promise((resolve) => setTimeout(resolve, 3_000)),
      ]);
    }
    for (const running of this.#running.values()) running.controller.abort();
    await Promise.race([
      Promise.allSettled([...this.#running.values()].map((running) => running.promise)),
      new Promise((resolve) => setTimeout(resolve, 7_000)),
    ]);
    const offline = await Promise.race([
      this.#client.from("agents").update({ status: "offline", last_heartbeat: new Date().toISOString() }).eq("id", this.#credentials.agent_id),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3_000)),
    ]);
    const error = offline?.error;
    if (error) log("worker.offline.failed", { error });
    this.#client.auth.stopAutoRefresh();
  }

  async #heartbeatNow(): Promise<void> {
    const { error } = await this.#client.rpc("agent_heartbeat");
    if (error) log("heartbeat.failed", { error });
  }

  async #catchUp(): Promise<void> {
    const { data, error } = await this.#client.from("tasks").select("*").eq("status", "assigned").order("priority", { ascending: false }).order("created_at");
    if (error) {
      log("catchup.failed", { error });
      return;
    }
    for (const task of (data ?? []) as TaskRecord[]) void this.#accept(task);
  }

  #accept(task: TaskRecord): void {
    if (this.#stopping || this.#running.has(task.id) || this.#running.size >= this.#config.agent.max_concurrency) return;
    const controller = new AbortController();
    const promise = this.#runTask(task, controller.signal).finally(() => {
      this.#running.delete(task.id);
      if (!this.#stopping) void this.#catchUp();
    });
    this.#running.set(task.id, { controller, promise });
  }

  async #updateTask(taskId: string, values: Record<string, unknown>): Promise<void> {
    const { error } = await this.#client.from("tasks").update(values).eq("id", taskId);
    if (error) throw error;
  }

  async #runTask(task: TaskRecord, signal: AbortSignal): Promise<void> {
    try {
      const { data, error } = await this.#client.rpc("claim_task", { p_task_id: task.id });
      if (error || !data) return;
      const claimed = (Array.isArray(data) ? data[0] : data) as TaskRecord | undefined;
      if (!claimed) return;
      await this.#updateTask(task.id, { status: "running", progress: "Executor started" });
      const execution = await this.#executor(this.#config, claimed, signal);
      if (execution.timedOut) {
        await this.#updateTask(task.id, { status: "timeout", progress: "Local executor timed out", result: execution.result });
      } else if (execution.interrupted) {
        await this.#updateTask(task.id, { status: "failed", progress: "Worker stopped during execution", result: execution.result });
      } else {
        await this.#updateTask(task.id, { status: execution.exitCode === 0 ? "done" : "failed", progress: execution.exitCode === 0 ? "Completed" : "Executor failed", result: execution.result });
      }
    } catch (error) {
      log("task.failed", { taskId: task.id, error });
      try {
        await this.#updateTask(task.id, { status: "failed", progress: "Worker exception", result: error instanceof Error ? error.message : String(error) });
      } catch (updateError) {
        log("task.failure-update.failed", { taskId: task.id, error: updateError });
      }
    }
  }
}
