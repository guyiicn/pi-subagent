import type { RunRegistry } from "../registry/run.js";
import type { ProcessTable } from "../runner/process-table.js";
import type { SessionRegistry } from "../registry/session.js";
import { Errors } from "../errors.js";
import { markManualKill } from "./delegate.js";
import type { Snapshot } from "../types.js";

export function kill(
  input: { runId: string },
  deps: { runs: RunRegistry; procs: ProcessTable; sessions: SessionRegistry },
): { session?: Snapshot; killed: boolean } {
  const run = deps.runs.get(input.runId);
  if (!run) throw Errors.notFound(`run ${input.runId}`);
  if (run.status !== "running") {
    return {
      session: deps.sessions.has(run.session) ? deps.sessions.snapshot(run.session) : undefined,
      killed: false,
    };
  }
  // 标记手动 kill（区分超时），再发 SIGTERM
  markManualKill(input.runId);
  deps.procs.kill(input.runId);
  // 进程退出后 process-table onExit → collectOutput resolve → delegate finalize 标 killed
  return {
    session: deps.sessions.has(run.session) ? deps.sessions.snapshot(run.session) : undefined,
    killed: true,
  };
}
