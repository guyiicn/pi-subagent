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

// ===== 精准度：不误伤常见非密钥长串 =====
const KEEP = [
  ["UUID", "session 97795bef-87ec-4d89-bcb7-09542931258c started"],
  ["路径片段", "/tmp/claude-1000/-home-guyii-code/97795bef-87ec-4d89-bcb7-09542931258c/scratchpad/a.md"],
  ["git sha", "HEAD is now at df0e3e8c1a9b2f7e4d5c6b7a8f9e0d1c2b3a4f5e"],
  ["长英文标识符", "call validateFilesAgainstRules_and_splitOutputFiles now"],
  ["大写路径", "/Users/SomeUser/Projects/MyProject2024/src/index.ts"],
];
for (const [name, text] of KEEP) {
  test(`保留：${name}`, () => {
    assert.equal(redact(text, 1000), text);
  });
}

// ===== 召回：常见密钥格式都打码 =====
const SECRETS = [
  ["OpenAI/Anthropic sk-", "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv"],
  ["GitHub ghp_", "ghp_1234567890abcdefghijABCDEFGHIJ"],
  ["GitHub PAT", "github_pat_11ABCDEFG0123456789_abcdefghij"],
  ["GitLab", "glpat-abcdefghij0123456789"],
  ["Slack", "xoxb-1234567890-abcdefghij"],
  ["AWS key id", "AKIAIOSFODNN7EXAMPLE"],
  ["Google API key", "AIzaSyA1234567890abcdefghijklmnopqrstu"],
  ["JWT", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
  ["高熵随机串", "Zq8mN3vX7kP2wR9tY5uJ1hG6fD4sA0lKqWeRtYuI"],
];
for (const [name, secret] of SECRETS) {
  test(`打码：${name}`, () => {
    const r = redact(`output: ${secret} done`, 1000);
    assert.ok(!r.includes(secret), r);
    assert.ok(r.includes("***"), r);
    assert.ok(r.startsWith("output: ") && r.endsWith(" done"), r);
  });
}

test("Bearer 头保留前缀，只打码 token", () => {
  assert.equal(redact("Authorization Bearer abc.def-ghi", 1000).includes("abc.def-ghi"), false);
  assert.equal(redact("curl -H 'Bearer abc.def-ghi'", 1000), "curl -H 'Bearer ***'");
});

test("PEM 私钥块整体打码", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabc\n-----END RSA PRIVATE KEY-----";
  assert.equal(redact(`key:\n${pem}\nok`, 1000), "key:\n***\nok");
});
