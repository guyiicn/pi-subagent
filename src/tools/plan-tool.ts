import { plan } from "../scheduler/plan.js";
import type { PlanInput, PlanOutput } from "../types.js";
import type { SessionRegistry } from "../registry/session.js";

// pi_plan 工具：existingSessions 用全量（不传 cwd，R3#14）
export function planTool(input: PlanInput, sessions: SessionRegistry): PlanOutput {
  const all = sessions.list();
  return plan({ ...input, existingSessions: all });
}
