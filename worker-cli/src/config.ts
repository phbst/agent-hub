import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";

const configSchema = z.object({
  hub: z.object({
    url: z.url().refine((value) => new URL(value).protocol === "https:", "hub.url must use HTTPS"),
    anon_key: z.string().min(20),
    credentials_file: z.string().min(1),
  }),
  agent: z.object({
    name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{1,63}$/),
    labels: z.array(z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/)).max(32).default([]),
    mode: z.enum(["cli", "sdk"]).default("cli"),
    max_concurrency: z.number().int().min(1).max(32).default(1),
    workspace_root: z.string().min(1),
    heartbeat_seconds: z.number().int().min(10).max(300).default(30),
  }),
  executor: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).max(64),
    prompt_stdin: z.boolean().default(true),
    result_max_chars: z.number().int().min(1000).max(1_000_000).default(200_000),
  }),
});

export type WorkerConfig = z.infer<typeof configSchema>;

export function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return path.resolve(value);
}

export async function loadConfig(configPath: string): Promise<WorkerConfig> {
  const source = configSchema.parse(parse(await readFile(expandHome(configPath), "utf8")));
  return {
    ...source,
    hub: { ...source.hub, credentials_file: expandHome(source.hub.credentials_file) },
    agent: { ...source.agent, workspace_root: expandHome(source.agent.workspace_root) },
  };
}
