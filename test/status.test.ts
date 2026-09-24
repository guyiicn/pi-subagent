import { test } from "node:test";
import assert from "node:assert/strict";
import { RunRegistry } from "../src/registry/run.js";
import { status } from "../src/tools/status.js";

test("已完成 run 立即返回结果", async () => {
  const runs = new RunRegistry();
  const r = runs.create({ session: "a", startedAt: 1 });
  runs.complete(r.runId, { status: "completed", result: "ok", endedAt: 2 });
  const out = await status({ runId: r.runId }, runs);
  assert.equal(out.status, "completed");
  assert.equal(out.result, "ok");
});

test("不存在 runId → not_found", async () => {
  const runs = new RunRegistry();
  await assert.rejects(
    () => status({ runId: "nope" }, runs),
    (e: any) => e.code === "not_found",
  );
});

test("expired runId → run_expired", async () => {
  const runs = new RunRegistry(1, 99999999);
  const r1 = runs.create({ session: "a", startedAt: 1 });
  runs.complete(r1.runId, { status: "completed", endedAt: 2 });
  const r2 = runs.create({ session: "a", startedAt: 3 });
  runs.complete(r2.runId, { status: "completed", endedAt: 4 });  // 淘汰 r1
  await assert.rejects(
    () => status({ runId: r1.runId }, runs),
    (e: any) => e.code === "run_expired",
  );
});

test("long-poll running run → 完成时返回", async () => {
  const runs = new RunRegistry();
  const r = runs.create({ session: "a", startedAt: 1 });
  setTimeout(() => runs.complete(r.runId, { status: "completed", result: "done", endedAt: 2 }), 50);
  const out = await status({ runId: r.runId, waitTimeoutMs: 2000 }, runs);
  assert.equal(out.status, "completed");
});

test("waitTimeoutMs=0 → 立即返回 running", async () => {
  const runs = new RunRegistry();
  const r = runs.create({ session: "a", startedAt: 1 });
  const out = await status({ runId: r.runId, waitTimeoutMs: 0 }, runs);
  assert.equal(out.status, "running");
});

// ===== [待实现] 运行中也返回已记录的 progress =====
// 现状：run 仍 running 时，status 只返回 { runId, session, status: "running" }，
// RunRegistry 里已流式记录（且已脱敏）的 progress 完全不可见，host 无法判断 Pi 是否在推进。

test("[待实现] running + waitTimeoutMs=0 → 返回已记录的 progress", async () => {
  const runs = new RunRegistry();
  const r = runs.create({ session: "a", startedAt: 1 });
  runs.appendProgress(r.runId, { ts: 2, tool: "write", summary: "Successfully wrote to a.py" });
  const out = await status({ runId: r.runId, waitTimeoutMs: 0 }, runs);
  assert.equal(out.status, "running");
  assert.deepEqual(out.progress?.map((p) => p.tool), ["write"]);
  assert.equal(out.progressTruncated, false);
});

test("running + long-poll 超时 → 返回超时那一刻的 progress（现已满足，防回归）", async () => {
  const runs = new RunRegistry();
  const r = runs.create({ session: "a", startedAt: 1 });
  setTimeout(() => runs.appendProgress(r.runId, { ts: 3, tool: "bash", summary: "ok" }), 20);
  const out = await status({ runId: r.runId, waitTimeoutMs: 100 }, runs);
  assert.equal(out.status, "running");
  assert.deepEqual(out.progress?.map((p) => p.tool), ["bash"]);
});
