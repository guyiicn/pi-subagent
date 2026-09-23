import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync } from "node:fs";
import { SessionRegistry } from "../src/registry/session.js";
import { RunRegistry } from "../src/registry/run.js";
import { ProcessTable } from "../src/runner/process-table.js";
import { TaskRegistry } from "../src/registry/task.js";
import { taskCreate, taskList, taskStageRun, taskStageCollect, taskPlan, applyReviewResult } from "../src/tools/task.js";
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
    const { task } = await createTask(d, c.dir);
    assert.equal(task.status, "planning");
    assert.equal(task.stages[0].status, "pending");
  });
  c.cleanup();
});

test("taskCreate planDraft 不存在 → plan_draft_missing", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("success"), async () => {
    const { d } = deps();
    await assert.rejects(
      () => taskCreate({ taskId: "t1", goal: "g", cwd: c.dir, planDraftPath: "_plan-draft.md", stages: [] }, d),
      (e: any) => e.code === "plan_draft_missing",
    );
  });
  c.cleanup();
});

test("taskCreate taskId 重复（无产出）→ 恢复合并不冲突，状态保留", async () => {
  const c = setupTaskDir();
  await withEnv(fakePiEnv("success"), async () => {
    const { d } = deps();
    await createTask(d, c.dir);
    // 再次 create 同 taskId：不抛 conflict，返回既有 task（恢复语义）
    const { task } = await createTask(d, c.dir);
    assert.equal(task.status, "planning");
    assert.equal(task.stages.length, 1);
  });
  c.cleanup();
});

test("taskCreate 恢复：中断 stage 的 outputFile 已存在 → 自动标 passed", async () => {
  const c = setupTaskDir();
  // 预写 outputFile，模拟中断但文件已产出
  writeFileSync(`${c.dir}/1.html`, "<h1>done</h1>");
  await withEnv(fakePiEnv("success"), async () => {
    const { d, tasks } = deps();
    // 先正常建任务，再模拟重启后的状态：stage 标 failed + interrupted attempt
    await createTask(d, c.dir);
    tasks.setStageStatus("t1", "1", "failed", "t1-1-a1");
    tasks.addAttempt("t1", "1", {
      attemptNo: 1, runId: "r0", status: "failed",
      failureType: "interrupted_by_restart", failureDetail: "server 重启时仍在运行", ts: Date.now(),
    });
    // 再次 create 同 taskId → 恢复：outputFile 存在 → stage 标 passed
    const { task } = await createTask(d, c.dir);
    assert.equal(task.stages[0].status, "passed");
    assert.equal(task.status, "completed");  // 全部 passed → completed
  });
  c.cleanup();
});

test("taskList 按 taskId / status 过滤", async () => {
  const c = setupTaskDir();
  await withEnv(fakePiEnv("success"), async () => {
    const { d, tasks } = deps();
    await createTask(d, c.dir);
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
    await createTask(d, c.dir);
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
    await createTask(dd.d, c.dir);
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
    await createTask(d, c.dir);
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
    await taskCreate({
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
    await createTask(d, c.dir);
    const res = await taskPlan({ taskId: "t1" }, d);
    assert.ok(res.runId);
    assert.equal(d.tasks.get("t1")!.reviewSession, "t1-review");
    assert.equal(d.tasks.get("t1")!.reviewRunId, res.runId, "应记录 reviewRunId");
    await drain(d);
  });
  c.cleanup();
});

// ===== applyReviewResult（审阅闭环）=====
test("applyReviewResult 从 _plan-reviewed.md 解析 verdict 并更新 task", async () => {
  const c = setupTaskDir();
  const { d, tasks } = deps();
  await createTask(d, c.dir);
  // 模拟 Pi 产出审阅文件
  writeFileSync(`${c.dir}/_plan-reviewed.md`, "verdict: reject\n\n原因：阶段划分不清晰\n");
  const res = applyReviewResult("t1", "run-abc", d);
  assert.equal(res.verdict, "reject");
  const t = tasks.get("t1")!;
  assert.equal(t.planVerdict, "reject");
  assert.equal(t.planReviewedPath, "_plan-reviewed.md");
  assert.equal(t.reviewRunId, "run-abc");
  c.cleanup();
});

test("applyReviewResult 文件缺失 → 默认 approve_with_changes", async () => {
  const c = setupTaskDir();
  const { d, tasks } = deps();
  await createTask(d, c.dir);
  const res = applyReviewResult("t1", "run-xyz", d);
  assert.equal(res.verdict, "approve_with_changes");
  assert.equal(tasks.get("t1")!.planVerdict, "approve_with_changes");
  c.cleanup();
});

// ===== async 模式 + stage_collect 收割 =====
test("stage_run async：立即返回 runId → stage_collect 收割后 passed", async () => {
  const c = setupTaskDir();
  await withEnv({ ...fakePiEnv("stage_success"), FAKE_OUTPUT_FILE: `${c.dir}/1.html` }, async () => {
    const { d } = deps();
    await createTask(d, c.dir);
    const start = await taskStageRun({ taskId: "t1", stageId: "1", mode: "async" }, d);
    assert.equal(start.outcome, "running");
    assert.ok(start.runId, "async 应返回 runId");
    // 收割（fake-pi 很快完成）
    const res = await taskStageCollect({ taskId: "t1", stageId: "1", waitTimeoutMs: 5000 }, d);
    assert.equal(res.outcome, "passed");
    assert.equal(res.stage.status, "passed");
    assert.equal(d.tasks.get("t1")!.status, "completed");
  });
  c.cleanup();
});

test("stage_collect：async 收割失败后自动重派（新 session），最终 passed", async () => {
  const c = setupTaskDir();
  await withEnv({ ...fakePiEnv("stage_success_secondtry"), FAKE_OUTPUT_FILE: `${c.dir}/1.html` }, async () => {
    const { d } = deps();
    await createTask(d, c.dir);
    const start = await taskStageRun({ taskId: "t1", stageId: "1", mode: "async" }, d);
    assert.equal(start.outcome, "running");
    // 第一次收割：fake 第一次不写文件 → 判定 failed → 自动重派（返回新 runId）
    const r1 = await taskStageCollect({ taskId: "t1", stageId: "1", waitTimeoutMs: 5000 }, d);
    assert.equal(r1.outcome, "running", "重派后仍是 running");
    assert.ok(r1.runId, "重派应返回新 runId");
    // 第二次收割：fake 第二次写文件 → passed
    const r2 = await taskStageCollect({ taskId: "t1", stageId: "1", waitTimeoutMs: 5000 }, d);
    assert.equal(r2.outcome, "passed");
    assert.equal(r2.attempts.length, 2, "应有 2 次 attempt");
    assert.equal(r2.attempts[0].status, "failed");
    assert.equal(r2.attempts[1].status, "passed");
  });
  c.cleanup();
});

test("stage_run manual 状态 + promptHintOverride 重试可再次执行", async () => {
  const c = setupTaskDir();
  // 第一阶段：success 模式不写文件 → 3 次失败 → manual
  await withEnv(fakePiEnv("success"), async () => {
    const { d } = deps();
    await createTask(d, c.dir);
    const m = await taskStageRun({ taskId: "t1", stageId: "1", maxAttempts: 3 }, d);
    assert.equal(m.outcome, "manual");
    assert.ok(m.manualPanel?.options.includes("retry_with_new_hint"));
    // 切换 secondtry：用 promptHintOverride 重试 → 第二次 attempt 写文件 → passed
    await withEnv({ ...fakePiEnv("stage_success_secondtry"), FAKE_OUTPUT_FILE: `${c.dir}/1.html` }, async () => {
      const retry = await taskStageRun({ taskId: "t1", stageId: "1", promptHintOverride: "请务必先写文件骨架", maxAttempts: 2 }, d);
      assert.equal(retry.outcome, "passed");
      assert.ok(retry.attempts.at(-1)?.status === "passed");
    });
  });
  c.cleanup();
});

test("manual 后 async 重试：stage_collect 按本轮 maxAttempts 继续重派，不直接回 manual", async () => {
  const c = setupTaskDir();
  await withEnv(fakePiEnv("success"), async () => {
    const { d } = deps();
    await createTask(d, c.dir);
    const m = await taskStageRun({ taskId: "t1", stageId: "1", maxAttempts: 3 }, d);
    assert.equal(m.outcome, "manual");
    await withEnv({ ...fakePiEnv("stage_success_secondtry"), FAKE_OUTPUT_FILE: `${c.dir}/1.html` }, async () => {
      const start = await taskStageRun(
        { taskId: "t1", stageId: "1", mode: "async", maxAttempts: 2, promptHintOverride: "先写骨架", stallTimeoutMs: 60000 },
        d,
      );
      assert.equal(start.outcome, "running");
      const opts = d.tasks.getStage("t1", "1")!.runOptions!;
      assert.equal(opts.attemptLimit, 5);
      assert.equal(opts.promptHintOverride, "先写骨架");
      assert.equal(opts.stallTimeoutMs, 60000);
      // 第 4 次失败 → 应重派第 5 次（旧逻辑按绝对次数 >3 直接 manual）
      const r1 = await taskStageCollect({ taskId: "t1", stageId: "1", waitTimeoutMs: 5000 }, d);
      assert.equal(r1.outcome, "running");
      const r2 = await taskStageCollect({ taskId: "t1", stageId: "1", waitTimeoutMs: 5000 }, d);
      assert.equal(r2.outcome, "passed");
      assert.equal(r2.attempts.at(-1)!.attemptNo, 5);
    });
    await drain(d);
  });
  c.cleanup();
});

test("taskCreate 恢复：中断 stage 的 outputFile 存在但验收不过（含 TODO）→ 不标 passed", async () => {
  const c = setupTaskDir();
  writeFileSync(`${c.dir}/1.html`, "<h1>TODO</h1>");
  await withEnv(fakePiEnv("success"), async () => {
    const { d, tasks } = deps();
    await createTask(d, c.dir);
    tasks.setStageStatus("t1", "1", "failed", "t1-1-a1");
    tasks.addAttempt("t1", "1", {
      attemptNo: 1, runId: "r0", status: "failed",
      failureType: "interrupted_by_restart", failureDetail: "server 重启时仍在运行", ts: Date.now(),
    });
    const { task } = await createTask(d, c.dir);
    assert.equal(task.stages[0].status, "failed");
    assert.notEqual(task.status, "completed");
  });
  c.cleanup();
});

test("Pi 正常退出但表示无法完成（无产出）→ failureType=pi_refused", async () => {
  const c = setupTaskDir();
  await withEnv({ ...fakePiEnv("success"), FAKE_RESULT_TEXT: "我无法完成这个任务，需要更多资料" }, async () => {
    const { d } = deps();
    await createTask(d, c.dir);
    const r = await taskStageRun({ taskId: "t1", stageId: "1", maxAttempts: 1 }, d);
    assert.equal(r.outcome, "manual");
    assert.equal(r.attempts[0].failureType, "pi_refused");
  });
  c.cleanup();
});

test("结果含拒绝词但产出验收通过 → passed（不误判 pi_refused）", async () => {
  const c = setupTaskDir();
  await withEnv({ ...fakePiEnv("stage_success"), FAKE_OUTPUT_FILE: `${c.dir}/1.html`, FAKE_RESULT_TEXT: "已完成，cannot find optional file 已跳过" }, async () => {
    const { d } = deps();
    await createTask(d, c.dir);
    const r = await taskStageRun({ taskId: "t1", stageId: "1", maxAttempts: 1 }, d);
    assert.equal(r.outcome, "passed");
  });
  c.cleanup();
});
