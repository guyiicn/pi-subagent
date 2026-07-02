import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { SessionRegistry } from "../src/registry/session.js";
import { RunRegistry } from "../src/registry/run.js";
import { ProcessTable } from "../src/runner/process-table.js";
import { TaskRegistry } from "../src/registry/task.js";
import { taskCreate, taskList, taskStageRun, taskPlan, applyReviewResult } from "../src/tools/task.js";
import { fakePiEnv, tmpCwd, withEnv } from "./helpers.js";

function deps() {
  const tasks = new TaskRegistry();
  return {
    d: { tasks, sessions: new SessionRegistry(), runs: new RunRegistry(), procs: new ProcessTable() },
    tasks,
  };
}

// 准备一个任务目录（含 _plan-draft.md）
function setupTaskDir() {
  const c = tmpCwd();
  writeFileSync(`${c.dir}/_plan-draft.md`, "# plan\n## stage 1: intro\n");
  return c;
}

function createTask(d: any, cwd: string, over: any = {}) {
  return taskCreate({
    taskId: over.taskId ?? "t1",
    goal: "测试任务",
    cwd,
    planDraftPath: "_plan-draft.md",
    stages: over.stages ?? [
      { stageId: "1", title: "intro", objective: "写 intro", inputFiles: ["_plan-draft.md"], outputFile: "1.html", dependsOn: [], parallelizable: true },
    ],
  }, d);
}

async function drain(d: any, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (d.runs.runningCount() > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (d.runs.runningCount() > 0) {
    d.procs.killAll();
    while (d.runs.runningCount() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }
}

// ===== create / list =====
test("taskCreate 建任务 + stages 初始化 pending", async () => {
  const c = setupTaskDir();
  await withEnv(fakePiEnv("success"), async () => {
    const { d } = deps();
    const { task } = createTask(d, c.dir);
    assert.equal(task.status, "planning");
    assert.equal(task.stages[0].status, "pending");
  });
  c.cleanup();
});

test("taskCreate planDraft 不存在 → plan_draft_missing", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("success"), async () => {
    const { d } = deps();
    assert.throws(
      () => taskCreate({ taskId: "t1", goal: "g", cwd: c.dir, planDraftPath: "_plan-draft.md", stages: [] }, d),
      (e: any) => e.code === "plan_draft_missing",
    );
  });
  c.cleanup();
});

test("taskCreate taskId 重复 → task_conflict", async () => {
  const c = setupTaskDir();
  await withEnv(fakePiEnv("success"), async () => {
    const { d } = deps();
    createTask(d, c.dir);
    assert.throws(() => createTask(d, c.dir), (e: any) => e.code === "task_conflict");
  });
  c.cleanup();
});

test("taskList 按 taskId / status 过滤", async () => {
  const c = setupTaskDir();
  await withEnv(fakePiEnv("success"), async () => {
    const { d, tasks } = deps();
    createTask(d, c.dir);
    assert.equal(taskList({ tasks }, { taskId: "t1" }).tasks.length, 1);
    assert.equal(taskList({ tasks }, { taskId: "nope" }).tasks.length, 0);
    assert.equal(taskList({ tasks }, { status: "planning" }).tasks.length, 1);
    assert.equal(taskList({ tasks }, { status: "completed" }).tasks.length, 0);
  });
  c.cleanup();
});

// ===== stage_run 成功路径 =====
test("stage_run 成功：stage_success 模式写出文件 → passed", async () => {
  const c = setupTaskDir();
  await withEnv({ ...fakePiEnv("stage_success"), FAKE_OUTPUT_FILE: `${c.dir}/1.html` }, async () => {
    const { d } = deps();
    createTask(d, c.dir);
    const res = await taskStageRun({ taskId: "t1", stageId: "1" }, d);
    assert.equal(res.outcome, "passed");
    assert.equal(res.stage.status, "passed");
    assert.equal(d.tasks.get("t1")!.status, "completed");
  });
  c.cleanup();
});

// ===== stage_run 重派路径 =====
test("stage_run 重派：第二次成功（marker 机制）→ passed，2 attempts", async () => {
  const c = setupTaskDir();
  await withEnv({ ...fakePiEnv("stage_success_secondtry"), FAKE_OUTPUT_FILE: `${c.dir}/1.html` }, async () => {
    const dd = deps();
    createTask(dd.d, c.dir);
    const res = await taskStageRun({ taskId: "t1", stageId: "1" }, dd.d);
    assert.equal(res.outcome, "passed");
    assert.equal(res.attempts.length, 2, "应有 2 次 attempt");
    assert.equal(res.attempts[0].status, "failed");
    assert.equal(res.attempts[1].status, "passed");
  });
  c.cleanup();
});

// ===== stage_run manual 路径 =====
test("stage_run manual：连续 3 次 no_output → manual + 决策面板", async () => {
  const c = setupTaskDir();
  // success 模式不写文件 → 每次 no_output
  await withEnv(fakePiEnv("success"), async () => {
    const { d } = deps();
    createTask(d, c.dir);
    const res = await taskStageRun({ taskId: "t1", stageId: "1", maxAttempts: 3 }, d);
    assert.equal(res.outcome, "manual");
    assert.equal(res.stage.status, "manual");
    assert.equal(d.tasks.get("t1")!.status, "blocked_manual");
    assert.ok(res.manualPanel, "应有决策面板");
    assert.equal(res.attempts.length, 3);
    assert.ok(res.attempts.every((a) => a.failureType === "no_output"));
  });
  c.cleanup();
});

// ===== 依赖检查 =====
test("stage_run 依赖未满足 → dependency_unmet", async () => {
  const c = setupTaskDir();
  await withEnv(fakePiEnv("success"), async () => {
    const { d } = deps();
    taskCreate({
      taskId: "t1", goal: "g", cwd: c.dir, planDraftPath: "_plan-draft.md",
      stages: [
        { stageId: "1", title: "a", objective: "o", inputFiles: [], outputFile: "1.html", dependsOn: [], parallelizable: true },
        { stageId: "2", title: "b", objective: "o", inputFiles: [], outputFile: "2.html", dependsOn: ["1"], parallelizable: false },
      ],
    }, d);
    // 阶段 1 没跑，直接跑阶段 2
    await assert.rejects(
      () => taskStageRun({ taskId: "t1", stageId: "2" }, d),
      (e: any) => e.code === "dependency_unmet",
    );
  });
  c.cleanup();
});

// ===== plan（审阅）=====
test("taskPlan 派审阅 delegate → 返回 runId", async () => {
  const c = setupTaskDir();
  await withEnv(fakePiEnv("stage_success"), async () => {
    const { d } = deps();
    createTask(d, c.dir);
    const res = await taskPlan({ taskId: "t1" }, d);
    assert.ok(res.runId);
    assert.equal(d.tasks.get("t1")!.reviewSession, "t1-review");
    await drain(d);
  });
  c.cleanup();
});
