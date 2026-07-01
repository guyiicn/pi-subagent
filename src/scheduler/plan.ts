import type { PlanInput, PlanOutput, SessionSpec, Snapshot, Constraints } from "../types.js";
import { REJECT_WORDS, DELEGATE_WORDS, DANGER_WORDS, containsAny } from "./keywords.js";

const MAX_CONCURRENCY = 4;
const BASE_RUN_TIMEOUT = 600000;
const HIGH_RUN_TIMEOUT = 1200000;  // 高复杂度加倍

export function plan(input: PlanInput): PlanOutput {
  const task = input.task;
  const fanout = input.fanout ?? 1;
  const cwd = input.cwd;
  const all = input.existingSessions;
  const runningCount = all.filter(s => s.status === "running").length;

  // ===== 阶段 1: 否决 (terminal) =====
  if (containsAny(task, REJECT_WORDS)) {
    return { shouldDelegate: false, reason: "任务需高频人工判断，建议亲自做" };
  }

  // ===== 阶段 2: 容量 =====
  const available = MAX_CONCURRENCY - runningCount;
  if (available <= 0) {
    return { shouldDelegate: false, reason: "无可用并发槽，稍后重试" };
  }
  const effectiveFanout = Math.min(fanout, available);
  const batched = effectiveFanout < fanout;

  // ===== 阶段 3: 复用（cwd 过滤）=====
  const candidates = all.filter(s => s.cwd === cwd && s.status === "idle");
  const specs: SessionSpec[] = [];
  for (let i = 0; i < effectiveFanout; i++) {
    const reuse = candidates[i];
    if (reuse) {
      specs.push({
        action: "continue",
        name: reuse.name,
        goal: reuse.goal,
        cwd,
        constraints: reuse.constraints,
        prompt: "",  // host 填
      });
    } else {
      specs.push({
        action: "create",
        name: `${task.slice(0, 12)}-${i}`,
        goal: task,
        cwd,
        prompt: "",
      });
    }
  }

  // ===== 阶段 4: 修饰（叠加）=====
  const isDanger = containsAny(task, DANGER_WORDS);
  const isHigh = input.estComplexity === "high";
  for (const s of specs) {
    if (isDanger) {
      const merged: Constraints = { ...(s.constraints ?? {}) };
      if (merged.tools?.length) {
        merged.tools = merged.tools.filter(t => t !== "bash");
      } else {
        merged.excludeTools = [...new Set([...(merged.excludeTools ?? []), "bash"])];
      }
      merged.thinking = "high";
      s.constraints = merged;
    }
    if (isHigh) {
      s.constraints = { ...(s.constraints ?? {}), thinking: "high" };
      s.runTimeoutMs = HIGH_RUN_TIMEOUT;
    } else if (!s.runTimeoutMs) {
      s.runTimeoutMs = BASE_RUN_TIMEOUT;
    }
  }

  // ===== 阶段 5: mode 决策 =====
  let mode: "sync" | "async" = "async";
  const reasons: string[] = [];
  if (effectiveFanout > 1) {
    mode = "async";
  } else if (containsAny(task, DELEGATE_WORDS)) {
    mode = "async";
  } else if (input.preferredMode === "sync" && effectiveFanout === 1) {
    mode = "sync";
  } else if (input.preferredMode === "sync" && effectiveFanout > 1) {
    mode = "async";
    reasons.push("fanout>1 不支持 sync，已改 async");
  }
  if (batched) reasons.push(`分批，余 ${fanout - effectiveFanout} 待后续`);

  return {
    shouldDelegate: true,
    reason: reasons.join("；") || "ok",
    plan: { mode, sessions: specs },
  };
}
