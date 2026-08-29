import { writeCredentials } from "./credentials.js";
import type { WorkerConfig } from "./config.js";

interface RegistrationResponse {
  status: string;
  agent_id?: string;
  credentials?: { email: string; password: string };
  error?: string;
}

async function callRegister(config: WorkerConfig, body: Record<string, unknown>): Promise<RegistrationResponse> {
  const response = await fetch(`${config.hub.url}/functions/v1/register`, {
    method: "POST",
    headers: { "content-type": "application/json", apikey: config.hub.anon_key },
    body: JSON.stringify(body),
  });
  const payload = (await response.json()) as RegistrationResponse;
  if (!response.ok && response.status !== 202) throw new Error(payload.error ?? `registration failed: ${response.status}`);
  return payload;
}

export async function register(config: WorkerConfig, bootstrapToken: string): Promise<void> {
  let action = "register";
  for (;;) {
    const response = await callRegister(config, {
      action,
      bootstrap_token: bootstrapToken,
      name: config.agent.name,
      labels: config.agent.labels,
      mode: config.agent.mode,
      max_concurrency: config.agent.max_concurrency,
    });
    if (response.credentials && response.agent_id) {
      await writeCredentials(config.hub.credentials_file, { agent_id: response.agent_id, ...response.credentials });
      process.stdout.write(`Agent approved and credentials saved to ${config.hub.credentials_file}\n`);
      return;
    }
    process.stdout.write(`Registration status: ${response.status}; waiting for administrator approval...\n`);
    action = "status";
    await new Promise((resolve) => setTimeout(resolve, 10_000));
  }
}
