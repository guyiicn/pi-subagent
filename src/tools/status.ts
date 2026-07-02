import type { RunRegistry } from "../registry/run.js";
import { Errors } from "../errors.js";

export interface StatusInput {
  runId: string;
  waitTimeoutMs?: number;
}

export interface StatusOutput {
  runId: string;
  session?: string;
  status: string;
  result?: string;
  progress?: any[];
  progressTruncated?: boolean;
  usage?: any;
  error?: any;
}

export async function status(input: StatusInput, runs: RunRegistry): Promise<StatusOutput> {
  // 立即返回（若已完成/不存在）
  const existing = runs.get(input.runId);
  if (existing && existing.status !== "running") {
    return {
      runId: input.runId,
      session: existing.session,
      status: existing.status,
      result: existing.result,
      progress: existing.progress,
      progressTruncated: existing.progressTruncated,
      usage: existing.usage,
      error: existing.error,
    };
  }
  if (!existing && runs.isExpired(input.runId)) throw Errors.runExpired(input.runId);
  if (!existing) throw Errors.notFound(`run ${input.runId}`);

  // long-poll：waitTimeoutMs 默认 25000（低于 host 工具调用硬超时 30s，确保 host 不掐断）
  // 传 0 → 立即返回当前 running（纯轮询）
  const waitMs = input.waitTimeoutMs ?? 25000;
  if (waitMs === 0) {
    return { runId: input.runId, session: existing.session, status: "running" };
  }
  const run = await runs.waitForCompletion(input.runId, waitMs);
  if (!run) return { runId: input.runId, session: existing.session, status: "running" };
  return {
    runId: input.runId,
    session: run.session,
    status: run.status,
    result: run.result,
    progress: run.progress,
    progressTruncated: run.progressTruncated,
    usage: run.usage,
    error: run.error,
  };
}
