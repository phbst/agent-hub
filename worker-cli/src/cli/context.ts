import { createInterface } from "node:readline/promises";
import { defaultConfigPath } from "../config.js";

export interface CliContext {
  positional: string[];
  flags: Map<string, string>;
  flagAll: (name: string) => string[];
  configPath: string;
  out: (line?: string) => void;
  fail: (line: string) => never;
  ask: (question: string, fallback?: string) => Promise<string>;
}

export function createContext(argv: string[]): CliContext {
  const flags = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      if (eq >= 0) flags.set(token.slice(2, eq), token.slice(eq + 1));
      else if (argv[i + 1] && !argv[i + 1]!.startsWith("--")) flags.set(token.slice(2), argv[++i]!);
      else flags.set(token.slice(2), "true");
    } else positional.push(token);
  }
  return {
    positional,
    flags,
    flagAll: (name) => {
      const values: string[] = [];
      for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === `--${name}` && argv[i + 1] && !argv[i + 1]!.startsWith("--")) values.push(argv[i + 1]!);
        else if (argv[i]!.startsWith(`--${name}=`)) values.push(argv[i]!.slice(name.length + 3));
      }
      return values;
    },
    configPath: flags.get("config") ?? defaultConfigPath,
    out: (line = "") => process.stdout.write(`${line}\n`),
    fail: (line: string): never => {
      process.stderr.write(`agenthub: ${line}\n`);
      process.exit(1);
    },
    ask: async (question, fallback = "") => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (await rl.question(fallback ? `${question} [${fallback}]: ` : `${question}: `)).trim();
        return answer || fallback;
      } finally {
        rl.close();
      }
    },
  };
}

export interface CommandDefinition {
  name: string;
  group: "机器" | "配置" | "管理";
  usage: string;
  describe: string;
  run: (ctx: CliContext) => Promise<void> | void;
}
