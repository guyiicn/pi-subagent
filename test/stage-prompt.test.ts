import { test } from "node:test";
import assert from "node:assert/strict";
import { buildStagePrompt, buildReviewPrompt, buildUpgradeHint } from "../src/tools/stage-prompt.js";
import type { Stage, Task } from "../src/types.js";

function makeStage(over: Partial<Stage> = {}): Stage {
  return {
    stageId: "2",
    title: "ScaledDotProduct",
    objective: "写缩放点积章节",
    inputFiles: ["_refs.md", "_skeleton.md"],
    outputFile: "02-scaled.html",
    dependsOn: ["1"],
    parallelizable: true,
    attempts: [],
    status: "pending",
    ...over,
  };
}

function makeTask(over: Partial<Task> = {}): Task {
  return {
    taskId: "t1",
    goal: "生成课件",
    cwd: "/proj",
    status: "executing",
    planDraftPath: "_plan-draft.md",
    stages: [],
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

test("buildStagePrompt 含 IOAC 四段", () => {
  const p = buildStagePrompt(makeStage(), makeTask(), 1);
  assert.ok(p.includes("【输入】"), "含 Input 段");
  assert.ok(p.includes("【目标】"), "含 Objective 段");
  assert.ok(p.includes("【约束】"), "含 Action 段");
  assert.ok(p.includes("【验收】"), "含 Check 段");
});

test("buildStagePrompt 输入文件用绝对路径", () => {
  const p = buildStagePrompt(makeStage(), makeTask({ cwd: "/proj" }), 1);
  assert.ok(p.includes("/proj/_refs.md"), "输入文件绝对化");
  assert.ok(p.includes("/proj/_skeleton.md"));
});

test("buildStagePrompt 输出文件绝对路径 + 只写它", () => {
  const p = buildStagePrompt(makeStage(), makeTask({ cwd: "/proj" }), 1);
  assert.ok(p.includes("/proj/02-scaled.html"));
  assert.ok(p.includes("只写"), "强调只写 outputFile");
});

test("buildStagePrompt 含禁联网 + promptHint", () => {
  const p = buildStagePrompt(makeStage({ promptHint: "强调 scale=1/sqrt(dk)" }), makeTask(), 1);
  assert.ok(p.includes("禁联网") || p.includes("不要联网"));
  assert.ok(p.includes("scale=1/sqrt(dk)"), "promptHint 注入");
});

test("buildStagePrompt attempt>1 含升级指令", () => {
  const p = buildStagePrompt(makeStage(), makeTask(), 2,
    { failureType: "no_output", failureDetail: "文件未生成" });
  assert.ok(p.includes("上次失败"), "含上次失败上下文");
  assert.ok(p.includes("write"), "升级指令提到 write");
});

test("buildUpgradeHint: 各 failureType 模板", () => {
  assert.ok(buildUpgradeHint("no_output", "x").includes("write"));
  assert.ok(buildUpgradeHint("incomplete", "缺 h1").includes("补全"));
  assert.ok(buildUpgradeHint("timeout", "x").includes("最小"));
  assert.ok(buildUpgradeHint("stalled", "x").includes("停滞"));
  assert.ok(buildUpgradeHint("pi_refused", "需要更多资料").includes("已有材料"));
  assert.equal(buildUpgradeHint("wrong_content", "x").includes("修正"), true);
});

test("buildReviewPrompt 含审阅指令 + verdict 要求", () => {
  const p = buildReviewPrompt(makeTask({ cwd: "/proj", planDraftPath: "_plan-draft.md" }));
  assert.ok(p.includes("/proj/_plan-draft.md"), "读草案");
  assert.ok(p.includes("verdict"), "要求 verdict");
  assert.ok(p.includes("approve"), "说明 verdict 选项");
  assert.ok(p.includes("_plan-reviewed.md"), "产出文件");
  assert.ok(p.includes("禁联网") || p.includes("不要联网"));
});
