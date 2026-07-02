import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Task, TaskRegistryFile, Stage } from "../types.js";

// design-batch1.md §D：tasks.json 原子写 + 加载修正（仿 persist.ts）

let writeChain: Promise<void> = Promise.resolve();

export function saveTasks(path: string, tasks: Task[]): Promise<void> {
  const data: TaskRegistryFile = { version: 1, tasks };
  const run = writeChain.then(() => doSave(path, data));
  writeChain = run.catch(() => undefined);
  return run;
}

function doSave(path: string, data: TaskRegistryFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);
}

export interface TaskLoadResult {
  tasks: Task[];   // 已修正：running stage → failed(interrupted)
}

export function loadTasks(path: string): TaskLoadResult {
  if (!existsSync(path)) return { tasks: [] };
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { tasks: [] };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    copyFileSync(path, path + ".corrupt-" + Date.now());
    return { tasks: [] };
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.tasks)) {
    return { tasks: [] };
  }
  const tasks: Task[] = [];
  for (const t of parsed.tasks) {
    const fixed = fixTask(t);
    if (fixed) tasks.push(fixed);
  }
  return { tasks };
}

// 单条 task 校验 + running stage 修正
function fixTask(t: any): Task | null {
  if (!t || typeof t !== "object") return null;
  if (typeof t.taskId !== "string" || typeof t.cwd !== "string" || typeof t.goal !== "string") return null;
  if (!Array.isArray(t.stages)) return null;
  const now = Date.now();
  const task: Task = {
    taskId: t.taskId,
    goal: t.goal,
    cwd: t.cwd,
    status: ["planning", "executing", "blocked_manual", "completed", "abandoned"].includes(t.status) ? t.status : "planning",
    planDraftPath: t.planDraftPath ?? "_plan-draft.md",
    planReviewedPath: t.planReviewedPath,
    planVerdict: t.planVerdict,
    stages: (t.stages as Stage[]).map(fixStage).filter((s): s is Stage => s !== null),
    reviewSession: t.reviewSession,
    reviewRunId: t.reviewRunId,
    createdAt: typeof t.createdAt === "number" ? t.createdAt : now,
    updatedAt: typeof t.updatedAt === "number" ? t.updatedAt : now,
  };
  return task;
}

// running stage → failed(interrupted)，attempts 末条标注
function fixStage(s: any): Stage | null {
  if (!s || typeof s !== "object" || typeof s.stageId !== "string") return null;
  const stage: Stage = {
    stageId: s.stageId,
    title: s.title ?? "",
    objective: s.objective ?? "",
    inputFiles: Array.isArray(s.inputFiles) ? s.inputFiles : [],
    outputFile: s.outputFile ?? "",
    dependsOn: Array.isArray(s.dependsOn) ? s.dependsOn : [],
    parallelizable: !!s.parallelizable,
    promptHint: s.promptHint,
    validateRules: s.validateRules,
    status: ["pending", "running", "passed", "failed", "manual", "skipped"].includes(s.status) ? s.status : "pending",
    session: s.session,
    attempts: Array.isArray(s.attempts) ? s.attempts : [],
    lastFailureReason: s.lastFailureReason,
  };
  if (stage.status === "running") {
    stage.status = "failed";
    stage.lastFailureReason = "interrupted by restart";
    stage.attempts.push({
      attemptNo: (stage.attempts.at(-1)?.attemptNo ?? 0) + 1,
      runId: stage.attempts.at(-1)?.runId ?? "",
      status: "failed",
      failureType: "interrupted_by_restart" as Stage["attempts"][number]["failureType"],
      failureDetail: "server 重启时仍在运行",
      ts: Date.now(),
    });
  }
  return stage;
}
