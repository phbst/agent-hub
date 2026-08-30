import { describe, expect, it } from "vitest";
import { builtinSkills, renderSkill } from "../shared/skills.js";

describe("renderSkill", () => {
  it("fills task, continuation and protocol placeholders", () => {
    const skill = builtinSkills.find((item) => item.name === "coding")!;
    const rendered = renderSkill(skill.template, { prompt: "重构 utils" }, [
      { question: "用哪个测试框架?", answer: "vitest" },
    ]);
    expect(rendered).toContain("重构 utils");
    expect(rendered).toContain("Prior decisions");
    expect(rendered).toContain("vitest");
    expect(rendered).toContain("===RESULT===");
    expect(rendered).toContain("===QUESTION===");
  });

  it("appends the protocol when a custom template omits the placeholder", () => {
    const rendered = renderSkill("只做这个: {{TASK}}", { prompt: "打包" });
    expect(rendered).toContain("打包");
    expect(rendered).toContain("===RESULT===");
  });

  it("every builtin skill keeps the task placeholder", () => {
    for (const skill of builtinSkills) expect(skill.template).toContain("{{TASK}}");
  });
});
