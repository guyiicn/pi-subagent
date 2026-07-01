import { existsSync, statSync } from "node:fs";
import { SessionRegistry } from "../registry/session.js";
import { RunRegistry } from "../registry/run.js";
import { ProcessTable } from "../runner/process-table.js";
import { spawnDelegate, collectOutput } from "../runner/spawn.js";
import { extractResult } from "../runner/parse.js";
import { Errors } from "../errors.js";
import { ERROR_CODES, PI_BUILTIN_TOOLS, type Constraints, type Snapshot, type ProgressEvent } from "../types.js";

const MAX_CONCURRENCY = 4;
const SESSION_START_TIMEOUT_MS = 10000;

// pi_kill 主动标记的 runId（区分超时 kill vs 手动 kill）
const manualKills = new Set<string>();
export function markManualKill(runId: string): void { manualKills.add(runId); }

export interface DelegateInput {
  prompt: string;
  session: string;
  cwd?: string;
  goal?: string;
  constraints?: Constraints;
  mode?: "sync" | "async";
  runTimeoutMs?: number;
  allowUnknownTools?: boolean;
}

export interface DelegateDeps {
  sessions: SessionRegistry;
  runs: RunRegistry;
  procs: ProcessTable;
}

export interface DelegateOutput {
  runId: string;
  session?: Snapshot;
  status: string;
  result?: string;
  progress?: ProgressEvent[];
  progressTruncated?: boolean;
  usage?: any;
  error?: any;
}

function validateTools(c: Constraints | undefined, allowUnknown: boolean): void {
  if (!c) return;
  const known = new Set<string>([...PI_BUILTIN_TOOLS]);
  for (const t of [...(c.tools ?? []), ...(c.excludeTools ?? [])]) {
    if (!known.has(t) && !allowUnknown) throw Errors.unknownTool(t);
  }
}

export async function delegate(input: DelegateInput, deps: DelegateDeps): Promise<DelegateOutput> {
  if (!input.prompt?.trim()) throw Errors.invalidArg("prompt required");
  if (!input.session) throw Errors.invalidArg("session required");

  const existing = deps.sessions.get(input.session);
  const isCreate = !existing;

  // 校验
  if (isCreate) {
    if (!input.goal) throw Errors.goalRequired();
    if (!input.cwd || !existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) {
      throw Errors.cwdInvalid(input.cwd ?? "(none)");
    }
    validateTools(input.constraints, !!input.allowUnknownTools);
  } else {
    if (input.cwd && existing!.cwd !== input.cwd) throw Errors.cwdMismatch(input.session, existing!.cwd);
    if (existing!.status === "running") throw Errors.sessionBusy(input.session, existing!.runId ?? "");
    validateTools(input.constraints, !!input.allowUnknownTools);
  }

  // 并发上限实时复查（R4#9）
  if (deps.runs.runningCount() >= MAX_CONCURRENCY) throw Errors.resourceBusy();

  const mode = input.mode ?? "async";
  const constraints = input.constraints ?? {};
  const runTimeoutMs = input.runTimeoutMs ?? 600000;
  const startedAt = Date.now();
  const cwd = existing?.cwd ?? input.cwd!;

  // 建 run + spawn
  const run = deps.runs.create({ session: input.session, startedAt });
  const { child } = spawnDelegate({
    prompt: input.prompt,
    sessionId: existing?.piSessionId,
    constraints,
    cwd,
  });

  // 握手状态（提前声明，onLine 闭包引用）
  const state = {
    sessionIdReceived: existing?.piSessionId !== undefined,
    piSessionId: existing?.piSessionId,
    sessionRecordCreated: !isCreate,  // 续接时 session 已存在
    asyncResolved: false,
  };
  let resolveHandshake: () => void = () => {};
  const handshakePromise = new Promise<void>((res) => { resolveHandshake = res; });

  // 注册到 process table（退出时清理）
  let exited = false;
  deps.procs.register(run.runId, child, () => { exited = true; });

  // 收尾：解析结果 + 更新 registry
  const finalize = async (): Promise<{ status: string; result?: string; error?: any; usage?: any; progress?: ProgressEvent[]; progressTruncated?: boolean }> => {
    const res = await collectPromise;
    const { result, progress, usage } = extractResult(res.lines);
    const endedAt = Date.now();

    let status: "completed" | "error" | "timeout" | "killed" = "completed";
    let error: any;

    if (!state.sessionIdReceived && isCreate) {
      // 新 session 没拿到 session 事件
      if (res.signal === "SIGTERM" || res.signal === "SIGKILL") {
        status = "error";
        error = { code: ERROR_CODES.SESSION_START_TIMEOUT, message: "session 事件握手超时", signal: res.signal };
      } else {
        status = "error";
        error = {
          code: ERROR_CODES.SESSION_CREATE_FAILED,
          message: "no session event before exit",
          stderrTail: res.stderrTail,
          exitCode: res.exitCode ?? undefined,
        };
      }
      // 不创建 SessionRecord
    } else if (res.signal === "SIGTERM" || res.signal === "SIGKILL") {
      // 被 kill：区分超时（collectOutput 内部 runTimeoutMs 触发）vs 主动 kill（pi_kill）
      if (manualKills.has(run.runId)) {
        manualKills.delete(run.runId);
        status = "killed";
        error = { code: ERROR_CODES.KILLED, message: "killed", signal: res.signal };
      } else {
        status = "timeout";
        error = { code: ERROR_CODES.TIMEOUT, message: "run timed out", signal: res.signal };
      }
    } else if (res.exitCode !== 0) {
      status = "error";
      error = { code: ERROR_CODES.NONZERO_EXIT, message: `exit ${res.exitCode}`, stderrTail: res.stderrTail, exitCode: res.exitCode ?? undefined };
    } else if (result === null) {
      status = "error";
      error = { code: ERROR_CODES.NO_AGENT_END, message: "no agent_end event", stderrTail: res.stderrTail };
    }

    deps.runs.complete(run.runId, {
      status,
      result: result ?? undefined,
      endedAt,
      progress,
      progressTruncated: false,
      usage,
      error,
    });

    // 更新 session（若记录已创建）
    if (deps.sessions.has(input.session)) {
      if (status === "completed") {
        deps.sessions.clearRunning(input.session, "idle", endedAt);
        deps.sessions.recordSuccess(input.session, result ?? "");
      } else {
        deps.sessions.clearRunning(
          input.session, "error", endedAt,
          error ? { code: error.code, message: error.message, runId: run.runId } : undefined,
        );
      }
      for (const p of progress) deps.sessions.appendProgress(input.session, p);
    }

    return { status, result: result ?? undefined, error, usage, progress, progressTruncated: false };
  };

  const collectPromise = collectOutput(child, {
    runTimeoutMs,
    onLine: (line) => {
      // session 事件握手
      if (!state.sessionIdReceived && line.includes('"type":"session"')) {
        try {
          const obj = JSON.parse(line);
          state.piSessionId = obj.id;
          state.sessionIdReceived = true;
          if (isCreate && state.piSessionId && !state.sessionRecordCreated) {
            deps.sessions.create({
              name: input.session,
              piSessionId: state.piSessionId,
              cwd,
              goal: input.goal!,
              constraints,
            });
            state.sessionRecordCreated = true;
          }
          if (deps.sessions.has(input.session)) {
            deps.sessions.setRunning(input.session, run.runId);
            deps.sessions.incMsgCount(input.session, startedAt);
          }
          if (!state.asyncResolved) {
            state.asyncResolved = true;
            resolveHandshake();
          }
        } catch {
          // 坏行忽略
        }
      }
      // 流式 progress
      if (line.includes('"type":"tool_execution_end"')) {
        try {
          const obj = JSON.parse(line);
          const txt = obj.result?.content
            ?.filter((c: any) => c.type === "text")
            .map((c: any) => c.text)
            .join("");
          if (txt) {
            const ev: ProgressEvent = { ts: Date.now(), tool: obj.toolName, summary: txt.slice(0, 200) };
            deps.runs.appendProgress(run.runId, ev);
          }
        } catch {
          // 坏行忽略
        }
      }
    },
  });

  // 超时 kill 由 collectOutput 内部 runTimeoutMs 处理（SIGTERM 进程）。
  // 区分"超时 kill"vs"pi_kill 主动 kill"靠 manualKills 集合（见 finalize）。

  // 握手超时（仅新 session）
  if (isCreate) {
    setTimeout(() => {
      if (!state.sessionIdReceived && !exited) {
        deps.procs.kill(run.runId);
      }
    }, SESSION_START_TIMEOUT_MS).unref?.();
  }

  // async 模式
  if (mode === "async") {
    if (isCreate) {
      // 等握手完成或进程结束
      await Promise.race([
        handshakePromise,
        collectPromise.then(() => undefined),
      ]);
      if (!state.sessionIdReceived) {
        // 握手失败（进程退出或超时已 kill）——等 finalize 标 error
        const fin = await finalize();
        return {
          runId: run.runId,
          status: fin.status,
          error: fin.error,
        };
      }
    } else {
      // 续接：立即 resolve
      if (!state.asyncResolved) {
        state.asyncResolved = true;
        resolveHandshake();
      }
    }
    // 后台跑 finalize（不阻塞返回）
    finalize().catch(() => undefined);
    return {
      runId: run.runId,
      session: deps.sessions.has(input.session) ? deps.sessions.snapshot(input.session) : undefined,
      status: "running",
    };
  }

  // sync 模式：阻塞到 finalize
  const fin = await finalize();
  return {
    runId: run.runId,
    session: deps.sessions.has(input.session) ? deps.sessions.snapshot(input.session) : undefined,
    status: fin.status,
    result: fin.result,
    progress: fin.progress,
    progressTruncated: fin.progressTruncated,
    usage: fin.usage,
    error: fin.error,
  };
}
