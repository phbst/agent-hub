import { describe, expect, it } from "vitest";
import { formatResult, parseQuestionBlock, parseResultBlock, wrapPrompt } from "../shared/prompt.js";

describe("wrapPrompt", () => {
  it("embeds the task text and the result protocol", () => {
    const wrapped = wrapPrompt({ prompt: "fix the failing test" });
    expect(wrapped).toContain("fix the failing test");
    expect(wrapped).toContain("===RESULT===");
    expect(wrapped).toContain("status: success | failure");
  });
});

describe("parseResultBlock", () => {
  it("parses a complete block and uses the last block in the output", () => {
    const output = [
      "===RESULT===", "status: failure", "summary: first attempt", "===END===",
      "retrying...",
      "===RESULT===", "status: success", "summary: tests fixed, 12 passing", "detail: patched utils.ts", "===END===",
    ].join("\n");
    const parsed = parseResultBlock(output);
    expect(parsed).toMatchObject({ found: true, status: "success", summary: "tests fixed, 12 passing", detail: "patched utils.ts" });
  });

  it("reports failure status and survives a missing end marker", () => {
    const parsed = parseResultBlock("===RESULT===\nstatus: failure\nsummary: could not reach registry");
    expect(parsed.status).toBe("failure");
    expect(parsed.summary).toBe("could not reach registry");
  });

  it("returns found=false without a block", () => {
    expect(parseResultBlock("plain executor output").found).toBe(false);
  });
});

describe("formatResult", () => {
  it("prefers the parsed summary and truncates to the limit", () => {
    const parsed = parseResultBlock("===RESULT===\nstatus: success\nsummary: done\ndetail: extras\n===END===");
    expect(formatResult(parsed, "raw", 1000)).toBe("done\n\nextras");
    expect(formatResult(parsed, "raw", 4)).toBe("done");
  });

  it("falls back to raw output when no block exists", () => {
    const parsed = parseResultBlock("raw output only");
    expect(formatResult(parsed, "raw output only", 1000)).toBe("raw output only");
  });
});

describe("parseQuestionBlock", () => {
  it("parses question, options and context", () => {
    const output = [
      "did some work",
      "===QUESTION===",
      "question: 迁移会锁表 3 分钟，现在执行吗？",
      "options: A) 现在 B) 低峰期",
      "context: schema diff 已生成在 migration.sql",
      "===END===",
    ].join("\n");
    const parsed = parseQuestionBlock(output);
    expect(parsed.found).toBe(true);
    expect(parsed.question).toContain("锁表");
    expect(parsed.options).toContain("低峰期");
    expect(parsed.context).toContain("migration.sql");
  });

  it("is not found for plain output or result blocks", () => {
    expect(parseQuestionBlock("just output").found).toBe(false);
    expect(parseQuestionBlock("===RESULT===\nstatus: success\nsummary: done\n===END===").found).toBe(false);
  });
});

describe("wrapPrompt continuation", () => {
  it("includes answered interactions and the resume instruction", () => {
    const wrapped = wrapPrompt({ prompt: "migrate the table" }, [
      { question: "现在执行还是低峰期？", answer: "低峰期，凌晨 2 点后" },
    ]);
    expect(wrapped).toContain("Prior decisions");
    expect(wrapped).toContain("低峰期，凌晨 2 点后");
    expect(wrapped).toContain("do not start over");
  });
});

describe("echoed prompt templates are not parsed as answers", () => {
  const echoedPrompt = wrapPrompt({ prompt: "do the thing" });
  it("ignores the protocol template when the executor only echoed the prompt", () => {
    expect(parseResultBlock(echoedPrompt).found).toBe(false);
    expect(parseQuestionBlock(echoedPrompt).found).toBe(false);
  });
  it("still finds the real block after an echoed prompt", () => {
    const output = `${echoedPrompt}\n模型输出...\n===RESULT===\nstatus: success\nsummary: 真结果\n===END===`;
    const parsed = parseResultBlock(output);
    expect(parsed.status).toBe("success");
    expect(parsed.summary).toBe("真结果");
  });
});
