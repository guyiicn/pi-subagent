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
