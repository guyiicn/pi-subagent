import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveTasks, loadTasks } from "../src/registry/task-persist.js";
import { TaskRegistry } from "../src/registry/task.js";
import type { Task } from "../src/types.js";

function tmpDir() { return mkdtempSync(join(tmpdir(), "pi-sub-task-")); }

function sampleTask(over: Partial<Task> = {}): Task {
  return {
    taskId: "t1",
    goal: "g",
    cwd: "/p",
    status: "executing",
    planDraftPath: "_plan-draft.md",
    stages: [
      { stageId: "1", title: "a", objective: "o", inputFiles: ["_refs.md"], outputFile: "1.html", dependsOn: [], parallelizable: true, attempts: [], status: "passed" },
      { stageId: "2", title: "b", objective: "o", inputFiles: ["_refs.md"], outputFile: "2.html", dependsOn: ["1"], parallelizable: false, attempts: [], status: "running", session: "t1-2" },
    ],
    createdAt: 1,
    updatedAt: 2,
    ...over,
  };
}

test("save + load 往返（passed stage 保留）", async () => {
  const dir = tmpDir();
  const path = join(dir, "tasks.json");
  await saveTasks(path, [sampleTask()]);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(raw.version, 1);
  const loaded = loadTasks(path);
  assert.equal(loaded.tasks.length, 1);
  assert.equal(loaded.tasks[0].stages[0].status, "passed");  // passed 保留
  rmSync(dir, { recursive: true, force: true });
});

test("running stage 加载修正为 failed + interrupted attempt", async () => {
  const dir = tmpDir();
  const path = join(dir, "tasks.json");
  await saveTasks(path, [sampleTask()]);  // stage 2 是 running
  const loaded = loadTasks(path);
  const s2 = loaded.tasks[0].stages[1];
  assert.equal(s2.status, "failed");  // 修正
  assert.equal(s2.lastFailureReason, "interrupted by restart");
  assert.ok(s2.attempts.some((a) => a.failureType === "interrupted_by_restart"));
  rmSync(dir, { recursive: true, force: true });
});

test("目录不存在时 save 自动 mkdir", async () => {
  const dir = tmpDir();
  const path = join(dir, "n1", "n2", "tasks.json");
  await saveTasks(path, []);
  assert.ok(existsSync(path));
  rmSync(dir, { recursive: true, force: true });
});

test("文件损坏 → 备份 + 空", () => {
  const dir = tmpDir();
  const path = join(dir, "tasks.json");
  writeFileSync(path, "{ broken {{{");
  const loaded = loadTasks(path);
  assert.deepEqual(loaded.tasks, []);
  const files = readdirSync(dir);
  assert.ok(files.some((f) => f.startsWith("tasks.json.corrupt-")));
  rmSync(dir, { recursive: true, force: true });
});

test("单条 task 缺 taskId → 丢弃，其他保留", () => {
  const dir = tmpDir();
  const path = join(dir, "tasks.json");
  writeFileSync(path, JSON.stringify({
    version: 1,
    tasks: [
      { goal: "g", cwd: "/p", planDraftPath: "_p.md", stages: [] },  // 缺 taskId
      sampleTask({ taskId: "good" }),
    ],
  }));
  const loaded = loadTasks(path);
  assert.equal(loaded.tasks.length, 1);
  assert.equal(loaded.tasks[0].taskId, "good");
  rmSync(dir, { recursive: true, force: true });
});

// TaskRegistry 内存测试
test("TaskRegistry create + get + conflict", () => {
  const r = new TaskRegistry();
  r.create({ taskId: "t1", goal: "g", cwd: "/p", planDraftPath: "_p.md", stages: [] });
  assert.ok(r.get("t1"));
  assert.throws(
    () => r.create({ taskId: "t1", goal: "g2", cwd: "/p", planDraftPath: "_p.md", stages: [] }),
    (e: any) => e.code === "task_conflict",
  );
});

test("TaskRegistry create 把 stages 初始化为 pending", () => {
  const r = new TaskRegistry();
  r.create({
    taskId: "t1", goal: "g", cwd: "/p", planDraftPath: "_p.md",
    stages: [{ stageId: "1", title: "a", objective: "o", inputFiles: [], outputFile: "1.html", dependsOn: [], parallelizable: true }],
  });
  const s = r.getStage("t1", "1");
  assert.equal(s?.status, "pending");
  assert.deepEqual(s?.attempts, []);
});

test("TaskRegistry addAttempt + lastFailureReason", () => {
  const r = new TaskRegistry();
  r.create({
    taskId: "t1", goal: "g", cwd: "/p", planDraftPath: "_p.md",
    stages: [{ stageId: "1", title: "a", objective: "o", inputFiles: [], outputFile: "1.html", dependsOn: [], parallelizable: true }],
  });
  r.addAttempt("t1", "1", { attemptNo: 1, runId: "r1", status: "failed", failureType: "no_output", failureDetail: "没文件", ts: 1 });
  const s = r.getStage("t1", "1");
  assert.equal(s?.attempts.length, 1);
  assert.ok(s?.lastFailureReason?.includes("no_output"));
});

test("TaskRegistry allStagesPassed", () => {
  const r = new TaskRegistry();
  r.create({
    taskId: "t1", goal: "g", cwd: "/p", planDraftPath: "_p.md",
    stages: [
      { stageId: "1", title: "a", objective: "o", inputFiles: [], outputFile: "1.html", dependsOn: [], parallelizable: true },
      { stageId: "2", title: "b", objective: "o", inputFiles: [], outputFile: "2.html", dependsOn: [], parallelizable: true },
    ],
  });
  assert.equal(r.allStagesPassed("t1"), false);
  r.setStageStatus("t1", "1", "passed");
  r.setStageStatus("t1", "2", "passed");
  assert.equal(r.allStagesPassed("t1"), true);
});

test("TaskRegistry persistHook 在变更时触发", () => {
  let calls = 0;
  const r = new TaskRegistry();
  r.setPersistHook(() => { calls++; });
  r.create({ taskId: "t1", goal: "g", cwd: "/p", planDraftPath: "_p.md", stages: [] });
  assert.ok(calls >= 1);
});
