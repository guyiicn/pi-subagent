import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDelegateArgs, buildForkArgs } from "../src/runner/argv.js";
import type { Constraints } from "../src/types.js";

test("delegate 基础参数含 -p/--mode json", () => {
  const a = buildDelegateArgs({ prompt: "hi", sessionId: undefined, constraints: {} });
  assert.deepEqual(a, ["-p", "hi", "--mode", "json"]);
});

test("delegate 续接加 --session-id", () => {
  const a = buildDelegateArgs({ prompt: "hi", sessionId: "uuid-1", constraints: {} });
  assert.deepEqual(a, ["-p", "hi", "--mode", "json", "--session-id", "uuid-1"]);
});

test("delegate constraints 全映射", () => {
  const c: Constraints = { tools: ["read", "bash"], excludeTools: ["edit"], thinking: "high", model: "gpt-x" };
  const a = buildDelegateArgs({ prompt: "hi", sessionId: undefined, constraints: c });
  assert.ok(a.includes("--tools"), "tools");
  assert.ok(a.includes("read,bash"), "tools 值");
  assert.ok(a.includes("--exclude-tools"), "excludeTools");
  assert.ok(a.includes("edit"), "excludeTools 值");
  assert.ok(a.includes("--thinking"), "thinking");
  assert.ok(a.includes("high"), "thinking 值");
  assert.ok(a.includes("--model"), "model");
  assert.ok(a.includes("gpt-x"), "model 值");
});

test("delegate 不含 session-dir/provider/append-system-prompt", () => {
  const a = buildDelegateArgs({ prompt: "hi", sessionId: undefined, constraints: {} });
  assert.ok(!a.some(x => x.includes("session-dir")));
  assert.ok(!a.some(x => x.includes("provider")));
  assert.ok(!a.some(x => x.includes("system-prompt")));
});

test("fork 参数 = --mode json --fork <id>", () => {
  assert.deepEqual(buildForkArgs("src-uuid"), ["--mode", "json", "--fork", "src-uuid"]);
});
