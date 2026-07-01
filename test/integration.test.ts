import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/registry/session.js";
import { RunRegistry } from "../src/registry/run.js";
import { ProcessTable } from "../src/runner/process-table.js";
import { delegate } from "../src/tools/delegate.js";
import { status } from "../src/tools/status.js";
import { kill } from "../src/tools/kill.js";
import { fakePiEnv, tmpCwd, withEnv } from "./helpers.js";

function sys() {
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

test("async 成功全流程：delegate → status 收割 completed", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("success"), async () => {
    const d = sys();
    const r1 = await delegate({ prompt: "do", session: "s1", cwd: c.dir, goal: "g", mode: "async" }, d);
    const done = await status({ runId: r1.runId, waitTimeoutMs: 5000 }, d.runs);
    assert.equal(done?.status, "completed");
    assert.ok(done?.result);
    assert.ok((done?.progress?.length ?? 0) > 0);
  });
  c.cleanup();
});

test("sync 超时：hang → status timeout", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("hang"), async () => {
    const d = sys();
    const r1 = await delegate({ prompt: "do", session: "s1", cwd: c.dir, goal: "g", mode: "async", runTimeoutMs: 500 }, d);
    const done = await status({ runId: r1.runId, waitTimeoutMs: 3000 }, d.runs);
    assert.equal(done?.status, "timeout");
    await drain(d);
  });
  c.cleanup();
});

test("kill 跨调用：delegate → kill → status killed", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("hang"), async () => {
    const d = sys();
    const r1 = await delegate({ prompt: "do", session: "s1", cwd: c.dir, goal: "g", mode: "async" }, d);
    const k = kill({ runId: r1.runId }, d);
    assert.equal(k.killed, true);
    const done = await status({ runId: r1.runId, waitTimeoutMs: 3000 }, d.runs);
    assert.equal(done?.status, "killed");
    await drain(d);
  });
  c.cleanup();
});

test("session_create_failed：no_session → error + registry 无记录", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("no_session"), async () => {
    const d = sys();
    const r1 = await delegate({ prompt: "do", session: "s1", cwd: c.dir, goal: "g", mode: "async" }, d);
    assert.equal(r1.status, "error");
    assert.equal(r1.error?.code, "session_create_failed");
    assert.equal(d.sessions.has("s1"), false);
    // 但 run 仍在 registry，可 status 查
    const done = await status({ runId: r1.runId }, d.runs);
    assert.equal(done?.status, "error");
    await drain(d);
  });
  c.cleanup();
});

test("多等待者：两个 status 同时等同一 run 都拿到结果", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("success"), async () => {
    const d = sys();
    const r1 = await delegate({ prompt: "do", session: "s1", cwd: c.dir, goal: "g", mode: "async" }, d);
    const [a, b] = await Promise.all([
      status({ runId: r1.runId, waitTimeoutMs: 5000 }, d.runs),
      status({ runId: r1.runId, waitTimeoutMs: 5000 }, d.runs),
    ]);
    assert.equal(a?.status, "completed");
    assert.equal(b?.status, "completed");
  });
  c.cleanup();
});

test("progress 上限：Run.progress 截到 200 + truncated", () => {
  const runs = new RunRegistry();
  const r = runs.create({ session: "a", startedAt: 1 });
  for (let i = 0; i < 250; i++) runs.appendProgress(r.runId, { ts: i, summary: `p${i}` });
  runs.complete(r.runId, { status: "completed", endedAt: 2 });
  assert.equal(runs.get(r.runId)!.progress.length, 200);
  assert.equal(runs.get(r.runId)!.progressTruncated, true);
});
