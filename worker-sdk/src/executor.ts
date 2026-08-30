import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { TaskRecord } from "../../shared/types.js";
import type { WorkerConfig } from "../../worker-cli/src/config.js";
import type { ExecutionResult, ProgressReporter } from "../../worker-cli/src/executor.js";

function assistantTextOf(message: unknown): string | null {
  if (!message || typeof message !== "object") return null;
  const container = message as { type?: string; message?: { content?: Array<{ type?: string; text?: string }> } };
  if (container.type !== "assistant" || !Array.isArray(container.message?.content)) return null;
  const text = container.message.content.find((part) => part.type === "text" && typeof part.text === "string")?.text;
  const firstLine = text?.split("\n").map((line) => line.trim()).find(Boolean);
  return firstLine ? firstLine.slice(0, 200) : null;
}

export async function executeSdkTask(config: WorkerConfig, task: TaskRecord, signal?: AbortSignal, onProgress?: ProgressReporter): Promise<ExecutionResult> {
  const workdir = path.join(config.agent.workspace_root, task.id);
  await mkdir(workdir, { recursive: true, mode: 0o700 });
  const { createWriteStream } = await import("node:fs");
  const transcript = createWriteStream(path.join(workdir, "transcript.log"), { flags: "a", mode: 0o600 });
  transcript.write(`\n===== turn started ${new Date().toISOString()} =====\n`);
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const output: string[] = [];
  let failed = false;
  for await (const message of query({
    prompt: task.prompt,
    options: {
      cwd: workdir,
      permissionMode: config.executor.permission_mode,
      maxTurns: config.executor.max_turns,
      ...(config.executor.model ? { model: config.executor.model } : {}),
      ...(signal ? { abortController: abortControllerFor(signal) } : {}),
    },
  })) {
    try { transcript.write(`${JSON.stringify(message)}\n`); } catch { /* non-serializable message */ }
    if (onProgress) {
      const text = assistantTextOf(message);
      if (text) onProgress(text);
    }
    if (message.type === "result") {
      failed = message.subtype !== "success";
      if ("result" in message && typeof message.result === "string") output.push(message.result);
    }
  }
  transcript.end(`===== turn ended ${new Date().toISOString()} =====\n`);
  return {
    result: output.join("\n\n").slice(0, config.executor.result_max_chars) || "Claude Agent SDK completed without a text result.",
    exitCode: failed ? 1 : 0,
    timedOut: false,
  };
}

function abortControllerFor(signal: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}
