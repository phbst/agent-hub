import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const credentialsSchema = z.object({
  agent_id: z.uuid(),
  email: z.email(),
  password: z.string().min(20),
});

export type WorkerCredentials = z.infer<typeof credentialsSchema>;

export async function readCredentials(filePath: string): Promise<WorkerCredentials> {
  const metadata = await stat(filePath);
  if ((metadata.mode & 0o077) !== 0) throw new Error(`credentials must be mode 0600: ${filePath}`);
  return credentialsSchema.parse(JSON.parse(await readFile(filePath, "utf8")));
}

export async function writeCredentials(filePath: string, credentials: WorkerCredentials): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(credentials, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  await rename(temporary, filePath);
  await chmod(filePath, 0o600);
}
