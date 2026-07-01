import { test } from "node:test";
import assert from "node:assert/strict";
import { plan } from "../src/scheduler/plan.js";
import type { Snapshot } from "../src/types.js";
import { randomBytes } from "node:crypto";

const CWD = "/proj";
function idleSnap(name: string, cwd = CWD, over: Partial<Snapshot> = {}): Snapshot {
  return { name, piSessionId: "u", cwd, goal: "g", status: "idle", progress: [], lastActive: 1, msgCount: 0, ...over };
}
function rand(n: number) { return randomBytes(4).readUInt32LE(0) % n; }

// ===== 单阶段 =====
test("R1 委托信号词 → async", () => {
  const o = plan({ task: "并行对比两个方案", fanout: 1, cwd: CWD, existingSessions: [] });
  assert.equal(o.shouldDelegate, true);
  assert.equal(o.plan?.mode, "async");
});

test("R1 fanout>1 → async + 多 session", () => {
  const o = plan({ task: "探索 a/b/c", fanout: 3, cwd: CWD, existingSessions: [] });
  assert.equal(o.plan?.mode, "async");
  assert.equal(o.plan?.sessions.length, 3);
});

test("阶段1 反信号词 → shouldDelegate=false (terminal)", () => {
  const o = plan({ task: "反复调这个动画", fanout: 3, cwd: CWD, existingSessions: [] });
  assert.equal(o.shouldDelegate, false);
  assert.equal(o.plan?.sessions.length ?? 0, 0);
});

test("R2 slots==0 → shouldDelegate=false terminal", () => {
  const busy = [1, 2, 3, 4].map(i => idleSnap(`s${i}`, CWD, { status: "running" }));
  const o = plan({ task: "做点事", fanout: 1, cwd: CWD, existingSessions: busy });
  assert.equal(o.shouldDelegate, false);
  assert.ok(o.reason.includes("并发槽"));
});

test("R2 fanout 截断到可用槽", () => {
  const busy = [1, 2].map(i => idleSnap(`s${i}`, CWD, { status: "running" }));
  const o = plan({ task: "探索 a/b/c/d/e/f", fanout: 6, cwd: CWD, existingSessions: busy });
  assert.equal(o.plan!.sessions.length, 2);  // 4-2=2 槽
  assert.ok(o.reason.includes("分批"));
});

test("R3 cwd 过滤复用：只 continue 同 cwd 的 idle", () => {
  const same = idleSnap("feat-auth", CWD);
  const other = idleSnap("feat-auth", "/other");
  const o = plan({ task: "给 auth 加测试", fanout: 1, cwd: CWD, existingSessions: [same, other] });
  const cont = o.plan!.sessions.find(s => s.action === "continue");
  assert.ok(cont);
  assert.equal(cont!.name, "feat-auth");
});

test("R3 全局 runningCount：其他 cwd 的 running 也占槽", () => {
  const otherBusy = [1, 2, 3, 4].map(i => idleSnap(`s${i}`, "/other", { status: "running" }));
  const o = plan({ task: "做点事", fanout: 1, cwd: CWD, existingSessions: otherBusy });
  assert.equal(o.shouldDelegate, false);  // 全局已满
});

test("R4 危险词 → excludeTools 含 bash", () => {
  const o = plan({ task: "删除旧目录并 rm 临时文件", fanout: 1, cwd: CWD, existingSessions: [] });
  const c = o.plan!.sessions[0].constraints;
  assert.ok(c?.excludeTools?.includes("bash"));
});

test("R4 高复杂度 → thinking high + runTimeoutMs 加倍", () => {
  const o = plan({ task: "重构状态层", fanout: 1, estComplexity: "high", cwd: CWD, existingSessions: [] });
  assert.equal(o.plan!.sessions[0].constraints?.thinking, "high");
  assert.ok((o.plan!.sessions[0].runTimeoutMs ?? 0) > 600000);
});

test("R5 preferredMode=sync 单任务 → sync", () => {
  const o = plan({ task: "改个常量", fanout: 1, preferredMode: "sync", cwd: CWD, existingSessions: [] });
  assert.equal(o.plan!.mode, "sync");
});

test("R5 preferredMode=sync 但 fanout>1 → async", () => {
  const o = plan({ task: "探索 a/b/c", fanout: 3, preferredMode: "sync", cwd: CWD, existingSessions: [] });
  assert.equal(o.plan!.mode, "async");
});

test("R5 默认 → async", () => {
  const o = plan({ task: "实现登录", fanout: 1, cwd: CWD, existingSessions: [] });
  assert.equal(o.plan!.mode, "async");
});

// ===== 组合 =====
test("组合：否决优先于一切（反信号词+危险+fanout+high）", () => {
  const o = plan({ task: "反复调删除逻辑", fanout: 3, estComplexity: "high", cwd: CWD, existingSessions: [] });
  assert.equal(o.shouldDelegate, false);
});

test("组合：危险+高复杂度叠加", () => {
  const o = plan({ task: "删除旧目录", fanout: 1, estComplexity: "high", cwd: CWD, existingSessions: [] });
  const s = o.plan!.sessions[0];
  assert.ok(s.constraints?.excludeTools?.includes("bash"));
  assert.equal(s.constraints?.thinking, "high");
  assert.ok((s.runTimeoutMs ?? 0) > 600000);
});

test("组合：信号词+危险叠加（async && excludeTools bash）", () => {
  const o = plan({ task: "并行对比删除方案", fanout: 2, cwd: CWD, existingSessions: [] });
  assert.equal(o.plan!.mode, "async");
  assert.ok(o.plan!.sessions.every(s => s.constraints?.excludeTools?.includes("bash")));
});

// ===== 性质测试（100 次随机）=====
test("性质：100 次随机输入满足不变量", () => {
  const words = ["探索整个", "并行对比", "精修", "反复调", "删除", "rm ", "实现", "改个"];
  const complexities = ["low", "medium", "high", undefined] as const;
  const modes = ["sync", "async", undefined] as const;
  for (let i = 0; i < 100; i++) {
    const task = words[rand(words.length)] + " task" + i;
    const fanout = 1 + rand(6);
    const running = Array.from({ length: rand(5) }, (_, k) => idleSnap(`r${k}`, "/x", { status: "running" }));
    const o = plan({
      task,
      fanout,
      estComplexity: complexities[rand(complexities.length)] as any,
      preferredMode: modes[rand(modes.length)] as any,
      cwd: CWD,
      existingSessions: running,
    });
    const runningCount = running.length;
    // 不变量 1: sessions ≤ min(fanout, max(0, 4 - runningCount))
    const sessLen = o.plan?.sessions.length ?? 0;
    const cap = Math.min(fanout, Math.max(0, 4 - runningCount));
    assert.ok(sessLen <= cap, `sessions ${sessLen} 超 ${cap} (task=${task})`);
    // 不变量 2: shouldDelegate=false → sessions 空
    if (!o.shouldDelegate) assert.equal(sessLen, 0);
    // 不变量 3: 危险词 → 所有 session excludeTools 含 bash
    if (/删除|rm /.test(task) && o.shouldDelegate) {
      assert.ok(o.plan!.sessions.every(s => s.constraints?.excludeTools?.includes("bash")), `danger task=${task}`);
    }
    // 不变量 4: 反信号词 → shouldDelegate false
    if (/精修|反复调/.test(task)) assert.equal(o.shouldDelegate, false);
  }
});
