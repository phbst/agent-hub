#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { readCredentials } from "./credentials.js";
import { register } from "./registration.js";
import { Worker } from "./worker.js";
import { acquireWorkerLock } from "./lock.js";

process.umask(0o077);

const [command = "start", ...args] = process.argv.slice(2);
const configIndex = args.indexOf("--config");
const configPath = configIndex >= 0 ? args[configIndex + 1] : process.env.AGENT_HUB_CONFIG ?? "~/.config/agent-hub/worker.toml";
if (!configPath) throw new Error("--config requires a path");
const config = await loadConfig(configPath);

if (command === "register") {
  const tokenIndex = args.indexOf("--bootstrap-token");
  const token = tokenIndex >= 0 ? args[tokenIndex + 1] : process.env.AGENT_HUB_BOOTSTRAP_TOKEN;
  if (!token) throw new Error("register requires --bootstrap-token or AGENT_HUB_BOOTSTRAP_TOKEN");
  await register(config, token);
} else if (command === "start") {
  const releaseLock = await acquireWorkerLock(configPath);
  const worker = new Worker(config, await readCredentials(config.hub.credentials_file));
  await worker.start();
  let stopping = false;
  await new Promise<void>((resolve) => {
    const stop = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      try {
        await worker.stop();
      } finally {
        await releaseLock();
        resolve();
      }
    };
    process.once("SIGINT", () => void stop());
    process.once("SIGTERM", () => void stop());
  });
  process.exit(0);
} else {
  throw new Error(`unknown command: ${command}`);
}
