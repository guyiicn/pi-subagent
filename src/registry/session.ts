import type { SessionRecord, Snapshot, ProgressEvent, Constraints } from "../types.js";
import { Errors } from "../errors.js";

const MAX_PROGRESS = 50;
const MAX_SUMMARY = 500;

export interface CreateInput {
  name: string;
  piSessionId: string;
  cwd: string;
  goal: string;
  constraints?: Constraints;
}

export class SessionRegistry {
  private map = new Map<string, SessionRecord>();

  create(input: CreateInput): SessionRecord {
    if (this.map.has(input.name)) throw Errors.conflict(`session ${input.name}`);
    const now = Date.now();
    const rec: SessionRecord = {
      name: input.name,
      piSessionId: input.piSessionId,
      cwd: input.cwd,
      goal: input.goal,
      status: "idle",
      constraints: input.constraints,
      progress: [],
      lastActive: now,
      msgCount: 0,
    };
    this.map.set(input.name, rec);
    return rec;
  }

  get(name: string): SessionRecord | undefined {
    return this.map.get(name);
  }

  has(name: string): boolean {
    return this.map.has(name);
  }

  // 脱敏快照（不暴露 piSessionId）
  snapshot(name: string): Snapshot {
    const r = this.map.get(name);
    if (!r) throw Errors.notFound(`session ${name}`);
    const { piSessionId: _omit, ...rest } = r;
    void _omit;
    return rest;
  }

  list(): Snapshot[] {
    return [...this.map.values()]
      .sort((a, b) => b.lastActive - a.lastActive)
      .map(r => {
        const { piSessionId: _, ...rest } = r;
        void _;
        return rest;
      });
  }

  listByCwd(cwd: string): Snapshot[] {
    return this.list().filter(s => s.cwd === cwd);
  }

  appendProgress(name: string, ev: ProgressEvent): void {
    const r = this.map.get(name);
    if (!r) return;
    r.progress.push(ev);
    if (r.progress.length > MAX_PROGRESS) r.progress = r.progress.slice(-MAX_PROGRESS);
  }

  touch(name: string, ts: number): void {
    const r = this.map.get(name);
    if (r) r.lastActive = ts;
  }

  incMsgCount(name: string, ts: number): void {
    const r = this.map.get(name);
    if (r) {
      r.msgCount += 1;
      r.lastActive = ts;
    }
  }

  setRunning(name: string, runId: string): void {
    const r = this.map.get(name);
    if (r) {
      r.status = "running";
      r.runId = runId;
    }
  }

  // clearRunning 把 session 回到终态（completed→idle，失败→error+lastError）
  clearRunning(name: string, status: "idle" | "error", ts: number, lastError?: SessionRecord["lastError"]): void {
    const r = this.map.get(name);
    if (!r) return;
    r.status = status;
    r.runId = undefined;
    r.lastActive = ts;
    if (lastError) r.lastError = lastError;
  }

  recordSuccess(name: string, summary: string): void {
    const r = this.map.get(name);
    if (!r) return;
    r.lastSummary = summary.length <= MAX_SUMMARY ? summary : summary.slice(0, MAX_SUMMARY);
  }

  recordFailure(name: string, err: { code: string; message: string; runId?: string }): void {
    const r = this.map.get(name);
    if (!r) return;
    r.lastError = { ...err, ts: Date.now() };
  }

  // 供 persist 用：返回所有记录（含 runId，persist 自己去掉）
  allPersistable(): SessionRecord[] {
    return [...this.map.values()];
  }

  // 供 persist 加载用：替换内存
  loadAll(records: SessionRecord[]): void {
    this.map.clear();
    for (const r of records) this.map.set(r.name, r);
  }
}
