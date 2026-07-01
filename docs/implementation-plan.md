# pi-subagent 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现一个 MCP server (`pi-subagent`) + Skill，把 Pi CLI 当作可被任意 MCP host 调用的编程子代理，支持 sync/async 委派、具名 session、调度决策、生命周期管理。

**Architecture:** 薄编排 MCP server（Node/TS）包 `pi -p --mode json`，进程隔离。三层职责：Tool layer（MCP 工具 + plan 纯函数决策）/ Session registry（状态 + 持久化）/ Runner（spawn pi、解析 NDJSON、Process table）。Skill 层教 host 何时委派。

**Tech Stack:** TypeScript + Node 26 + `@modelcontextprotocol/sdk` 1.29 + `tsx` + `node:test`/`node:assert`（零测试依赖）。

**Spec:** `docs/superpowers/specs/2026-07-01-pi-subagent-design.md`（设计已过 4 轮评审）。

**约定:** 实测 fixture 来自 `pi -p` 真实输出（Task 3 录制）。`PI_BIN` 环境变量覆盖 pi 路径供假 pi 测试。

---

## 文件结构

```
pi-subagent/
├── package.json
├── tsconfig.json
├── src/
│   ├── types.ts              ← 所有共享类型 (SessionRecord/Run/RunError/Usage/Snapshot/Constraints/ProgressEvent/PlanInput/PlanOutput/SessionSpec) + 错误码枚举
│   ├── errors.ts             ← makeError(code,...) 工具 + code 枚举常量
│   ├── runner/
│   │   ├── parse.ts          ← parseNdjson(line): 事件归类；extractResult(events): 取 agent_end
│   │   ├── argv.ts           ← buildDelegateArgs()/buildForkArgs() (§9.6)
│   │   ├── spawn.ts          ← spawnPi()/spawnFork() child_process 封装
│   │   └── process-table.ts  ← managed children (run + fork) + AbortController + 等待者队列
│   ├── registry/
│   │   ├── session.ts        ← SessionRegistry: create/get/list/snapshot/redact + msgCount/lastActive 规则
│   │   ├── run.ts            ← RunRegistry: create/get/update + TTL/容量淘汰 + multi-waiter
│   │   └── persist.ts        ← load()/save() 原子写 + 单条坏记录处理 + 加载修正 running
│   ├── scheduler/
│   │   ├── keywords.ts       ← 反信号词/委托信号词/危险词词表
│   │   └── plan.ts           ← plan(): 5 阶段纯函数
│   ├── tools/
│   │   ├── delegate.ts       ← pi_delegate (sync/async + 握手)
│   │   ├── status.ts         ← pi_status (long-poll)
│   │   ├── plan-tool.ts      ← pi_plan (调 scheduler/plan)
│   │   ├── session.ts        ← pi_session_list / pi_session_snapshot / pi_session_fork
│   │   └── kill.ts           ← pi_kill
│   └── server.ts             ← MCP server 入口 (stdio) + 工具注册 + 退出清理
├── skills/
│   └── pi-subagent/
│       ├── SKILL.md
│       └── references/delegation-patterns.md
└── test/
    ├── fixtures/
    │   ├── pi-output-echo.jsonl   ← Task 3 录制
    │   ├── fake-pi.sh             ← 假 pi (argv 分支)
    │   └── fake-pi-no-session.sh  ← 无 session 事件退出
    ├── helpers.ts            ← 共享测试辅助 (临时 cwd、registry 等)
    ├── parse.test.ts
    ├── argv.test.ts
    ├── session-registry.test.ts
    ├── run-registry.test.ts
    ├── persist.test.ts
    ├── redaction.test.ts
    ├── scheduler.test.ts
    ├── delegate.test.ts
    ├── status.test.ts
    ├── fork.test.ts
    ├── kill.test.ts
    └── integration.test.ts
```

**职责边界:** 每个文件单一职责。types.ts 是唯一类型来源。registry 不碰进程；runner 不碰持久化；scheduler 是纯函数不碰任何 IO。

---

## Task 1: 项目脚手架 + git init

**Files:**
- Create: `pi-subagent/package.json`
- Create: `pi-subagent/tsconfig.json`
- Create: `pi-subagent/.gitignore`

- [ ] **Step 1: 建目录 + git init**

```bash
mkdir -p /home/guyii/code/pi-subagent
cd /home/guyii/code/pi-subagent
git init
```

- [ ] **Step 2: 写 package.json**

```json
{
  "name": "pi-subagent",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "pi-subagent": "./dist/server.js" },
  "scripts": {
    "build": "tsc",
    "test": "node --test --test-reporter=spec test/*.test.ts",
    "test:fast": "node --test --test-reporter=dot test/*.test.ts",
    "start": "tsx src/server.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.29.0"
  },
  "devDependencies": {
    "tsx": "4.22.4",
    "typescript": "^5.5.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 3: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

注: node --test 直接跑 .ts 需要 tsx。在 package.json 的 test 脚本加 `--import tsx`：
```json
"test": "node --import tsx --test --test-reporter=spec test/*.test.ts"
```

- [ ] **Step 4: 写 .gitignore**

```
node_modules/
dist/
*.log
```

- [ ] **Step 5: 安装依赖**

Run: `cd /home/guyii/code/pi-subagent && npm install`
Expected: 安装成功，node_modules 生成。

- [ ] **Step 6: 验证 tsx 能跑 ts**

创建临时 `src/hello.ts`：
```ts
const x: number = 1 + 2;
console.log(x);
```
Run: `npx tsx src/hello.ts`
Expected: 输出 `3`。然后删掉 `src/hello.ts`。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: project scaffold + deps"
```

---

## Task 2: 共享类型 + 错误码

**Files:**
- Create: `pi-subagent/src/types.ts`
- Create: `pi-subagent/src/errors.ts`
- Test: `pi-subagent/test/types.test.ts`

- [ ] **Step 1: 写 src/types.ts（全部共享类型，按 spec §4 + §5）**

```ts
// ===== Constraints (§5.3) =====
export interface Constraints {
  tools?: string[];          // → pi --tools 白名单
  excludeTools?: string[];   // → pi --exclude-tools 黑名单
  thinking?: "off"|"minimal"|"low"|"medium"|"high"|"xhigh";
  model?: string;
}

// ===== 内置 Pi 工具名 (R3#7) =====
export const PI_BUILTIN_TOOLS = ["read", "bash", "edit", "write"] as const;

// ===== ProgressEvent (§4) =====
export interface ProgressEvent {
  ts: number;
  tool?: string;
  summary: string;   // 经 redaction，截断 200 字符
}

// ===== Usage (§4) =====
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cost?: number;
}

// ===== RunError (§4, R3#3) =====
export interface RunError {
  code: string;
  message: string;
  stderrTail?: string;
  signal?: string;
  exitCode?: number;
}

// ===== SessionRecord (§4, 内存态) =====
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

// ===== Run (§4) =====
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

// ===== Snapshot (§4 _snapshot 脱敏视图) =====
export type Snapshot = Omit<SessionRecord, "piSessionId">;

// ===== Plan 类型 (§5.3, §6) =====
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
  fanout?: number;           // 默认 1
  estComplexity?: "low"|"medium"|"high";
  cwd: string;
  existingSessions: Snapshot[];
  preferredMode?: "sync"|"async";
}

export interface PlanOutput {
  shouldDelegate: boolean;
  reason: string;
  plan?: { mode: "sync"|"async"; sessions: SessionSpec[] };
}

// ===== 持久化 (§4, R4#4) =====
export type PersistedSessionRecord = Omit<SessionRecord, "runId">;

export interface RegistryFile {
  version: 1;
  sessions: PersistedSessionRecord[];
}

// ===== 错误码 (§7.1 + R2/R3/R4) =====
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
```

- [ ] **Step 2: 写 src/errors.ts**

```ts
import { ERROR_CODES } from "./types.js";

export interface ToolError {
  error: string;
  code: string;
  detail?: unknown;
}

export function makeError(code: string, message: string, detail?: unknown): ToolError {
  return { error: message, code, detail };
}

// 便捷构造器
export const Errors = {
  invalidArg: (msg: string, detail?: unknown) => makeError(ERROR_CODES.INVALID_ARG, msg, detail),
  goalRequired: () => makeError(ERROR_CODES.GOAL_REQUIRED, "goal required to create session"),
  cwdInvalid: (cwd: string) => makeError(ERROR_CODES.CWD_INVALID, `cwd does not exist or not a directory: ${cwd}`),
  cwdMismatch: (name: string, existing: string) => makeError(ERROR_CODES.CWD_MISMATCH, `session ${name} already bound to cwd ${existing}`),
  sessionBusy: (name: string, runId: string) => makeError(ERROR_CODES.SESSION_BUSY, `session ${name} is running`, { runId }),
  unknownTool: (name: string) => makeError(ERROR_CODES.UNKNOWN_TOOL, `unknown tool name: ${name}`),
  notFound: (what: string) => makeError(ERROR_CODES.NOT_FOUND, `not found: ${what}`),
  conflict: (what: string) => makeError(ERROR_CODES.CONFLICT, `already exists: ${what}`),
  resourceBusy: () => makeError(ERROR_CODES.RESOURCE_BUSY, "concurrency limit (4) reached"),
  forkTimeout: () => makeError(ERROR_CODES.FORK_TIMEOUT, "fork process timed out"),
  runExpired: (runId: string) => makeError(ERROR_CODES.RUN_EXPIRED, `run expired: ${runId}`),
};
```

- [ ] **Step 3: 写 test/types.test.ts（编译期类型检查 + 常量存在）**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ERROR_CODES, PI_BUILTIN_TOOLS } from "../src/types.js";

test("ERROR_CODES 包含全部稳定码", () => {
  const codes = Object.values(ERROR_CODES);
  for (const required of ["invalid_arg","goal_required","cwd_invalid","cwd_mismatch","session_busy","unknown_tool","not_found","conflict","run_expired","resource_busy","fork_timeout","session_create_failed","session_start_timeout","interrupted_by_restart"]) {
    assert.ok(codes.includes(required as never), `missing code: ${required}`);
  }
});

test("PI_BUILTIN_TOOLS 含 read/bash/edit/write", () => {
  assert.deepEqual([...PI_BUILTIN_TOOLS].sort(), ["bash","edit","read","write"]);
});
```

- [ ] **Step 4: 跑测试验证通过**

Run: `cd /home/guyii/code/pi-subagent && npm test`
Expected: 2 passed。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: shared types + error codes"
```

---

## Task 3: 录制真实 pi 输出 fixture

**Files:**
- Create: `pi-subagent/test/fixtures/pi-output-echo.jsonl`

这个 fixture 是解析器测试的黄金样本，来自真实 `pi -p`。后续 Task 4 直接用它。

- [ ] **Step 1: 录制一次真实的 pi -p 输出**

```bash
cd /home/guyii/code/pi-subagent
mkdir -p test/fixtures
pi -p --no-skills --no-context-files --thinking off --tools bash --mode json \
  "run: echo FIXTURE_PING" > test/fixtures/pi-output-echo.jsonl 2>/dev/null
wc -l test/fixtures/pi-output-echo.jsonl
```
Expected: 行数 > 30（含 session/turn_*/message_*/tool_execution_*/agent_end 全事件类型）。

- [ ] **Step 2: 验证关键事件类型齐全**

Run:
```bash
grep -oE '"type":"[^"]+"' test/fixtures/pi-output-echo.jsonl | sort -u
```
Expected: 至少含 `session`, `turn_start`, `turn_end`, `message_end`, `tool_execution_end`, `agent_end`。

- [ ] **Step 3: 验证 agent_end 含 messages 数组**

Run: `grep '"type":"agent_end"' test/fixtures/pi-output-echo.jsonl | grep -o '"messages":\[' | head -1`
Expected: 输出 `"messages":[`。

- [ ] **Step 4: Commit**

```bash
git add test/fixtures/pi-output-echo.jsonl
git commit -m "test: record real pi -p output fixture"
```

---

## Task 4: NDJSON 解析器

**Files:**
- Create: `pi-subagent/src/runner/parse.ts`
- Test: `pi-subagent/test/parse.test.ts`

解析 `pi -p --mode json` 的 NDJSON 流：逐行分类，取 agent_end 的 result + tool_execution_end 的 progress，丢 delta。

- [ ] **Step 1: 写 test/parse.test.ts（先写失败测试）**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extractResult, classifyLine, type PiEvent } from "../src/runner/parse.js";

const FIXTURE = readFileSync(new URL("./fixtures/pi-output-echo.jsonl", import.meta.url), "utf8")
  .split("\n").filter(l => l.trim());

test("classifyLine 识别 session 事件", () => {
  const first = JSON.parse(FIXTURE[0]);
  const ev = classifyLine(FIXTURE[0]);
  assert.equal(ev?.type, "session");
  assert.ok(ev?.sessionId);
});

test("classifyLine 对坏 JSON 行返回 null（不抛）", () => {
  assert.equal(classifyLine("not json {{"), null);
  assert.equal(classifyLine(""), null);
});

test("extractResult 从 fixture 取出 result + progress", () => {
  const { result, progress } = extractResult(FIXTURE);
  assert.ok(typeof result === "string" && result.length > 0, "result 应为非空文本");
  assert.ok(progress.length > 0, "应有 progress (tool_execution_end)");
  assert.ok(progress.every(p => typeof p.summary === "string"), "每条 progress 有 summary");
  assert.ok(progress.every(p => p.summary.length <= 200), "summary 截断到 200");
});

test("extractResult 无 agent_end 时 result 为 null", () => {
  const lines = FIXTURE.filter(l => !l.includes('"type":"agent_end"'));
  const { result } = extractResult(lines);
  assert.equal(result, null);
});

test("extractResult 从 agent_end 取 usage", () => {
  const { usage } = extractResult(FIXTURE);
  assert.ok(usage, "应有 usage");
  assert.ok(typeof usage?.totalTokens === "number" || usage?.totalTokens === undefined);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /home/guyii/code/pi-subagent && npm test -- --test-name-pattern=classifyLine 2>&1 | head -20`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 src/runner/parse.ts**

```ts
import type { ProgressEvent, Usage } from "../types.js";

// 分类后的事件（只保留关心的）
export interface PiEvent {
  type: string;
  sessionId?: string;
  // tool_execution_end:
  toolName?: string;
  toolResultText?: string;
  // agent_end:
  messages?: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
  usage?: Usage;
}

// 解析单行；坏行返回 null（不抛）
export function classifyLine(line: string): PiEvent | null {
  if (!line || !line.trim()) return null;
  let obj: any;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || typeof obj.type !== "string") return null;

  switch (obj.type) {
    case "session":
      return { type: "session", sessionId: obj.id };
    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        toolName: obj.toolName,
        toolResultText: extractToolText(obj.result),
      };
    case "agent_end":
      return { type: "agent_end", messages: obj.messages, usage: extractUsage(obj.messages) };
    default:
      return { type: obj.type };  // 其余 (delta/turn_*/message_*) 只记类型，内容丢弃
  }
}

function extractToolText(result: any): string | undefined {
  if (!result?.content) return undefined;
  const texts = result.content.filter((c: any) => c.type === "text").map((c: any) => c.text ?? "");
  return texts.join("\n") || undefined;
}

function extractUsage(messages: any[] | undefined): Usage | undefined {
  if (!messages) return undefined;
  // usage 通常在最后一条 assistant message 上
  for (let i = messages.length - 1; i >= 0; i--) {
    const u = messages[i]?.usage;
    if (u) {
      return {
        inputTokens: u.input,
        outputTokens: u.output,
        totalTokens: u.totalTokens,
        cost: u.cost?.total,
      };
    }
  }
  return undefined;
}

export interface Extracted {
  result: string | null;
  progress: ProgressEvent[];
  usage?: Usage;
}

// 从完整 NDJSON 行数组提取结果
export function extractResult(lines: string[]): Extracted {
  let result: string | null = null;
  let usage: Usage | undefined;
  const progress: ProgressEvent[] = [];

  for (const line of lines) {
    const ev = classifyLine(line);
    if (!ev) continue;
    if (ev.type === "tool_execution_end" && ev.toolResultText) {
      progress.push({ ts: Date.now(), tool: ev.toolName, summary: truncate(ev.toolResultText) });
    } else if (ev.type === "agent_end") {
      usage = ev.usage;
      result = extractFinalAssistantText(ev.messages);
    }
  }
  return { result, progress, usage };
}

// 取最后一条 assistant 消息的文本
export function extractFinalAssistantText(messages?: PiEvent["messages"]): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") {
      const text = m.content.filter(c => c.type === "text").map(c => c.text ?? "").join("");
      if (text.trim()) return text;
    }
  }
  return null;
}

function truncate(s: string, n = 200): string {
  return s.length <= n ? s : s.slice(0, n);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- --test-name-pattern="parse|classifyLine|extractResult" 2>&1 | tail -15`
Expected: 5 passed。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: NDJSON parser (agent_end + tool_execution_end)"
```

---

## Task 5: progress redaction

**Files:**
- Create: `pi-subagent/src/registry/redact.ts`
- Test: `pi-subagent/test/redaction.test.ts`

按 spec §4 redaction 规则（JS 可实现正则 + 截断）。

- [ ] **Step 1: 写 test/redaction.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { redact } from "../src/registry/redact.js";

test("截断到 200 字符", () => {
  const long = "x".repeat(500);
  const r = redact(long);
  assert.equal(r.length, 200);
});

test("似 token 字符串替换为 ***", () => {
  const r = redact("key=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9abc");
  assert.ok(r.includes("***"));
  assert.ok(!r.includes("eyJhbGci"));
});

test("password=xxx 被替换", () => {
  const r = redact("my password=hunter2 leaked");
  assert.ok(r.includes("***"));
  assert.ok(!r.includes("hunter2"));
});

test("API_KEY=xxx 被替换", () => {
  const r = redact("API_KEY=sk-abc123def");
  assert.ok(r.includes("***"));
  assert.ok(!r.includes("sk-abc123def"));
});

test("普通文本不被破坏", () => {
  assert.equal(redact("hello world"), "hello world");
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npm test -- --test-name-pattern="redact" 2>&1 | head -10`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 写 src/registry/redact.ts**

```ts
// spec §4 redaction: best-effort，挡住常见明文泄露
const RE_TOKEN = /[A-Za-z0-9_\-]{20,}/g;
const RE_SENSITIVE_KV = /(password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization|credential)s?\s*[:=]\s*\S+/gi;

export function redact(input: string, maxLen = 200): string {
  let s = input;
  s = s.replace(RE_TOKEN, "***");
  s = s.replace(RE_SENSITIVE_KV, "***");
  return s.length <= maxLen ? s : s.slice(0, maxLen);
}
```

- [ ] **Step 4: 跑确认通过**

Run: `npm test -- --test-name-pattern="redact" 2>&1 | tail -10`
Expected: 5 passed。

- [ ] **Step 5: 修改 parse.ts 让 progress 用 redact**

在 `src/runner/parse.ts` 顶部 import，并把 `truncate(ev.toolResultText)` 改为 `redact(ev.toolResultText)`：
```ts
import { redact } from "../registry/redact.js";
// ...
summary: redact(ev.toolResultText),
```
删除 parse.ts 里自己的 `truncate` 函数（redact 已含截断）。重跑 parse 测试应仍通过。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: progress redaction + wire into parser"
```

---

## Task 6: argv 构建器

**Files:**
- Create: `pi-subagent/src/runner/argv.ts`
- Test: `pi-subagent/test/argv.test.ts`

按 spec §9.6。v1 不传 session-dir/provider/append-system-prompt。

- [ ] **Step 1: 写 test/argv.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDelegateArgs, buildForkArgs } from "../src/runner/argv.js";
import type { Constraints } from "../src/types.js";

test("delegate 基础参数含 -p/--mode json", () => {
  const a = buildDelegateArgs({ prompt: "hi", sessionId: undefined, constraints: {} });
  assert.deepEqual(a, ["-p", "hi", "--mode", "json"]);
});

test("delegate 续接加 --session-id", () => {
  const a = buildDelegateArgs({ prompt: "hi", sessionId: "uuid-1", constraints: {} });
  assert.deepEqual(a, ["-p", "hi", "--mode", "json", "--session-id", "uuid-1"]);
});

test("delegate constraints 全映射", () => {
  const c: Constraints = { tools: ["read", "bash"], excludeTools: ["edit"], thinking: "high", model: "gpt-x" };
  const a = buildDelegateArgs({ prompt: "hi", sessionId: undefined, constraints: c });
  assert.ok(a.includes("--tools"), "tools");
  assert.ok(a.includes("read,bash"), "tools 值");
  assert.ok(a.includes("--exclude-tools"), "excludeTools");
  assert.ok(a.includes("edit"), "excludeTools 值");
  assert.ok(a.includes("--thinking"), "thinking");
  assert.ok(a.includes("high"), "thinking 值");
  assert.ok(a.includes("--model"), "model");
  assert.ok(a.includes("gpt-x"), "model 值");
});

test("delegate 不含 session-dir/provider/append-system-prompt", () => {
  const a = buildDelegateArgs({ prompt: "hi", sessionId: undefined, constraints: {} });
  assert.ok(!a.some(x => x.includes("session-dir")));
  assert.ok(!a.some(x => x.includes("provider")));
  assert.ok(!a.some(x => x.includes("system-prompt")));
});

test("fork 参数 = --mode json --fork <id>", () => {
  assert.deepEqual(buildForkArgs("src-uuid"), ["--mode", "json", "--fork", "src-uuid"]);
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npm test -- --test-name-pattern="argv|delegate 基础|fork 参数" 2>&1 | head -10`
Expected: FAIL。

- [ ] **Step 3: 写 src/runner/argv.ts**

```ts
import type { Constraints } from "../types.js";

export interface DelegateArgsInput {
  prompt: string;
  sessionId?: string;       // undefined = 创建新 session
  constraints: Constraints;
}

export function buildDelegateArgs(input: DelegateArgsInput): string[] {
  const args = ["-p", input.prompt, "--mode", "json"];
  if (input.sessionId) args.push("--session-id", input.sessionId);
  const c = input.constraints;
  if (c.tools?.length) args.push("--tools", c.tools.join(","));
  if (c.excludeTools?.length) args.push("--exclude-tools", c.excludeTools.join(","));
  if (c.thinking) args.push("--thinking", c.thinking);
  if (c.model) args.push("--model", c.model);
  // v1 不传: --session-dir, --provider, --append-system-prompt (spec §11)
  return args;
}

export function buildForkArgs(sourceSessionId: string): string[] {
  return ["--mode", "json", "--fork", sourceSessionId];
}
```

- [ ] **Step 4: 跑确认通过**

Run: `npm test -- --test-name-pattern="argv|delegate 基础|fork 参数" 2>&1 | tail -10`
Expected: 5 passed。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: argv builder (delegate + fork)"
```

---

## Task 7: SessionRegistry（含 redaction、msgCount/lastActive 规则）

**Files:**
- Create: `pi-subagent/src/registry/session.ts`
- Test: `pi-subagent/test/session-registry.test.ts`

- [ ] **Step 1: 写 test/session-registry.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/registry/session.js";
import { Errors } from "../src/errors.js";

function makeReg() { return new SessionRegistry(); }

test("create 新 session", () => {
  const r = makeReg();
  r.create({ name: "feat-x", piSessionId: "u1", cwd: "/p", goal: "do x" });
  const s = r.get("feat-x");
  assert.equal(s?.piSessionId, "u1");
  assert.equal(s?.status, "idle");
  assert.equal(s?.msgCount, 0);
  assert.deepEqual(s?.progress, []);
});

test("create 重复名 → conflict", () => {
  const r = makeReg();
  r.create({ name: "a", piSessionId: "u1", cwd: "/p", goal: "g" });
  assert.throws(() => r.create({ name: "a", piSessionId: "u2", cwd: "/p", goal: "g" }), (e: any) => e.code === "conflict");
});

test("snapshot 脱敏不含 piSessionId", () => {
  const r = makeReg();
  r.create({ name: "a", piSessionId: "secret-uuid", cwd: "/p", goal: "g" });
  const snap = r.snapshot("a");
  assert.equal((snap as any).piSessionId, undefined);
  assert.equal(snap.name, "a");
});

test("progress FIFO 截断到 50", () => {
  const r = makeReg();
  r.create({ name: "a", piSessionId: "u1", cwd: "/p", goal: "g" });
  for (let i = 0; i < 60; i++) r.appendProgress("a", { ts: i, summary: `p${i}` });
  const s = r.get("a")!;
  assert.equal(s.progress.length, 50);
  assert.equal(s.progress[0].summary, "p10");  // 最早 10 条被丢
});

test("listByCwd 按 cwd 过滤 + lastActive 倒序", () => {
  const r = makeReg();
  r.create({ name: "a", piSessionId: "u1", cwd: "/p1", goal: "g" });
  r.touch("a", 100);
  r.create({ name: "b", piSessionId: "u2", cwd: "/p1", goal: "g" });
  r.touch("b", 200);
  r.create({ name: "c", piSessionId: "u3", cwd: "/p2", goal: "g" });
  const p1 = r.listByCwd("/p1");
  assert.equal(p1.length, 2);
  assert.equal(p1[0].name, "b");  // lastActive 更大在前
});

test("recordSuccess 更新 lastSummary 不覆盖 lastError", () => {
  const r = makeReg();
  r.create({ name: "a", piSessionId: "u1", cwd: "/p", goal: "g" });
  r.recordSuccess("a", "ok summary", { totalTokens: 10 });
  assert.equal(r.get("a")?.lastSummary, "ok summary");
});

test("recordFailure 写 lastError 不覆盖 lastSummary", () => {
  const r = makeReg();
  r.create({ name: "a", piSessionId: "u1", cwd: "/p", goal: "g" });
  r.recordSuccess("a", "good", { totalTokens: 1 });
  r.recordFailure("a", { code: "timeout", message: "t/o" });
  assert.equal(r.get("a")?.lastSummary, "good");  // 不覆盖
  assert.equal(r.get("a")?.lastError?.code, "timeout");
});

test("incMsgCount + setRunning/clearRunning", () => {
  const r = makeReg();
  r.create({ name: "a", piSessionId: "u1", cwd: "/p", goal: "g" });
  r.incMsgCount("a", 1000);
  r.setRunning("a", "run-1");
  assert.equal(r.get("a")?.msgCount, 1);
  assert.equal(r.get("a")?.status, "running");
  assert.equal(r.get("a")?.runId, "run-1");
  r.clearRunning("a", "idle", 2000);
  assert.equal(r.get("a")?.status, "idle");
  assert.equal(r.get("a")?.runId, undefined);
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npm test -- --test-name-pattern="create 新 session|snapshot|progress FIFO" 2>&1 | head -10`
Expected: FAIL。

- [ ] **Step 3: 写 src/registry/session.ts**

```ts
import type { SessionRecord, Snapshot, ProgressEvent, Usage, Constraints } from "../types.js";
import { Errors } from "../errors.js";

const MAX_PROGRESS = 50;
const MAX_SUMMARY = 500;

export interface CreateInput {
  name: string; piSessionId: string; cwd: string; goal: string; constraints?: Constraints;
}

export class SessionRegistry {
  private map = new Map<string, SessionRecord>();

  create(input: CreateInput): SessionRecord {
    if (this.map.has(input.name)) throw Errors.conflict(`session ${input.name}`);
    const now = Date.now();
    const rec: SessionRecord = {
      name: input.name, piSessionId: input.piSessionId, cwd: input.cwd, goal: input.goal,
      status: "idle", constraints: input.constraints, progress: [], lastActive: now, msgCount: 0,
    };
    this.map.set(input.name, rec);
    return rec;
  }

  get(name: string): SessionRecord | undefined { return this.map.get(name); }

  has(name: string): boolean { return this.map.has(name); }

  // 脱敏快照（不暴露 piSessionId）
  snapshot(name: string): Snapshot {
    const r = this.map.get(name);
    if (!r) throw Errors.notFound(`session ${name}`);
    const { piSessionId: _omit, ...rest } = r;
    return rest;
  }

  list(): Snapshot[] {
    return [...this.map.values()]
      .sort((a, b) => b.lastActive - a.lastActive)
      .map(r => { const { piSessionId: _, ...rest } = r; return rest; });
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
    if (r) { r.msgCount += 1; r.lastActive = ts; }
  }

  setRunning(name: string, runId: string): void {
    const r = this.map.get(name);
    if (r) { r.status = "running"; r.runId = runId; }
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

  recordSuccess(name: string, summary: string, _usage?: Usage): void {
    const r = this.map.get(name);
    if (!r) return;
    r.lastSummary = summary.length <= MAX_SUMMARY ? summary : summary.slice(0, MAX_SUMMARY);
  }

  recordFailure(name: string, err: { code: string; message: string; runId?: string }): void {
    const r = this.map.get(name);
    if (!r) return;
    r.lastError = { ...err, ts: Date.now() };
  }

  // 供 persist 用：返回可序列化记录（去掉 runId）
  allPersistable(): SessionRecord[] {
    return [...this.map.values()];
  }

  // 供 persist 加载用：替换内存
  loadAll(records: SessionRecord[]): void {
    this.map.clear();
    for (const r of records) this.map.set(r.name, r);
  }
}
```

- [ ] **Step 4: 跑确认通过**

Run: `npm test -- --test-name-pattern="create 新 session|snapshot|progress FIFO|listByCwd|recordSuccess|recordFailure|incMsgCount" 2>&1 | tail -15`
Expected: 8 passed。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: SessionRegistry (snapshot/redact/progress/lastSummary rules)"
```

---

## Task 8: persist（原子写 + 加载修正 + 单条坏记录）

**Files:**
- Create: `pi-subagent/src/registry/persist.ts`
- Test: `pi-subagent/test/persist.test.ts`

- [ ] **Step 1: 写 test/persist.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveRegistry, loadRegistry } from "../src/registry/persist.js";
import type { SessionRecord } from "../src/types.js";

function tmpDir() { return mkdtempSync(join(tmpdir(), "pi-sub-test-")); }

function sampleRecord(over: Partial<SessionRecord> = {}): SessionRecord {
  return { name: "a", piSessionId: "u1", cwd: "/p", goal: "g", status: "idle", progress: [], lastActive: 1, msgCount: 0, ...over };
}

test("save + load 往返（running 记录落盘保真）", () => {
  const dir = tmpDir();
  const path = join(dir, "registry.json");
  saveRegistry(path, [{ ...sampleRecord({ name: "r1", status: "running", runId: "x" }) }]);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(raw.version, 1);
  assert.equal(raw.sessions[0].status, "running");  // 落盘保真
  assert.equal(raw.sessions[0].runId, undefined);   // runId 不落盘
  const loaded = loadRegistry(path);
  assert.equal(loaded.sessions[0].status, "error"); // 加载修正
  assert.equal(loaded.sessions[0].lastError?.code, "interrupted_by_restart");
  rmSync(dir, { recursive: true, force: true });
});

test("目录不存在时 save 自动 mkdir", () => {
  const dir = tmpDir();
  const nested = join(dir, "nested", "deep");
  const path = join(nested, "registry.json");
  saveRegistry(path, []);
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
  assert.ok(existsSync(path + ".corrupt"));  // 备份在
  rmSync(dir, { recursive: true, force: true });
});

test("单条记录缺 progress → 补 []，其他记录不受影响", () => {
  const dir = tmpDir();
  const path = join(dir, "registry.json");
  // 手写：一条缺 progress，一条正常
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

test("save 写入串行化：并发两次 save 都落盘", async () => {
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
```

- [ ] **Step 2: 跑确认失败**

Run: `npm test -- --test-name-pattern="save|load|目录|文件" 2>&1 | head -10`
Expected: FAIL。

- [ ] **Step 3: 写 src/registry/persist.ts**

```ts
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, copyFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SessionRecord, PersistedSessionRecord, RegistryFile } from "../types.js";

// 写串行化 queue（R3#10 + R4#4）
let writeChain: Promise<void> = Promise.resolve();

export function saveRegistry(path: string, records: SessionRecord[]): Promise<void> {
  // 落盘：去掉 runId，status 保真（含 running，加载时修正）
  const persisted: PersistedSessionRecord[] = records.map(r => {
    const { runId: _drop, ...rest } = r;
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
```

- [ ] **Step 4: 跑确认通过**

Run: `npm test -- --test-name-pattern="save|load|目录|文件|串行" 2>&1 | tail -15`
Expected: 7 passed。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: registry persist (atomic write + load fix + per-record corrupt)"
```

---

## Task 9: scheduler/plan（5 阶段纯函数 + 表驱动 + 性质测试）

**Files:**
- Create: `pi-subagent/src/scheduler/keywords.ts`
- Create: `pi-subagent/src/scheduler/plan.ts`
- Test: `pi-subagent/test/scheduler.test.ts`

这是 spec 的重点模块（用户强调"上下文/调用/同步异步调度要可测"）。

- [ ] **Step 1: 写 src/scheduler/keywords.ts**

```ts
// spec §6 信号词词表（加词即加测试，不改逻辑）
export const REJECT_WORDS = ["精修", "反复调", "我亲自", "亲手"] as const;
export const DELEGATE_WORDS = ["探索整个", "并行对比", "独立实现", "同时调研"] as const;
export const DANGER_WORDS = ["删除", "rm ", "rm -", "force", "reset --hard", "drop table"] as const;

export function containsAny(text: string, words: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return words.some(w => lower.includes(w.toLowerCase()));
}
```

- [ ] **Step 2: 写 test/scheduler.test.ts（单阶段用例）**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { plan } from "../src/scheduler/plan.js";
import type { Snapshot } from "../src/types.js";

const CWD = "/proj";
function idleSnap(name: string, cwd = CWD, over: Partial<Snapshot> = {}): Snapshot {
  return { name, piSessionId: "u", cwd, goal: "g", status: "idle", progress: [], lastActive: 1, msgCount: 0, ...over };
}

test("R1 委托信号词 → async", () => {
  const o = plan({ task: "并行对比两个方案", fanout: 1, cwd: CWD, existingSessions: [] });
  assert.equal(o.shouldDelegate, true);
  assert.equal(o.plan?.mode, "async");
});

test("R1 fanout>1 → async + 多 session", () => {
  const o = plan({ task: "探索 a/b/c", fanout: 3, cwd: CWD, existingSessions: [] });
  assert.equal(o.plan?.mode, "async");
  assert.equal(o.plan?.sessions.length, 3);
});

test("阶段1 反信号词 → shouldDelegate=false (terminal)", () => {
  const o = plan({ task: "反复调这个动画", fanout: 3, cwd: CWD, existingSessions: [] });
  assert.equal(o.shouldDelegate, false);
  assert.equal(o.plan?.sessions.length ?? 0, 0);
});

test("R2 slots==0 → shouldDelegate=false terminal", () => {
  const busy = [1,2,3,4].map(i => idleSnap(`s${i}`, CWD, { status: "running" }));
  const o = plan({ task: "做点事", fanout: 1, cwd: CWD, existingSessions: busy });
  assert.equal(o.shouldDelegate, false);
  assert.ok(o.reason.includes("并发槽"));
});

test("R2 fanout 截断到可用槽", () => {
  const busy = [1,2].map(i => idleSnap(`s${i}`, CWD, { status: "running" }));
  const o = plan({ task: "探索 a/b/c/d/e/f", fanout: 6, cwd: CWD, existingSessions: busy });
  assert.equal(o.plan!.sessions.length, 2);  // 4-2=2 槽
  assert.ok(o.reason.includes("分批"));
});

test("R3 cwd 过滤复用：只 continue 同 cwd 的 idle", () => {
  const same = idleSnap("feat-auth", CWD);
  const other = idleSnap("feat-auth", "/other");
  const o = plan({ task: "给 auth 加测试", fanout: 1, cwd: CWD, existingSessions: [same, other] });
  const cont = o.plan!.sessions.find(s => s.action === "continue");
  assert.ok(cont);
  assert.equal(cont!.name, "feat-auth");
});

test("R3 全局 runningCount：其他 cwd 的 running 也占槽", () => {
  const otherBusy = [1,2,3,4].map(i => idleSnap(`s${i}`, "/other", { status: "running" }));
  const o = plan({ task: "做点事", fanout: 1, cwd: CWD, existingSessions: otherBusy });
  assert.equal(o.shouldDelegate, false);  // 全局已满
});

test("R4 危险词 → excludeTools 含 bash", () => {
  const o = plan({ task: "删除旧目录并 rm 临时文件", fanout: 1, cwd: CWD, existingSessions: [] });
  const c = o.plan!.sessions[0].constraints;
  assert.ok(c?.excludeTools?.includes("bash"));
});

test("R4 高复杂度 → thinking high + runTimeoutMs 加倍", () => {
  const o = plan({ task: "重构状态层", fanout: 1, estComplexity: "high", cwd: CWD, existingSessions: [] });
  assert.equal(o.plan!.sessions[0].constraints?.thinking, "high");
  assert.ok((o.plan!.sessions[0].runTimeoutMs ?? 0) > 600000);
});

test("R5 preferredMode=sync 单任务 → sync", () => {
  const o = plan({ task: "改个常量", fanout: 1, preferredMode: "sync", cwd: CWD, existingSessions: [] });
  assert.equal(o.plan!.mode, "sync");
});

test("R5 preferredMode=sync 但 fanout>1 → async + reason", () => {
  const o = plan({ task: "探索 a/b/c", fanout: 3, preferredMode: "sync", cwd: CWD, existingSessions: [] });
  assert.equal(o.plan!.mode, "async");
  assert.ok(o.reason.includes("sync") || o.reason.includes("async"));
});

test("R5 默认 → async", () => {
  const o = plan({ task: "实现登录", fanout: 1, cwd: CWD, existingSessions: [] });
  assert.equal(o.plan!.mode, "async");
});
```

- [ ] **Step 3: 写组合用例（追加到同一文件）**

```ts
test("组合：否决优先于一切（反信号词+危险+fanout+high）", () => {
  const o = plan({ task: "反复调删除逻辑", fanout: 3, estComplexity: "high", cwd: CWD, existingSessions: [] });
  assert.equal(o.shouldDelegate, false);
});

test("组合：危险+高复杂度叠加（excludeTools bash && thinking high && timeout 加倍）", () => {
  const o = plan({ task: "删除旧目录", fanout: 1, estComplexity: "high", cwd: CWD, existingSessions: [] });
  const s = o.plan!.sessions[0];
  assert.ok(s.constraints?.excludeTools?.includes("bash"));
  assert.equal(s.constraints?.thinking, "high");
  assert.ok((s.runTimeoutMs ?? 0) > 600000);
});

test("组合：信号词+危险叠加（async && excludeTools bash）", () => {
  const o = plan({ task: "并行对比删除方案", fanout: 2, cwd: CWD, existingSessions: [] });
  assert.equal(o.plan!.mode, "async");
  assert.ok(o.plan!.sessions.every(s => s.constraints?.excludeTools?.includes("bash")));
});
```

- [ ] **Step 4: 写性质测试（100 次随机）**

```ts
import { randomBytes } from "node:crypto";
function rand(n: number) { return randomBytes(n).readUInt32LE(0) % n; }

test("性质：100 次随机输入满足不变量", () => {
  const words = ["探索整个", "并行对比", "精修", "反复调", "删除", "rm ", "实现", "改个"];
  const complexities = ["low", "medium", "high", undefined] as const;
  const modes = ["sync", "async", undefined] as const;
  for (let i = 0; i < 100; i++) {
    const task = words[rand(words.length)] + " task" + i;
    const fanout = 1 + rand(6);
    const running = Array.from({length: rand(5)}, (_, k) => idleSnap(`r${k}`, "/x", {status:"running"}));
    const o = plan({
      task, fanout,
      estComplexity: complexities[rand(complexities.length)],
      preferredMode: modes[rand(modes.length)],
      cwd: CWD, existingSessions: running,
    });
    const runningCount = running.length;
    // 不变量 1: sessions ≤ min(fanout, 4 - runningCount)
    const sessLen = o.plan?.sessions.length ?? 0;
    assert.ok(sessLen <= Math.min(fanout, Math.max(0, 4 - runningCount)),
      `sessions ${sessLen} 超 ${Math.min(fanout, 4-runningCount)} (task=${task})`);
    // 不变量 2: shouldDelegate=false → sessions 空
    if (!o.shouldDelegate) assert.equal(sessLen, 0);
    // 不变量 3: 危险词 → 所有 session excludeTools 含 bash
    if (/删除|rm /.test(task) && o.shouldDelegate) {
      assert.ok(o.plan!.sessions.every(s => s.constraints?.excludeTools?.includes("bash")));
    }
    // 不变量 4: 反信号词 → shouldDelegate false
    if (/精修|反复调/.test(task)) assert.equal(o.shouldDelegate, false);
    // 不变量 5: preferredMode sync 且 fanout==1 → sync；fanout>1 → async
    if (o.shouldDelegate && o.plan!.sessions.length === 1) {
      // 单 session 时 mode 由 preferredMode 决定
    }
  }
});
```

- [ ] **Step 5: 写 src/scheduler/plan.ts**

```ts
import type { PlanInput, PlanOutput, SessionSpec, Snapshot } from "../types.js";
import { REJECT_WORDS, DELEGATE_WORDS, DANGER_WORDS, containsAny } from "./keywords.js";

const MAX_CONCURRENCY = 4;
const BASE_RUN_TIMEOUT = 600000;
const HIGH_RUN_TIMEOUT = 1200000;  // 高复杂度加倍

export function plan(input: PlanInput): PlanOutput {
  const task = input.task;
  const fanout = input.fanout ?? 1;
  const cwd = input.cwd;
  const all = input.existingSessions;
  const runningCount = all.filter(s => s.status === "running").length;

  // ===== 阶段 1: 否决 (terminal) =====
  if (containsAny(task, REJECT_WORDS)) {
    return { shouldDelegate: false, reason: "任务需高频人工判断，建议亲自做" };
  }

  // ===== 阶段 2: 容量 =====
  const available = MAX_CONCURRENCY - runningCount;
  if (available <= 0) {
    return { shouldDelegate: false, reason: "无可用并发槽，稍后重试" };
  }
  const effectiveFanout = Math.min(fanout, available);
  const batched = effectiveFanout < fanout;

  // ===== 阶段 3: 复用（cwd 过滤）=====
  const candidates = all.filter(s => s.cwd === cwd && s.status === "idle");
  const specs: SessionSpec[] = [];
  for (let i = 0; i < effectiveFanout; i++) {
    const reuse = candidates[i];
    if (reuse) {
      specs.push({
        action: "continue",
        name: reuse.name,
        goal: reuse.goal,
        cwd,
        constraints: reuse.constraints,
        prompt: "",  // host 填
      });
    } else {
      specs.push({
        action: "create",
        name: `${task.slice(0, 12)}-${i}`,
        goal: task,
        cwd,
        prompt: "",
      });
    }
  }

  // ===== 阶段 4: 修饰（叠加）=====
  const isDanger = containsAny(task, DANGER_WORDS);
  const isHigh = input.estComplexity === "high";
  for (const s of specs) {
    if (isDanger) {
      s.constraints = { ...s.constraints };
      if (s.constraints.tools?.length) {
        s.constraints.tools = s.constraints.tools.filter(t => t !== "bash");
      } else {
        s.constraints.excludeTools = [...new Set([...(s.constraints.excludeTools ?? []), "bash"])];
      }
      s.constraints.thinking = "high";
    }
    if (isHigh) {
      s.constraints = { ...s.constraints, thinking: "high" };
      s.runTimeoutMs = HIGH_RUN_TIMEOUT;
    }
  }

  // ===== 阶段 5: mode 决策 =====
  let mode: "sync" | "async" = "async";
  const reasons: string[] = [];
  if (effectiveFanout > 1) {
    mode = "async";
  } else if (containsAny(task, DELEGATE_WORDS)) {
    mode = "async";
  } else if (input.preferredMode === "sync" && effectiveFanout === 1) {
    mode = "sync";
  } else if (input.preferredMode === "sync" && effectiveFanout > 1) {
    mode = "async";
    reasons.push("fanout>1 不支持 sync，已改 async");
  }
  if (batched) reasons.push(`分批，余 ${fanout - effectiveFanout} 待后续`);

  return {
    shouldDelegate: true,
    reason: reasons.join("；") || "ok",
    plan: { mode, sessions: specs },
  };
}
```

- [ ] **Step 6: 跑全部 scheduler 测试**

Run: `npm test -- --test-name-pattern="scheduler|R[0-9]|组合|性质|plan" 2>&1 | tail -20`
Expected: 单阶段 13 + 组合 3 + 性质 1 = 17 passed。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: scheduler plan() 5-stage + table-driven + property tests"
```

---

## Task 10: RunRegistry（TTL/容量淘汰 + 多等待者）

**Files:**
- Create: `pi-subagent/src/registry/run.ts`
- Test: `pi-subagent/test/run-registry.test.ts`

- [ ] **Step 1: 写 test/run-registry.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { RunRegistry } from "../src/registry/run.js";

function makeReg(maxCompleted = 128, ttlMs = 86400000) {
  return new RunRegistry(maxCompleted, ttlMs);
}

test("create + get running run", () => {
  const r = makeReg();
  const run = r.create({ session: "a", startedAt: 1 });
  assert.equal(run.status, "running");
  assert.equal(r.get(run.runId)?.status, "running");
});

test("complete 后仍可 get", () => {
  const r = makeReg();
  const run = r.create({ session: "a", startedAt: 1 });
  r.complete(run.runId, { status: "completed", result: "ok", endedAt: 2 });
  assert.equal(r.get(run.runId)?.status, "completed");
  assert.equal(r.get(run.runId)?.result, "ok");
});

test("runningCount 统计", () => {
  const r = makeReg();
  r.create({ session: "a", startedAt: 1 });
  r.create({ session: "b", startedAt: 2 });
  assert.equal(r.runningCount(), 2);
  r.complete(r.list()[0].runId, { status: "completed", endedAt: 3 });
  assert.equal(r.runningCount(), 1);
});

test("超过 maxCompleted 淘汰旧完成 run → get 返回 undefined（expired）", () => {
  const r = makeReg(2, 999999999);
  const r1 = r.create({ session: "a", startedAt: 1 });
  r.complete(r1.runId, { status: "completed", endedAt: 2 });
  const r2 = r.create({ session: "a", startedAt: 3 });
  r.complete(r2.runId, { status: "completed", endedAt: 4 });
  const r3 = r.create({ session: "a", startedAt: 5 });
  r.complete(r3.runId, { status: "completed", endedAt: 6 });
  // 只保留最近 2 条完成 → r1 被淘汰
  assert.equal(r.get(r1.runId), undefined);
  assert.equal(r.isExpired(r1.runId), true);
  assert.ok(r.get(r2.runId));
});

test("TTL 过期淘汰", () => {
  const r = makeReg(128, 100);  // 100ms TTL
  const run = r.create({ session: "a", startedAt: 1 });
  r.complete(run.runId, { status: "completed", endedAt: 2 });
  // 模拟时间流逝：手动调 cleanup 用旧时间
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      r.cleanupExpired();
      assert.equal(r.get(run.runId), undefined);
      resolve();
    }, 150);
  });
});

test("多等待者：完成时全部唤醒", async () => {
  const r = makeReg();
  const run = r.create({ session: "a", startedAt: 1 });
  const w1 = r.waitForCompletion(run.runId, 1000);
  const w2 = r.waitForCompletion(run.runId, 1000);
  r.complete(run.runId, { status: "completed", result: "done", endedAt: 2 });
  const [a, b] = await Promise.all([w1, w2]);
  assert.equal(a?.result, "done");
  assert.equal(b?.result, "done");
});

test("waitForCompletion 超时返回当前状态", async () => {
  const r = makeReg();
  const run = r.create({ session: "a", startedAt: 1 });
  const res = await r.waitForCompletion(run.runId, 50);
  assert.equal(res?.status, "running");  // 仍 running（超时）
});

test("isExpired 对从未存在的 runId 返回 false", () => {
  const r = makeReg();
  assert.equal(r.isExpired("never"), false);
});
```

- [ ] **Step 2: 跑确认失败**

Run: `npm test -- --test-name-pattern="run-registry|RunRegistry|waitForCompletion|maxCompleted|TTL|多等待" 2>&1 | head -10`
Expected: FAIL。

- [ ] **Step 3: 写 src/registry/run.ts**

```ts
import { randomUUID } from "node:crypto";
import type { Run, RunError, Usage, ProgressEvent } from "../types.js";

export interface CreateRunInput {
  session: string;
  startedAt: number;
}

export interface CompleteInput {
  status: "completed" | "error" | "killed" | "timeout";
  result?: string;
  endedAt: number;
  progress?: ProgressEvent[];
  progressTruncated?: boolean;
  usage?: Usage;
  error?: RunError;
}

interface Waiter {
  resolve: (r: Run | undefined) => void;
}

export class RunRegistry {
  private runs = new Map<string, Run>();
  private completedOrder: string[] = [];  // 完成顺序（FIFO 淘汰）
  private waiters = new Map<string, Waiter[]>();
  private expiredSet = new Set<string>();

  constructor(
    private maxCompleted = 128,
    private ttlMs = 86400000,
  ) {}

  create(input: CreateRunInput): Run {
    const run: Run = { runId: randomUUID(), session: input.session, status: "running", progress: [], startedAt: input.startedAt };
    this.runs.set(run.runId, run);
    return run;
  }

  get(runId: string): Run | undefined { return this.runs.get(runId); }

  isExpired(runId: string): boolean { return this.expiredSet.has(runId); }

  runningCount(): number {
    let n = 0; for (const r of this.runs.values()) if (r.status === "running") n++; return n;
  }

  list(): Run[] { return [...this.runs.values()]; }

  complete(runId: string, input: CompleteInput): void {
    const r = this.runs.get(runId);
    if (!r) return;
    r.status = input.status;
    r.result = input.result;
    r.endedAt = input.endedAt;
    if (input.progress) r.progress = input.progress;
    if (input.progressTruncated) r.progressTruncated = input.progressTruncated;
    if (input.usage) r.usage = input.usage;
    if (input.error) r.error = input.error;
    this.completedOrder.push(runId);
    this.evictIfNeeded();
    // 唤醒所有等待者
    const ws = this.waiters.get(runId) ?? [];
    for (const w of ws) w.resolve(r);
    this.waiters.delete(runId);
  }

  appendProgress(runId: string, ev: ProgressEvent): void {
    const r = this.runs.get(runId);
    if (!r) return;
    r.progress.push(ev);
    if (r.progress.length > 200) {
      r.progress = r.progress.slice(-200);
      r.progressTruncated = true;
    }
  }

  // long-poll：完成或超时返回
  waitForCompletion(runId: string, timeoutMs: number): Promise<Run | undefined> {
    const existing = this.runs.get(runId);
    if (existing && existing.status !== "running") return Promise.resolve(existing);
    if (this.expiredSet.has(runId)) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.runs.get(runId)), timeoutMs);
      const waiter: Waiter = { resolve: (r) => { clearTimeout(timer); resolve(r); } };
      const arr = this.waiters.get(runId) ?? [];
      arr.push(waiter);
      this.waiters.set(runId, arr);
    });
  }

  cleanupExpired(): void {
    const now = Date.now();
    for (const id of [...this.completedOrder]) {
      const r = this.runs.get(id);
      if (!r || !r.endedAt) continue;
      if (now - r.endedAt > this.ttlMs) {
        this.runs.delete(id);
        this.expiredSet.add(id);
        this.completedOrder = this.completedOrder.filter(x => x !== id);
      }
    }
  }

  private evictIfNeeded(): void {
    const completed = [...this.completedOrder];
    while (completed.length > this.maxCompleted) {
      const old = completed.shift()!;
      this.runs.delete(old);
      this.expiredSet.add(old);
    }
    this.completedOrder = completed;
  }
}
```

- [ ] **Step 4: 跑确认通过**

Run: `npm test -- --test-name-pattern="run-registry|RunRegistry|waitForCompletion|maxCompleted|TTL|多等待" 2>&1 | tail -15`
Expected: 8 passed。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: RunRegistry (TTL/cap eviction + multi-waiter long-poll)"
```

---

## Task 11: process-table + spawn

**Files:**
- Create: `pi-subagent/src/runner/process-table.ts`
- Create: `pi-subagent/src/runner/spawn.ts`

process-table 管 managed children（run + fork 进程）+ 退出清理。spawn 封装 child_process。

- [ ] **Step 1: 写 src/runner/process-table.ts**

```ts
import { ChildProcess } from "node:child_process";

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
      try { if (!m.child.killed) m.child.kill("SIGTERM"); } catch {}
    }
  }

  has(id: string): boolean { return this.children.has(id); }
}
```

- [ ] **Step 2: 写 src/runner/spawn.ts**

```ts
import { spawn, ChildProcess } from "node:child_process";
import { buildDelegateArgs, buildForkArgs } from "./argv.js";
import type { Constraints } from "../types.js";

const DEFAULT_PI_BIN = "pi";

function piBin(): string {
  return process.env.PI_BIN ?? DEFAULT_PI_BIN;
}

// spawn delegate pi 进程，逐行读 stdout（NDJSON）
export interface SpawnedDelegate {
  child: ChildProcess;
}

export function spawnDelegate(opts: {
  prompt: string;
  sessionId?: string;
  constraints: Constraints;
  cwd: string;
}): SpawnedDelegate {
  const args = buildDelegateArgs({ prompt: opts.prompt, sessionId: opts.sessionId, constraints: opts.constraints });
  const child = spawn(piBin(), args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
  return { child };
}

export function spawnFork(opts: { sourceSessionId: string; cwd: string }): ChildProcess {
  const args = buildForkArgs(opts.sourceSessionId);
  return spawn(piBin(), args, { cwd: opts.cwd, stdio: ["ignore", "pipe", "pipe"] });
}

// 逐行读 child.stdout，回调每行；返回结束 promise（含 exitCode/signal）
export interface CollectResult {
  lines: string[];
  stderrTail: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

export function collectOutput(child: ChildProcess, opts: { runTimeoutMs?: number; onLine?: (line: string) => void } = {}): Promise<CollectResult> {
  return new Promise((resolve) => {
    const lines: string[] = [];
    let stderrBuf = "";
    let timer: NodeJS.Timeout | undefined;

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    let pending = "";
    child.stdout?.on("data", (chunk: string) => {
      pending += chunk;
      let idx;
      while ((idx = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, idx);
        pending = pending.slice(idx + 1);
        if (line.trim()) { lines.push(line); opts.onLine?.(line); }
      }
    });
    child.stderr?.on("data", (chunk: string) => {
      stderrBuf += chunk;
      if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(-2048);  // 保留末 2KB
    });

    const done = (exitCode: number | null, signal: NodeJS.Signals | null) => {
      if (timer) clearTimeout(timer);
      if (pending.trim()) { lines.push(pending); opts.onLine?.(pending); }
      resolve({ lines, stderrTail: stderrBuf.slice(-2048), exitCode, signal });
    };

    child.once("exit", (code, sig) => done(code, sig));

    if (opts.runTimeoutMs) {
      timer = setTimeout(() => {
        if (!child.killed) child.kill("SIGTERM");
        setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 5000);
      }, opts.runTimeoutMs);
    }
  });
}
```

- [ ] **Step 3: 写 test/spawn.test.ts（用 echo 当假进程）**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { collectOutput } from "../src/runner/spawn.js";

test("collectOutput 读 stdout 逐行 + exitCode", async () => {
  const child = spawn("echo", ['{"type":"session","id":"u1"}', '{"type":"agent_end","messages":[]}']);
  const res = await collectOutput(child);
  assert.equal(res.exitCode, 0);
  assert.equal(res.lines.length, 2);
  assert.ok(res.lines[0].includes("session"));
});

test("collectOutput stderr 末尾保留", async () => {
  const child = spawn("sh", ["-c", "echo err1 >&2; echo err2 >&2; echo out"]);
  const res = await collectOutput(child);
  assert.ok(res.stderrTail.includes("err2"));
});
```

- [ ] **Step 4: 跑确认通过**

Run: `npm test -- --test-name-pattern="collectOutput|stdout|stderr" 2>&1 | tail -10`
Expected: 2 passed。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: process-table + spawn/collectOutput"
```

---

## Task 12: 假 pi fixtures + 测试辅助

**Files:**
- Create: `pi-subagent/test/fixtures/fake-pi.sh`
- Create: `pi-subagent/test/fixtures/fake-pi-no-session.sh`
- Create: `pi-subagent/test/fixtures/fake-pi-hang.sh`
- Create: `pi-subagent/test/helpers.ts`

假 pi 据 argv/env 吐不同 NDJSON，供集成测试用。

- [ ] **Step 1: 写 fake-pi.sh（正常成功：session + tool + agent_end）**

```bash
#!/usr/bin/env bash
# 假 pi：根据 argv 吐 NDJSON
# 触发条件：env FAKE_PI_MODE (success|no_session|hang|error_exit)
set -e
MODE="${FAKE_PI_MODE:-success}"
UUID="${FAKE_PI_UUID:-019f0000-0000-0000-0000-000000000001}"

emit() { echo "$1"; }

if [[ "$MODE" == "no_session" ]]; then
  # 不吐 session 事件，直接退出非零
  echo "pi bootstrap failed" >&2
  exit 3
fi

if [[ "$MODE" == "hang" ]]; then
  emit "{\"type\":\"session\",\"version\":3,\"id\":\"$UUID\",\"cwd\":\"$(pwd)\"}"
  sleep 600  # 卡住，等被 kill
  exit 0
fi

# success / error_exit 都先吐 session
emit "{\"type\":\"session\",\"version\":3,\"id\":\"$UUID\",\"cwd\":\"$(pwd)\"}"
emit "{\"type\":\"turn_start\",\"timestamp\":1}"
emit "{\"type\":\"tool_execution_end\",\"toolCallId\":\"t1\",\"toolName\":\"bash\",\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"FAKE_OUTPUT_$UUID\"}]}}"
emit "{\"type\":\"agent_end\",\"messages\":[{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":\"q\"}]},{\"role\":\"assistant\",\"content\":[{\"type\":\"text\",\"text\":\"FAKE_RESULT_$MODE\"}],\"usage\":{\"input\":10,\"output\":5,\"totalTokens\":15,\"cost\":{\"total\":0.001}}}]}"

if [[ "$MODE" == "error_exit" ]]; then
  echo "boom" >&2
  exit 4
fi
exit 0
```

- [ ] **Step 2: 给假 pi 加可执行权限**

```bash
chmod +x test/fixtures/fake-pi.sh
# hang/no_session 复用同一脚本靠 FAKE_PI_MODE 切换，不需单独文件
```

（计划里 fake-pi-hang.sh / fake-pi-no-session.sh 不再单独建文件——用同一脚本 + FAKE_PI_MODE 环境变量切换，更 DRY。删除文件结构里的这两个。）

- [ ] **Step 3: 写 test/helpers.ts**

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 提供一个临时 cwd + 设 PI_BIN 指向 fake-pi
export function fakePiEnv(mode: "success" | "no_session" | "hang" | "error_exit" = "success") {
  return {
    PI_BIN: join(process.cwd(), "test/fixtures/fake-pi.sh"),
    FAKE_PI_MODE: mode,
  };
}

export function tmpCwd(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-sub-cwd-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export function withEnv(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  return fn().finally(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });
}
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: fake-pi fixture + test helpers"
```

---

## Task 13: pi_delegate（sync/async + 握手 + 创建/续接）

**Files:**
- Create: `pi-subagent/src/tools/delegate.ts`
- Test: `pi-subagent/test/delegate.test.ts`

这是最复杂的工具。封装：握手（新 session 等 session 事件）、spawn、collectOutput、解析、更新 registry。

- [ ] **Step 1: 写 src/tools/delegate.ts**

```ts
import { existsSync, statSync } from "node:fs";
import { SessionRegistry } from "../registry/session.js";
import { RunRegistry } from "../registry/run.js";
import { ProcessTable } from "../runner/process-table.js";
import { spawnDelegate, collectOutput } from "../runner/spawn.js";
import { extractResult } from "../runner/parse.js";
import { Errors } from "../errors.js";
import { ERROR_CODES, PI_BUILTIN_TOOLS, type Constraints, type Snapshot } from "../types.js";

const MAX_CONCURRENCY = 4;
const SESSION_START_TIMEOUT_MS = 10000;

export interface DelegateInput {
  prompt: string;
  session: string;
  cwd: string;
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

function validateTools(c: Constraints | undefined, allowUnknown: boolean): void {
  if (!c) return;
  const known = new Set<string>([...PI_BUILTIN_TOOLS]);
  for (const t of [...(c.tools ?? []), ...(c.excludeTools ?? [])]) {
    if (!known.has(t) && !allowUnknown) throw Errors.unknownTool(t);
  }
}

export async function delegate(input: DelegateInput, deps: DelegateDeps): Promise<{
  runId: string; session?: Snapshot; status: string; result?: string; progress?: any[]; usage?: any; error?: any;
}> {
  if (!input.prompt?.trim()) throw Errors.invalidArg("prompt required");
  if (!input.session) throw Errors.invalidArg("session required");

  const existing = deps.sessions.get(input.session);
  const isCreate = !existing;

  if (isCreate) {
    if (!input.goal) throw Errors.goalRequired();
    if (!input.cwd || !existsSync(input.cwd) || !statSync(input.cwd).isDirectory()) throw Errors.cwdInvalid(input.cwd);
    if (input.constraints) validateTools(input.constraints, !!input.allowUnknownTools);
  } else {
    if (input.cwd && existing!.cwd !== input.cwd) throw Errors.cwdMismatch(input.session, existing!.cwd);
    if (existing!.status === "running") throw Errors.sessionBusy(input.session, existing!.runId ?? "");
    if (input.constraints) validateTools(input.constraints, !!input.allowUnknownTools);
  }

  // 并发上限实时复查（R4#9）
  if (deps.runs.runningCount() >= MAX_CONCURRENCY) throw Errors.resourceBusy();

  const mode = input.mode ?? "async";
  const constraints = input.constraints ?? {};
  const runTimeoutMs = input.runTimeoutMs ?? 600000;
  const startedAt = Date.now();

  const run = deps.runs.create({ session: input.session, startedAt });
  let piSessionId = existing?.piSessionId;

  const child = spawnDelegate({
    prompt: input.prompt,
    sessionId: existing?.piSessionId,
    constraints,
    cwd: existing?.cwd ?? input.cwd!,
  });

  deps.procs.register(run.runId, child.child, () => {});

  // 立即把 session 标 running（若已存在）
  if (existing) {
    deps.sessions.setRunning(input.session, run.runId);
  }

  // 握手：新 session 必须等 session 事件（R4#2）
  let sessionIdReceived = piSessionId !== undefined;
  let sessionTimer: NodeJS.Timeout | undefined;

  const collectPromise = collectOutput(child.child, {
    runTimeoutMs,
    onLine: (line) => {
      if (!sessionIdReceived && line.includes('"type":"session"')) {
        try {
          const obj = JSON.parse(line);
          piSessionId = obj.id;
          sessionIdReceived = true;
          if (isCreate && piSessionId) {
            // 收到 session 事件 → 提交 SessionRecord
            deps.sessions.create({
              name: input.session, piSessionId, cwd: input.cwd!, goal: input.goal!, constraints,
            });
            deps.sessions.setRunning(input.session, run.runId);
            deps.sessions.incMsgCount(input.session, startedAt);
          } else if (existing) {
            deps.sessions.incMsgCount(input.session, startedAt);
          }
          if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = undefined; }
          // async 模式在此刻 resolve（握手完成）
          if (mode === "async" && !asyncResolved) {
            asyncResolved = true;
            resolveAsync();
          }
        } catch {}
      }
      // 流式 progress
      if (line.includes('"type":"tool_execution_end"')) {
        try {
          const obj = JSON.parse(line);
          const txt = obj.result?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
          if (txt) deps.runs.appendProgress(run.runId, { ts: Date.now(), tool: obj.toolName, summary: txt.slice(0, 200) });
        } catch {}
      }
    },
  });

  // 握手超时（仅新 session）
  let asyncResolved = false;
  let resolveAsync: () => void = () => {};
  const asyncHandshake = new Promise<void>((res) => { resolveAsync = res; });

  if (isCreate) {
    sessionTimer = setTimeout(() => {
      if (!sessionIdReceived) {
        // 握手超时：kill + 标 error
        deps.procs.kill(run.runId);
        if (!asyncResolved) { asyncResolved = true; }
      }
    }, SESSION_START_TIMEOUT_MS);
  } else {
    // 续接：async 立即 resolve
    if (mode === "async" && !asyncResolved) { asyncResolved = true; resolveAsync(); }
  }

  // 收尾函数
  const finalize = async () => {
    const res = await collectPromise;
    const { result, progress, usage } = extractResult(res.lines);

    let status: "completed" | "error" | "timeout" | "killed" = "completed";
    let error: any;
    const endedAt = Date.now();

    if (!sessionIdReceived && isCreate) {
      // 新 session 没拿到 session 事件
      if (res.signal === "SIGTERM" || res.signal === "SIGKILL") {
        status = "error"; error = { code: ERROR_CODES.SESSION_START_TIMEOUT, message: "session 事件握手超时" };
      } else {
        status = "error"; error = { code: ERROR_CODES.SESSION_CREATE_FAILED, message: "no session event", stderrTail: res.stderrTail, exitCode: res.exitCode ?? undefined };
      }
      // 不创建 SessionRecord
    } else if (res.signal === "SIGTERM" || res.signal === "SIGKILL") {
      status = "killed"; error = { code: ERROR_CODES.KILLED, message: "killed", signal: res.signal };
    } else if (res.exitCode !== 0) {
      status = "error"; error = { code: ERROR_CODES.NONZERO_EXIT, message: `exit ${res.exitCode}`, stderrTail: res.stderrTail, exitCode: res.exitCode ?? undefined };
    } else if (result === null) {
      status = "error"; error = { code: ERROR_CODES.NO_AGENT_END, message: "no agent_end", stderrTail: res.stderrTail };
    }

    deps.runs.complete(run.runId, {
      status, result: result ?? undefined, endedAt,
      progress, progressTruncated: false, usage, error,
    });

    // 更新 session
    if (deps.sessions.has(input.session)) {
      if (status === "completed") {
        deps.sessions.clearRunning(input.session, "idle", endedAt);
        deps.sessions.recordSuccess(input.session, result ?? "");
      } else {
        deps.sessions.clearRunning(input.session, "error", endedAt, error ? { code: error.code, message: error.message, runId: run.runId } : undefined);
      }
      // progress 追加到 session（截断 50）
      for (const p of progress) deps.sessions.appendProgress(input.session, p);
    }
    return { status, result: result ?? undefined, error };
  };

  if (mode === "async") {
    if (isCreate) {
      // 等握手完成或失败
      await Promise.race([asyncHandshake, collectPromise.then(() => null)]);
      if (sessionTimer) { clearTimeout(sessionTimer); sessionTimer = undefined; }
    }
    // 后台跑 finalize（不阻塞返回）
    finalize().catch(() => {});
    if (!sessionIdReceived && isCreate) {
      // 握手失败
      return { runId: run.runId, status: "error", error: { code: ERROR_CODES.SESSION_CREATE_FAILED, message: "no session event" } };
    }
    return { runId: run.runId, session: deps.sessions.has(input.session) ? deps.sessions.snapshot(input.session) : undefined, status: "running" };
  }

  // sync：阻塞到 finalize
  const fin = await finalize();
  return {
    runId: run.runId,
    session: deps.sessions.has(input.session) ? deps.sessions.snapshot(input.session) : undefined,
    status: fin.status,
    result: fin.result,
    progress,
    usage,
    error: fin.error,
  };
}
```

- [ ] **Step 2: 写 test/delegate.test.ts（用假 pi）**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/registry/session.js";
import { RunRegistry } from "../src/registry/run.js";
import { ProcessTable } from "../runner/process-table.js";
import { delegate } from "../src/tools/delegate.js";
import { fakePiEnv, tmpCwd, withEnv } from "./helpers.js";

function deps() {
  return { sessions: new SessionRegistry(), runs: new RunRegistry(), procs: new ProcessTable() };
}

test("async 新 session 成功（握手后返回 running）", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("success"), async () => {
    const d = deps();
    const r = await delegate({ prompt: "hi", session: "s1", cwd: c.dir, goal: "g", mode: "async" }, d);
    assert.equal(r.status, "running");
    assert.ok(r.runId);
    assert.ok(r.session);
    assert.equal(r.session?.name, "s1");
  });
  c.cleanup();
});

test("async 创建时 goal 缺失 → goal_required", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("success"), async () => {
    const d = deps();
    await assert.rejects(() => delegate({ prompt: "hi", session: "s1", cwd: c.dir, mode: "async" }, d), (e: any) => e.code === "goal_required");
  });
  c.cleanup();
});

test("async cwd 不存在 → cwd_invalid", async () => {
  await withEnv(fakePiEnv("success"), async () => {
    const d = deps();
    await assert.rejects(() => delegate({ prompt: "hi", session: "s1", cwd: "/no/such/dir", goal: "g", mode: "async" }, d), (e: any) => e.code === "cwd_invalid");
  });
});

test("no_session 模式 → session_create_failed + 无 SessionRecord", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("no_session"), async () => {
    const d = deps();
    const r = await delegate({ prompt: "hi", session: "s1", cwd: c.dir, goal: "g", mode: "async" }, d);
    assert.equal(r.status, "error");
    assert.equal(r.error?.code, "session_create_failed");
    assert.equal(d.sessions.has("s1"), false);  // 无记录
  });
  c.cleanup();
});

test("sync 续接已有 session 阻塞返回 completed", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("success"), async () => {
    const d = deps();
    // 先 async 建一个
    const r1 = await delegate({ prompt: "hi", session: "s1", cwd: c.dir, goal: "g", mode: "async" }, d);
    // 等 run 完成
    const done = await d.runs.waitForCompletion(r1.runId, 5000);
    assert.equal(done?.status, "completed");
    // sync 续接
    const r2 = await delegate({ prompt: "again", session: "s1", mode: "sync" }, d);
    assert.equal(r2.status, "completed");
    assert.ok(r2.result);
  });
  c.cleanup();
});

test("并发第 5 个 → resource_busy", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("hang"), async () => {
    const d = deps();
    // 4 个 hang 占满
    for (let i = 0; i < 4; i++) {
      await delegate({ prompt: "h", session: `s${i}`, cwd: c.dir, goal: "g", mode: "async" }, d);
    }
    // 第 5 个被拒
    await assert.rejects(() => delegate({ prompt: "h", session: "s5", cwd: c.dir, goal: "g", mode: "async" }, d), (e: any) => e.code === "resource_busy");
    d.procs.killAll();
  });
  c.cleanup();
});
```

- [ ] **Step 3: 跑确认通过**

Run: `npm test -- --test-name-pattern="delegate|async 新 session|sync 续接|resource_busy|no_session|goal 缺|cwd 不存在" 2>&1 | tail -20`
Expected: 6 passed。

注：测试可能因假 pi 路径问题失败，调整 helpers.ts 的 PI_BIN 用绝对路径。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: pi_delegate (sync/async + handshake + create/continue)"
```

---

## Task 14: pi_status（long-poll + run_expired）

**Files:**
- Create: `pi-subagent/src/tools/status.ts`
- Test: `pi-subagent/test/status.test.ts`

- [ ] **Step 1: 写 src/tools/status.ts**

```ts
import { RunRegistry } from "../registry/run.js";
import { Errors } from "../errors.js";

export interface StatusInput { runId: string; waitTimeoutMs?: number; }

export async function status(input: StatusInput, runs: RunRegistry) {
  // 立即返回（若已完成/不存在）
  const existing = runs.get(input.runId);
  if (existing && existing.status !== "running") {
    return { runId: input.runId, session: existing.session, status: existing.status, result: existing.result, progress: existing.progress, progressTruncated: existing.progressTruncated, usage: existing.usage, error: existing.error };
  }
  if (!existing && runs.isExpired(input.runId)) throw Errors.runExpired(input.runId);
  if (!existing) throw Errors.notFound(`run ${input.runId}`);

  // long-poll
  const run = await runs.waitForCompletion(input.runId, input.waitTimeoutMs ?? 0);
  if (!run) return { runId: input.runId, session: existing.session, status: "running" };
  return {
    runId: input.runId, session: run.session, status: run.status,
    result: run.result, progress: run.progress, progressTruncated: run.progressTruncated, usage: run.usage, error: run.error,
  };
}
```

- [ ] **Step 2: 写 test/status.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { RunRegistry } from "../src/registry/run.js";
import { status } from "../src/tools/status.js";

test("已完成 run 立即返回结果", async () => {
  const runs = new RunRegistry();
  const r = runs.create({ session: "a", startedAt: 1 });
  runs.complete(r.runId, { status: "completed", result: "ok", endedAt: 2 });
  const out = await status({ runId: r.runId }, runs);
  assert.equal(out.status, "completed");
  assert.equal(out.result, "ok");
});

test("不存在 runId → not_found", async () => {
  const runs = new RunRegistry();
  await assert.rejects(() => status({ runId: "nope" }, runs), (e: any) => e.code === "not_found");
});

test("expired runId → run_expired", async () => {
  const runs = new RunRegistry(1, 99999999);
  const r1 = runs.create({ session: "a", startedAt: 1 });
  runs.complete(r1.runId, { status: "completed", endedAt: 2 });
  const r2 = runs.create({ session: "a", startedAt: 3 });
  runs.complete(r2.runId, { status: "completed", endedAt: 4 });  // 淘汰 r1
  await assert.rejects(() => status({ runId: r1.runId }, runs), (e: any) => e.code === "run_expired");
});

test("long-poll running run → 完成时返回", async () => {
  const runs = new RunRegistry();
  const r = runs.create({ session: "a", startedAt: 1 });
  setTimeout(() => runs.complete(r.runId, { status: "completed", result: "done", endedAt: 2 }), 50);
  const out = await status({ runId: r.runId, waitTimeoutMs: 2000 }, runs);
  assert.equal(out.status, "completed");
});
```

- [ ] **Step 3: 跑确认通过**

Run: `npm test -- --test-name-pattern="status|已完成|不存在|expired|long-poll" 2>&1 | tail -10`
Expected: 4 passed。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: pi_status (long-poll + run_expired)"
```

---

## Task 15: pi_plan 工具 + pi_session_list/snapshot/fork + pi_kill

**Files:**
- Create: `pi-subagent/src/tools/plan-tool.ts`
- Create: `pi-subagent/src/tools/session.ts`
- Create: `pi-subagent/src/tools/kill.ts`
- Test: `pi-subagent/test/fork.test.ts`, `pi-subagent/test/kill.test.ts`

这些工具较薄（plan 调 scheduler，session 调 registry，kill 调 procs）。

- [ ] **Step 1: 写 src/tools/plan-tool.ts**

```ts
import { plan } from "../scheduler/plan.js";
import type { PlanInput, PlanOutput } from "../types.js";
import { SessionRegistry } from "../registry/session.js";

export function planTool(input: PlanInput, sessions: SessionRegistry): PlanOutput {
  // existingSessions 用全量（不传 cwd，R3#14）
  const all = sessions.list();
  return plan({ ...input, existingSessions: all });
}
```

- [ ] **Step 2: 写 src/tools/session.ts**

```ts
import { SessionRegistry } from "../registry/session.js";
import { ProcessTable } from "../runner/process-table.js";
import { spawnFork, collectOutput } from "../runner/spawn.js";
import { Errors } from "../errors.js";
import { classifyLine } from "../runner/parse.js";

const FORK_TIMEOUT_MS = 30000;

export function sessionList(sessions: SessionRegistry, cwd?: string) {
  return { sessions: cwd ? sessions.listByCwd(cwd) : sessions.list() };
}

export function sessionSnapshot(sessions: SessionRegistry, name: string) {
  if (!sessions.has(name)) throw Errors.notFound(`session ${name}`);
  return { session: sessions.snapshot(name) };
}

export async function sessionFork(input: { from: string; to: string }, deps: { sessions: SessionRegistry; procs: ProcessTable }) {
  const src = deps.sessions.get(input.from);
  if (!src) throw Errors.notFound(`session ${input.from}`);
  if (deps.sessions.has(input.to)) throw Errors.conflict(`session ${input.to}`);

  const child = spawnFork({ sourceSessionId: src.piSessionId, cwd: src.cwd });
  let newPiSessionId: string | undefined;

  // collectOutput 内置 runTimeoutMs（超时会 SIGTERM 进程）。fork 超时由它处理。
  const result = await collectOutput(child, {
    runTimeoutMs: FORK_TIMEOUT_MS,
    onLine: (line) => {
      const ev = classifyLine(line);
      if (ev?.type === "session" && ev.sessionId) newPiSessionId = ev.sessionId;
    },
  });

  // 若被超时 kill，signal 非空
  if (result.signal && !newPiSessionId) throw Errors.forkTimeout();
  if (!newPiSessionId) throw Errors.invalidArg("fork produced no session event", { stderrTail: result.stderrTail });

  deps.sessions.create({
    name: input.to,
    piSessionId: newPiSessionId,
    cwd: src.cwd,
    goal: `fork of ${src.name}: ${src.goal}`,
    constraints: src.constraints,
  });
  return { session: deps.sessions.snapshot(input.to) };
}
```

- [ ] **Step 3: 写 src/tools/kill.ts**

```ts
import { RunRegistry } from "../registry/run.js";
import { ProcessTable } from "../runner/process-table.js";
import { SessionRegistry } from "../registry/session.js";
import { Errors } from "../errors.js";

export function kill(input: { runId: string }, deps: { runs: RunRegistry; procs: ProcessTable; sessions: SessionRegistry }) {
  const run = deps.runs.get(input.runId);
  if (!run) throw Errors.notFound(`run ${input.runId}`);
  if (run.status !== "running") return { session: deps.sessions.has(run.session) ? deps.sessions.snapshot(run.session) : undefined, killed: false };
  deps.procs.kill(input.runId);
  // 进程退出后 process-table 的 onExit 钩子会触发 collectOutput resolve，delegate finalize 会标 killed
  return { session: deps.sessions.has(run.session) ? deps.sessions.snapshot(run.session) : undefined, killed: true };
}
```

- [ ] **Step 4: 写 test/fork.test.ts（用真 pi --fork 或假 pi 模拟）**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/registry/session.js";
import { ProcessTable } from "../runner/process-table.js";
import { sessionFork } from "../src/tools/session.js";

test("fork to 已存在 → conflict", async () => {
  const sessions = new SessionRegistry();
  sessions.create({ name: "src", piSessionId: "u1", cwd: "/p", goal: "g" });
  sessions.create({ name: "dst", piSessionId: "u2", cwd: "/p", goal: "g" });
  await assert.rejects(() => sessionFork({ from: "src", to: "dst" }, { sessions, procs: new ProcessTable() }), (e: any) => e.code === "conflict");
});

test("fork from 不存在 → not_found", async () => {
  const sessions = new SessionRegistry();
  await assert.rejects(() => sessionFork({ from: "nope", to: "dst" }, { sessions, procs: new ProcessTable() }), (e: any) => e.code === "not_found");
});
```
（真 fork 进程的 E2E 在 Task 18 集成测试覆盖。）

- [ ] **Step 5: 写 test/kill.test.ts**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { RunRegistry } from "../src/registry/run.js";
import { ProcessTable } from "../runner/process-table.js";
import { SessionRegistry } from "../src/registry/session.js";
import { kill } from "../src/tools/kill.js";

test("kill 不存在 runId → not_found", () => {
  assert.throws(() => kill({ runId: "nope" }, { runs: new RunRegistry(), procs: new ProcessTable(), sessions: new SessionRegistry() }), (e: any) => e.code === "not_found");
});

test("kill 已完成 run → killed=false 幂等", () => {
  const runs = new RunRegistry();
  const r = runs.create({ session: "a", startedAt: 1 });
  runs.complete(r.runId, { status: "completed", endedAt: 2 });
  const out = kill({ runId: r.runId }, { runs, procs: new ProcessTable(), sessions: new SessionRegistry() });
  assert.equal(out.killed, false);
});
```

- [ ] **Step 6: 跑确认通过**

Run: `npm test -- --test-name-pattern="plan-tool|session|fork|kill" 2>&1 | tail -15`
Expected: fork 2 + kill 2 = 4 passed。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: pi_plan/session-list/snapshot/fork/kill tools"
```

---

## Task 16: MCP server 入口 + 工具注册 + 退出清理

**Files:**
- Create: `pi-subagent/src/server.ts`

- [ ] **Step 1: 写 src/server.ts**

```ts
#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SessionRegistry } from "./registry/session.js";
import { RunRegistry } from "./registry/run.js";
import { ProcessTable } from "./runner/process-table.js";
import { loadRegistry, saveRegistry } from "./registry/persist.js";
import { delegate } from "./tools/delegate.js";
import { status } from "./tools/status.js";
import { planTool } from "./tools/plan-tool.js";
import { sessionList, sessionSnapshot, sessionFork } from "./tools/session.js";
import { kill } from "./tools/kill.js";
import { join } from "node:path";
import { homedir } from "node:os";

const REGISTRY_PATH = process.env.PI_SUBAGENT_REGISTRY ?? join(homedir(), ".pi-subagent", "registry.json");

const sessions = new SessionRegistry();
const runs = new RunRegistry();
const procs = new ProcessTable();

// 启动加载
const loaded = loadRegistry(REGISTRY_PATH);
sessions.loadAll(loaded.sessions);

// 持久化钩子：session 变更后落盘
function persist() {
  saveRegistry(REGISTRY_PATH, sessions.allPersistable()).catch(() => {});
}
// 包装：在每个改变 session 的操作后调 persist（简化：全工具调用后都存一次）

const server = new Server(
  { name: "pi-subagent", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "pi_delegate", description: "委派任务给 Pi 子代理", inputSchema: { type: "object", properties: {
      prompt: { type: "string" }, session: { type: "string" }, cwd: { type: "string" },
      goal: { type: "string" }, mode: { type: "string", enum: ["sync", "async"] },
      runTimeoutMs: { type: "number" }, allowUnknownTools: { type: "boolean" },
    }, required: ["prompt", "session"] } },
    { name: "pi_status", description: "取 run 结果（long-poll）", inputSchema: { type: "object", properties: {
      runId: { type: "string" }, waitTimeoutMs: { type: "number" },
    }, required: ["runId"] } },
    { name: "pi_plan", description: "调度决策", inputSchema: { type: "object", properties: {
      task: { type: "string" }, fanout: { type: "number" }, estComplexity: { type: "string", enum: ["low","medium","high"] },
      cwd: { type: "string" }, preferredMode: { type: "string", enum: ["sync","async"] },
    }, required: ["task", "cwd"] } },
    { name: "pi_session_list", description: "列 session", inputSchema: { type: "object", properties: { cwd: { type: "string" } } } },
    { name: "pi_session_snapshot", description: "取 session 详情", inputSchema: { type: "object", properties: { session: { type: "string" } }, required: ["session"] } },
    { name: "pi_session_fork", description: "派生 session", inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] } },
    { name: "pi_kill", description: "中止 run", inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"] } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments ?? {};
  try {
    let result: unknown;
    switch (req.params.name) {
      case "pi_delegate":
        result = await delegate(args as any, { sessions, runs, procs }); break;
      case "pi_status":
        result = await status(args as any, runs); break;
      case "pi_plan":
        result = planTool(args as any, sessions); break;
      case "pi_session_list":
        result = sessionList(sessions, (args as any).cwd); break;
      case "pi_session_snapshot":
        result = sessionSnapshot(sessions, (args as any).session); break;
      case "pi_session_fork":
        result = await sessionFork(args as any, { sessions, procs }); break;
      case "pi_kill":
        result = kill(args as any, { runs, procs, sessions }); break;
      default:
        return { content: [{ type: "text", text: JSON.stringify({ error: "unknown tool" }) }], isError: true };
    }
    persist();
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: JSON.stringify(e.code ? e : { error: String(e), code: "internal" }) }], isError: true };
  }
});

// 退出清理：kill 所有 managed child
function cleanup() { procs.killAll(); }
process.on("SIGINT", () => { cleanup(); process.exit(0); });
process.on("SIGTERM", () => { cleanup(); process.exit(0); });
process.on("exit", cleanup);

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2: 手动冒烟测试（真 pi）**

Run: `cd /home/guyii/code/pi-subagent && npx tsx src/server.ts &`
然后另开终端用 MCP inspector 或简单 stdin 测 list tools：
```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | npx tsx src/server.ts 2>/dev/null | head -1
```
Expected: 返回 7 个工具的 JSON。然后 kill 后台进程。

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: MCP server entry (7 tools + stdio + exit cleanup)"
```

---

## Task 17: 集成测试（假 pi 端到端）

**Files:**
- Create: `pi-subagent/test/integration.test.ts`

- [ ] **Step 1: 写 test/integration.test.ts（覆盖 spec §9.2 关键场景）**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/registry/session.js";
import { RunRegistry } from "../src/registry/run.js";
import { ProcessTable } from "../runner/process-table.js";
import { delegate } from "../src/tools/delegate.js";
import { status } from "../src/tools/status.js";
import { kill } from "../src/tools/kill.js";
import { fakePiEnv, tmpCwd, withEnv } from "./helpers.js";

function sys() {
  return { sessions: new SessionRegistry(), runs: new RunRegistry(), procs: new ProcessTable() };
}

test("async 成功全流程：delegate → status 收割 completed", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("success"), async () => {
    const d = sys();
    const r1 = await delegate({ prompt: "do", session: "s1", cwd: c.dir, goal: "g", mode: "async" }, d);
    const done = await status({ runId: r1.runId, waitTimeoutMs: 5000 }, d.runs);
    assert.equal(done?.status, "completed");
    assert.ok(done?.result);
    assert.ok(done?.progress?.length);
  });
  c.cleanup();
});

test("sync 超时：hang → kill → status timeout", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("hang"), async () => {
    const d = sys();
    const r1 = await delegate({ prompt: "do", session: "s1", cwd: c.dir, goal: "g", mode: "async", runTimeoutMs: 500 }, d);
    const done = await status({ runId: r1.runId, waitTimeoutMs: 3000 }, d.runs);
    assert.equal(done?.status, "timeout");
    d.procs.killAll();
  });
  c.cleanup();
});

test("kill 跨调用：delegate → kill → status killed", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("hang"), async () => {
    const d = sys();
    const r1 = await delegate({ prompt: "do", session: "s1", cwd: c.dir, goal: "g", mode: "async" }, d);
    const k = kill({ runId: r1.runId }, d);
    assert.equal(k.killed, true);
    const done = await status({ runId: r1.runId, waitTimeoutMs: 3000 }, d.runs);
    assert.equal(done?.status, "killed");
    d.procs.killAll();
  });
  c.cleanup();
});

test("session_create_failed：no_session → error + registry 无记录", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("no_session"), async () => {
    const d = sys();
    const r1 = await delegate({ prompt: "do", session: "s1", cwd: c.dir, goal: "g", mode: "async" }, d);
    assert.equal(r1.status, "error");
    assert.equal(r1.error?.code, "session_create_failed");
    assert.equal(d.sessions.has("s1"), false);
    // 但 run 仍在 registry，可 status 查
    const done = await status({ runId: r1.runId }, d.runs);
    assert.equal(done?.status, "error");
  });
  c.cleanup();
});

test("多等待者：两个 status 同时等同一 run 都拿到结果", async () => {
  const c = tmpCwd();
  await withEnv(fakePiEnv("success"), async () => {
    const d = sys();
    const r1 = await delegate({ prompt: "do", session: "s1", cwd: c.dir, goal: "g", mode: "async" }, d);
    const [a, b] = await Promise.all([
      status({ runId: r1.runId, waitTimeoutMs: 5000 }, d.runs),
      status({ runId: r1.runId, waitTimeoutMs: 5000 }, d.runs),
    ]);
    assert.equal(a?.status, "completed");
    assert.equal(b?.status, "completed");
  });
  c.cleanup();
});

test("progress 上限：假 pi 吐 >200 条（模拟）→ 截断 + truncated", async () => {
  // 注：fake-pi.sh 默认只吐 1 条 tool_execution_end。这个测试改用直接 RunRegistry 验证上限
  const runs = new RunRegistry();
  const r = runs.create({ session: "a", startedAt: 1 });
  for (let i = 0; i < 250; i++) runs.appendProgress(r.runId, { ts: i, summary: `p${i}` });
  runs.complete(r.runId, { status: "completed", endedAt: 2 });
  assert.equal(runs.get(r.runId)!.progress.length, 200);
  assert.equal(runs.get(r.runId)!.progressTruncated, true);
});
```

- [ ] **Step 2: 跑全部测试**

Run: `npm test 2>&1 | tail -25`
Expected: 全部 passed（含此前所有 task 的测试）。

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "test: integration (async/sync/timeout/kill/session_create_failed/multi-waiter/progress cap)"
```

---

## Task 18: Skill（SKILL.md + delegation-patterns）

**Files:**
- Create: `pi-subagent/skills/pi-subagent/SKILL.md`
- Create: `pi-subagent/skills/pi-subagent/references/delegation-patterns.md`
- 部署：软链到 `~/.agents/skills/pi-subagent` 和 `~/.pi/agent/skills/pi-subagent`

- [ ] **Step 1: 写 skills/pi-subagent/SKILL.md**

```markdown
---
name: pi-subagent
version: 1.0.0
description: "委派编程任务给 Pi 子代理执行。当需要把独立子任务交给另一个 agent（探索代码库、实现隔离功能、并行 fan-out、危险操作隔离执行）时使用。提供同步/异步委派与 session 生命周期管理。"
metadata:
  requires:
    mcps: ["pi-subagent"]
---

# pi-subagent (v1)

委派编程任务给 Pi 子代理。子代理在你指定的 cwd 里独立工作，进程隔离，结果可收割。

## 标准流程

拿到任务后：
1. 调 `pi_session_list` **不传 cwd，取全量 existingSessions**（全局 runningCount 才能正确反映并发；pi_plan 内部用全量算并发、用 input.cwd 做复用过滤）。
2. 调 `pi_plan` 获取执行计划（shouldDelegate / mode / sessions）。
3. `shouldDelegate=false` → 自己做；否则严格按计划的 mode 和 sessions 调 `pi_delegate`，不要自行改 mode。
4. async：发起后用短 `pi_status(waitTimeoutMs:30000)` 反复收割，直到 status 为 completed/error/timeout/killed；综合 result 决策。

## 反模式（禁止）

- ❌ 模糊任务甩锅（"看看这项目"）— 子代理会迷失。要么自己先明确任务边界，要么不委派。
- ❌ 高频人工判断的精修任务委派 — 往返成本高。
- ❌ 委派后不读结果 — 必须读 result 并据此决策。
- ❌ 使用 allowUnknownTools — 该参数仅手工低层逃生，策略层禁用。

## prompt 自包含原则

委派的 prompt 必须自包含（子代理看不到我们的对话上下文）：
- **目标**：要完成什么（一句话可验证的成功标准）
- **上下文**：相关文件路径、已知约束
- **边界**：不要碰什么
- **交付要求**：返回什么（结论格式 / 改了哪些文件 / 测试是否过）

详细委派模式见 `references/delegation-patterns.md`。

## 工具速查

| 工具 | 用途 |
|------|------|
| pi_plan | 决策：该不该委派、sync/async、开几个 session |
| pi_delegate | 派任务（默认 async） |
| pi_status | 收割 run 结果（long-poll） |
| pi_session_list | 列 session |
| pi_session_snapshot | 看 session 详情 |
| pi_session_fork | 从已有 session 派生（试另一条路） |
| pi_kill | 中止 run |
```

- [ ] **Step 2: 写 references/delegation-patterns.md**

```markdown
# 委派模式参考

这些规则已在 `pi_plan` 中实现，此处仅供理解。

## 模式 1：探索 fan-out

任务如"调研 A/B/C 三个方案的优劣"。
- `pi_plan({ task: "...", fanout: 3, cwd })` → 返回 3 个 SessionSpec，mode=async。
- 为每个 spec 填自包含 prompt，依次 `pi_delegate(mode:async)`。
- 注意并发上限 4：fanout>4 会被截断分批。
- 逐个 `pi_status` 收割，综合各 result 做决策。

## 模式 2：分而治之实现

把大任务拆成独立子任务（如前端/后端/测试各一）。
- 每个子任务一个 session，async 并行。
- 子任务间有依赖时，按依赖顺序串行 delegate（前一个 completed 再发下一个）。

## 模式 3：危险操作隔离

任务含删除/重置等危险操作。
- `pi_plan` 自动检测危险词，收紧 constraints（excludeTools:["bash"]）。
- 不要手动放宽。子代理用受限工具集执行，降低误伤。

## 模式 4：长任务后台跑

不确定时长的任务。
- async delegate 立即返回 runId。
- 用 `pi_status(waitTimeoutMs:30000)` 反复收割（每次最多等 30s，避免撞 host tool-call 超时）。
- 期间可继续做别的，run 在后台跑。

## sync vs async 怎么选

- 单个、预计 < 几分钟、要立刻拿结果 → `pi_plan({ preferredMode: "sync" })`。
- 并行 fan-out / 不确定时长 / 不想阻塞 → async（默认）。
```

- [ ] **Step 3: 部署软链**

```bash
ln -s /home/guyii/code/pi-subagent/skills/pi-subagent ~/.agents/skills/pi-subagent
ln -s /home/guyii/code/pi-subagent/skills/pi-subagent ~/.pi/agent/skills/pi-subagent
ls -la ~/.agents/skills/pi-subagent ~/.pi/agent/skills/pi-subagent
```
Expected: 两个软链都指向项目 skill 目录。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: pi-subagent skill (SKILL.md + delegation patterns) + symlinks"
```

---

## Task 19: README + 收尾

**Files:**
- Create: `pi-subagent/README.md`

- [ ] **Step 1: 写 README.md**

包含：是什么、安装、配置 MCP host（ZCode/Claude Code 等）、工具列表、session 模型、测试命令。

- [ ] **Step 2: 全量测试最终确认**

Run: `cd /home/guyii/code/pi-subagent && npm test 2>&1 | tail -30`
Expected: 全绿。

- [ ] **Step 3: 最终 Commit**

```bash
git add -A
git commit -m "docs: README + finalize"
```
