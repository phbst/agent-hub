#!/usr/bin/env node
import { loadConfig } from "../../worker-cli/src/config.js";
import { readCredentials } from "../../worker-cli/src/credentials.js";
import { register } from "../../worker-cli/src/registration.js";
import { Worker } from "../../worker-cli/src/worker.js";
import { executeSdkTask } from "./executor.js";

process.umask(0o077);
const [command = "start", ...args] = process.argv.slice(2);
const configIndex = args.indexOf("--config");
const configPath = configIndex >= 0 ? args[configIndex + 1] : process.env.AGENT_HUB_CONFIG ?? "~/.config/agent-hub/sdk-worker.toml";
if (!configPath) throw new Error("--config requires a path");
const config = await loadConfig(configPath);

if (command === "register") {
  const tokenIndex = args.indexOf("--bootstrap-token");
  const token = tokenIndex >= 0 ? args[tokenIndex + 1] : process.env.AGENT_HUB_BOOTSTRAP_TOKEN;
  if (!token) throw new Error("register requires a bootstrap token");
  await register(config, token);
} else if (command === "start") {
  const worker = new Worker(config, await readCredentials(config.hub.credentials_file), executeSdkTask);
  await worker.start();
  let stopping = false;
  const stop = async () => { if (!stopping) { stopping = true; await worker.stop(); } };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
  while (!stopping) await new Promise((resolve) => setTimeout(resolve, 1000));
} else {
  throw new Error(`unknown command: ${command}`);
}
