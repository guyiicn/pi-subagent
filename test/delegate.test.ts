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

// 等待所有 running run 完成（确保后台 finalize 跑完，避免未决 promise）
async function drain(d: { runs: RunRegistry; procs: ProcessTable }, timeoutMs = 5000) {
  // 给后台 finalize 时间跑；若仍有 running，kill 后再等
  const deadline = Date.now() + timeoutMs;
  while (d.runs.runningCount() > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50));
  }
  if (d.runs.runningCount() > 0) {
    d.procs.killAll();
    // kill 后等所有 run complete（finalize 跑完）
    const deadline2 = Date.now() + timeoutMs;
    while (d.runs.runningCount() > 0 && Date.now() < deadline2) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

test("async 新 session 成功（握手后返回 running）", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("success"), async () => {
    const d = deps();
    const r = await delegate({ prompt: "hi", session: "s1", cwd: c.dir, goal: "g", mode: "async" }, d);
    assert.equal(r.status, "running");
    assert.ok(r.runId);
    assert.ok(r.session);
    assert.equal(r.session?.name, "s1");
    await drain(d);
  });
  c.cleanup();
});

test("async 创建时 goal 缺失 → goal_required", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("success"), async () => {
    const d = deps();
    await assert.rejects(
      () => delegate({ prompt: "hi", session: "s1", cwd: c.dir, mode: "async" }, d),
      (e: any) => e.code === "goal_required",
    );
  });
  c.cleanup();
});

test("async cwd 不存在 → cwd_invalid", async () => {
  await withEnv(fakePiEnv("success"), async () => {
    const d = deps();
    await assert.rejects(
      () => delegate({ prompt: "hi", session: "s1", cwd: "/no/such/dir", goal: "g", mode: "async" }, d),
      (e: any) => e.code === "cwd_invalid",
    );
  });
});

test("no_session 模式 → session_create_failed + 无 SessionRecord", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("no_session"), async () => {
    const d = deps();
    const r = await delegate({ prompt: "hi", session: "s1", cwd: c.dir, goal: "g", mode: "async" }, d);
    assert.equal(r.status, "error");
    assert.equal(r.error?.code, "session_create_failed");
    assert.equal(d.sessions.has("s1"), false);  // 无记录
    await drain(d);
  });
  c.cleanup();
});

test("sync 续接已有 session 阻塞返回 completed", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("success"), async () => {
    const d = deps();
    const r1 = await delegate({ prompt: "hi", session: "s1", cwd: c.dir, goal: "g", mode: "async" }, d);
    const done = await d.runs.waitForCompletion(r1.runId, 5000);
    assert.equal(done?.status, "completed");
    const r2 = await delegate({ prompt: "again", session: "s1", mode: "sync" }, d);
    assert.equal(r2.status, "completed");
    assert.ok(r2.result);
  });
  c.cleanup();
});

test("并发第 5 个 → resource_busy", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("hang"), async () => {
    const d = deps();
    for (let i = 0; i < 4; i++) {
      await delegate({ prompt: "h", session: `s${i}`, cwd: c.dir, goal: "g", mode: "async" }, d);
    }
    await assert.rejects(
      () => delegate({ prompt: "h", session: "s5", cwd: c.dir, goal: "g", mode: "async" }, d),
      (e: any) => e.code === "resource_busy",
    );
    await drain(d);
  });
  c.cleanup();
});

test("PI_BIN 不存在 → session_create_failed，不挂起", async () => {
  const c = tmpCwd();
  await withEnv({ PI_BIN: "/no/such/pi-binary", FAKE_PI_MODE: "success" }, async () => {
    const d = deps();
    const r = await delegate({ prompt: "hi", session: "s1", cwd: c.dir, goal: "g", mode: "async" }, d);
    assert.equal(r.status, "error");
    assert.equal(r.error?.code, "session_create_failed");
    assert.equal(d.sessions.has("s1"), false);
    await drain(d);
  });
  c.cleanup();
});

test("async finalize 完成后触发 onSessionChange（持久化钩子）", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("success"), async () => {
    let changeCalls = 0;
    const d = { ...deps(), onSessionChange: () => { changeCalls++; } };
    await delegate({ prompt: "hi", session: "s1", cwd: c.dir, goal: "g", mode: "async" }, d);
    // 等 finalize 跑完
    await drain(d);
    assert.ok(changeCalls >= 1, `onSessionChange 应被调用，实际 ${changeCalls}`);
  });
  c.cleanup();
});
