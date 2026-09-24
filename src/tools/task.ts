import { existsSync, statSync, readFileSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { TaskRegistry } from "../registry/task.js";
import type { SessionRegistry } from "../registry/session.js";
import type { RunRegistry } from "../registry/run.js";
import type { ProcessTable } from "../runner/process-table.js";
import { delegate, type DelegateDeps, type DelegateInput } from "./delegate.js";
import { status } from "./status.js";
import { validateFile, validateFiles, splitOutputFiles } from "../runner/validate.js";
import { buildStagePrompt, buildReviewPrompt } from "./stage-prompt.js";
import { snapshotDir, diffSnapshots, checkScope, MAX_SNAPSHOT_FILES, type DirSnapshot } from "../runner/scope.js";
import { Errors } from "../errors.js";
import type { Task, Stage, StageAttempt, StageCreateInput, ManualPanel, Constraints, Snapshot, StageRunInput, StageScopeResult } from "../types.js";

export interface TaskDeps {
  tasks: TaskRegistry;
  sessions: SessionRegistry;
  runs: RunRegistry;
  procs: ProcessTable;
  onTaskChange?: () => void;
}

// ============ pi_task_create ============
export async function taskCreate(
  input: { taskId: string; goal: string; cwd: string; planDraftPath: string; stages: StageCreateInput[] },
  deps: TaskDeps,
): Promise<{ task: Task }> {
  if (!input.taskId) throw Errors.invalidArg("taskId required");
  if (!existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) throw Errors.cwdInvalid(input.cwd);
  // P2 问题1: planDraftPath 支持绝对路径（join('/cwd','/abs') 会错误拼成 /cwd/abs）
  const draftAbs = isAbsolute(input.planDraftPath) ? input.planDraftPath : join(input.cwd, input.planDraftPath);
  if (!existsSync(draftAbs)) throw Errors.planDraftMissing(input.planDraftPath);
  if (input.stages.length === 0) throw Errors.invalidArg("stages must not be empty");

  // 恢复语义：同 taskId 已存在（如重启后残留）→ 合并 stages 而非冲突。
  // 对每个已存在 stage：若其 outputFile 已存在且通过验收 → 标 passed（文件其实写完了，
  // 只是中断时状态没落盘），host 可续跑剩余阶段，不必手改 tasks.json。
  const existing = deps.tasks.get(input.taskId);
  if (existing) {
    for (const newStage of input.stages) {
      const old = existing.stages.find((s) => s.stageId === newStage.stageId);
      if (!old) continue;
      if (old.status === "passed" || old.status === "skipped") continue;
      // 仅对中断（interrupted_by_restart）尝试恢复，不覆盖真实失败
      const interrupted = old.attempts.some((a) => a.failureType === "interrupted_by_restart");
      if (!interrupted && old.status !== "failed") continue;
      if (!newStage.outputFile) continue;
      // 按 stage 验收规则真正验收（支持多文件 outputFile），不只看文件存在
      const v = await validateFiles(newStage.outputFile, input.cwd, newStage.validateRules ?? old.validateRules);
      if (v.passed) {
        deps.tasks.setStageStatus(input.taskId, newStage.stageId, "passed");
        deps.tasks.setStageSession(input.taskId, newStage.stageId, old.session);
      }
    }
    const task = deps.tasks.get(input.taskId)!;
    if (deps.tasks.allStagesPassed(input.taskId)) {
      deps.tasks.setTaskStatus(input.taskId, "completed");
    } else if (task.status === "planning") {
      deps.tasks.setTaskStatus(input.taskId, "planning");
    }
    deps.onTaskChange?.();
    return { task };
  }

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

  // 记录 reviewRunId：host 之后用 pi_status(runId) 收割；收割完成后 server 层
  // 会检测 runId 是否匹配某 task 的 reviewRunId，匹配则自动调 applyReviewResult 解析 verdict。
  deps.tasks.setReviewRunId(input.taskId, r.runId);

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
  input: StageRunInput,
  deps: TaskDeps,
): Promise<{
  stage: Stage;
  outcome?: "passed" | "manual" | "running";
  runId?: string;          // async 模式：返回 runId，host 用 stage_collect 收割
  attempts: StageAttempt[];
  manualPanel?: ManualPanel;
  scopeWarnings?: string[];
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

  // 状态检查：passed/skipped 不重复
  if (stage.status === "passed" || stage.status === "skipped") {
    return { stage, outcome: "passed", attempts: stage.attempts };
  }

  // manual 状态允许带 promptHintOverride 重试（面板 retry_with_new_hint 落地）
  const hintOverride = input.promptHintOverride;
  const maxAttempts = input.maxAttempts ?? 3;
  // 批次2: 默认禁 skill（防联网诱导），保留 bash 让 Pi 写文件
  const constraints = input.constraints ?? { noSkills: true, noContextFiles: true };

  // 标记任务进入执行态（planning → executing）
  if (task.status === "planning") deps.tasks.setTaskStatus(input.taskId, "executing");

  // async 模式：只发起第一次 delegate，返回 runId；判定/重试交给 stage_collect
  if (input.mode === "async") {
    // 已有一个在跑的 run（上次 async 发起未收割）→ 返回既有 run
    if (stage.currentRunId && deps.runs.get(stage.currentRunId)?.status === "running") {
      return { stage, outcome: "running", runId: stage.currentRunId, attempts: stage.attempts };
    }
    const baseAttemptNo = stage.attempts.at(-1)?.attemptNo ?? 0;
    const attemptNo = baseAttemptNo + 1;
    const sessionName = `${input.taskId}-${input.stageId}-a${attemptNo}`;
    deps.tasks.setStageStatus(input.taskId, input.stageId, "running", sessionName);
    // 保存发起参数，stage_collect 自动重派时沿用；attemptLimit 与 sync 一致按"本轮"计数
    deps.tasks.setStageRunOptions(input.taskId, input.stageId, {
      constraints,
      stallTimeoutMs: input.stallTimeoutMs,
      runTimeoutMs: input.runTimeoutMs,
      promptHintOverride: hintOverride,
      attemptLimit: baseAttemptNo + maxAttempts,
    });
    const r = await launchStageRun(
      {
        prompt: buildStagePrompt(stage, task, attemptNo, lastFailureOf(stage), hintOverride),
        session: sessionName,
        cwd: task.cwd,
        goal: `${task.taskId} / ${stage.stageId}: ${stage.objective}`,
        mode: "async",
        constraints,
        stallTimeoutMs: input.stallTimeoutMs,
        runTimeoutMs: input.runTimeoutMs,
      },
      deps, task, stage,
    );
    // 记录 currentRunId 供 stage_collect 收割
    deps.tasks.setStageCurrentRunId(input.taskId, input.stageId, r.runId);
    return { stage: deps.tasks.getStage(input.taskId, input.stageId)!, outcome: "running", runId: r.runId, attempts: stage.attempts };
  }

  // sync 模式（默认）：完整跑完重试循环，返回 outcome
  const result = await runStageAttempts(
    input, deps, task, stage, hintOverride, maxAttempts, constraints,
  );
  return result;
}

// 收割并判定一次已发起的 stage run（async 模式配套；也供 sync 内部用）
export async function taskStageCollect(
  input: { taskId: string; stageId: string; waitTimeoutMs?: number },
  deps: TaskDeps,
): Promise<{
  stage: Stage;
  outcome?: "passed" | "manual" | "running";
  runId?: string;          // 自动重派后返回新 runId
  attempts: StageAttempt[];
  manualPanel?: ManualPanel;
  scopeWarnings?: string[];
}> {
  const task = deps.tasks.get(input.taskId);
  if (!task) throw Errors.taskNotFound(input.taskId);
  const stage = task.stages.find((s) => s.stageId === input.stageId);
  if (!stage) throw Errors.stageNotFound(input.taskId, input.stageId);

  if (stage.status !== "running") {
    // 没有在跑 → 按当前状态返回（passed 直接返回）
    return { stage, outcome: stage.status === "passed" ? "passed" : stage.status === "manual" ? "manual" : undefined, attempts: stage.attempts };
  }

  const lastRunId = stage.currentRunId ?? stage.attempts.at(-1)?.runId;
  if (!lastRunId) throw Errors.invalidArg(`stage ${input.stageId} has no run to collect`);

  const waitMs = Math.min(input.waitTimeoutMs ?? 25000, 28000);
  const run = await deps.runs.waitForCompletion(lastRunId, waitMs);
  if (!run || run.status === "running") {
    // 还没完 → 仍是 running
    return { stage, outcome: "running", attempts: stage.attempts };
  }

  // run 已完成 → 判定 + 可能需要重试（沿用 stage_run 发起时的参数；旧数据无 runOptions 则用默认）
  const opts = stage.runOptions ?? { constraints: { noSkills: true, noContextFiles: true }, attemptLimit: 3 };
  const { verdict, scope } = await judgeWithScope(run, task, stage);
  const attempt: StageAttempt = {
    attemptNo: (stage.attempts.at(-1)?.attemptNo ?? 0) + 1,
    runId: run.runId,
    status: verdict.passed ? "passed" : "failed",
    failureType: verdict.passed ? undefined : verdict.failureType,
    failureDetail: verdict.passed ? "" : verdict.detail,
    ts: Date.now(),
    scope,
  };
  deps.tasks.addAttempt(input.taskId, input.stageId, attempt);

  if (verdict.passed) {
    deps.tasks.setStageCurrentRunId(input.taskId, input.stageId, undefined);
    deps.tasks.setStageStatus(input.taskId, input.stageId, "passed");
    if (deps.tasks.allStagesPassed(input.taskId)) deps.tasks.setTaskStatus(input.taskId, "completed");
    deps.onTaskChange?.();
    return { stage: deps.tasks.getStage(input.taskId, input.stageId)!, outcome: "passed", attempts: stage.attempts, ...scopeWarnings(scope) };
  }

  // 失败：继续发下一次（新 session 名防历史混入）
  const attemptNo = attempt.attemptNo + 1;
  if (attemptNo <= opts.attemptLimit) {
    deps.tasks.setStageCurrentRunId(input.taskId, input.stageId, undefined);
    deps.tasks.setStageStatus(input.taskId, input.stageId, "running", `${input.taskId}-${input.stageId}-a${attemptNo}`);
    const r = await launchStageRun(
      {
        prompt: buildStagePrompt(
          stage, task, attemptNo,
          { failureType: attempt.failureType!, failureDetail: attempt.failureDetail },
          opts.promptHintOverride,
        ),
        session: `${input.taskId}-${input.stageId}-a${attemptNo}`,
        cwd: task.cwd,
        goal: `${task.taskId} / ${input.stageId}: ${stage.objective}`,
        mode: "async",
        constraints: opts.constraints,
        stallTimeoutMs: opts.stallTimeoutMs,
        runTimeoutMs: opts.runTimeoutMs,
      },
      deps, task, stage,
    );
    deps.tasks.setStageCurrentRunId(input.taskId, input.stageId, r.runId);
    return { stage: deps.tasks.getStage(input.taskId, input.stageId)!, outcome: "running", runId: r.runId, attempts: stage.attempts };
  }

  // 超过 maxAttempts → manual
  deps.tasks.setStageCurrentRunId(input.taskId, input.stageId, undefined);
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

// sync 模式的完整重试循环
async function runStageAttempts(
  input: StageRunInput,
  deps: TaskDeps,
  task: Task,
  stage: Stage,
  hintOverride: string | undefined,
  maxAttempts: number,
  constraints: Constraints,
): Promise<{ stage: Stage; outcome: "passed" | "manual"; attempts: StageAttempt[]; manualPanel?: ManualPanel; scopeWarnings?: string[] }> {
  // 已有 attempts（如 manual 后重试）→ attemptNo 接续，不重置
  const baseAttemptNo = stage.attempts.at(-1)?.attemptNo ?? 0;
  for (let attemptNo = baseAttemptNo + 1; attemptNo <= baseAttemptNo + maxAttempts; attemptNo++) {
    const lastAtt = attemptNo > 1 ? stage.attempts.at(-1) : undefined;
    const prevFailure = lastAtt && lastAtt.failureType
      ? { failureType: lastAtt.failureType, failureDetail: lastAtt.failureDetail }
      : undefined;

    // 每次 attempt 用新 session 名（skill: 重派用新 session 防历史 progress 混入）
    const sessionName = `${input.taskId}-${input.stageId}-a${attemptNo}`;
    deps.tasks.setStageStatus(input.taskId, input.stageId, "running", sessionName);

    const prompt = buildStagePrompt(stage, task, attemptNo, prevFailure, hintOverride);

    const r = await launchStageRun(
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
      deps, task, stage,
    );

    // 等完成
    const done = await deps.runs.waitForCompletion(r.runId, (input.runTimeoutMs ?? 600000) + 10000);

    // 判定 + 验收（多文件 outputFile 支持逗号分隔，P0 问题2）
    const { verdict, scope } = await judgeWithScope(done, task, stage, r.runId);
    const attempt: StageAttempt = {
      attemptNo,
      runId: r.runId,
      status: verdict.passed ? "passed" : "failed",
      failureType: verdict.passed ? undefined : verdict.failureType,
      failureDetail: verdict.passed ? "" : verdict.detail,
      ts: Date.now(),
      scope,
    };
    deps.tasks.addAttempt(input.taskId, input.stageId, attempt);

    if (verdict.passed) {
      deps.tasks.setStageStatus(input.taskId, input.stageId, "passed");
      // 所有 stage 完成 → task completed
      if (deps.tasks.allStagesPassed(input.taskId)) {
        deps.tasks.setTaskStatus(input.taskId, "completed");
      }
      deps.onTaskChange?.();
      return { stage: deps.tasks.getStage(input.taskId, input.stageId)!, outcome: "passed", attempts: stage.attempts, ...scopeWarnings(scope) };
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

function lastFailureOf(stage: Stage): { failureType: StageAttempt["failureType"]; failureDetail: string } | undefined {
  const last = stage.attempts.at(-1);
  return last && last.failureType ? { failureType: last.failureType, failureDetail: last.failureDetail } : undefined;
}

// ============ 写入范围追踪 ============
// run 前快照 cwd，run 结束那一刻再快照（而非收割时——async 收割可能滞后，期间别的阶段写的文件会混入）。
// 快照只在内存：server 重启后该 run 的 scope 记为未检查，不误判。
interface ScopeRecord {
  taskId: string;
  stageId: string;
  runId: string;
  start: number;
  end?: number;
  before: DirSnapshot;
  after?: DirSnapshot;
  done: Promise<void>;
}
const scopeRecords = new Map<string, ScopeRecord>();
const WINDOW_RETAIN_MS = 3600_000;

async function launchStageRun(input: DelegateInput, deps: TaskDeps, task: Task, stage: Stage): Promise<{ runId: string }> {
  const before = snapshotDir(task.cwd);
  const start = Date.now();
  const r = await delegate(input, deps as DelegateDeps);
  const rec: ScopeRecord = { taskId: task.taskId, stageId: stage.stageId, runId: r.runId, start, before, done: Promise.resolve() };
  rec.done = waitRunEnd(deps.runs, r.runId).then(() => {
    rec.after = snapshotDir(task.cwd);
    rec.end = Date.now();
  });
  scopeRecords.set(r.runId, rec);
  pruneScopeRecords();
  return { runId: r.runId };
}

async function waitRunEnd(runs: RunRegistry, runId: string): Promise<void> {
  for (;;) {
    const r = await runs.waitForCompletion(runId, 60_000);
    if (!r || r.status !== "running") return;
  }
}

// 结束的记录保留一段时间，作为并发重叠判断的时间窗口，之后清掉
function pruneScopeRecords(): void {
  const now = Date.now();
  for (const [id, r] of scopeRecords) if (r.end && now - r.end > WINDOW_RETAIN_MS) scopeRecords.delete(id);
}

async function evaluateScope(runId: string, task: Task, stage: Stage): Promise<StageScopeResult> {
  const rec = scopeRecords.get(runId);
  if (!rec) return { checked: false, note: "无 run 前快照（server 重启或非本进程发起），未检查" };
  await rec.done;
  if (rec.before.truncated || rec.after!.truncated) {
    return { checked: false, note: `任务目录文件数超过 ${MAX_SNAPSHOT_FILES}，未检查` };
  }
  // 与本 run 时间窗口重叠的同任务其他阶段：其产出计入允许范围（并行阶段共享 cwd，否则会互相误报）
  const overlapping = new Set<string>();
  for (const o of scopeRecords.values()) {
    if (o.taskId !== rec.taskId || o.stageId === rec.stageId) continue;
    if (o.start < rec.end! && (o.end ?? Infinity) > rec.start) overlapping.add(o.stageId);
  }
  const allowStages = [stage, ...task.stages.filter((s) => overlapping.has(s.stageId))];
  // 本阶段之前 attempt 自己新建的多余文件，后续 attempt 清理/改写属正常，不算违规
  const ownPriorStray = stage.attempts.flatMap((a) => a.scope?.stray ?? []);
  const check = checkScope(diffSnapshots(rec.before, rec.after!), {
    cwd: task.cwd,
    outputFiles: [
      ...allowStages.flatMap((s) => (s.outputFile ? splitOutputFiles(s.outputFile, task.cwd) : [])),
      ...ownPriorStray,
    ],
    allowExtraFiles: allowStages.flatMap((s) => s.allowExtraFiles ?? []),
  });
  return {
    checked: true,
    stray: check.stray,
    violations: check.violations,
    ...(overlapping.size ? { overlappingStages: [...overlapping].sort() } : {}),
  };
}

// 判定 + 写入范围检查。violation（改/删不属于本阶段的文件）一律判失败；stray 仅 strictScope 时判失败
async function judgeWithScope(
  done: { runId?: string; status?: string; error?: { code?: string }; result?: string } | undefined,
  task: Task,
  stage: Stage,
  runId = done?.runId ?? "",
): Promise<{ verdict: { passed: boolean; failureType?: StageAttempt["failureType"]; detail: string }; scope: StageScopeResult }> {
  const verdict = await judgeAttempt(done, stage.outputFile ?? "", task.cwd, stage);
  const scope = await evaluateScope(runId, task, stage);
  const problems = [
    ...(scope.violations ?? []),
    ...(stage.strictScope ? (scope.stray ?? []).map((p) => `created: ${p}`) : []),
  ];
  if (problems.length > 0) {
    const scopeDetail = `写了本阶段范围外的文件：${problems.join(", ")}`;
    return {
      verdict: {
        passed: false,
        failureType: "scope_violation",
        detail: verdict.passed ? scopeDetail : `${scopeDetail}；另：${verdict.detail}`,
      },
      scope,
    };
  }
  return { verdict, scope };
}

function scopeWarnings(scope: StageScopeResult): { scopeWarnings?: string[] } {
  return scope.stray?.length ? { scopeWarnings: scope.stray.map((p) => `新建了 outputFile 以外的文件（未删除，请 host 确认）：${p}`) } : {};
}

// 判定单次 attempt：综合 run 终态 + 文件验收（支持多文件 outputFile）

async function judgeAttempt(
  done: { status?: string; error?: { code?: string }; result?: string } | undefined,
  outputSpec: string,
  cwd: string,
  stage: Stage,
): Promise<{ passed: boolean; failureType?: StageAttempt["failureType"]; detail: string }> {
  // run 异常
  if (done?.status === "timeout") {
    return { passed: false, failureType: "timeout", detail: "run timed out" };
  }
  if (done?.status === "error" && done.error?.code === "stalled") {
    return { passed: false, failureType: "stalled", detail: "run stalled, no progress" };
  }
  // 文件验收（多文件：逗号/分号分隔，每个独立检查）
  const v = await validateFiles(outputSpec, cwd, stage.validateRules);
  if (v.passed) return { passed: true, detail: "ok" };
  // Pi 拒绝：拒绝时 Pi 通常正常退出（completed），故不限 status，只要验收没过且结果含拒绝词
  const result = done?.result ?? "";
  if (/我需要|无法完成|不能完成|需要更多|refuse|cannot/i.test(result)) {
    return { passed: false, failureType: "pi_refused", detail: result.slice(0, 200) };
  }
  // 文件问题归类
  const files = splitOutputFiles(outputSpec, cwd);
  const anyExists = files.some((f) => existsSync(f));
  if (!anyExists) return { passed: false, failureType: "no_output", detail: v.detail ?? "no file" };
  if (v.failedRule?.kind === "not_contains") {
    return { passed: false, failureType: "incomplete", detail: v.detail ?? "contains TODO" };
  }
  return { passed: false, failureType: "incomplete", detail: v.detail ?? "validation failed" };
}
