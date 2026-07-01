import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/registry/redact.js";

test("截断到 200 字符（非敏感长文本）", () => {
  // 用含空格的普通句子，不会被 token 正则整体吃掉
  const long = "this is normal text ".repeat(50);
  const r = redact(long);
  assert.equal(r.length, 200);
});

test("似 token 字符串替换为 ***", () => {
  const r = redact("key=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abc");
  assert.ok(r.includes("***"));
  assert.ok(!r.includes("eyJhbGci"));
});

test("password=xxx 被替换", () => {
  const r = redact("my password=hunter2 leaked");
  assert.ok(r.includes("***"));
  assert.ok(!r.includes("hunter2"));
});

test("API_KEY=xxx 被替换", () => {
  const r = redact("API_KEY=sk-abc123def");
  assert.ok(r.includes("***"));
  assert.ok(!r.includes("sk-abc123def"));
});

test("普通文本不被破坏", () => {
  assert.equal(redact("hello world"), "hello world");
});
