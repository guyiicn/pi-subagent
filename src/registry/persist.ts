import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionRecord, PersistedSessionRecord, RegistryFile } from "../types.js";

// 写串行化 queue（R3#10 + R4#4）
let writeChain: Promise<void> = Promise.resolve();

export function saveRegistry(path: string, records: SessionRecord[]): Promise<void> {
  // 落盘：去掉 runId，status 保真（含 running，加载时修正）
  const persisted: PersistedSessionRecord[] = records.map(r => {
    const { runId: _drop, ...rest } = r;
    void _drop;
    return rest;
  });
  const data: RegistryFile = { version: 1, sessions: persisted };

  const run = writeChain.then(() => doSave(path, data));
  // 串行但不让一次失败卡死后续
  writeChain = run.catch(() => undefined);
  return run;
}

function doSave(path: string, data: RegistryFile): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = path + ".tmp";
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  renameSync(tmp, path);  // POSIX 原子
}

export interface LoadResult {
  sessions: SessionRecord[];  // 已修正 running→error、补默认字段
}

export function loadRegistry(path: string): LoadResult {
  if (!existsSync(path)) return { sessions: [] };

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return { sessions: [] };
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 整文件损坏：备份 + 空启动
    copyFileSync(path, path + ".corrupt-" + Date.now());
    return { sessions: [] };
  }

  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.sessions)) {
    return { sessions: [] };
  }

  const sessions: SessionRecord[] = [];
  for (const rec of parsed.sessions) {
    const fixed = fixRecord(rec);
    if (fixed) sessions.push(fixed);
  }
  return { sessions };
}

// 单条记录校验 + 补默认 + running 修正
function fixRecord(rec: any): SessionRecord | null {
  if (!rec || typeof rec !== "object") return null;
  // 核心字段缺失 → 丢弃
  if (typeof rec.name !== "string" || typeof rec.piSessionId !== "string" ||
      typeof rec.cwd !== "string" || typeof rec.goal !== "string") {
    return null;
  }
  // status 非法 → 丢弃
  if (!["idle", "running", "error"].includes(rec.status)) return null;

  const now = Date.now();
  const status: SessionRecord["status"] = rec.status;
  const out: SessionRecord = {
    name: rec.name,
    piSessionId: rec.piSessionId,
    cwd: rec.cwd,
    goal: rec.goal,
    status,
    constraints: rec.constraints,
    lastSummary: rec.lastSummary,
    lastError: rec.lastError,
    progress: Array.isArray(rec.progress) ? rec.progress : [],  // 补默认
    lastActive: typeof rec.lastActive === "number" ? rec.lastActive : now,
    msgCount: typeof rec.msgCount === "number" ? rec.msgCount : 0,
  };

  // 加载修正：running → error（进程已不在）
  if (out.status === "running") {
    out.status = "error";
    out.lastError = { code: "interrupted_by_restart", message: "server 重启时仍在运行", ts: now };
  }
  return out;
}
