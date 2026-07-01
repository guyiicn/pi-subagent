// ===== Constraints (spec §5.3) =====
export interface Constraints {
  tools?: string[];          // → pi --tools 白名单
  excludeTools?: string[];   // → pi --exclude-tools 黑名单
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  model?: string;
}

// ===== 内置 Pi 工具名 (R3#7) =====
export const PI_BUILTIN_TOOLS = ["read", "bash", "edit", "write"] as const;

// ===== ProgressEvent (spec §4) =====
export interface ProgressEvent {
  ts: number;
  tool?: string;
  summary: string;   // 经 redaction，截断 200 字符
}

// ===== Usage (spec §4) =====
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cost?: number;
}

// ===== RunError (spec §4, R3#3) =====
export interface RunError {
  code: string;
  message: string;
  stderrTail?: string;
  signal?: string;
  exitCode?: number;
}

// ===== SessionRecord (spec §4, 内存态) =====
export interface SessionRecord {
  name: string;
  piSessionId: string;
  cwd: string;
  goal: string;
  status: "idle" | "running" | "error";
  constraints?: Constraints;
  lastSummary?: string;
  lastError?: { code: string; message: string; runId?: string; ts: number };
  progress: ProgressEvent[];
  lastActive: number;
  msgCount: number;
  runId?: string;   // 内存态，不落盘
}

// ===== Run (spec §4) =====
export interface Run {
  runId: string;
  session: string;
  status: "running" | "completed" | "error" | "killed" | "timeout";
  result?: string;
  progress: ProgressEvent[];
  progressTruncated?: boolean;
  usage?: Usage;
  error?: RunError;
  startedAt: number;
  endedAt?: number;
}

// ===== Snapshot (spec §4 _snapshot 脱敏视图) =====
export type Snapshot = Omit<SessionRecord, "piSessionId">;

// ===== Plan 类型 (spec §5.3, §6) =====
export interface SessionSpec {
  action: "create" | "continue";
  name: string;
  goal: string;
  cwd: string;
  constraints?: Constraints;
  prompt: string;
  runTimeoutMs?: number;
}

export interface PlanInput {
  task: string;
  fanout?: number;
  estComplexity?: "low" | "medium" | "high";
  cwd: string;
  existingSessions: Snapshot[];
  preferredMode?: "sync" | "async";
}

export interface PlanOutput {
  shouldDelegate: boolean;
  reason: string;
  plan?: { mode: "sync" | "async"; sessions: SessionSpec[] };
}

// ===== 持久化 (spec §4, R4#4) =====
export type PersistedSessionRecord = Omit<SessionRecord, "runId">;

export interface RegistryFile {
  version: 1;
  sessions: PersistedSessionRecord[];
}

// ===== 错误码 (spec §7.1 + R2/R3/R4) =====
export const ERROR_CODES = {
  INVALID_ARG: "invalid_arg",
  GOAL_REQUIRED: "goal_required",
  CWD_INVALID: "cwd_invalid",
  CWD_MISMATCH: "cwd_mismatch",
  SESSION_BUSY: "session_busy",
  UNKNOWN_TOOL: "unknown_tool",
  NOT_FOUND: "not_found",
  CONFLICT: "conflict",
  RUN_EXPIRED: "run_expired",
  RESOURCE_BUSY: "resource_busy",
  FORK_TIMEOUT: "fork_timeout",
  // run.error.code (运行期):
  NO_AGENT_END: "no_agent_end",
  NONZERO_EXIT: "nonzero_exit",
  SIGNAL: "signal",
  TIMEOUT: "timeout",
  KILLED: "killed",
  SESSION_CREATE_FAILED: "session_create_failed",
  SESSION_START_TIMEOUT: "session_start_timeout",
  INTERRUPTED_BY_RESTART: "interrupted_by_restart",
} as const;
