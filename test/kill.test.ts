import { test } from "node:test";
import assert from "node:assert/strict";
import { RunRegistry } from "../src/registry/run.js";
import { ProcessTable } from "../src/runner/process-table.js";
import { SessionRegistry } from "../src/registry/session.js";
import { kill } from "../src/tools/kill.js";

test("kill 不存在 runId → not_found", () => {
  assert.throws(
    () => kill({ runId: "nope" }, { runs: new RunRegistry(), procs: new ProcessTable(), sessions: new SessionRegistry() }),
    (e: any) => e.code === "not_found",
  );
});

test("kill 已完成 run → killed=false 幂等", () => {
  const runs = new RunRegistry();
  const r = runs.create({ session: "a", startedAt: 1 });
  runs.complete(r.runId, { status: "completed", endedAt: 2 });
  const out = kill({ runId: r.runId }, { runs, procs: new ProcessTable(), sessions: new SessionRegistry() });
  assert.equal(out.killed, false);
});
