import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { collectOutput } from "../src/runner/spawn.js";

test("collectOutput 读 stdout 逐行 + exitCode", async () => {
  const child = spawn("printf", ['{"type":"session","id":"u1"}\\n{"type":"agent_end","messages":[]}\\n']);
  const res = await collectOutput(child);
  assert.equal(res.exitCode, 0);
  assert.equal(res.lines.length, 2);
  assert.ok(res.lines[0].includes("session"));
});

test("collectOutput stderr 末尾保留", async () => {
  const child = spawn("sh", ["-c", "echo err1 >&2; echo err2 >&2; echo out"]);
  const res = await collectOutput(child);
  assert.ok(res.stderrTail.includes("err2"));
});

// 回归：stdout 流发出 'error' 不能升级成 uncaughtException 掀翻进程（并发下曾致 server 崩溃）。
// 若 collectOutput 未给流挂 'error' 监听，本用例会让测试进程崩溃而非正常结束。
test("collectOutput stdout 'error' 事件不崩溃、正常 settle", async () => {
  const child = spawn("sh", ["-c", 'printf \'{"type":"session","id":"u1"}\\n\'; sleep 0.05']);
  const p = collectOutput(child);
  // 在读取过程中人为向流注入一个 error 事件（模拟 destroy/kill 时的 EPIPE 等）
  child.stdout?.emit("error", new Error("simulated pipe error"));
  const res = await p;
  assert.equal(res.exitCode, 0);
  assert.ok(res.lines.some((l) => l.includes("session")));
});
