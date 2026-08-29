import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { TaskRecord } from "../../shared/types.js";
import type { WorkerConfig } from "./config.js";

export interface ExecutionResult {
  result: string;
  exitCode: number;
  timedOut: boolean;
  interrupted?: boolean;
}

function replaceTokens(value: string, workdir: string, task: TaskRecord): string {
  return value.replaceAll("{workdir}", workdir).replaceAll("{task_id}", task.id);
}

export async function executeTask(config: WorkerConfig, task: TaskRecord, signal?: AbortSignal): Promise<ExecutionResult> {
  const workdir = path.join(config.agent.workspace_root, task.id);
  await mkdir(workdir, { recursive: true, mode: 0o700 });
  const args = config.executor.args.map((argument) => replaceTokens(argument, workdir, task));
  return new Promise((resolve, reject) => {
    const child = spawn(config.executor.command, args, {
      cwd: workdir,
      env: { ...process.env, AGENT_HUB_TASK_ID: task.id },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    const collect = (target: Buffer[], chunk: Buffer, current: number): number => {
      if (current >= config.executor.result_max_chars) return current;
      const next = chunk.subarray(0, config.executor.result_max_chars - current);
      target.push(next);
      return current + next.length;
    };
    child.stdout.on("data", (chunk: Buffer) => { outputBytes = collect(output, chunk, outputBytes); });
    child.stderr.on("data", (chunk: Buffer) => { errorBytes = collect(errors, chunk, errorBytes); });
    let timedOut = false;
    let interrupted = false;
    const terminate = (): void => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    };
    const onAbort = (): void => { interrupted = true; terminate(); };
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, task.timeout_minutes * 60_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      const stdout = Buffer.concat(output).toString("utf8").trim();
      const stderr = Buffer.concat(errors).toString("utf8").trim();
      resolve({ result: stdout || stderr || `Executor exited with code ${code ?? -1}`, exitCode: code ?? -1, timedOut, interrupted });
    });
    if (config.executor.prompt_stdin) child.stdin.end(task.prompt);
    else child.stdin.end();
  });
}
