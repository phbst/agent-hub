export const agentModes = ["sdk", "cli", "session"] as const;
export const agentStatuses = ["pending_approval", "online", "offline", "revoked"] as const;
export const taskStatuses = [
  "pending",
  "assigned",
  "claimed",
  "running",
  "waiting_input",
  "done",
  "failed",
  "timeout",
  "cancelled",
] as const;

export type AgentMode = (typeof agentModes)[number];
export type AgentStatus = (typeof agentStatuses)[number];
export type TaskStatus = (typeof taskStatuses)[number];

export type TaskTarget =
  | { type: "auto" }
  | { type: "agent"; name: string }
  | { type: "label"; labels: string[] };

export interface AgentRecord {
  id: string;
  name: string;
  labels: string[];
  mode: AgentMode;
  status: AgentStatus;
  max_concurrency: number;
  running_count: number;
  paused: boolean;
  last_heartbeat: string | null;
  auth_user_id: string | null;
  created_at: string;
}

export interface TaskRecord {
  id: string;
  title: string;
  prompt: string;
  source: "wechat" | "web" | "api";
  source_msg_id: string | null;
  target: TaskTarget;
  assigned_to: string | null;
  status: TaskStatus;
  progress: string | null;
  result: string | null;
  priority: number;
  timeout_minutes: number;
  retry_count: number;
  created_at: string;
  claimed_at: string | null;
  finished_at: string | null;
}

export interface InteractionRecord {
  id: string;
  task_id: string;
  agent_id: string | null;
  question: string;
  context: string | null;
  options: string | null;
  answer: string | null;
  answered_via: "web" | "wechat" | "api" | null;
  asked_at: string;
  answered_at: string | null;
}

export interface TaskFileRecord {
  id: string;
  task_id: string;
  agent_id: string | null;
  direction: "in" | "out" | "log";
  name: string;
  path: string;
  size: number | null;
  mime: string | null;
  created_at: string;
}

export interface EventRecord {
  id: number;
  task_id: string | null;
  agent_id: string | null;
  kind: string;
  payload: Record<string, unknown>;
  created_at: string;
}
