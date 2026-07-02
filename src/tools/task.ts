import { existsSync, statSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { TaskRegistry } from "../registry/task.js";
import type { SessionRegistry } from "../registry/session.js";
import type { RunRegistry } from "../registry/run.js";
import type { ProcessTable } from "../runner/process-table.js";
import { delegate, type DelegateDeps } from "./delegate.js";
import { status } from "./status.js";
import { validateFile, validateFiles, splitOutputFiles } from "../runner/validate.js";
import { buildStagePrompt, buildReviewPrompt } from "./stage-prompt.js";
import { Errors } from "../errors.js";
import type { Task, Stage, StageAttempt, StageCreateInput, ManualPanel, Constraints, Snapshot } from "../types.js";

export interface TaskDeps {
  tasks: TaskRegistry;
  sessions: SessionRegistry;
  runs: RunRegistry;
  procs: ProcessTable;
  onTaskChange?: () => void;
}

// ============ pi_task_create ============
export function taskCreate(
  input: { taskId: string; goal: string; cwd: string; planDraftPath: string; stages: StageCreateInput[] },
  deps: TaskDeps,
): { task: Task } {
  if (!input.taskId) throw Errors.invalidArg("taskId required");
  if (!existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) throw Errors.cwdInvalid(input.cwd);
  // P2 问题1: planDraftPath 支持绝对路径（join('/cwd','/abs') 会错误拼成 /cwd/abs）
  const draftAbs = isAbsolute(input.planDraftPath) ? input.planDraftPath : join(input.cwd, input.planDraftPath);
  if (!existsSync(draftAbs)) throw Errors.planDraftMissing(input.planDraftPath);
  if (input.stages.length === 0) throw Errors.invalidArg("stages must not be empty");

  const task = deps.tasks.create({
    taskId: input.taskId,
    goal: input.goal,
    cwd: input.cwd,
    planDraftPath: input.planDraftPath,
    stages: input.stages,
  });
  deps.onTaskChange?.();
  return { task };
}

// ============ pi_task_list / get ============
export function taskList(
  deps: TaskDeps,
  filter?: { taskId?: string; status?: Task["status"] },
): { tasks: Task[] } {
  if (filter?.taskId) {
    const t = deps.tasks.get(filter.taskId);
    return { tasks: t ? [t] : [] };
  }
  return { tasks: deps.tasks.list(filter?.status) };
}

// ============ pi_task_plan（审阅）============
export async function taskPlan(
  input: { taskId: string; constraints?: Constraints; stallTimeoutMs?: number; runTimeoutMs?: number },
  deps: TaskDeps,
): Promise<{ runId: string; verdict?: string; task: Task }> {
  const task = deps.tasks.get(input.taskId);
  if (!task) throw Errors.taskNotFound(input.taskId);

  const reviewSession = task.reviewSession ?? `${input.taskId}-review`;
  deps.tasks.setReviewSession(input.taskId, reviewSession);

  // 写 _refs.md 占位提示（若不存在不强制）
  const prompt = buildReviewPrompt(task);
  // 批次2: 默认禁 skill（防 UltimateSearch 等联网诱导）。审阅不需要 bash 写盘外的东西
  const constraints = input.constraints ?? { noSkills: true, noContextFiles: true };

  const r = await delegate(
    {
      prompt,
      session: reviewSession,
      cwd: task.cwd,
      goal: `review plan for task ${input.taskId}`,
      mode: "async",
      constraints,
      stallTimeoutMs: input.stallTimeoutMs,
      runTimeoutMs: input.runTimeoutMs,
    },
    deps as DelegateDeps,
  );

  return { runId: r.runId, task: deps.tasks.get(input.taskId)! };
}

// 审阅 run 完成后调：解析 verdict，更新 task
export function applyReviewResult(taskId: string, runId: string, deps: TaskDeps): { verdict?: string; task: Task } {
  const task = deps.tasks.get(taskId);
  if (!task) throw Errors.taskNotFound(taskId);
  const reviewedAbs = join(task.cwd, "_plan-reviewed.md");
  let verdict: Task["planVerdict"];
  try {
    const content = readFileSync(reviewedAbs, "utf8");
    const m = content.match(/^verdict:\s*(\w+)/m);
    const v = m?.[1]?.toLowerCase();
    verdict = v === "approve" ? "approve" : v === "reject" ? "reject" : "approve_with_changes";
  } catch {
    verdict = "approve_with_changes";  // 文件没生成，默认带修改通过（host 仍可决策）
  }
  deps.tasks.setReviewResult(taskId, verdict, "_plan-reviewed.md", runId);
  deps.onTaskChange?.();
  return { verdict, task: deps.tasks.get(taskId)! };
}

// ============ pi_task_stage_run（核心）============
export async function taskStageRun(
  input: {
    taskId: string;
    stageId: string;
    constraints?: Constraints;
    stallTimeoutMs?: number;
    runTimeoutMs?: number;
    maxAttempts?: number;
  },
  deps: TaskDeps,
): Promise<{
  stage: Stage;
  outcome: "passed" | "manual";
  attempts: StageAttempt[];
  manualPanel?: ManualPanel;
}> {
  const task = deps.tasks.get(input.taskId);
  if (!task) throw Errors.taskNotFound(input.taskId);
  const stage = task.stages.find((s) => s.stageId === input.stageId);
  if (!stage) throw Errors.stageNotFound(input.taskId, input.stageId);

  // 依赖检查
  const unmet = stage.dependsOn.filter((dep) => {
    const ds = task.stages.find((s) => s.stageId === dep);
    return !ds || (ds.status !== "passed" && ds.status !== "skipped");
  });
  if (unmet.length > 0) throw Errors.dependencyUnmet(stage.stageId, unmet);

  // 状态检查：pending/failed/manual 才能跑；passed/skipped 不重复
  if (stage.status === "passed" || stage.status === "skipped") {
    return { stage, outcome: "passed", attempts: stage.attempts };
  }

  const maxAttempts = input.maxAttempts ?? 3;
  // 批次2: 默认禁 skill（防联网诱导），保留 bash 让 Pi 写文件
  const constraints = input.constraints ?? { noSkills: true, noContextFiles: true };
  const sessionName = stage.session ?? `${input.taskId}-${input.stageId}`;
  deps.tasks.setStageStatus(input.taskId, input.stageId, "running", sessionName);

  for (let attemptNo = 1; attemptNo <= maxAttempts; attemptNo++) {
    const lastAtt = attemptNo > 1 ? stage.attempts.at(-1) : undefined;
    const prevFailure = lastAtt && lastAtt.failureType
      ? { failureType: lastAtt.failureType, failureDetail: lastAtt.failureDetail }
      : undefined;

    const prompt = buildStagePrompt(stage, task, attemptNo, prevFailure);

    const r = await delegate(
      {
        prompt,
        session: sessionName,
        cwd: task.cwd,
        goal: `${task.taskId} / ${stage.stageId}: ${stage.objective}`,
        mode: "async",
        constraints,
        stallTimeoutMs: input.stallTimeoutMs,
        runTimeoutMs: input.runTimeoutMs,
      },
      deps as DelegateDeps,
    );

    // 等完成
    const done = await deps.runs.waitForCompletion(r.runId, (input.runTimeoutMs ?? 600000) + 10000);

    // 判定 + 验收（多文件 outputFile 支持逗号分隔，P0 问题2）
    const verdict = judgeAttempt(done, stage.outputFile ?? "", task.cwd, stage);
    const attempt: StageAttempt = {
      attemptNo,
      runId: r.runId,
      status: verdict.passed ? "passed" : "failed",
      failureType: verdict.passed ? undefined : verdict.failureType,
      failureDetail: verdict.passed ? "" : verdict.detail,
      ts: Date.now(),
    };
    deps.tasks.addAttempt(input.taskId, input.stageId, attempt);

    if (verdict.passed) {
      deps.tasks.setStageStatus(input.taskId, input.stageId, "passed");
      // 所有 stage 完成 → task completed
      if (deps.tasks.allStagesPassed(input.taskId)) {
        deps.tasks.setTaskStatus(input.taskId, "completed");
      }
      deps.onTaskChange?.();
      return { stage: deps.tasks.getStage(input.taskId, input.stageId)!, outcome: "passed", attempts: stage.attempts };
    }
    // 失败：进下一次（循环自动用上次失败拼升级 prompt）
  }

  // 全部失败 → manual
  deps.tasks.setStageStatus(input.taskId, input.stageId, "manual");
  deps.tasks.setTaskStatus(input.taskId, "blocked_manual");
  deps.onTaskChange?.();

  const lastRun = stage.attempts.at(-1);
  const lastResult = lastRun ? deps.runs.get(lastRun.runId)?.result : undefined;
  const panel: ManualPanel = {
    taskId: input.taskId,
    stageId: input.stageId,
    attempts: stage.attempts,
    lastPiResult: lastResult ? lastResult.slice(0, 500) : undefined,
    availableFiles: [
      task.planDraftPath,
      ...(task.planReviewedPath ? [task.planReviewedPath] : []),
      ...stage.inputFiles,
    ],
    options: ["retry_with_new_hint", "skip", "abort_task", "manual_write"],
  };
  return { stage: deps.tasks.getStage(input.taskId, input.stageId)!, outcome: "manual", attempts: stage.attempts, manualPanel: panel };
}

// 判定单次 attempt：综合 run 终态 + 文件验收（支持多文件 outputFile）
function judgeAttempt(
  done: { status?: string; error?: { code?: string }; result?: string } | undefined,
  outputSpec: string,
  cwd: string,
  stage: Stage,
): { passed: boolean; failureType?: StageAttempt["failureType"]; detail: string } {
  // run 异常
  if (done?.status === "timeout") {
    return { passed: false, failureType: "timeout", detail: "run timed out" };
  }
  if (done?.status === "error" && done.error?.code === "stalled") {
    return { passed: false, failureType: "stalled", detail: "run stalled, no progress" };
  }
  if (done?.status === "error") {
    // Pi 拒绝（result 里含拒绝词）
    const result = done.result ?? "";
    if (/我需要|无法完成|不能完成|需要更多|refuse|cannot/i.test(result)) {
      return { passed: false, failureType: "pi_refused", detail: result.slice(0, 200) };
    }
  }
  // 文件验收（多文件：逗号/分号分隔，每个独立检查）
  const v = validateFiles(outputSpec, cwd, stage.validateRules);
  if (v.passed) return { passed: true, detail: "ok" };
  // 文件问题归类
  const files = splitOutputFiles(outputSpec, cwd);
  const anyExists = files.some((f) => existsSync(f));
  if (!anyExists) return { passed: false, failureType: "no_output", detail: v.detail ?? "no file" };
  if (v.failedRule?.kind === "not_contains") {
    return { passed: false, failureType: "incomplete", detail: v.detail ?? "contains TODO" };
  }
  return { passed: false, failureType: "incomplete", detail: v.detail ?? "validation failed" };
}
