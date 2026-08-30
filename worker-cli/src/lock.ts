import { readFile, unlink, writeFile } from "node:fs/promises";
import { expandHome } from "./config.js";

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

// One running worker per config file. A second `agenthub start` (or a stale manual run racing the
// installed service) silently steals tasks with outdated in-memory config, so refuse to start.
export async function acquireWorkerLock(configPath: string): Promise<() => Promise<void>> {
  const lockPath = `${expandHome(configPath)}.lock`;
  const existing = await readFile(lockPath, "utf8").catch(() => null);
  if (existing) {
    const pid = Number.parseInt(existing, 10);
    if (Number.isInteger(pid) && pid > 0 && pid !== process.pid && isProcessAlive(pid)) {
      throw new Error(`另一个 worker 已在用同一配置运行 (pid ${pid})。先停掉它,或用 --config 指定不同配置。`);
    }
  }
  await writeFile(lockPath, String(process.pid), { mode: 0o600 });
  return async () => {
    const holder = await readFile(lockPath, "utf8").catch(() => null);
    if (holder?.trim() === String(process.pid)) await unlink(lockPath).catch(() => undefined);
  };
}
