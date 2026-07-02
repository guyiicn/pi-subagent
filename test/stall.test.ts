import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/registry/session.js";
import { RunRegistry } from "../src/registry/run.js";
import { ProcessTable } from "../src/runner/process-table.js";
import { delegate } from "../src/tools/delegate.js";
import { fakePiEnv, tmpCwd, withEnv } from "./helpers.js";

function deps() {
  return { sessions: new SessionRegistry(), runs: new RunRegistry(), procs: new ProcessTable() };
}

async function drain(d: { runs: RunRegistry; procs: ProcessTable }, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (d.runs.runningCount() > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (d.runs.runningCount() > 0) {
    d.procs.killAll();
    const d2 = Date.now() + timeoutMs;
    while (d.runs.runningCount() > 0 && Date.now() < d2) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

test("停滞检测：stall 模式 + stallTimeoutMs=500 → run 标 stalled", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("stall"), async () => {
    const d = deps();
    const r = await delegate({
      prompt: "do", session: "s1", cwd: c.dir, goal: "g",
      mode: "async", stallTimeoutMs: 500,
    }, d);
    // 等 run 终结（停滞会 kill + 标 stalled）
    const done = await d.runs.waitForCompletion(r.runId, 5000);
    assert.equal(done?.status, "error");
    assert.equal(done?.error?.code, "stalled");
    await drain(d);
  });
  c.cleanup();
});

test("正常 progress 不触发停滞（success 模式快速完成）", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("success"), async () => {
    const d = deps();
    const r = await delegate({
      prompt: "do", session: "s1", cwd: c.dir, goal: "g",
      mode: "async", stallTimeoutMs: 10000,
    }, d);
    const done = await d.runs.waitForCompletion(r.runId, 5000);
    assert.equal(done?.status, "completed");
  });
  c.cleanup();
});
