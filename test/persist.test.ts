import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveRegistry, loadRegistry } from "../src/registry/persist.js";
import type { SessionRecord } from "../src/types.js";

function tmpDir() { return mkdtempSync(join(tmpdir(), "pi-sub-test-")); }

function sampleRecord(over: Partial<SessionRecord> = {}): SessionRecord {
  return { name: "a", piSessionId: "u1", cwd: "/p", goal: "g", status: "idle", progress: [], lastActive: 1, msgCount: 0, ...over };
}

test("save + load 往返（running 记录落盘保真）", async () => {
  const dir = tmpDir();
  const path = join(dir, "registry.json");
  await saveRegistry(path, [sampleRecord({ name: "r1", status: "running", runId: "x" })]);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(raw.version, 1);
  assert.equal(raw.sessions[0].status, "running");  // 落盘保真
  assert.equal(raw.sessions[0].runId, undefined);   // runId 不落盘
  const loaded = loadRegistry(path);
  assert.equal(loaded.sessions[0].status, "error"); // 加载修正
  assert.equal(loaded.sessions[0].lastError?.code, "interrupted_by_restart");
  rmSync(dir, { recursive: true, force: true });
});

test("目录不存在时 save 自动 mkdir", async () => {
  const dir = tmpDir();
  const nested = join(dir, "nested", "deep");
  const path = join(nested, "registry.json");
  await saveRegistry(path, []);
  assert.ok(existsSync(path));
  rmSync(dir, { recursive: true, force: true });
});

test("文件不存在 → 空注册表", () => {
  const dir = tmpDir();
  const loaded = loadRegistry(join(dir, "nope.json"));
  assert.deepEqual(loaded.sessions, []);
  rmSync(dir, { recursive: true, force: true });
});

test("文件损坏 → 备份 + 空启动", () => {
  const dir = tmpDir();
  const path = join(dir, "registry.json");
  writeFileSync(path, "{ not valid json {{{");
  const loaded = loadRegistry(path);
  assert.deepEqual(loaded.sessions, []);
  // 备份在：目录下有 .corrupt- 开头的文件
  const files = readdirSync(dir);
  assert.ok(files.some(f => f.startsWith("registry.json.corrupt-")), `应有 corrupt 备份，实际: ${files.join(",")}`);
  rmSync(dir, { recursive: true, force: true });
});

test("单条记录缺 progress → 补 []，其他记录不受影响", () => {
  const dir = tmpDir();
  const path = join(dir, "registry.json");
  writeFileSync(path, JSON.stringify({
    version: 1,
    sessions: [
      { name: "a", piSessionId: "u1", cwd: "/p", goal: "g", status: "idle", lastActive: 1, msgCount: 0 },
      { name: "b", piSessionId: "u2", cwd: "/p", goal: "g", status: "idle", progress: [], lastActive: 2, msgCount: 1 },
    ],
  }));
  const loaded = loadRegistry(path);
  assert.equal(loaded.sessions.length, 2);
  assert.deepEqual(loaded.sessions[0].progress, []);  // 补默认
  rmSync(dir, { recursive: true, force: true });
});

test("单条记录缺核心字段 name → 该条丢弃，其他保留", () => {
  const dir = tmpDir();
  const path = join(dir, "registry.json");
  writeFileSync(path, JSON.stringify({
    version: 1,
    sessions: [
      { piSessionId: "u1", cwd: "/p", goal: "g", status: "idle", progress: [], lastActive: 1, msgCount: 0 }, // 缺 name
      { name: "good", piSessionId: "u2", cwd: "/p", goal: "g", status: "idle", progress: [], lastActive: 2, msgCount: 0 },
    ],
  }));
  const loaded = loadRegistry(path);
  assert.equal(loaded.sessions.length, 1);
  assert.equal(loaded.sessions[0].name, "good");
  rmSync(dir, { recursive: true, force: true });
});

test("save 写入串行化：并发两次 save 都落盘不损坏", async () => {
  const dir = tmpDir();
  const path = join(dir, "registry.json");
  await Promise.all([
    saveRegistry(path, [sampleRecord({ name: "a" })]),
    saveRegistry(path, [sampleRecord({ name: "b" })]),
  ]);
  // 串行 queue 保证最后一次胜出，文件不损坏
  const raw = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(raw.sessions.length === 1);  // 后写的覆盖
  rmSync(dir, { recursive: true, force: true });
});
