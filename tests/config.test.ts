import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../worker-cli/src/config.js";
import { readCredentials } from "../worker-cli/src/credentials.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("worker configuration", () => {
  it("loads a safe argument-array executor", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-config-"));
    directories.push(directory);
    const configPath = path.join(directory, "worker.toml");
    await writeFile(configPath, `[hub]\nurl="https://example.supabase.co"\nanon_key="sb_publishable_1234567890"\ncredentials_file="${directory}/credentials.json"\n[agent]\nname="test-agent"\nlabels=["linux"]\nmode="cli"\nmax_concurrency=1\nworkspace_root="${directory}/workspaces"\nheartbeat_seconds=30\n[executor]\ncommand="codex"\nargs=["exec","-"]\nprompt_stdin=true\nresult_max_chars=200000\n`);
    const config = await loadConfig(configPath);
    expect(config.executor).toMatchObject({ command: "codex", args: ["exec", "-"], prompt_stdin: true });
  });

  it("rejects world-readable credentials", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "agent-hub-credentials-"));
    directories.push(directory);
    const filePath = path.join(directory, "credentials.json");
    await writeFile(filePath, JSON.stringify({ agent_id: crypto.randomUUID(), email: "agent@example.com", password: "a-long-enough-password-value" }));
    await chmod(filePath, 0o644);
    await expect(readCredentials(filePath)).rejects.toThrow(/0600/);
  });
});
