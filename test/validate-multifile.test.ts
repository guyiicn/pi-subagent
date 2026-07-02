import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFiles, splitOutputFiles } from "../src/runner/validate.js";

const DIR = join(tmpdir(), "pi-sub-vmulti-" + process.pid);
mkdirSync(DIR, { recursive: true });

test("splitOutputFiles: 逗号分隔 → 多路径", () => {
  const files = splitOutputFiles("a.html, b.css; c.js", DIR);
  assert.equal(files.length, 3);
  assert.equal(files[0], join(DIR, "a.html"));
  assert.equal(files[1], join(DIR, "b.css"));
  assert.equal(files[2], join(DIR, "c.js"));
});

test("splitOutputFiles: 单文件", () => {
  const files = splitOutputFiles("only.html", DIR);
  assert.equal(files.length, 1);
});

test("splitOutputFiles: 绝对路径保留", () => {
  const files = splitOutputFiles("/abs/a.html, rel/b.html", DIR);
  assert.equal(files[0], "/abs/a.html");
  assert.equal(files[1], join(DIR, "rel/b.html"));
});

test("validateFiles: 多文件全存在 → pass", () => {
  writeFileSync(join(DIR, "m1.html"), "<h1>1</h1>");
  writeFileSync(join(DIR, "m2.css"), "body{}");
  const r = validateFiles("m1.html, m2.css", DIR);
  assert.equal(r.passed, true);
});

test("validateFiles: 多文件其中一个不存在 → fail 含该文件路径", () => {
  writeFileSync(join(DIR, "ok.html"), "<h1>x</h1>");
  const r = validateFiles("ok.html, missing.html", DIR);
  assert.equal(r.passed, false);
  assert.ok(r.detail?.includes("missing.html"));
});

test("validateFiles: 默认规则(无TODO)对多文件生效", () => {
  writeFileSync(join(DIR, "good.html"), "<h1>ok</h1>");
  writeFileSync(join(DIR, "bad.html"), "TODO later");
  const r = validateFiles("good.html, bad.html", DIR);
  assert.equal(r.passed, false);
  assert.ok(r.detail?.includes("bad.html"));
});

test.after(() => {
  rmSync(DIR, { recursive: true, force: true });
});
