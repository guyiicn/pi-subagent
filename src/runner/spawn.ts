import { spawn, type ChildProcess } from "node:child_process";
import { buildDelegateArgs, buildForkArgs } from "./argv.js";
import type { Constraints } from "../types.js";

const DEFAULT_PI_BIN = "pi";

// PI_BIN 可含参数（空格拆分），便于测试用 "bash /path/to/fake-pi.sh" 绕开可执行权限
function piBinParts(): { cmd: string; extraArgs: string[] } {
  const bin = process.env.PI_BIN ?? DEFAULT_PI_BIN;
  const parts = bin.split(/\s+/).filter(Boolean);
  return { cmd: parts[0], extraArgs: parts.slice(1) };
}

export interface SpawnedDelegate {
  child: ChildProcess;
}

export function spawnDelegate(opts: {
  prompt: string;
  sessionId?: string;
  constraints: Constraints;
  cwd: string;
}): SpawnedDelegate {
  const { cmd, extraArgs } = piBinParts();
  const args = [...extraArgs, ...buildDelegateArgs({
    prompt: opts.prompt,
    sessionId: opts.sessionId,
    constraints: opts.constraints,
  })];
  const child = spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
  return { child };
}

export function spawnFork(opts: { sourceSessionId: string; cwd: string }): ChildProcess {
  const { cmd, extraArgs } = piBinParts();
  const args = [...extraArgs, ...buildForkArgs(opts.sourceSessionId)];
  return spawn(cmd, args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
}

export interface CollectResult {
  lines: string[];
  stderrTail: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError?: Error;   // spawn 失败（如 PI_BIN 不存在）
}

// 逐行读 child.stdout，回调每行；返回结束 promise（含 exitCode/signal）
export function collectOutput(
  child: ChildProcess,
  opts: { runTimeoutMs?: number; onLine?: (line: string) => void } = {},
): Promise<CollectResult> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    let stderrBuf = "";
    let pending = "";
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    let spawnError: Error | undefined;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    child.stdout?.on("data", (chunk: string) => {
      pending += chunk;
      let idx;
      while ((idx = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        if (line.trim()) {
          lines.push(line);
          opts.onLine?.(line);
        }
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderrBuf += chunk;
      if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-2048);  // 保留末 2KB
    });

    const done = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      // 销毁 stdio 流，避免流 pending 阻止进程退出
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (pending.trim()) {
        lines.push(pending);
        opts.onLine?.(pending);
      }
      resolve({ lines, stderrTail: stderrBuf.slice(-2048), exitCode, signal, spawnError });
    };

    child.once("exit", (code, sig) => done(code, sig));

    // spawn 失败（如 PI_BIN 不存在/不可执行）：发 error，可能不发 exit。
    // close 兜底：进程退出后流关闭也会触发，确保 done 一定被调用。
    child.once("error", (err) => {
      spawnError = err;
      done(null, null);
    });
    child.once("close", (code, sig) => done(code, sig));

    if (opts.runTimeoutMs) {
      timer = setTimeout(() => {
        if (!child.killed) child.kill("SIGTERM");
        // grace 5s 后 SIGKILL
        setTimeout(() => {
          if (!child.killed) child.kill("SIGKILL");
        }, 5000);
      }, opts.runTimeoutMs);
    }
  });
}
