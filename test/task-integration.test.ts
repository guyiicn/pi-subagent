import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { SessionRegistry } from "../src/registry/session.js";
import { RunRegistry } from "../src/registry/run.js";
import { ProcessTable } from "../src/runner/process-table.js";
import { TaskRegistry } from "../src/registry/task.js";
import { taskCreate, taskStageRun } from "../src/tools/task.js";
import { fakePiEnv, tmpCwd, withEnv } from "./helpers.js";
import { loadTasks } from "../src/registry/task-persist.js";
import { saveTasks } from "../src/registry/task-persist.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync } from "node:fs";

function deps() {
  const tasks = new TaskRegistry();
  return { tasks, d: { tasks, sessions: new SessionRegistry(), runs: new RunRegistry(), procs: new ProcessTable() } };
}

async function drain(d: any, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (d.runs.runningCount() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  if (d.runs.runningCount() > 0) {
    d.procs.killAll();
    while (d.runs.runningCount() > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }
}

// ===== 完整多阶段流程 =====
test("完整流程：2 阶段都成功 → task completed", async () => {
  const c = tmpCwd();
  writeFileSync(`${c.dir}/_plan-draft.md`, "# plan\n");
  await withEnv(fakePiEnv("stage_success"), async () => {
    const { tasks, d } = deps();
    taskCreate({
      taskId: "multi", goal: "多阶段", cwd: c.dir, planDraftPath: "_plan-draft.md",
      stages: [
        { stageId: "1", title: "a", objective: "o1", inputFiles: ["_plan-draft.md"], outputFile: "1.html", dependsOn: [], parallelizable: true },
        { stageId: "2", title: "b", objective: "o2", inputFiles: ["_plan-draft.md"], outputFile: "2.html", dependsOn: ["1"], parallelizable: false },
      ],
    }, d);

    // 阶段 2 依赖 1，必须先跑 1
    process.env.FAKE_OUTPUT_FILE = `${c.dir}/1.html`;
    const r1 = await taskStageRun({ taskId: "multi", stageId: "1" }, d);
    assert.equal(r1.outcome, "passed");
    assert.notEqual(tasks.get("multi")!.status, "completed");  // 还有阶段 2

    process.env.FAKE_OUTPUT_FILE = `${c.dir}/2.html`;
    const r2 = await taskStageRun({ taskId: "multi", stageId: "2" }, d);
    assert.equal(r2.outcome, "passed");
    assert.equal(tasks.get("multi")!.status, "completed");  // 全完成
    delete process.env.FAKE_OUTPUT_FILE;
  });
  c.cleanup();
});

// ===== 重启恢复：running stage 加载修正 =====
test("重启恢复：running stage 加载后 → failed + interrupted attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-sub-restart-"));
  const tasksPath = join(dir, "tasks.json");
  // 模拟执行到一半的状态：stage 1 passed, stage 2 running
  await saveTasks(tasksPath, [{
    taskId: "t1", goal: "g", cwd: dir, status: "executing", planDraftPath: "_plan-draft.md",
    stages: [
      { stageId: "1", title: "a", objective: "o", inputFiles: [], outputFile: "1.html", dependsOn: [], parallelizable: true, attempts: [], status: "passed" },
      { stageId: "2", title: "b", objective: "o", inputFiles: [], outputFile: "2.html", dependsOn: ["1"], parallelizable: false, attempts: [{ attemptNo: 1, runId: "r1", status: "failed", failureType: "no_output", failureDetail: "x", ts: 1 }], status: "running", session: "t1-2" },
    ],
    createdAt: 1, updatedAt: 2,
  }]);

  // 模拟 server 重启：重新加载
  const loaded = loadTasks(tasksPath);
  assert.equal(loaded.tasks.length, 1);
  const s2 = loaded.tasks[0].stages[1];
  assert.equal(s2.status, "failed");  // running 被修正
  assert.equal(s2.lastFailureReason, "interrupted by restart");
  assert.ok(s2.attempts.some((a: any) => a.failureType === "interrupted_by_restart"));
  // stage 1 的 passed 保留
  assert.equal(loaded.tasks[0].stages[0].status, "passed");

  dir && (await import("node:fs")).rmSync(dir, { recursive: true, force: true });
});

// ===== manual 后任务阻塞，后续 stage_run 在依赖未满足时也拒 =====
test("manual 状态：task blocked_manual，新 stage 仍受依赖检查", async () => {
  const c = tmpCwd();
  writeFileSync(`${c.dir}/_plan-draft.md`, "# plan\n");
  await withEnv(fakePiEnv("success"), async () => {
    const { d } = deps();
    taskCreate({
      taskId: "t1", goal: "g", cwd: c.dir, planDraftPath: "_plan-draft.md",
      stages: [
        { stageId: "1", title: "a", objective: "o", inputFiles: [], outputFile: "1.html", dependsOn: [], parallelizable: true },
        { stageId: "2", title: "b", objective: "o", inputFiles: [], outputFile: "2.html", dependsOn: ["1"], parallelizable: false },
      ],
    }, d);
    // 阶段 1 跑到 manual（success 不写文件 → 3 次失败）
    const r1 = await taskStageRun({ taskId: "t1", stageId: "1", maxAttempts: 3 }, d);
    assert.equal(r1.outcome, "manual");
    // 阶段 2 依赖 1（1 是 manual 不是 passed）→ 拒
    await assert.rejects(
      () => taskStageRun({ taskId: "t1", stageId: "2" }, d),
      (e: any) => e.code === "dependency_unmet",
    );
    await drain(d);
  });
  c.cleanup();
});
