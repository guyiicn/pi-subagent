import { test } from "node:test";
import assert from "node:assert/strict";
import { RunRegistry } from "../src/registry/run.js";

function makeReg(maxCompleted = 128, ttlMs = 86400000) {
  return new RunRegistry(maxCompleted, ttlMs);
}

test("create + get running run", () => {
  const r = makeReg();
  const run = r.create({ session: "a", startedAt: 1 });
  assert.equal(run.status, "running");
  assert.equal(r.get(run.runId)?.status, "running");
});

test("complete 后仍可 get", () => {
  const r = makeReg();
  const run = r.create({ session: "a", startedAt: 1 });
  r.complete(run.runId, { status: "completed", result: "ok", endedAt: 2 });
  assert.equal(r.get(run.runId)?.status, "completed");
  assert.equal(r.get(run.runId)?.result, "ok");
});

test("runningCount 统计", () => {
  const r = makeReg();
  const r1 = r.create({ session: "a", startedAt: 1 });
  r.create({ session: "b", startedAt: 2 });
  assert.equal(r.runningCount(), 2);
  r.complete(r1.runId, { status: "completed", endedAt: 3 });
  assert.equal(r.runningCount(), 1);
});

test("超过 maxCompleted 淘汰旧完成 run", () => {
  const r = makeReg(2, 999999999);
  const r1 = r.create({ session: "a", startedAt: 1 });
  r.complete(r1.runId, { status: "completed", endedAt: 2 });
  const r2 = r.create({ session: "a", startedAt: 3 });
  r.complete(r2.runId, { status: "completed", endedAt: 4 });
  const r3 = r.create({ session: "a", startedAt: 5 });
  r.complete(r3.runId, { status: "completed", endedAt: 6 });
  // 只保留最近 2 条完成 → r1 被淘汰
  assert.equal(r.get(r1.runId), undefined);
  assert.equal(r.isExpired(r1.runId), true);
  assert.ok(r.get(r2.runId));
});

test("TTL 过期淘汰", async () => {
  const r = makeReg(128, 100);  // 100ms TTL
  const run = r.create({ session: "a", startedAt: 1 });
  r.complete(run.runId, { status: "completed", endedAt: 2 });
  await new Promise<void>((resolve) => {
    setTimeout(() => {
      r.cleanupExpired();
      assert.equal(r.get(run.runId), undefined);
      resolve();
    }, 150);
  });
});

test("多等待者：完成时全部唤醒", async () => {
  const r = makeReg();
  const run = r.create({ session: "a", startedAt: 1 });
  const w1 = r.waitForCompletion(run.runId, 1000);
  const w2 = r.waitForCompletion(run.runId, 1000);
  r.complete(run.runId, { status: "completed", result: "done", endedAt: 2 });
  const [a, b] = await Promise.all([w1, w2]);
  assert.equal(a?.result, "done");
  assert.equal(b?.result, "done");
});

test("waitForCompletion 超时返回当前状态", async () => {
  const r = makeReg();
  const run = r.create({ session: "a", startedAt: 1 });
  const res = await r.waitForCompletion(run.runId, 50);
  assert.equal(res?.status, "running");  // 仍 running（超时）
});

test("isExpired 对从未存在的 runId 返回 false", () => {
  const r = makeReg();
  assert.equal(r.isExpired("never"), false);
});
