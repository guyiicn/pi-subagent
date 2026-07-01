import type { SessionRegistry } from "../registry/session.js";
import type { ProcessTable } from "../runner/process-table.js";
import { spawnFork, collectOutput } from "../runner/spawn.js";
import { classifyLine } from "../runner/parse.js";
import { Errors } from "../errors.js";
import type { Snapshot } from "../types.js";

const FORK_TIMEOUT_MS = 30000;

export function sessionList(sessions: SessionRegistry, cwd?: string) {
  return { sessions: cwd ? sessions.listByCwd(cwd) : sessions.list() };
}

export function sessionSnapshot(sessions: SessionRegistry, name: string): { session: Snapshot } {
  if (!sessions.has(name)) throw Errors.notFound(`session ${name}`);
  return { session: sessions.snapshot(name) };
}

export async function sessionFork(
  input: { from: string; to: string },
  deps: { sessions: SessionRegistry; procs: ProcessTable },
): Promise<{ session: Snapshot }> {
  const src = deps.sessions.get(input.from);
  if (!src) throw Errors.notFound(`session ${input.from}`);
  if (deps.sessions.has(input.to)) throw Errors.conflict(`session ${input.to}`);

  const child = spawnFork({ sourceSessionId: src.piSessionId, cwd: src.cwd });
  let newPiSessionId: string | undefined;

  // collectOutput 内置 runTimeoutMs（超时会 SIGTERM 进程）
  const result = await collectOutput(child, {
    runTimeoutMs: FORK_TIMEOUT_MS,
    onLine: (line) => {
      const ev = classifyLine(line);
      if (ev?.type === "session" && ev.sessionId) newPiSessionId = ev.sessionId;
    },
  });

  if (result.signal && !newPiSessionId) throw Errors.forkTimeout();
  if (!newPiSessionId) {
    throw Errors.invalidArg("fork produced no session event", { stderrTail: result.stderrTail });
  }

  deps.sessions.create({
    name: input.to,
    piSessionId: newPiSessionId,
    cwd: src.cwd,
    goal: `fork of ${src.name}: ${src.goal}`,
    constraints: src.constraints,
  });
  return { session: deps.sessions.snapshot(input.to) };
}
