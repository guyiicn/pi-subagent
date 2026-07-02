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
  lastProgressAt: number;   // 批次1: 收到最近一次 tool_execution_end 的时间；create 时 = startedAt
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
  // 批次1 新增
  STALLED: "stalled",
  TASK_NOT_FOUND: "task_not_found",
  STAGE_NOT_FOUND: "stage_not_found",
  DEPENDENCY_UNMET: "dependency_unmet",
  TASK_CONFLICT: "task_conflict",
  PLAN_DRAFT_MISSING: "plan_draft_missing",
} as const;

// ============================================================
// 批次1: Task 编排（design-batch1.md §C）
// ============================================================

export interface ValidateRule {
  kind: "file_exists" | "file_nonempty" | "contains" | "not_contains" | "regex";
  pattern?: string;            // contains/not_contains/regex 用
}

export interface StageAttempt {
  attemptNo: number;           // 1..3
  runId: string;
  status: "passed" | "failed";
  failureType?: "no_output" | "incomplete" | "wrong_content" | "timeout" | "stalled" | "pi_refused";
  failureDetail: string;
  ts: number;
}

export interface Stage {
  stageId: string;             // host 给，如 "1"/"2"/"3a"。Task 内唯一
  title: string;
  objective: string;           // 阶段目标（一句话）
  inputFiles: string[];        // 读哪些（相对 cwd）
  outputFile: string;          // 写哪个（相对 cwd）
  dependsOn: string[];         // 依赖的 stageId
  parallelizable: boolean;
  promptHint?: string;         // host 给的额外提示（注入 IOAC Action 段）
  validateRules?: ValidateRule[];  // 无则用默认
  status: "pending" | "running" | "passed" | "failed" | "manual" | "skipped";
  session?: string;            // 执行 session 名
  attempts: StageAttempt[];
  lastFailureReason?: string;
}

export interface Task {
  taskId: string;
  goal: string;
  cwd: string;
  status: "planning" | "executing" | "blocked_manual" | "completed" | "abandoned";
  planDraftPath: string;       // 相对 cwd
  planReviewedPath?: string;
  planVerdict?: "approve" | "approve_with_changes" | "reject";
  stages: Stage[];
  reviewSession?: string;
  reviewRunId?: string;
  createdAt: number;
  updatedAt: number;
}

// Task 持久化文件
export interface TaskRegistryFile {
  version: 1;
  tasks: Task[];
}

// pi_task_stage_run 返回的决策面板
export interface ManualPanel {
  taskId: string;
  stageId: string;
  attempts: StageAttempt[];
  lastPiResult?: string;
  availableFiles: string[];
  options: ["retry_with_new_hint", "skip", "abort_task", "manual_write"];
}

// stage 执行时 host 给的创建参数（Pick 自 Stage）
export type StageCreateInput = Pick<
  Stage,
  "stageId" | "title" | "objective" | "inputFiles" | "outputFile" | "dependsOn" | "parallelizable" | "promptHint" | "validateRules"
>;

