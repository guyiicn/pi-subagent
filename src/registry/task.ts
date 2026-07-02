import type { Task, Stage, StageAttempt, StageCreateInput } from "../types.js";
import { Errors } from "../errors.js";

// design-batch1.md §C/D：Task 内存态 + 触发持久化

export type PersistHook = () => void;

export class TaskRegistry {
  private map = new Map<string, Task>();
  private persistHook?: PersistHook;

  setPersistHook(hook: PersistHook): void {
    this.persistHook = hook;
  }

  private touch(taskId: string): void {
    const t = this.map.get(taskId);
    if (t) t.updatedAt = Date.now();
    this.persistHook?.();
  }

  create(input: {
    taskId: string;
    goal: string;
    cwd: string;
    planDraftPath: string;
    stages: StageCreateInput[];
  }): Task {
    if (this.map.has(input.taskId)) throw Errors.taskConflict(input.taskId);
    const now = Date.now();
    // 补默认字段（防 host 传的 stage 缺字段导致后续 map/filter 崩）
    const stages: Stage[] = input.stages.map((s) => ({
      stageId: s.stageId,
      title: s.title ?? "",
      objective: s.objective ?? s.goal ?? "",   // 兼容 host 用 goal 而非 objective
      inputFiles: s.inputFiles ?? [],
      outputFile: s.outputFile ?? "",
      dependsOn: s.dependsOn ?? [],
      parallelizable: s.parallelizable ?? false,
      promptHint: s.promptHint,
      validateRules: s.validateRules,
      status: "pending" as const,
      attempts: [],
    }));
    const task: Task = {
      taskId: input.taskId,
      goal: input.goal,
      cwd: input.cwd,
      status: "planning",
      planDraftPath: input.planDraftPath,
      stages,
      createdAt: now,
      updatedAt: now,
    };
    this.map.set(input.taskId, task);
    this.touch(input.taskId);
    return task;
  }

  get(taskId: string): Task | undefined {
    return this.map.get(taskId);
  }

  has(taskId: string): boolean {
    return this.map.has(taskId);
  }

  list(filterStatus?: Task["status"]): Task[] {
    const all = [...this.map.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    return filterStatus ? all.filter((t) => t.status === filterStatus) : all;
  }

  getStage(taskId: string, stageId: string): Stage | undefined {
    return this.map.get(taskId)?.stages.find((s) => s.stageId === stageId);
  }

  // 审阅完成：记 verdict + reviewed path
  setReviewResult(taskId: string, verdict: Task["planVerdict"], reviewedPath: string, runId: string): void {
    const t = this.map.get(taskId);
    if (!t) return;
    t.planVerdict = verdict;
    t.planReviewedPath = reviewedPath;
    t.reviewRunId = runId;
    this.touch(taskId);
  }

  setReviewSession(taskId: string, session: string): void {
    const t = this.map.get(taskId);
    if (t) {
      t.reviewSession = session;
      this.touch(taskId);
    }
  }

  // stage 状态变更
  setStageStatus(taskId: string, stageId: string, status: Stage["status"], session?: string): void {
    const t = this.map.get(taskId);
    const s = t?.stages.find((x) => x.stageId === stageId);
    if (!t || !s) return;
    s.status = status;
    if (session) s.session = session;
    this.touch(taskId);
  }

  addAttempt(taskId: string, stageId: string, attempt: StageAttempt): void {
    const t = this.map.get(taskId);
    const s = t?.stages.find((x) => x.stageId === stageId);
    if (!t || !s) return;
    s.attempts.push(attempt);
    if (attempt.status === "failed") {
      s.lastFailureReason = `${attempt.failureType ?? "unknown"}: ${attempt.failureDetail}`;
    }
    this.touch(taskId);
  }

  setTaskStatus(taskId: string, status: Task["status"]): void {
    const t = this.map.get(taskId);
    if (t) {
      t.status = status;
      this.touch(taskId);
    }
  }

  // 所有 stage 都 passed → 可标 completed（调用方判断）
  allStagesPassed(taskId: string): boolean {
    const t = this.map.get(taskId);
    if (!t || t.stages.length === 0) return false;
    return t.stages.every((s) => s.status === "passed" || s.status === "skipped");
  }

  allPersistable(): Task[] {
    return [...this.map.values()];
  }

  loadAll(tasks: Task[]): void {
    this.map.clear();
    for (const t of tasks) this.map.set(t.taskId, t);
  }
}
