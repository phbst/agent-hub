import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

const configSchema = z.object({
  hub: z.object({
    url: z.url().refine((value) => new URL(value).protocol === "https:", "hub.url must use HTTPS"),
    anon_key: z.string().min(20),
    credentials_file: z.string().min(1).default("~/.config/agent-hub/credentials.json"),
  }),
  agent: z.object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{1,63}$/),
    labels: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/)).max(32).default([]),
    mode: z.enum(["cli", "sdk"]).default("sdk"),
    max_concurrency: z.number().int().min(1).max(32).default(2),
    workspace_root: z.string().min(1).default("~/agent-hub-workspaces"),
    heartbeat_seconds: z.number().int().min(10).max(300).default(30),
  }),
  executor: z.object({
    kind: z.enum(["sdk", "codex", "claude", "custom"]).default("sdk"),
    model: z.string().max(120).optional(),
    reasoning: z.enum(["low", "medium", "high", "auto"]).default("auto"),
    permission_mode: z.enum(["bypassPermissions", "acceptEdits", "default", "plan"]).default("bypassPermissions"),
    skill: z.string().max(120).optional(),
    command: z.string().min(1).default("codex"),
    args: z.array(z.string()).max(64).default([]),
    prompt_stdin: z.boolean().default(true),
    wrap_prompt: z.boolean().default(true),
    progress_interval_seconds: z.number().int().min(5).max(600).default(30),
    result_max_chars: z.number().int().min(1000).max(1_000_000).default(200_000),
    max_turns: z.number().int().min(1).max(1000).default(120),
  }),
  paths: z.object({
    skills_dir: z.string().min(1).default("~/.config/agent-hub/skills"),
  }).default({ skills_dir: "~/.config/agent-hub/skills" }),
});

export type WorkerConfig = z.infer<typeof configSchema>;

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return path.resolve(value);
}

export function parseConfig(source: string): WorkerConfig {
  const parsed = configSchema.parse(parse(source));
  return {
    ...parsed,
    hub: { ...parsed.hub, credentials_file: expandHome(parsed.hub.credentials_file) },
    agent: { ...parsed.agent, workspace_root: expandHome(parsed.agent.workspace_root) },
    paths: { skills_dir: expandHome(parsed.paths.skills_dir) },
  };
}

export async function loadConfig(configPath: string): Promise<WorkerConfig> {
  return parseConfig(await readFile(expandHome(configPath), "utf8"));
}

export const defaultConfigPath = process.env.AGENT_HUB_CONFIG ?? "~/.config/agent-hub/worker.toml";
