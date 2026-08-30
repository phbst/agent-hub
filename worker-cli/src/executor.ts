import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
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

export type ProgressReporter = (line: string) => void;

function replaceTokens(value: string, workdir: string, task: TaskRecord): string {
  return value.replaceAll("{workdir}", workdir).replaceAll("{task_id}", task.id);
}

// Build the executor command line. When `args` is configured it wins (custom kind); otherwise we
// generate the standard invocation for the chosen CLI, injecting the default model and the
// bypass-permission flags so sessions run with full local (npm/root-of-this-user) capability.
export function resolveCommand(config: WorkerConfig, workdir: string): { command: string; args: string[] } {
  const { kind, command, args, model, reasoning } = config.executor;
  if (kind === "custom" || args.length > 0) {
    return { command, args };
  }
  if (kind === "claude") {
    return {
      command: command === "codex" ? "claude" : command,
      args: [
        "-p",
        ...(model ? ["--model", model] : []),
        "--permission-mode", config.executor.permission_mode,
        ...(config.executor.permission_mode === "bypassPermissions" ? ["--dangerously-skip-permissions"] : []),
        "--output-format", "stream-json", "--verbose",
      ],
    };
  }
  // codex (default)
  const bypass = config.executor.permission_mode === "bypassPermissions";
  return {
    command: command === "claude" ? "codex" : command,
    args: [
      "exec", "--skip-git-repo-check", "-C", workdir,
      ...(model ? ["-m", model] : []),
      ...(reasoning !== "auto" ? ["-c", `model_reasoning_effort=${reasoning}`] : []),
      ...(bypass ? ["--dangerously-bypass-approvals-and-sandbox"] : ["--sandbox", "workspace-write"]),
      "-",
    ],
  };
}

function lastMeaningfulLine(chunk: Buffer): string | null {
  const lines = chunk.toString("utf8").split("\n").map((line) => line.trim()).filter(Boolean);
  const line = lines[lines.length - 1];
  return line ? line.slice(0, 200) : null;
}

export async function executeTask(config: WorkerConfig, task: TaskRecord, signal?: AbortSignal, onProgress?: ProgressReporter): Promise<ExecutionResult> {
  const workdir = path.join(config.agent.workspace_root, task.id);
  await mkdir(workdir, { recursive: true, mode: 0o700 });
  const resolved = resolveCommand(config, workdir);
  const args = resolved.args.map((argument) => replaceTokens(argument, workdir, task));
  const transcript = createWriteStream(path.join(workdir, "transcript.log"), { flags: "a", mode: 0o600 });
  transcript.write(`\n===== turn started ${new Date().toISOString()} =====\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, args, {
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
    child.stdout.on("data", (chunk: Buffer) => {
      outputBytes = collect(output, chunk, outputBytes);
      transcript.write(chunk);
      if (onProgress) {
        const line = lastMeaningfulLine(chunk);
        if (line) onProgress(line);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      errorBytes = collect(errors, chunk, errorBytes);
      transcript.write(chunk);
    });
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
      transcript.end(`\n===== executor error: ${error.message} =====\n`);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      transcript.end(`\n===== turn ended (exit ${code ?? -1}) ${new Date().toISOString()} =====\n`);
      const stdout = Buffer.concat(output).toString("utf8").trim();
      const stderr = Buffer.concat(errors).toString("utf8").trim();
      resolve({ result: stdout || stderr || `Executor exited with code ${code ?? -1}`, exitCode: code ?? -1, timedOut, interrupted });
    });
    if (config.executor.prompt_stdin) child.stdin.end(task.prompt);
    else child.stdin.end();
  });
}
