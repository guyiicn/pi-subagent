import type { ChildProcess } from "node:child_process";

interface ManagedChild {
  child: ChildProcess;
  onExit: () => void;  // 退出清理钩子
}

// 管理所有 spawn 出来的子进程（delegate run + fork）
// server 退出时遍历全部发 SIGTERM
export class ProcessTable {
  private children = new Map<string, ManagedChild>();  // key: runId 或 forkId

  register(id: string, child: ChildProcess, onExit: () => void): void {
    this.children.set(id, { child, onExit });
    child.once("exit", () => {
      this.children.delete(id);
      onExit();
    });
  }

  kill(id: string): boolean {
    const m = this.children.get(id);
    if (!m) return false;
    if (!m.child.killed) m.child.kill("SIGTERM");
    return true;
  }

  // server 退出清理：SIGTERM 所有 managed child
  killAll(): void {
    for (const m of this.children.values()) {
      try {
        if (!m.child.killed) m.child.kill("SIGTERM");
      } catch {
        // 忽略已退出的
      }
    }
  }

  has(id: string): boolean {
    return this.children.has(id);
  }
}
