import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient, type RealtimeChannel, type SupabaseClient } from "@supabase/supabase-js";
import type { TaskRecord } from "../../shared/types.js";
import { log } from "../../shared/log.js";
import { formatResult, parseQuestionBlock, parseResultBlock } from "../../shared/prompt.js";
import { buildTaskPrompt } from "./skills.js";
import type { InteractionRecord, TaskFileRecord } from "../../shared/types.js";

const maxOutputFiles = 20;
const maxOutputFileBytes = 100 * 1024 * 1024;
import type { WorkerConfig } from "./config.js";
import type { WorkerCredentials } from "./credentials.js";
import { executeTask } from "./executor.js";

type TaskExecutor = typeof executeTask;
type RunningTask = { controller: AbortController; promise: Promise<void> };

export function isSessionAuthorizationError(error: { code?: string; message?: string }): boolean {
  return error.code === "42501"
    || error.code === "PGRST301"
    || /jwt|permission denied for function agent_heartbeat|not authenticated/i.test(error.message ?? "");
}

export class Worker {
  readonly #config: WorkerConfig;
  readonly #credentials: WorkerCredentials;
  readonly #client: SupabaseClient;
  readonly #executor: TaskExecutor;
  readonly #running = new Map<string, RunningTask>();
  readonly #cancelled = new Set<string>();
  #channel: RealtimeChannel | null = null;
  #heartbeat: NodeJS.Timeout | null = null;
  #authRecovery: Promise<void> | null = null;
  #lastAuthRecoveryAt = 0;
  #stopping = false;

  constructor(config: WorkerConfig, credentials: WorkerCredentials, executor: TaskExecutor = executeTask) {
    this.#config = config;
    this.#credentials = credentials;
    this.#client = createClient(config.hub.url, config.hub.anon_key, { auth: { persistSession: false, autoRefreshToken: true } });
    this.#executor = executor;
  }

  async start(): Promise<void> {
    await mkdir(this.#config.agent.workspace_root, { recursive: true, mode: 0o700 });
    await this.#signIn();
    const { data } = await this.#client.auth.getSession();
    if (!data.session) throw new Error("agent session unavailable after login");
    const confirmation = await fetch(`${this.#config.hub.url}/functions/v1/register`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: this.#config.hub.anon_key, authorization: `Bearer ${data.session.access_token}` },
      body: JSON.stringify({ action: "confirm" }),
    });
    if (!confirmation.ok) throw new Error(`registration confirmation failed: ${confirmation.status} ${await confirmation.text()}`);
    await this.#heartbeatNow();
    this.#heartbeat = setInterval(() => void this.#heartbeatNow(), this.#config.agent.heartbeat_seconds * 1000);
    this.#subscribe();
    await this.#catchUp();
    log("worker.started", { agentId: this.#credentials.agent_id, name: this.#config.agent.name });
  }

  async #signIn(): Promise<void> {
    const { data, error } = await this.#client.auth.signInWithPassword({ email: this.#credentials.email, password: this.#credentials.password });
    if (error || !data.session) throw error ?? new Error("agent login failed");
  }

  #subscribe(): void {
    this.#channel = this.#client
      .channel(`agent-tasks-${this.#credentials.agent_id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "tasks", filter: `assigned_to=eq.${this.#credentials.agent_id}` }, (payload) => {
        const task = payload.new as TaskRecord;
        if (task.status === "assigned") void this.#accept(task);
        else if (task.status === "cancelled") this.#cancelLocal(task.id);
      })
      .subscribe((status) => {
        log("realtime.status", { status });
        if (status === "SUBSCRIBED") void this.#catchUp();
      });
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
    if (!error) return;
    if (!isSessionAuthorizationError(error)) {
      log("heartbeat.failed", { error });
      return;
    }
    try {
      await this.#recoverAuthentication();
      const retry = await this.#client.rpc("agent_heartbeat");
      if (retry.error) log("heartbeat.failed", { error: retry.error });
      else log("heartbeat.recovered");
    } catch (recoveryError) {
      log("heartbeat.auth-recovery.failed", { error: recoveryError });
    }
  }

  async #recoverAuthentication(): Promise<void> {
    if (this.#authRecovery) return this.#authRecovery;
    if (Date.now() - this.#lastAuthRecoveryAt < 60_000) throw new Error("authentication recovery is cooling down");
    this.#lastAuthRecoveryAt = Date.now();
    this.#authRecovery = (async () => {
      await this.#signIn();
      const staleChannel = this.#channel;
      this.#channel = null;
      if (staleChannel) {
        await Promise.race([
          this.#client.removeChannel(staleChannel),
          new Promise((resolve) => setTimeout(resolve, 3_000)),
        ]);
      }
      if (!this.#stopping) {
        this.#subscribe();
        await this.#catchUp();
      }
      log("worker.reauthenticated");
    })().finally(() => {
      this.#authRecovery = null;
    });
    return this.#authRecovery;
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
      this.#cancelled.delete(task.id);
      if (!this.#stopping) void this.#catchUp();
    });
    this.#running.set(task.id, { controller, promise });
  }

  #workdir(taskId: string): string {
    return path.join(this.#config.agent.workspace_root, taskId);
  }

  async #downloadInputs(taskId: string): Promise<void> {
    const { data, error } = await this.#client.from("task_files")
      .select("*").eq("task_id", taskId).eq("direction", "in");
    if (error) {
      log("inputs.list.failed", { taskId, error });
      return;
    }
    const files = (data ?? []) as TaskFileRecord[];
    if (!files.length) return;
    const inputDir = path.join(this.#workdir(taskId), "inputs");
    await mkdir(inputDir, { recursive: true, mode: 0o700 });
    for (const file of files) {
      const safeName = path.basename(file.name);
      const { data: blob, error: downloadError } = await this.#client.storage.from("task-files").download(file.path);
      if (downloadError || !blob) {
        log("inputs.download.failed", { taskId, file: file.path, error: downloadError });
        continue;
      }
      await writeFile(path.join(inputDir, safeName), Buffer.from(await blob.arrayBuffer()), { mode: 0o600 });
    }
    log("inputs.ready", { taskId, count: files.length });
  }

  async #uploadOutputs(taskId: string): Promise<number> {
    const outputDir = path.join(this.#workdir(taskId), "outputs");
    let entries: string[];
    try {
      entries = await readdir(outputDir, { recursive: true });
    } catch {
      return 0;
    }
    let uploaded = 0;
    for (const entry of entries.slice(0, 200)) {
      if (uploaded >= maxOutputFiles) break;
      const localPath = path.join(outputDir, entry);
      const info = await stat(localPath).catch(() => null);
      if (!info?.isFile()) continue;
      if (info.size > maxOutputFileBytes) {
        log("outputs.skipped.too-large", { taskId, file: entry, size: info.size });
        continue;
      }
      const storagePath = `${taskId}/out/${entry.split(path.sep).join("/")}`;
      const { error: uploadError } = await this.#client.storage.from("task-files")
        .upload(storagePath, await readFile(localPath), { upsert: true });
      if (uploadError) {
        log("outputs.upload.failed", { taskId, file: entry, error: uploadError });
        continue;
      }
      const { error: registerError } = await this.#client.from("task_files").insert({
        task_id: taskId,
        agent_id: this.#credentials.agent_id,
        direction: "out",
        name: entry.split(path.sep).join("/"),
        path: storagePath,
        size: info.size,
      });
      if (registerError && registerError.code !== "23505") log("outputs.register.failed", { taskId, file: entry, error: registerError });
      uploaded += 1;
    }
    if (uploaded) log("outputs.uploaded", { taskId, count: uploaded });
    return uploaded;
  }

  async #uploadTranscript(taskId: string): Promise<void> {
    const localPath = path.join(this.#workdir(taskId), "transcript.log");
    const info = await stat(localPath).catch(() => null);
    if (!info?.isFile() || info.size === 0 || info.size > maxOutputFileBytes) return;
    const storagePath = `${taskId}/log/transcript.log`;
    const { error: uploadError } = await this.#client.storage.from("task-files")
      .upload(storagePath, await readFile(localPath), { upsert: true, contentType: "text/plain; charset=utf-8" });
    if (uploadError) {
      log("transcript.upload.failed", { taskId, error: uploadError });
      return;
    }
    const { error: registerError } = await this.#client.from("task_files").insert({
      task_id: taskId, agent_id: this.#credentials.agent_id, direction: "log",
      name: "transcript.log", path: storagePath, size: info.size, mime: "text/plain",
    });
    if (registerError && registerError.code !== "23505") log("transcript.register.failed", { taskId, error: registerError });
  }

  async #answeredInteractions(taskId: string): Promise<InteractionRecord[]> {
    const { data, error } = await this.#client.from("task_interactions")
      .select("*").eq("task_id", taskId).not("answer", "is", null).order("asked_at");
    if (error) {
      log("interactions.load.failed", { taskId, error });
      return [];
    }
    return (data ?? []) as InteractionRecord[];
  }

  async #askOperator(taskId: string, question: string, options: string, context: string): Promise<void> {
    const { error } = await this.#client.from("task_interactions").insert({
      task_id: taskId,
      agent_id: this.#credentials.agent_id,
      question: question.slice(0, 4000),
      options: options || null,
      context: context || null,
    });
    if (error) throw error;
    await this.#updateTask(taskId, { status: "waiting_input", progress: `Waiting for operator: ${question.slice(0, 160)}` });
    log("task.waiting_input", { taskId });
  }

  async #updateTask(taskId: string, values: Record<string, unknown>): Promise<void> {
    const { error } = await this.#client.from("tasks").update(values).eq("id", taskId);
    if (error) throw error;
  }

  #cancelLocal(taskId: string): void {
    const running = this.#running.get(taskId);
    if (!running) return;
    this.#cancelled.add(taskId);
    running.controller.abort();
    log("task.cancelled", { taskId });
  }

  #progressReporter(taskId: string): (line: string) => void {
    let lastReportedAt = 0;
    return (line: string) => {
      const now = Date.now();
      if (now - lastReportedAt < this.#config.executor.progress_interval_seconds * 1000) return;
      lastReportedAt = now;
      this.#updateTask(taskId, { progress: line }).catch((error) => log("progress.failed", { taskId, error }));
    };
  }

  async #runTask(task: TaskRecord, signal: AbortSignal): Promise<void> {
    try {
      const { data, error } = await this.#client.rpc("claim_task", { p_task_id: task.id });
      if (error || !data) return;
      const claimed = (Array.isArray(data) ? data[0] : data) as TaskRecord | undefined;
      if (!claimed) return;
      await this.#updateTask(task.id, { status: "running", progress: "Executor started" });
      await this.#downloadInputs(task.id);
      const prompt = await buildTaskPrompt(this.#config, claimed, await this.#answeredInteractions(task.id));
      const executable = { ...claimed, prompt };
      const execution = await this.#executor(this.#config, executable, signal, this.#progressReporter(task.id));
      const parsed = parseResultBlock(execution.result);
      const result = formatResult(parsed, execution.result, this.#config.executor.result_max_chars);
      if (execution.interrupted && this.#cancelled.has(task.id)) {
        this.#cancelled.delete(task.id);
        return;
      }
      if (!execution.interrupted) await this.#uploadTranscript(task.id).catch((error) => log("transcript.failed", { taskId: task.id, error }));
      if (!execution.timedOut && !execution.interrupted && !parsed.found && execution.exitCode === 0) {
        const question = parseQuestionBlock(execution.result);
        if (question.found) {
          await this.#askOperator(task.id, question.question, question.options, question.context);
          return;
        }
      }
      if (execution.timedOut) {
        await this.#updateTask(task.id, { status: "timeout", progress: "Local executor timed out", result });
      } else if (execution.interrupted) {
        await this.#updateTask(task.id, { status: "failed", progress: "Worker stopped during execution", result });
      } else {
        const delivered = await this.#uploadOutputs(task.id).catch((error) => { log("outputs.failed", { taskId: task.id, error }); return 0; });
        const succeeded = execution.exitCode === 0 && parsed.status !== "failure";
        const progress = succeeded ? (delivered ? `Completed, ${delivered} file(s) delivered` : "Completed") : "Executor failed";
        await this.#updateTask(task.id, { status: succeeded ? "done" : "failed", progress, result });
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
