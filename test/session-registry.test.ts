import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/registry/session.js";

function makeReg() { return new SessionRegistry(); }

test("create 新 session", () => {
  const r = makeReg();
  r.create({ name: "feat-x", piSessionId: "u1", cwd: "/p", goal: "do x" });
  const s = r.get("feat-x");
  assert.equal(s?.piSessionId, "u1");
  assert.equal(s?.status, "idle");
  assert.equal(s?.msgCount, 0);
  assert.deepEqual(s?.progress, []);
});

test("create 重复名 → conflict", () => {
  const r = makeReg();
  r.create({ name: "a", piSessionId: "u1", cwd: "/p", goal: "g" });
  assert.throws(
    () => r.create({ name: "a", piSessionId: "u2", cwd: "/p", goal: "g" }),
    (e: any) => e.code === "conflict",
  );
});

test("snapshot 脱敏不含 piSessionId", () => {
  const r = makeReg();
  r.create({ name: "a", piSessionId: "secret-uuid", cwd: "/p", goal: "g" });
  const snap = r.snapshot("a");
  assert.equal((snap as any).piSessionId, undefined);
  assert.equal(snap.name, "a");
});

test("progress FIFO 截断到 50", () => {
  const r = makeReg();
  r.create({ name: "a", piSessionId: "u1", cwd: "/p", goal: "g" });
  for (let i = 0; i < 60; i++) r.appendProgress("a", { ts: i, summary: `p${i}` });
  const s = r.get("a")!;
  assert.equal(s.progress.length, 50);
  assert.equal(s.progress[0].summary, "p10");  // 最早 10 条被丢
});

test("listByCwd 按 cwd 过滤 + lastActive 倒序", () => {
  const r = makeReg();
  r.create({ name: "a", piSessionId: "u1", cwd: "/p1", goal: "g" });
  r.touch("a", 100);
  r.create({ name: "b", piSessionId: "u2", cwd: "/p1", goal: "g" });
  r.touch("b", 200);
  r.create({ name: "c", piSessionId: "u3", cwd: "/p2", goal: "g" });
  const p1 = r.listByCwd("/p1");
  assert.equal(p1.length, 2);
  assert.equal(p1[0].name, "b");  // lastActive 更大在前
});

test("recordSuccess 更新 lastSummary", () => {
  const r = makeReg();
  r.create({ name: "a", piSessionId: "u1", cwd: "/p", goal: "g" });
  r.recordSuccess("a", "ok summary");
  assert.equal(r.get("a")?.lastSummary, "ok summary");
});

test("recordFailure 写 lastError 不覆盖 lastSummary", () => {
  const r = makeReg();
  r.create({ name: "a", piSessionId: "u1", cwd: "/p", goal: "g" });
  r.recordSuccess("a", "good");
  r.recordFailure("a", { code: "timeout", message: "t/o" });
  assert.equal(r.get("a")?.lastSummary, "good");  // 不覆盖
  assert.equal(r.get("a")?.lastError?.code, "timeout");
});

test("incMsgCount + setRunning/clearRunning", () => {
  const r = makeReg();
  r.create({ name: "a", piSessionId: "u1", cwd: "/p", goal: "g" });
  r.incMsgCount("a", 1000);
  r.setRunning("a", "run-1");
  assert.equal(r.get("a")?.msgCount, 1);
  assert.equal(r.get("a")?.status, "running");
  assert.equal(r.get("a")?.runId, "run-1");
  r.clearRunning("a", "idle", 2000);
  assert.equal(r.get("a")?.status, "idle");
  assert.equal(r.get("a")?.runId, undefined);
});
