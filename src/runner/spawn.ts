import { spawn, type ChildProcess } from "node:child_process";
import { buildDelegateArgs, buildForkArgs } from "./argv.js";
import type { Constraints } from "../types.js";

const DEFAULT_PI_BIN = "pi";

function piBin(): string {
  return process.env.PI_BIN ?? DEFAULT_PI_BIN;
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
  const args = buildDelegateArgs({
    prompt: opts.prompt,
    sessionId: opts.sessionId,
    constraints: opts.constraints,
  });
  const child = spawn(piBin(), args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
  return { child };
}

export function spawnFork(opts: { sourceSessionId: string; cwd: string }): ChildProcess {
  const args = buildForkArgs(opts.sourceSessionId);
  return spawn(piBin(), args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
}

export interface CollectResult {
  lines: string[];
  stderrTail: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
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
      if (pending.trim()) {
        lines.push(pending);
        opts.onLine?.(pending);
      }
      resolve({ lines, stderrTail: stderrBuf.slice(-2048), exitCode, signal });
    };

    child.once("exit", (code, sig) => done(code, sig));

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
