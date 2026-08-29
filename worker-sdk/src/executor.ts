import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { TaskRecord } from "../../shared/types.js";
import type { WorkerConfig } from "../../worker-cli/src/config.js";
import type { ExecutionResult } from "../../worker-cli/src/executor.js";

export async function executeSdkTask(config: WorkerConfig, task: TaskRecord, signal?: AbortSignal): Promise<ExecutionResult> {
  const workdir = path.join(config.agent.workspace_root, task.id);
  await mkdir(workdir, { recursive: true, mode: 0o700 });
  const { query } = await import("@anthropic-ai/claude-agent-sdk");
  const output: string[] = [];
  let failed = false;
  for await (const message of query({
    prompt: task.prompt,
    options: {
      cwd: workdir,
      permissionMode: "acceptEdits",
      maxTurns: 100,
      ...(signal ? { abortController: abortControllerFor(signal) } : {}),
    },
  })) {
    if (message.type === "result") {
      failed = message.subtype !== "success";
      if ("result" in message && typeof message.result === "string") output.push(message.result);
    }
  }
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
