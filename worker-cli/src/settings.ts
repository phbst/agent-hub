import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "smol-toml";
import { expandHome, parseConfig, type WorkerConfig } from "./config.js";

// Raw (pre-validation) config shape used while editing on disk. We validate through parseConfig
// only when the worker actually starts, so partial edits during setup do not hard-fail.
export type RawConfig = Record<string, Record<string, unknown>>;

export interface NewConfigInput {
  hubUrl: string;
  anonKey: string;
  name: string;
  labels: string[];
  mode: "cli" | "sdk";
  maxConcurrency: number;
  workspaceRoot: string;
  executorKind: "sdk" | "codex" | "claude" | "custom";
  model?: string | undefined;
}

export function buildConfig(input: NewConfigInput): RawConfig {
  const executor: Record<string, unknown> = {
    kind: input.executorKind,
    reasoning: "auto",
    permission_mode: "bypassPermissions",
    wrap_prompt: true,
  };
  if (input.model) executor.model = input.model;
  if (input.executorKind === "codex" || input.executorKind === "claude") executor.command = input.executorKind;
  return {
    hub: { url: input.hubUrl, anon_key: input.anonKey, credentials_file: "~/.config/agent-hub/credentials.json" },
    agent: {
      name: input.name,
      labels: input.labels,
      mode: input.mode,
      max_concurrency: input.maxConcurrency,
      workspace_root: input.workspaceRoot,
      heartbeat_seconds: 30,
    },
    executor,
    paths: { skills_dir: "~/.config/agent-hub/skills" },
  };
}

export async function readRaw(configPath: string): Promise<RawConfig> {
  return parse(await readFile(expandHome(configPath), "utf8")) as RawConfig;
}

export async function writeRaw(configPath: string, raw: RawConfig): Promise<void> {
  const resolved = expandHome(configPath);
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  await writeFile(resolved, stringify(raw), { mode: 0o600 });
}

const coercers: Record<string, (value: string) => unknown> = {
  "agent.labels": (value) => value.split(",").map((item) => item.trim()).filter(Boolean),
  "agent.max_concurrency": Number,
  "agent.heartbeat_seconds": Number,
  "executor.max_turns": Number,
  "executor.progress_interval_seconds": Number,
  "executor.result_max_chars": Number,
  "executor.wrap_prompt": (value) => value === "true",
};

export async function setValue(configPath: string, dottedKey: string, value: string): Promise<WorkerConfig> {
  const [section, key] = dottedKey.split(".");
  if (!section || !key) throw new Error(`key must be section.key, got: ${dottedKey}`);
  const raw = await readRaw(configPath);
  raw[section] ??= {};
  raw[section]![key] = coercers[dottedKey] ? coercers[dottedKey]!(value) : value;
  const validated = parseConfig(stringify(raw)); // validate before persisting
  await writeRaw(configPath, raw);
  return validated;
}
