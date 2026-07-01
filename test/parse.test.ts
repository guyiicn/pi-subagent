import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractResult, classifyLine } from "../src/runner/parse.js";

const FIXTURE = readFileSync(new URL("./fixtures/pi-output-echo.jsonl", import.meta.url), "utf8")
  .split("\n").filter(l => l.trim());

test("classifyLine 识别 session 事件", () => {
  const ev = classifyLine(FIXTURE[0]);
  assert.equal(ev?.type, "session");
  assert.ok(ev?.sessionId);
});

test("classifyLine 对坏 JSON 行返回 null（不抛）", () => {
  assert.equal(classifyLine("not json {{"), null);
  assert.equal(classifyLine(""), null);
});

test("extractResult 从 fixture 取出 result + progress", () => {
  const { result, progress } = extractResult(FIXTURE);
  assert.ok(typeof result === "string" && result.length > 0, "result 应为非空文本");
  assert.ok(progress.length > 0, "应有 progress (tool_execution_end)");
  assert.ok(progress.every(p => typeof p.summary === "string"), "每条 progress 有 summary");
  assert.ok(progress.every(p => p.summary.length <= 200), "summary 截断到 200");
});

test("extractResult 无 agent_end 时 result 为 null", () => {
  const lines = FIXTURE.filter(l => !l.includes('"type":"agent_end"'));
  const { result } = extractResult(lines);
  assert.equal(result, null);
});

test("extractResult 从 agent_end 取 usage", () => {
  const { usage } = extractResult(FIXTURE);
  assert.ok(usage, "应有 usage");
});
