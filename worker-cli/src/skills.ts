import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InteractionRecord, TaskRecord } from "../../shared/types.js";
import { type SkillDefinition, builtinSkills, renderSkill } from "../../shared/skills.js";
import { wrapPrompt } from "../../shared/prompt.js";
import type { WorkerConfig } from "./config.js";

function frontmatter(source: string): { description: string; body: string } {
  const match = source.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return { description: "", body: source.trim() };
  const description = match[1]!.match(/^description:\s*(.*)$/m)?.[1]?.trim() ?? "";
  return { description, body: match[2]!.trim() };
}

export async function listSkills(config: WorkerConfig): Promise<SkillDefinition[]> {
  const custom: SkillDefinition[] = [];
  try {
    const entries = await readdir(config.paths.skills_dir);
    for (const entry of entries.filter((name) => name.endsWith(".md"))) {
      const source = await readFile(path.join(config.paths.skills_dir, entry), "utf8");
      const { description, body } = frontmatter(source);
      custom.push({ name: entry.replace(/\.md$/, ""), description, builtin: false, template: body });
    }
  } catch {
    /* skills dir not created yet */
  }
  const overridden = new Set(custom.map((skill) => skill.name));
  return [...custom, ...builtinSkills.filter((skill) => !overridden.has(skill.name))];
}

export async function resolveSkill(config: WorkerConfig): Promise<SkillDefinition | null> {
  const name = config.executor.skill;
  if (!name) return null;
  const all = await listSkills(config);
  return all.find((skill) => skill.name === name) ?? null;
}

export async function writeCustomSkill(config: WorkerConfig, name: string, template: string, description = ""): Promise<string> {
  await mkdir(config.paths.skills_dir, { recursive: true, mode: 0o700 });
  const file = path.join(config.paths.skills_dir, `${name}.md`);
  const doc = `---\nname: ${name}\ndescription: ${description}\n---\n\n${template.trim()}\n`;
  await writeFile(file, doc, { mode: 0o600 });
  return file;
}

export async function skillFilePath(config: WorkerConfig, name: string): Promise<string> {
  const file = path.join(config.paths.skills_dir, `${name}.md`);
  const builtin = builtinSkills.find((skill) => skill.name === name);
  try {
    await stat(file);
    return file;
  } catch {
    if (builtin) return writeCustomSkill(config, name, builtin.template, builtin.description);
    throw new Error(`skill not found: ${name}`);
  }
}

export async function buildTaskPrompt(
  config: WorkerConfig,
  task: Pick<TaskRecord, "prompt">,
  interactions: Pick<InteractionRecord, "question" | "answer">[],
): Promise<string> {
  if (!config.executor.wrap_prompt) return task.prompt;
  const skill = await resolveSkill(config);
  return skill ? renderSkill(skill.template, task, interactions) : wrapPrompt(task, interactions);
}
