import type { AgentRecord, TaskRecord, TaskStatus } from "./types.js";

const modeRank = { sdk: 0, cli: 1, session: 2 } as const;

export const legalTransitions: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  pending: ["assigned", "cancelled"],
  assigned: ["claimed", "cancelled", "pending"],
  claimed: ["running", "failed", "timeout", "cancelled", "pending"],
  running: ["done", "failed", "timeout", "cancelled", "pending"],
  done: [],
  failed: [],
  timeout: ["pending", "failed"],
  cancelled: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return legalTransitions[from].includes(to);
}

function hasLabels(agent: AgentRecord, labels: string[]): boolean {
  return labels.every((label) => agent.labels.includes(label));
}

export function chooseAgent(task: TaskRecord, agents: AgentRecord[]): AgentRecord | null {
  const online = agents.filter((agent) => agent.status === "online" && agent.max_concurrency > 0);
  const { target } = task;
  let candidates: AgentRecord[];
  if (target.type === "agent") {
    candidates = online.filter((agent) => agent.name === target.name);
  } else if (target.type === "label") {
    candidates = online.filter((agent) => hasLabels(agent, target.labels));
  } else {
    candidates = online;
  }
  return (
    candidates.sort((left, right) => {
      const leftLoad = left.running_count / left.max_concurrency;
      const rightLoad = right.running_count / right.max_concurrency;
      return leftLoad - rightLoad || modeRank[left.mode] - modeRank[right.mode] || left.name.localeCompare(right.name);
    })[0] ?? null
  );
}
