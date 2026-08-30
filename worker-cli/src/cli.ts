#!/usr/bin/env node
import { type CommandDefinition, createContext } from "./cli/context.js";
import { machineCommands } from "./cli/machine.js";
import { configureCommands } from "./cli/configure.js";
import { manageCommands } from "./cli/manage.js";
import { bold, dim, padEndVisual } from "./cli/ui.js";

process.umask(0o077);

const commands: CommandDefinition[] = [...machineCommands, ...configureCommands, ...manageCommands];
const registry = new Map(commands.map((command) => [command.name, command]));

function renderHelp(): void {
  const out = (line = "") => process.stdout.write(`${line}\n`);
  out(bold("agenthub") + dim(" — Agent Hub worker & 管理 CLI"));
  out(dim("用法: agenthub <命令> [参数] [--config <path>]"));
  const groups: Array<CommandDefinition["group"]> = ["机器", "配置", "管理"];
  const labels: Record<CommandDefinition["group"], string> = { 机器: "机器 / 运行", 配置: "配置", 管理: "管理台功能 (先 agenthub admin login)" };
  const width = Math.max(...commands.map((command) => command.name.length));
  for (const group of groups) {
    out(`\n${bold(labels[group])}`);
    for (const command of commands.filter((command) => command.group === group)) {
      out(`  ${padEndVisual(command.name, width)}  ${dim(command.describe)}`);
    }
  }
  out(dim("\nworker 以 bypass 权限在工作目录起会话,具备本机(当前用户)的 npm 等能力;token 自动刷新长期在线。"));
  out(dim("单条命令详细用法见 --help 或各命令的错误提示。"));
}

const ctx = createContext(process.argv.slice(2));
const name = ctx.positional[0] ?? "help";

if (name === "help" || name === "--help" || name === "-h") {
  renderHelp();
} else {
  const command = registry.get(name);
  if (!command) {
    process.stderr.write(`agenthub: 未知命令 "${name}"(agenthub help 查看用法)\n`);
    process.exit(1);
  }
  if (ctx.flags.get("help") === "true") {
    process.stdout.write(`${command.usage}\n${command.describe}\n`);
  } else {
    try {
      await command.run(ctx);
    } catch (error) {
      process.stderr.write(`agenthub: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
  }
}
