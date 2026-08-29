import { describe, expect, it } from "vitest";
import { canTransition, chooseAgent } from "../shared/scheduler.js";
import type { AgentRecord, TaskRecord } from "../shared/types.js";

const now = new Date().toISOString();
function agent(overrides: Partial<AgentRecord>): AgentRecord {
  return {
    id: crypto.randomUUID(), name: "agent", labels: [], mode: "cli", status: "online",
    max_concurrency: 2, running_count: 0, last_heartbeat: now, auth_user_id: crypto.randomUUID(), created_at: now,
    ...overrides,
  };
}
function task(target: TaskRecord["target"]): TaskRecord {
  return {
    id: crypto.randomUUID(), title: "task", prompt: "do it", source: "web", source_msg_id: null,
    target, assigned_to: null, status: "pending", progress: null, result: null, priority: 0,
    timeout_minutes: 60, retry_count: 0, created_at: now, claimed_at: null, finished_at: null,
  };
}

describe("scheduler", () => {
  it("chooses the lowest normalized load and uses mode as a tie breaker", () => {
    const busy = agent({ name: "busy-sdk", mode: "sdk", running_count: 2 });
    const cli = agent({ name: "idle-cli", mode: "cli" });
    const sdk = agent({ name: "idle-sdk", mode: "sdk" });
    expect(chooseAgent(task({ type: "auto" }), [busy, cli, sdk])?.name).toBe("idle-sdk");
  });

  it("respects directed and all-label targeting", () => {
    const linux = agent({ name: "linux", labels: ["linux"] });
    const gpu = agent({ name: "gpu", labels: ["linux", "gpu"] });
    expect(chooseAgent(task({ type: "agent", name: "linux" }), [linux, gpu])?.id).toBe(linux.id);
    expect(chooseAgent(task({ type: "label", labels: ["linux", "gpu"] }), [linux, gpu])?.id).toBe(gpu.id);
  });

  it("enforces terminal states", () => {
    expect(canTransition("assigned", "claimed")).toBe(true);
    expect(canTransition("running", "done")).toBe(true);
    expect(canTransition("done", "running")).toBe(false);
  });
});
