import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { snapshotDir, diffSnapshots, checkScope, globToRegExp } from "../src/runner/scope.js";
import { tmpCwd } from "./helpers.js";

test("snapshotDir：相对路径 + 忽略 __pycache__/.git/*.pyc", () => {
  const c = tmpCwd();
  mkdirSync(join(c.dir, "src"));
  mkdirSync(join(c.dir, "__pycache__"));
  mkdirSync(join(c.dir, ".git"));
  writeFileSync(join(c.dir, "a.py"), "x");
  writeFileSync(join(c.dir, "src/b.py"), "y");
  writeFileSync(join(c.dir, "__pycache__/a.cpython-312.pyc"), "z");
  writeFileSync(join(c.dir, ".git/HEAD"), "ref");
  writeFileSync(join(c.dir, "c.pyc"), "z");
  const snap = snapshotDir(c.dir);
  assert.deepEqual([...snap.files.keys()].sort(), ["a.py", "src/b.py"]);
  assert.equal(snap.truncated, false);
  c.cleanup();
});

test("snapshotDir：超过上限标 truncated", () => {
  const c = tmpCwd();
  for (let i = 0; i < 5; i++) writeFileSync(join(c.dir, `f${i}`), "x");
  assert.equal(snapshotDir(c.dir, 3).truncated, true);
  c.cleanup();
});

test("diffSnapshots：新建 / 修改 / 删除", () => {
  const c = tmpCwd();
  writeFileSync(join(c.dir, "keep"), "1");
  writeFileSync(join(c.dir, "mod"), "1");
  writeFileSync(join(c.dir, "del"), "1");
  const before = snapshotDir(c.dir);
  writeFileSync(join(c.dir, "mod"), "22");
  utimesSync(join(c.dir, "mod"), new Date(), new Date(Date.now() + 5000));
  rmSync(join(c.dir, "del"));
  writeFileSync(join(c.dir, "new"), "1");
  assert.deepEqual(diffSnapshots(before, snapshotDir(c.dir)), { created: ["new"], modified: ["mod"], deleted: ["del"] });
  c.cleanup();
});

test("globToRegExp：* 不跨目录，** 跨目录，/ 结尾为目录前缀", () => {
  assert.ok(globToRegExp("*.log").test("a.log"));
  assert.ok(!globToRegExp("*.log").test("x/a.log"));
  assert.ok(globToRegExp("**/*.log").test("x/y/a.log"));
  assert.ok(globToRegExp("**/*.log").test("a.log"));
  assert.ok(globToRegExp("fixtures/").test("fixtures/a/b.json"));
  assert.ok(globToRegExp("data?.csv").test("data1.csv"));
  assert.ok(!globToRegExp("a.b").test("axb"));
});

test("checkScope：outputFile / _ 元数据 / allowExtraFiles 放行，其余归 stray/violation", () => {
  const r = checkScope(
    { created: ["out.py", "_notes.md", "fixtures/x.json", "sw.txt"], modified: ["core.py", "out.py"], deleted: ["old.txt"] },
    { cwd: "/w", outputFiles: ["/w/out.py"], allowExtraFiles: ["fixtures/"] },
  );
  assert.deepEqual(r.stray, ["sw.txt"]);
  assert.deepEqual(r.violations, ["modified: core.py", "deleted: old.txt"]);
});
