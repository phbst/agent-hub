import { spawn } from "node:child_process";
import { loadConfig } from "../config.js";
import { setValue } from "../settings.js";
import { buildTaskPrompt, listSkills, skillFilePath, writeCustomSkill } from "../skills.js";
import type { CommandDefinition } from "./context.js";
import { bold, dim, green, heading, kv, note, ok, table } from "./ui.js";
import { pickService, services } from "./machine.js";

export const configureCommands: CommandDefinition[] = [
  {
    name: "config",
    group: "配置",
    usage: "agenthub config show | set <section.key> <value>",
    describe: "查看 / 修改任意配置项",
    run: async (ctx) => {
      if (ctx.positional[1] === "set") {
        const [, , key, value] = ctx.positional;
        if (!key || value === undefined) ctx.fail("用法: agenthub config set <section.key> <value>");
        await setValue(ctx.configPath, key!, value!);
        ctx.out(ok(`${key} = ${value}`));
        return;
      }
      const config = await loadConfig(ctx.configPath);
      ctx.out(kv([
        ["hub.url", config.hub.url],
        ["hub.anon_key", `${config.hub.anon_key.slice(0, 10)}…`],
        ["agent.name", config.agent.name],
        ["agent.mode", config.agent.mode],
        ["agent.labels", config.agent.labels.join(", ") || dim("无")],
        ["agent.max_concurrency", String(config.agent.max_concurrency)],
        ["agent.workspace_root", config.agent.workspace_root],
        ["executor.kind", config.executor.kind],
        ["executor.model", config.executor.model ?? dim("默认")],
        ["executor.reasoning", config.executor.reasoning],
        ["executor.permission_mode", config.executor.permission_mode],
        ["executor.skill", config.executor.skill ?? dim("内置 default")],
      ]));
    },
  },
  {
    name: "service",
    group: "配置",
    usage: "agenthub service [sdk|codex|claude|custom]",
    describe: "查看 / 设置默认执行服务",
    run: async (ctx) => {
      const target = ctx.positional[1];
      const svc = target
        ? Object.values(services).find((item) => item.kind === target) ?? ctx.fail("用法: agenthub service <sdk|codex|claude|custom>")
        : await pickService(ctx);
      await setValue(ctx.configPath, "agent.mode", svc.mode);
      await setValue(ctx.configPath, "executor.kind", svc.kind);
      ctx.out(ok(`默认执行服务 → ${bold(svc.kind)} (模式 ${svc.mode})`));
    },
  },
  {
    name: "model",
    group: "配置",
    usage: "agenthub model [name]",
    describe: "查看 / 设置默认模型",
    run: async (ctx) => {
      if (ctx.positional[1]) {
        await setValue(ctx.configPath, "executor.model", ctx.positional[1]!);
        ctx.out(ok(`默认模型 → ${ctx.positional[1]}`));
      } else {
        const config = await loadConfig(ctx.configPath);
        ctx.out(config.executor.model ?? dim("(执行器默认)"));
        ctx.out(note("常用: claude-fable-5(默认)· claude-opus-5 · claude-sonnet-5 · codex: gpt-5.6-sol(默认)"));
      }
    },
  },
  {
    name: "workspace",
    group: "配置",
    usage: "agenthub workspace [path]",
    describe: "查看 / 设置持久工作目录",
    run: async (ctx) => {
      if (ctx.positional[1]) {
        await setValue(ctx.configPath, "agent.workspace_root", ctx.positional[1]!);
        ctx.out(ok(`工作目录 → ${ctx.positional[1]}`));
      } else {
        ctx.out((await loadConfig(ctx.configPath)).agent.workspace_root);
      }
    },
  },
  {
    name: "skill",
    group: "配置",
    usage: "agenthub skill list|init|dir|show|use|new|edit|preview",
    describe: "管理派发任务使用的 prompt skill",
    run: async (ctx) => {
      const config = await loadConfig(ctx.configPath);
      const sub = ctx.positional[1] ?? "list";
      if (sub === "list") {
        const skills = await listSkills(config);
        ctx.out(table(
          [{ header: "" }, { header: "SKILL" }, { header: "来源" }, { header: "说明", max: 46 }],
          skills.map((skill) => [
            skill.name === config.executor.skill ? green("●") : dim("○"),
            skill.name,
            skill.builtin ? dim("内置") : "自定义",
            skill.description,
          ]),
        ));
        ctx.out(note(`\n当前: ${config.executor.skill ?? "内置 default"} · 切换: agenthub skill use <name>`));
        ctx.out(note(`目录: ${config.paths.skills_dir}(直接增改 *.md 即生效;agenthub skill init 可导出内置模板)`));
        return;
      }
      if (sub === "dir") {
        ctx.out(config.paths.skills_dir);
        return;
      }
      if (sub === "init") {
        const existing = new Set((await listSkills(config)).filter((s) => !s.builtin).map((s) => s.name));
        let exported = 0;
        for (const skill of await listSkills(config)) {
          if (!skill.builtin || existing.has(skill.name)) continue;
          await writeCustomSkill(config, skill.name, skill.template, skill.description);
          exported += 1;
        }
        ctx.out(ok(`已导出 ${exported} 个内置 skill 到 ${config.paths.skills_dir}`));
        ctx.out(note("直接编辑目录里的 *.md(同名覆盖内置);新建 <名字>.md 即新增 skill,无需其他命令。"));
        ctx.out(note("文件格式:开头 --- name/description --- 的 frontmatter,正文为模板,含 {{TASK}}/{{CONTINUATION}}/{{PROTOCOL}} 占位符。"));
        return;
      }
      if (sub === "show") {
        const skill = (await listSkills(config)).find((s) => s.name === ctx.positional[2]);
        if (!skill) ctx.fail(`skill not found: ${ctx.positional[2]}`);
        ctx.out(skill!.template);
        return;
      }
      if (sub === "use") {
        const name = ctx.positional[2];
        if (!name) ctx.fail("用法: agenthub skill use <name>");
        if (!(await listSkills(config)).some((s) => s.name === name)) ctx.fail(`skill not found: ${name}`);
        await setValue(ctx.configPath, "executor.skill", name!);
        ctx.out(ok(`已切换 skill → ${name}`));
        return;
      }
      if (sub === "new" || sub === "edit") {
        const name = ctx.positional[2];
        if (!name) ctx.fail(`用法: agenthub skill ${sub} <name>`);
        const file = sub === "new"
          ? await writeCustomSkill(config, name!, "你在执行一个远程任务。\n\n## 任务\n{{TASK}}\n{{CONTINUATION}}\n\n{{PROTOCOL}}\n", "自定义 skill")
          : await skillFilePath(config, name!);
        const editor = process.env.EDITOR ?? "nano";
        ctx.out(dim(`编辑 ${file} (${editor})`));
        await new Promise<void>((resolve) => {
          const child = spawn(editor, [file], { stdio: "inherit" });
          child.on("close", () => resolve());
          child.on("error", () => {
            ctx.out(note(`无法启动编辑器 ${editor};文件已就位,直接编辑: ${file}`));
            resolve();
          });
        });
        ctx.out(ok(`文件: ${file} · 启用: agenthub skill use ${name}`));
        return;
      }
      if (sub === "preview") {
        ctx.out(heading("当前 skill 渲染预览"));
        ctx.out(await buildTaskPrompt(config, { prompt: "（示例任务）把 utils 里的重复代码抽出来" }, []));
        return;
      }
      ctx.fail(`未知 skill 子命令: ${sub}`);
    },
  },
];
