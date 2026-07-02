import { randomUUID } from "node:crypto";
import type { Run, RunError, Usage, ProgressEvent } from "../types.js";

export interface CreateRunInput {
  session: string;
  startedAt: number;
}

export interface CompleteInput {
  status: "completed" | "error" | "killed" | "timeout";
  result?: string;
  endedAt: number;
  progress?: ProgressEvent[];
  progressTruncated?: boolean;
  usage?: Usage;
  error?: RunError;
}

interface Waiter {
  resolve: (r: Run | undefined) => void;
}

export class RunRegistry {
  private runs = new Map<string, Run>();
  private completedOrder: string[] = [];  // 完成顺序（FIFO 淘汰）
  private waiters = new Map<string, Waiter[]>();
  private expiredSet = new Set<string>();

  constructor(
    private maxCompleted = 128,
    private ttlMs = 86400000,
  ) {}

  create(input: CreateRunInput): Run {
    const run: Run = {
      runId: randomUUID(),
      session: input.session,
      status: "running",
      progress: [],
      startedAt: input.startedAt,
      lastProgressAt: input.startedAt,
    };
    this.runs.set(run.runId, run);
    return run;
  }

  get(runId: string): Run | undefined {
    return this.runs.get(runId);
  }

  isExpired(runId: string): boolean {
    return this.expiredSet.has(runId);
  }

  runningCount(): number {
    let n = 0;
    for (const r of this.runs.values()) if (r.status === "running") n++;
    return n;
  }

  list(): Run[] {
    return [...this.runs.values()];
  }

  complete(runId: string, input: CompleteInput): void {
    const r = this.runs.get(runId);
    if (!r) return;
    r.status = input.status;
    r.result = input.result;
    r.endedAt = input.endedAt;
    if (input.progress) r.progress = input.progress;
    if (input.progressTruncated) r.progressTruncated = input.progressTruncated;
    if (input.usage) r.usage = input.usage;
    if (input.error) r.error = input.error;
    this.completedOrder.push(runId);
    this.evictIfNeeded();
    // 唤醒所有等待者
    const ws = this.waiters.get(runId) ?? [];
    for (const w of ws) w.resolve(r);
    this.waiters.delete(runId);
  }

  appendProgress(runId: string, ev: ProgressEvent): void {
    const r = this.runs.get(runId);
    if (!r) return;
    r.progress.push(ev);
    r.lastProgressAt = Date.now();   // 批次1: 停滞检测用
    if (r.progress.length > 200) {
      r.progress = r.progress.slice(-200);
      r.progressTruncated = true;
    }
  }

  // long-poll：完成或超时返回
  waitForCompletion(runId: string, timeoutMs: number): Promise<Run | undefined> {
    const existing = this.runs.get(runId);
    if (existing && existing.status !== "running") return Promise.resolve(existing);
    if (this.expiredSet.has(runId)) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.runs.get(runId)), timeoutMs);
      const waiter: Waiter = {
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      };
      const arr = this.waiters.get(runId) ?? [];
      arr.push(waiter);
      this.waiters.set(runId, arr);
    });
  }

  cleanupExpired(): void {
    const now = Date.now();
    for (const id of [...this.completedOrder]) {
      const r = this.runs.get(id);
      if (!r || !r.endedAt) continue;
      if (now - r.endedAt > this.ttlMs) {
        this.runs.delete(id);
        this.expiredSet.add(id);
        this.completedOrder = this.completedOrder.filter(x => x !== id);
      }
    }
  }

  private evictIfNeeded(): void {
    const completed = [...this.completedOrder];
    while (completed.length > this.maxCompleted) {
      const old = completed.shift()!;
      this.runs.delete(old);
      this.expiredSet.add(old);
    }
    this.completedOrder = completed;
  }
}
