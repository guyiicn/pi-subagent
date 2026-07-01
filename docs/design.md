# Pi 子代理编排层设计 (pi-subagent)

- **状态**: 设计已与用户确认，待实现
- **日期**: 2026-07-01
- **作者**: ZCode 协同设计
- **参考**: [OpenAI cs-agents-demo 架构分析](../../../code/pi-subagent-design/02-openai-demo-analysis.md)

## 1. 目标与范围

把 **Pi**（`@earendil-works/pi-coding-agent@0.77.0`，已安装于本机 `/home/guyii/.npm-global/bin/pi`）当做一个**可被调用的编程子代理**，由任意 MCP host（ZCode / Claude Code / Pi 自身 / Cursor 等）委派任务、追踪会话、中止进程。

### 交付形态: 双层

- **能力层 (MCP server)** — `pi-subagent` server (Node/TS)。7 个 MCP 工具，封装 `pi -p --mode json` 的编排能力。任何标准 MCP 客户端可加载。
- **策略层 (Skill)** — `pi-subagent` skill (`~/.agents/skills/pi-subagent/SKILL.md`)。教 host 何时/如何委派。

### 需求约束

| 维度 | 决定 |
|------|------|
| 方向 | 编排（Pi 当子代理），非"教 Pi 方法论" |
| 形态 | MCP server + Skill 双层 |
| 会话语义 | 全 session 化 — 每个任务绑定具名 session |
| 目标 host | 通用 MCP 客户端 |
| 工作目录 | 任务级指定 cwd |
| 同步/异步 | 都支持 (sync + async + long-poll)，默认 async (评审 #2) |
| 并发上限 | 4 个 running run |
| 进程退出策略 | server 退出时 kill 所有 running run |

## 2. 实测事实 (支撑设计)

来自对 `pi -p` 的实地探测:

1. `pi -p "..."` 非交互执行后退出 (headless 可用)。
2. `--mode json` 输出 **NDJSON 事件流**，每行一个 `{"type":...}`。关键事件:
   - `session`: 含 `id` (UUID)、`cwd`、`version`
   - `turn_start` / `turn_end`
   - `message_end`: 含完整 assistant 消息
   - `tool_execution_end`: 含工具结果 (用作进度)
   - `agent_end`: 含完整 `messages` 数组 + token 用量 + stopReason
3. 输出体量极大 (一次 echo ~50KB，绝大多数是流式 delta 噪声) → 逐行读，保留 `agent_end` (结果) 与 `tool_execution_end` (进度)，丢弃 delta。
4. **子进程工作目录与 session 存储是两个独立维度** (评审 #4 实测确认):
   - 子进程工作目录 (pi 在哪跑命令/读写文件) 由 `child_process.spawn(cmd, args, { cwd })` 控制。
   - pi session 文件存储目录由 `--session-dir <dir>` 控制，**与工作目录无关**。
   - 实测: 只设 spawn cwd 不传 `--session-dir`，session 默认落在 `~/.pi/agent/sessions/--<cwd 路径 / 换 ->>--/`，按 cwd 自动分子目录，**不污染项目**。
   - 实测: 传 `--session-dir <X>`，session 落在 X 下，但 pi 的命令仍在 spawn cwd 执行。
   - **本设计的决定**: 不传 `--session-dir`，用 pi 默认存储 (`~/.pi/agent/sessions/`)。子代理工作目录靠 spawn cwd 控制。**取消早期设计里"cwd = session-dir"的错误表述**。
5. 会话复用: `--session-id <UUID>` 续接、`--continue` 续上一会话、`--fork <id>` 派生。
6. 权限收紧: `--tools <a,b>` / `--exclude-tools <c>`。
7. 可控项: `--thinking <level>`、`--append-system-prompt`、`--model`、`--provider`。

## 3. 架构

```
┌─────────────────────────────────────────────────────────────┐
│  MCP Host (ZCode / Claude Code / Pi 自身 / Cursor …)         │
│  通过 stdio 加载 MCP server                                  │
└───────────────────────────┬─────────────────────────────────┘
                            │ MCP protocol (JSON-RPC over stdio)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│  pi-subagent-server  (Node/TS MCP server, 核心)              │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐    │
│  │ Tool layer   │  │ Session      │  │ Pi runner       │    │
│  │ (7 tools)    │─▶│ registry     │─▶│ (spawn pi -p)   │    │
│  │ + plan()     │  │ name↔Record  │  │ --mode json     │    │
│  └──────┬───────┘  │ + _snapshot  │  │ 解析 agent_end  │    │
│         │          └──────────────┘  │ + tool_exec_end │    │
│         │                  ▲         └────────┬────────┘    │
│         │                  │                  ▼             │
│         │          ┌──────────────┐  ┌─────────────────┐    │
│         └──────────│ Run registry │◀─│ Process table   │    │
│           (kill)   │ runId↔Run    │  │ child+AbortCtrl │    │
│                    └──────────────┘  └─────────────────┘    │
└─────────────────────────────────────────────────────────────┘
                            │ child_process.spawn
                            ▼
                   ┌─────────────────────┐
                   │  pi CLI (0.77.0)    │  ← 已装，不改它
                   │  -p --mode json     │
                   │  --session-id <id>  │
                   │  spawn({cwd}) 控工作目录│
                   │  (不传 --session-dir)│
                   └─────────────────────┘
```

### 核心设计决策

1. **进程隔离**: 每个 `pi_delegate` = 一次 `pi -p` 子进程。Pi 崩溃只影响该次调用。
2. **三层职责分离**: Tool layer (MCP schema + plan 决策) / Session registry (状态) / Pi runner + Run registry + Process table (进程编排)。
3. **工作目录 = spawn cwd**: 子代理在目标项目干活 (spawn cwd)；session 存储用 pi 默认目录 (`~/.pi/agent/sessions/`)，不传 `--session-dir`，不污染项目 (评审 #4 实测确认)。
4. **session 注册表是新增层**: 维护 `name ↔ SessionRecord` 人类可读映射，支撑全 session 化。
5. **只解析 agent_end + tool_execution_end**，丢弃 delta 噪声。
6. **统一状态出口 `_snapshot()`**: list/history 共用，避免序列化逻辑重复 (学 demo 的 snapshot())。
7. **保留进度事件** (学 demo ProgressUpdate): tool_execution_end 作为进度轨迹透传。
8. **决策逻辑下沉为纯函数 `plan()`**: 调度策略可测，非散文 (见 §6)。

### 从 OpenAI cs-agents-demo 迁移的模式

| demo 模式 | 是否迁移 | 我们如何用 |
|-----------|---------|-----------|
| ConversationState 结构化上下文 + public_context 脱敏 | ✅ | SessionRecord + _snapshot 脱敏视图 |
| snapshot() 统一状态出口 | ✅ | _snapshot() 供 list/history |
| ProgressUpdateEvent 进度流 | ✅ | tool_execution_end 透传为 progress[] |
| handoff 拓扑 (单进程多 agent) | ❌ 概念 | 进程级隔离; 入口分流下沉到 plan()/Skill |
| guardrails 前置校验 | ✅ 形式 | 内容审查换为参数/cwd 校验 |
| Store 抽象 / SSE 多订阅 | ❌ | YAGNI; pi 自持久化; MCP 是请求-响应 |
| _broadcast_delta vs state (临时 vs 持久) | ✅ 思想 | delegate 返回分 progress[] (临时) 与 result (持久) |

## 4. 数据结构

### SessionRecord (注册表每条记录)

```ts
interface SessionRecord {
  name: string;              // 人类可读名，唯一键
  piSessionId: string;       // pi 的 UUID (首次 delegate 生成并记下)
  cwd: string;               // 子代理工作目录 (绝对路径)
  goal: string;              // 该 session 目标 (创建时 host 显式传，必填)
  status: "idle"|"running"|"error";  // R2#4: 简洁活跃态; timeout/killed 都映射为 error，细节见 lastError
  constraints?: Constraints; // 创建时填，之后不可改
  lastSummary?: string;      // 最近一次**成功**的 assistant 回复摘要 (R2#9: 失败不覆盖)
  lastError?: {              // R2#4: 最近一次失败的真实原因
    code: string;            // "timeout"|"killed"|"no_agent_end"|"nonzero_exit"|"signal"|"interrupted_by_restart"|...
    message: string;
    runId?: string;
    ts: number;
  };
  progress: ProgressEvent[]; // 进度轨迹，最近 50 条 FIFO
  lastActive: number;        // unix ms
  msgCount: number;          // 已 delegate 次数
  runId?: string;            // 内存态: 若 status==running，对应当前 run
}
```

### ProgressEvent

```ts
interface ProgressEvent {
  ts: number;
  tool?: string;             // "bash"|"edit"|"write"|...
  summary: string;           // 工具结果摘要 (前 200 字符，经 redaction)
}
```

**progress redaction** (评审次要风险 + R3#6 + R3#13): progress 来自 `tool_execution_end` 的工具结果，可能含 token/key/环境变量/敏感路径。入库前过简单 redaction (best-effort):
- 截断到 200 字符
- **JS 可实现正则** (R3#6: 不要用 `(?i)`，JS RegExp 不支持 inline flag):
  - 似 token: `/[A-Za-z0-9_\-]{20,}/g` → `***`
  - 敏感 key/value (R3#13: 按 key 命中敏感词替换，不承诺识别整份 .env 文件):
    `/(password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization|credential)s?\s*[:=]\s*\S+/gi` → `***`
  - 环境变量赋值行: `/^[A-Z0-9_]{2,}\s*=\s*\S+$/gm` 当 key 含上述敏感词时替换 (逐行匹配)
- redaction 是 best-effort (不可能穷举)，但挡住最常见的明文泄露
- 测试: `_snapshot()` 不暴露 `piSessionId`；喂含假 token / `API_KEY=xxx` / `password=abc` 的 progress 进 redaction，断言输出含 `***` 不含原值

**lastSummary 生成规则 (R2#9)**:
- **成功** (run.status=="completed"): `lastSummary = truncate(最终assistant文本, 500)`。最终文本取自 `agent_end.messages` 最后一条 role==assistant 的 text content。
- **失败** (error/timeout/killed): **不覆盖** lastSummary，改写 `lastError`。这样 lastSummary 始终反映"最近一次成功"，不被失败污染。
- **不引入额外模型总结**: 避免成本与不确定性。截断即可，host 需要细节去读 `pi_session_snapshot` 的 progress。
- 测试: delegate 成功后 lastSummary 更新；失败后 lastSummary 不变但 lastError 更新。

**msgCount / lastActive 更新规则 (R3#9)**:
- 前置校验失败: 不创建/不更新 session，msgCount 不变，lastActive 不变。
- spawn 成功并收到 `session` 事件后: `msgCount += 1`，`lastActive = startedAt`。
- run 完成/失败/kill/timeout: `lastActive = endedAt`。
- fork 新 session: `msgCount = 0`，`lastActive = createdAt`。
- 这样 `pi_session_list` 按 lastActive 排序和 msgCount 统计都可测。

### Run (Run registry 每条)

```ts
interface Run {
  runId: string;             // server 生成，唯一
  session: string;           // 所属 session 名
  status: "running"|"completed"|"error"|"killed"|"timeout";
  result?: string;           // 完成后的 assistant 最终文本
  progress: ProgressEvent[]; // 本次 run 进度轨迹
  usage?: Usage;
  error?: RunError;          // R3#3: 本次 run 的详细失败信息 (status!=completed 时)
  progressTruncated?: boolean; // R3#5: progress 超 200 条被截断时为 true
  startedAt: number;
  endedAt?: number;
  // 内部 (不外泄): child process 句柄 + AbortController + 等待者队列 (R3#12)
}

interface RunError {         // R3#3: run 级失败详情 (区别于 session.lastError 摘要)
  code: string;              // "no_agent_end"|"nonzero_exit"|"signal"|"timeout"|"killed"|"session_create_failed"|"session_start_timeout"|...
  message: string;
  stderrTail?: string;       // stderr 末 ~2KB
  signal?: string;           // 如 "SIGSEGV"
  exitCode?: number;
}

interface Usage {            // pi cost 输出不稳定，全部可选
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cost?: number;
}

// progress 上限 (R3#5): Run.progress 最近 200 条 FIFO；session.progress 最近 50 条 FIFO。
// 单条 summary 已截断 200 字符。截断时置 progressTruncated=true。
```

### _snapshot() 脱敏视图 (学 public_context)

```ts
function _snapshot(r: SessionRecord): Snapshot {
  // 不暴露 piSessionId 等内部字段
  return { name, cwd, goal, status, constraints,
           lastSummary, lastError, progress, lastActive, msgCount, runId };
}
```

### Session registry 持久化契约 (评审 #3 新增)

Pi 自己持久化的是 UUID jsonl，**不是** `name → piSessionId/cwd/goal/constraints` 的人类可读映射。若 server 重启后 registry 丢失，"全 session 化"和具名 session 续接都会废掉。故 registry 必须自己持久化。

```ts
// 持久化文件
路径: ~/.pi-subagent/registry.json
schema: {
  version: 1,                    // schema version，未来迁移用
  sessions: PersistedSessionRecord[]
}

// R2#5 + R3#1 + R4#4: 显式持久化类型
type PersistedSessionRecord = Omit<SessionRecord, "runId">;
// runId 不落盘 (内存态)；status 保留真实值含 running (加载时修正)
```

**类型边界 (R2#5 + R3#1)**:
- 内存态 `SessionRecord`: 可有 `runId?`。
- 落盘态 `PersistedSessionRecord`: **不含** `runId`；status 保留真实值 (含 running)。
- **R3#1 关键修正**: 不在写盘时把 running 伪造成 error (正常运行期 persist 会产生误导中间态)。改为**加载时**才判定 interrupted。

**加载时单条记录校验 (R4#4)**: 整文件 parse 失败 → 整文件 corrupt (备份+空启动)。若文件 parse 成功但**单条记录**缺字段或 status 非法，按记录级处理 (不整文件丢弃):
- 缺 `progress` → 补 `[]`。
- 缺 `msgCount` → 补 `0`。
- 缺 `lastActive` → 补文件 mtime。
- `status` 非 `idle|running|error` → 该记录标 corrupt，跳过 (记日志)，不阻断其他记录加载。
- 缺 `name`/`piSessionId`/`cwd`/`goal` (核心字段) → 该记录 corrupt，跳过。

**目录与写入策略** (R2#10 补全):
1. 首次写前 `fs.mkdir(~/.pi-subagent/, { recursive: true })` (目录可能不存在)。
2. 写到临时文件 `registry.json.tmp`。
3. `fs.rename` 原子替换 (POSIX 原子 rename)。
4. **写入串行化**: persist 走一个 promise queue，保证按变更顺序落盘。多个 async run 近乎同时完成时，不会因各自基于旧快照并发写而互相覆盖 (R2#10 核心风险)。所有 registry 变更先作用于单线程内存对象，再排队落盘。
5. 触发时机: session 创建/fork/状态变更/delegate 完成/kill 完成——任何改变 SessionRecord 的操作后入队一次写。

**启动加载策略**:
1. 读 `registry.json`; 不存在 → 空注册表 (首次运行)。
2. JSON.parse 失败 → 备份为 `registry.json.corrupt-<ts>`，空注册表启动，记日志 (不崩溃)。
3. `version` 不匹配 → 预留迁移钩子 (v1 阶段直接加载; 未来加 `migrate(oldJson) → newJson`)。
4. **R3#1**: 加载后，任何 `status==="running"` 的记录修正为 `status="error"` + `lastError={code:"interrupted_by_restart", message:"server 重启时仍在运行", ts:now}`、清 `runId`。(落盘时保留 running 真值；只在重启加载这一刻判定 interrupted，避免正常运行期 persist 写出误导中间态。)

**不做的** (YAGNI):
- 不扫 `~/.pi/agent/sessions/` 重建 registry (pi jsonl 没有 name/goal 信息，重建不出人类可读映射)。
- 不持久化 Run registry (run 是瞬时态，重启后历史 run 无意义；pi jsonl 已存对话内容)。

**Run registry 是纯内存**:
- server 重启 → 所有未完成 run 视为终止 (对应 session 在加载阶段已置 error)。
- 这与 §7.3"server 退出时 kill 所有 running run"一致: 进程被杀 + registry 标 error，状态自洽。

**完成 Run 的保留策略 (R3#4)**: Run registry 纯内存，不定义保留会无限增长。
- running run: 永远保留。
- completed/error/killed/timeout run: 保留最近 `maxCompletedRuns=128` 条 **且** TTL `completedRunTtlMs=24h`，超出淘汰。
- 淘汰后 `pi_status(runId)` → `run_expired` (R3#4 新增稳定码，区别于 not_found 的"从未存在")。
- 淘汰在每次新 run 创建时懒清理 (不必每次写盘触发)。

## 5. 工具集 (7 个 MCP 工具)

### 5.1 `pi_delegate` — 派任务 (核心)

全 session 化: 首次调用建 session 并记 goal，后续自动续接。

```ts
input: {
  prompt: string;            // 必填，自包含任务指令
  session: string;           // 必填，具名 session (不存在则创建)
  cwd: string;               // 创建时必填; 已存在则校验一致
  goal: string;              // 创建时必填 (显式传); 已存在则忽略
  constraints?: Constraints; // 创建时填，不可改 (类型见 §5.3)
  mode?: "sync"|"async";     // 默认 async (评审 #2: 规避 host tool-call 超时)
  runTimeoutMs?: number;     // R3#2: run 自身超时，默认 600000
  allowUnknownTools?: boolean; // R3#7+R4#5: 默认 false；true 跳过未知工具校验 (仅手工低层逃生，plan/Skill 不用)
}
// async 返回 (默认):
//   - 续接已有 session: spawn 后立即返回
//   - 创建新 session: 等到收到 Pi 的 `session` 事件 (拿到 piSessionId) 后返回 (R4#2 握手)
output: { runId, session?: Snapshot, status: "running" | "error", error?: RunError }
// sync 返回 (显式 mode:sync 时，阻塞到完成/超时):
output: { runId, result?, progress, progressTruncated?, session?: Snapshot, status, usage?, error? }
```

**async 返回点 (R4#2 — 解决"立即返回"与"等 session 事件"的冲突)**:
- **续接已有 session**: SessionRecord 已在 registry，spawn 后**立即**返回 runId + snapshot(running)。
- **创建新 session**: SessionRecord 要等 `session` 事件才能拿到 piSessionId。故 async **不是无条件立即返回**，而是"完成握手后返回"——等到 `session` 事件 (创建 SessionRecord) 或启动失败。
  - 收到 `session` 事件 → 创建 SessionRecord → 返回 `{runId, session:Snapshot, status:"running"}`。
  - 进程在 `session` 事件前退出 → 返回 `{runId, status:"error", error:{code:"session_create_failed"}}`，**不返回 session snapshot** (故 output.session 为 optional)，**不创建 SessionRecord**。
  - `sessionStartTimeoutMs=10000` 内无 `session` 事件也无退出 → 标 run error + `session_start_timeout` + kill 进程，返回 error。避免 tool call 卡死。
- 握手超时很短 (10s)，远小于 host tool-call 超时，不会撞 host 超时。握手后的真正执行靠 `pi_status` 异步收割。

**默认 async 的理由 (评审 #2)**: 多数 MCP host 对单次 tool call 有 30-60s 超时。async 握手 ~10s 内返回 runId，真正执行靠 `pi_status(waitTimeoutMs)` 短轮询收割，规避冲突。

**sync 取消/中断的生命周期 (评审 #2 + R2#6)**:

MCP stdio 与 HTTP/SSE 不同，需分两层:

- **层 A — per-request 取消 (依赖 SDK 能力)**: 若所用 MCP SDK 为该 tool call 提供 per-request abort/cancel signal，则 sync 请求被取消时 → kill 对应 run (SIGTERM→grace→SIGKILL)，run 置 `killed`。该 run **不能**再通过 `pi_status` 收割 (要"取消后续跑"请用 async)。
- **层 B — 进程级退出 (必有)**: stdin 关闭 / 收到 SIGTERM/SIGINT / server 退出 → 走 §7.3 全局清理，kill **所有** running run。

**实现承诺的边界 (R2#6)**: spec **只在层 B 做硬承诺** (进程退出必清理，这是确定能实现的)。层 A 视所用 MCP SDK 而定——若 SDK 不提供 per-request abort，则**不承诺**单请求取消语义，sync 取消时该 run 会继续跑到完成/超时 (但 host 已断开，结果丢失)。实现时探测 SDK 能力:
- 支持 per-request abort → 实现层 A。
- 不支持 → 文档注明"sync 取消不保证立即停止；要可中断请用 async + pi_kill"。

### 5.2 `pi_status` — 取 Run 结果 (async 收割口)

```ts
input: { runId: string; waitTimeoutMs?: number }  // R3#2: 拆名，区别于 runTimeoutMs
output: { runId, session, status, result?, progress, progressTruncated?, usage?, error? }
// 不给 waitTimeoutMs → 立即返回当前状态 (纯轮询)
// 给 waitTimeoutMs → long-poll: 最多阻塞这么久，run 完成立即返回完整结果
```
**R3#2 命名区分**: `runTimeoutMs` (delegate，run 自身超时，默认 10min) vs `waitTimeoutMs` (status，long-poll 等待，建议短如 30s 反复收割)。Skill 指引: async 后用短 `pi_status(waitTimeoutMs:30000)` 反复收割，避免单次 tool call 撞 host 超时。

**多等待者语义 (R3#12)**: 同一 runId 可被多个 `pi_status` 同时 long-poll。
- 允许多个等待者；run 完成时全部唤醒、返回同一结果 (实现用 per-run promise/EventEmitter)。
- 等待者只读，不能修改 run 状态。
- `pi_kill` 与 long-poll 并发时: kill 完成后，所有等待者收到 status=killed + error。
- 测试: 两个 status 同时等待同一 run，完成时都拿到完整结果。

### 5.3 `pi_plan` — 调度决策 (纯函数，不 spawn)

```ts
input: {
  task: string;
  fanout?: number;           // 预计并行子任务数，默认 1
  estComplexity?: "low"|"medium"|"high";
  cwd: string;
  existingSessions: Snapshot[];  // host 先调 pi_session_list 填入 (不传 cwd，拿全量；见 R2#3)
  preferredMode?: "sync"|"async"; // 默认 async; fanout==1 时可请求 sync (见 §6 阶段5)
}
output: {
  shouldDelegate: boolean;
  reason: string;
  plan?: { mode: "sync"|"async"; sessions: SessionSpec[] };
}
interface SessionSpec {
  action: "create"|"continue";
  name: string;
  goal: string;
  cwd: string;
  constraints?: Constraints;
  prompt: string;            // 自包含 prompt 模板 (host 可微调)
  runTimeoutMs?: number;     // R3#2: run 自身超时 (映射到 pi_delegate.runTimeoutMs)
}
interface Constraints {      // R2#7: 显式建模白名单/黑名单
  tools?: string[];          // → pi --tools，显式白名单
  excludeTools?: string[];   // → pi --exclude-tools，显式黑名单
  thinking?: "off"|"minimal"|"low"|"medium"|"high"|"xhigh";
  model?: string;
}
```

**Pi 工具名枚举** (R2#7 + R3#7，constraints.tools/excludeTools 校验基准):
- 内置工具名: `read`、`bash`、`edit`、`write` (可校验)
- 已发现的扩展工具名: 启动时探测已装 extension/skill 注册的工具 (可校验)
- 未知工具名: **默认硬 reject** → `unknown_tool` (R3#7: 沙箱场景下拼错工具名会导致策略失效，不能 silently 允许)
- 逃生参数: `pi_delegate` input 增 `allowUnknownTools?: boolean` (默认 false)；true 时跳过未知工具校验 (R4#6: 不返回 warning，直接放行)。
- **R4#5 策略层保守**: `pi_plan` **不生成**未知工具名 (只用内置+已发现扩展名)；`SessionSpec` 不含 `allowUnknownTools`；Skill 禁止使用该参数。`allowUnknownTools` 仅作为手工调 `pi_delegate` 的低层逃生口。

### 5.4 `pi_session_list` — 列 session

```ts
input: { cwd?: string }      // 可选，按工作目录过滤
output: { sessions: Snapshot[] }  // 按 lastActive 倒序
```

### 5.5 `pi_session_snapshot` — 取 session 详情 (评审 #5 重命名)

```ts
input: { session: string }
output: { session: Snapshot }  // 脱敏快照 (非原始 jsonl)
```

重命名理由: 原名 `pi_session_history` 带 `limit` 参数暗示"取最近 N 条对话"，但 Snapshot 只含 `lastSummary/progress/msgCount`，无对话历史。命名诚实化，去掉无语义的 `limit`。若未来要读原始 jsonl 返回最近 N 条消息，再新增独立工具。

### 5.6 `pi_session_fork` — 派生 session

```ts
input: { from: string; to: string }
output: { session: Snapshot }  // 新 session 快照
```

**输出契约 (R2#8 明确)**: fork 产生的新 SessionRecord:
- `piSessionId`: 新 UUID (调 `pi --fork <源 piSessionId>` 从返回的 `session` 事件拿)
- `cwd`: = 源 session.cwd (**继承**)
- `constraints`: = 源 session.constraints (**继承**)
- `goal`: `fork of ${源name}: ${源goal}`
- `progress`: `[]` (**清空**，新 session 不背历史进度)
- `msgCount`: `0` (从 0 开始)
- `lastSummary`: `undefined` (**清空**)
- `lastError`: `undefined`
- `status`: `"idle"` (fork 后未运行，待首次 delegate)
- 实现 (R3#11 实测确认): `spawn(pi, ["--mode","json","--fork",源piSessionId], {cwd: 源.cwd})`。
  - **不需 `-p`、不需 prompt**——实测 fork 只产生 `session` 事件 (带新 UUID + parentSession 指向源) 就退出，**不跑 agent 轮**。
  - 因此 msgCount=0、lastSummary=undefined 契约**成立** (无 agent 输出可记)。
  - **必须 `spawn({cwd: 源.cwd})`**: 实测新 session 的 cwd 来自 spawn cwd (跑在 /tmp 则落 --tmp-- 目录)。要让新 session 归到源项目下，spawn cwd 必须等于源.cwd。

**错误**:
- `from` 不存在 → `not_found`
- `to` 已存在 → `conflict` (R2#8 新增稳定码，不复用 invalid_arg)

**进程语义 (R4#7)**: fork 是短生命周期管理操作，与 delegate 的 Run 不同:
- fork **不创建 Run**、**不占 delegate 并发槽** (4 上限只管 delegate run)。
- 但 fork 子进程仍进 process table 的 "managed child" 集合——**server 退出时要 kill** (与 delegate run 同样的清理)。
- fork 自带短超时 `forkTimeoutMs=30000`；超时 → kill 进程 + 返回 `fork_timeout` 错误。
- fork 失败返回普通 tool error (不通过 `pi_status` 收割，因为无 Run)。
- 不要把 fork 放进 Run registry，否则 `pi_status`/`pi_kill` 语义复杂化。

### 5.7 `pi_kill` — 中止进程

```ts
input: { runId: string }
output: { session: Snapshot; killed: boolean }
// 已结束 → killed=false 幂等; running → SIGTERM→5s grace→SIGKILL，run.status=killed、session.status=error
```

### 工具矩阵

| # | 工具 | sync | async |
|---|------|------|-------|
| 1 | pi_delegate | ✓ 阻塞返回 | ✓ 立即返回 runId |
| 2 | pi_status | — | ✓ 轮询/long-poll |
| 3 | pi_plan | ✓ | ✓ |
| 4 | pi_session_list | ✓ | ✓ |
| 5 | pi_session_snapshot | ✓ | ✓ |
| 6 | pi_session_fork | ✓ | ✓ |
| 7 | pi_kill | ✓ | ✓ |

### 状态机约束

- 同一 session 不并发: session 有 running run 时，再 delegate (任何模式) → 报错 `session_busy` 且带 runId。
- session.status 跟随其 run: idle ↔ running; run 完成回 idle，run 失败 (error/timeout/killed) 回 error 并写 lastError (R2#4)。
- goal 创建时必填 (未传且 session 不存在 → 拒绝)。
- constraints 创建后不可改 (换配置就 fork)。
- 并发上限 4 个 running run。

## 6. 调度策略 (plan() 纯函数)

**多阶段决策模型 (评审 #1 修订)**: 原 first-match R1→R10 模型有缺陷——委派决策规则排在容量/修饰规则前，导致"反复调的复杂任务"先命中委派规则，反信号词和危险操作收紧永远不生效。改为**五个阶段顺序执行，每阶段职责单一，修饰规则叠加而非互斥**:

```
阶段1 否决   → 反信号词触发，shouldDelegate=false，terminal
阶段2 容量   → 全局 runningCount 算可用槽；slots<=0 则否决 terminal；否则截断 fanout、标记 busy
阶段3 复用   → cwd 过滤后，决定 create 还是 continue
阶段4 修饰   → 危险词收紧 (excludeTools/bash)、高复杂度提 thinking/timeout (叠加)
阶段5 mode   → fanout>1 或委托信号词→async；preferredMode=sync 且单任务→sync；默认 async
```

**关键区别**: 阶段 1 是 terminal (否决即返回)；阶段 2-4 是**叠加修饰**，不互斥——一个任务可同时被危险词收紧 (阶段4) 和高复杂度提 timeout (阶段4)，也可同时受容量截断 (阶段2) 和续接复用 (阶段3)。

### 阶段 1: 否决 (terminal)

| 触发 | 输出 |
|------|------|
| task 含反信号词 ("精修"/"反复调"/"我亲自") | shouldDelegate=false, reason="任务需高频人工判断，建议亲自做" |

触发即返回，不进后续阶段。

### 阶段 2: 容量

**全局 vs cwd 的区分 (R2#3)**: 并发上限 4 是 server 全局资源；但 session 复用应按 cwd 匹配。故:
- Skill 调 `pi_session_list` **不传 cwd**，拿全量 sessions 给 `pi_plan`。
- `runningCount` = 全量 existingSessions 中 `status=="running"` 的数量 (**全局**，正确反映 server 占用)。
- **复用候选**必须额外过滤 `session.cwd === input.cwd` (见阶段3)，防跨项目误复用同名 session。

| 触发 | 效果 |
|------|------|
| `可用槽 = 4 - runningCount` | 基准值 (R2#2) |
| `可用槽 <= 0` (runningCount>=4) | shouldDelegate=**false**, reason="无可用并发槽，稍后重试", plan.sessions=[] (**terminal**，性质测试要求 shouldDelegate=false 时 sessions 必空，与此一致) |
| `0 < 可用槽 < fanout` | 实际并发数截到可用槽，reason 标"分批，余 N 待后续" |
| existingSessions 中有 name 匹配但 running | 该 session 不纳入候选，reason 标"X 正忙，已跳过" (避免 session_busy) |

### 阶段 3: 复用

| 触发 | 效果 |
|------|------|
| existingSessions 中 `cwd===input.cwd` 且 name 语义匹配且 idle | action=continue，复用其 goal/constraints |
| 否则 | action=create，生成新 session 名 |

注: 复用匹配**必须**带 cwd 过滤 (R2#3)，避免 "feat-auth" 在 A 项目和 B 项目被误复用。

### 阶段 4: 修饰 (叠加，非互斥)

| 触发 | 效果 (叠加到已生成的 SessionSpec.constraints) |
|------|------|
| task 含危险词 ("删除"/"rm"/"force"/"reset --hard") | **R2#7 改**: 若 spec 已有 `tools` 白名单 → 从白名单删除 `bash`/`shell`；否则设 `excludeTools:["bash"]`。并 thinking=high |
| estComplexity==high | thinking=high, runTimeoutMs 加倍 (R3#2 命名) |

两个修饰可同时生效 (危险 + 高复杂度 → excludeTools:["bash"] && thinking=high && runTimeoutMs 加倍)。

### 阶段 5: mode 决策 (R2#1)

按优先级判定:

| 优先级 | 条件 | 输出 mode |
|--------|------|----------|
| 1 | 实际并发数 > 1 (fanout 截断后) | **async** (并发任务 sync 会顺序阻塞，强制 async) |
| 2 | task 含委托信号词 ("探索整个"/"并行对比"/"独立实现X和Y") | async |
| 3 | preferredMode==="sync" 且 实际并发数==1 | **sync** (host 显式要求单任务同步) |
| 4 | preferredMode==="sync" 但 实际并发数 > 1 | async, reason="fanout>1 不支持 sync，已改 async" |
| 5 | 其他 (默认) | async |

这样 sync 是 preferredMode + 单任务时的合法计划输出，不是手工后门；fanout>1 时强制 async 并说明原因 (R2#1 + R2#2 要求的 reason)。

### 信号词词表

作为常量数据单独抽出 (`scheduler/keywords.ts`)，加词即加测试，不改逻辑:
- 反信号词 (阶段1): 精修、反复调、我亲自...
- 委托信号词 (阶段5): 探索整个、并行对比、独立实现...
- 危险词 (阶段4): 删除、rm、force、reset --hard...

## 7. 错误处理

### 7.1 前置校验 (spawn 前同步拒绝，不产生 Run)

| 错误 | code |
|------|------|
| prompt 空 / session 名非法 | `invalid_arg` |
| 创建 session 时 goal 缺失 | `goal_required` |
| cwd 不存在/不是目录 | `cwd_invalid` |
| session 已存在但 cwd 不一致 | `cwd_mismatch` |
| session 正在 running | `session_busy` (带 runId) |
| constraints.tools 含未知工具名 | `unknown_tool` |
| fork 时 from 不存在 | `not_found` |
| fork 时 to 已存在 / session 名重复 | `conflict` (R2#8) |
| pi_status / pi_kill runId 不存在 | `not_found` |
| pi_status runId 已淘汰 (超过保留期) | `run_expired` (R3#4) |
| 并发超上限 | `resource_busy` |
| fork 进程超时 | `fork_timeout` (R4#7) |

统一错误格式: `{ error: string; code: string; detail?: any }`，code 为稳定枚举。

**plan vs delegate 的并发边界 (R4#9)**: `pi_plan` 与 `pi_delegate` 对并发的处理层次不同，避免 host 拿旧 plan 后状态变化仍越界:
- `pi_plan` **不返回错误**，slots<=0 时只返回 `shouldDelegate=false` + reason (纯函数，基于 host 传入的快照 existingSessions)。
- `pi_delegate` 在 **spawn 前**重新实时检查全局 running count；若 >=4，返回 tool error `resource_busy` (不依赖 plan，因为 plan 到 delegate 之间可能有其他 host 并发占了槽)。

### 7.2 运行期失败 (已 spawn，Run 已建)

| 错误 | Run.status | 检测/行为 |
|------|-----------|----------|
| 进程退出但无 agent_end | `error` | result 空，progress 保留，run.error.stderrTail = stderr 末 2KB |
| 非零退出 | `error` | run.error.stderrTail + exitCode |
| 超时 | `timeout` | 自动 kill 进程 (SIGTERM→grace→SIGKILL)，附已收 progress |
| 进程崩溃 (signal) | `error` | run.error.signal 标 signal |
| jsonl 解析失败 | — | 跳过该行继续读，不中止; 仅无 agent_end 时才 error |
| **创建 session 时进程在 `session` 事件前退出 (R3#10)** | `error` | run.error.code=`session_create_failed`；**不创建 SessionRecord** (piSessionId 无从获取)；返回运行期 error，不污染 registry |
| **创建 session 时 sessionStartTimeoutMs 内无 session 事件 (R4#2)** | `error` | run.error.code=`session_start_timeout`；kill 进程；不创建 SessionRecord |

原则: 错误保留可观测性 (progress + stderr 片段都带回去，统一进 run.error)。

**R3#10 + R4#8 创建阶段处理细则**:
- 新 session 的 SessionRecord **只在收到 `session` 事件后**才提交进 registry。
- 收到 `session` 事件后、后续无 `agent_end`: 保留 SessionRecord，status=error，lastError=no_agent_end (已记 piSessionId，下次可续)。
- 未收到 `session` 事件就退出: 不创建 SessionRecord，run 标 session_create_failed，返回给 host。host 可重试 (session 名仍可用，因 registry 无记录)。
- **R4#8 Run 保留**: session_create_failed 的 Run **仍保留**在 Run registry 的 completed/error TTL 里 (§R3#4)。`Run.session` 填**请求里的 session name** (即使 registry 无对应 SessionRecord)，这样 `pi_status(runId)` 仍可查到该失败 run 并返回 error。
- async 新 session 创建失败: `pi_delegate` 直接返回 `{runId, status:"error", error}` (output.session 缺省，见 §5.1)。

### 7.3 kill 与清理

- `pi_kill(runId)`: 已结束 → killed=false 幂等; running → SIGTERM → 5s grace → SIGKILL → run.status=killed → session.status=error + lastError{code:"killed"} (R2#4，被 kill 是失败); runId 不存在 → not_found。
- 僵尸防御: 持有 child 引用 + AbortController; run 结束兜底 kill; **server 退出时遍历所有 running run + 所有 managed child (含 fork 进程，R4#7) 发 SIGTERM**。

### 7.4 会话一致性 (注册表 vs pi jsonl)

懒检测: delegate 续接前若 pi 报 session 不存在 → `session_file_missing`，标 error，提示重建。不主动扫盘。

### 7.5 资源上限

- 最大并发 running run: **4** (超限 `resource_busy`)。
- 最大注册 session 数: 64 (超限拒绝新建/fork)。
- progress 每 session 截断 50 条 (FIFO)。

## 8. Skill 层 (策略)

### 文件结构

```
~/.agents/skills/pi-subagent/
├── SKILL.md                          ← 主入口 (精简)
└── references/
    └── delegation-patterns.md        ← 详细委派模式 (4 个模式 + prompt 模板)
```

软链: `~/.pi/agent/skills/pi-subagent -> ~/.agents/skills/pi-subagent` (与现有 lark-* 同范式)。

### frontmatter

```yaml
---
name: pi-subagent
version: 1.0.0
description: "委派编程任务给 Pi 子代理执行。当需要把独立子任务交给另一个 agent (探索代码库、实现隔离功能、并行 fan-out、危险操作隔离执行) 时使用。提供同步/异步委派与 session 生命周期管理。"
metadata:
  requires:
    mcps: ["pi-subagent"]
---
```

### SKILL.md 核心指引 (精简)

> 拿到任务后:
> 1. 调 `pi_session_list` **不传 cwd，取全量 existingSessions** (R3#14: 全局 runningCount 才能正确反映并发；pi_plan 内部用全量算并发、用 input.cwd 做复用过滤)。
> 2. 调 `pi_plan` 获取执行计划 (shouldDelegate / mode / sessions)。
> 3. `shouldDelegate=false` → 自己做; 否则严格按计划的 mode 和 sessions 调 `pi_delegate`，不要自行改 mode。
> 4. async: 发起后用短 `pi_status(waitTimeoutMs:30000)` 反复收割 (R3#2)，直到 status 为 completed/error/timeout/killed; 综合 result 决策。

**反模式 (写进 SKILL 防乱用):**
- ❌ 模糊任务甩锅 ("看看这项目") — 子代理会迷失。
- ❌ 高频人工判断的精修任务委派 — 往返成本高。
- ❌ 委派后不读结果 — 必须读 result 并据此决策。

**prompt 自包含原则** (委派的 prompt 要含): 目标 / 上下文 (相关文件路径) / 边界 (不碰什么) / 交付要求。

### Skill 与能力层边界

| 该 host (Skill) 决定 | 该 server (MCP) 执行 |
|----------------------|---------------------|
| 该不该委派 (via pi_plan) | spawn pi、解析输出 |
| prompt 内容微调 | 存 session 记录、管 run |
| 看结果后下一步 | 返回 result/progress |
| — | 强制并发上限 |

## 9. 测试策略

三层金字塔 (从纯函数到真集成，逐层降低确定性):

```
┌─────────────────────┐
│  E2E (真实 pi -p)    │  少量 · 慢 · 默认 skip (升级 pi 时手动跑)
├─────────────────────┤
│  集成 (假 pi 可执行)  │  中等 · 快 · 确定性
├─────────────────────┤
│  单元 (纯函数)        │  大量 · 极快 · 全确定性
└─────────────────────┘
```

### 9.1 单元测试 (纯函数，全 mock)

| 模块 | 测什么 |
|------|--------|
| NDJSON 解析器 | 喂 fixture (§2 实测录制)，断言: 取 agent_end result + tool_execution_end progress、丢 delta、坏行跳过不崩、无 agent_end 返回 null |
| Session registry | 创建/查/续; 同名 conflict; msgCount 自增; progress FIFO 截断 50; _snapshot 脱敏 (不暴露 piSessionId) |
| 前置校验 | goal 缺失/cwd 不存在/名非法/cwd 不一致/tools 未知 — 每个 code 正确 |
| 并发控制 | 第 5 个 running run 拒 (resource_busy); 同 session running 时 delegate 拒 (session_busy 带 runId) |
| 超时/kill | 到点 SIGTERM→grace→SIGKILL; kill 已结束 run killed=false 幂等; kill 不存在 runId not_found |
| **fork 契约 (R2#8)** | fork 后: piSessionId 新、cwd 继承、constraints 继承、goal 含"fork of"、progress=[]、msgCount=0、lastSummary=undef; to 已存在→conflict; from 不存在→not_found |
| **lastSummary (R2#9)** | 成功 run 后 lastSummary=截断500; 失败 run 后 lastSummary **不变** 但 lastError 更新 |
| **lastError (R2#4)** | timeout/killed/no_agent_exit 等各失败 code 正确写入 lastError; snapshot 暴露 lastError |
| **persist 类型边界 (R2#5 + R3#1 + R4#3)** | 序列化内存 running 记录 → 落盘 **status 仍为 running** (保真)、无 runId; 反序列化/启动加载时 running 记录 → 修正为 status:error + lastError:interrupted_by_restart |
| **persist 原子+串行 (R2#10)** | 目录不存在时 mkdir; tmp+rename; 两个 run 近乎同时完成 → registry 同时含两者更新 (promise queue 串行，无覆盖); 损坏文件 → 备份+空启动 |
| **plan() 决策** | 见 9.4 |

### 9.2 集成测试 (假 pi 可执行)

`PI_BIN=test/fixtures/fake-pi.sh` 覆盖 pi 路径。假 pi 据 argv 吐不同 NDJSON (成功/超时 hang/非零退出/无 agent_end/崩溃 signal)。端到端场景:

1. sync delegate 成功: 建 session → result+progress → idle
2. sync 超时: 假 pi hang → runTimeoutMs 到点自动 kill → run=timeout 进程确被杀
3. async + status long-poll: async 立即返回 → status(waitTimeoutMs=大) 阻塞 → 完成后立即返回完整
4. fork: 新 session piSessionId ≠ 源、cwd/constraints 继承、progress 清空、spawn cwd=源.cwd (R2#8 + R3#11)
5. kill 跨调用: async → runId → kill → status 看到 killed + error
6. 并发上限: 4 个 async 成功，第 5 resource_busy
7. **server 退出清理 (层B)**: 起 running run → 结束 server → 所有假 pi 进程收 SIGTERM (假 pi 记录信号到文件验证)
8. **调度→执行联动**: pi_plan(fanout:3) → 3 个 SessionSpec → 依次 delegate(async) → 全 status 收割 → 无 resource_busy/session_busy; plan mode 与实际 mode 一致
9. **默认 async (R2#11)**: pi_delegate 不传 mode → 立即返回 runId + status:running，不阻塞
10. **sync 取消 (层A，视SDK)**: 若 SDK 支持 per-request abort → sync 进行中取消 → 仅该 run 被 kill，其他 run 不受影响；若不支持 → 标 skip 并注明
11. **status 不存在 runId (R2#11)**: pi_status(随机runId) → not_found 错误码
12. **重启恢复 (R2#11)**: 起几个 run (含 running) → 杀 server → 重启 → registry 加载后原 running session 状态=error + lastError.code=interrupted_by_restart、无 runId (R3#1: 落盘时保留 running 真值)
13. **run_expired (R3#4)**: 造 >128 条完成 run 或调小 TTL → 旧 run 被 pi_status 返回 run_expired (非 not_found)
14. **session_create_failed (R3#10)**: 假 pi 无 session 事件直接退出 → run=error + session_create_failed；**registry 无新 SessionRecord** (session 名仍可重试)
15. **多等待者 (R3#12)**: 两个 pi_status(waitTimeoutMs) 同时等同一 run → 完成时都拿到完整结果
16. **progress 上限 (R3#5)**: 假 pi 吐 >200 条 tool_execution_end → Run.progress 截到 200 + progressTruncated=true
17. **unknown_tool 硬拒 (R3#7)**: constraints.tools 含拼错名 → unknown_tool；allowUnknownTools=true → 跳过校验通过 (R4#6 不返回 warning)

### 9.3 E2E (真实 pi，可选)

默认 skip (env flag 门控)。仅验证命令行参数被真 pi 接受:
- 真 delegate: 建 session、sync delegate、非空 result
- 真续接: 同 session 二次 delegate --continue 成功
- 真 fork: --fork 产出新 session

### 9.4 调度策略 plan() 测试 (本次重点)

**单阶段用例** (每行触发一个阶段):

| 用例 | 输入 | 期望 |
|------|------|------|
| 并行探索3方向 | fanout:3 | async, 3 sessions |
| 委托信号词 | "并行对比..." fanout:1 | async |
| 精修任务否决 | "反复调..." | shouldDelegate=false (阶段1 terminal) |
| fanout6但只有2槽 | fanout:6, running:2 | async, 2 sessions, "分批" |
| 续接idle session | existing idle feat-auth | continue feat-auth |
| 跳过busy session | existing running | reason 含"正忙" |
| 危险操作收紧 | "删除...rm" | tools 不含 bash |
| 高复杂度 | estComplexity:high | thinking=high, runTimeoutMs 加倍 |
| 默认委派 | 普通 | async (默认) |
| **preferredMode=sync 单任务 (R2#1)** | preferredMode:sync, fanout:1 | mode=sync |
| **preferredMode=sync 但 fanout>1 (R2#1)** | preferredMode:sync, fanout:3 | async, reason 含"不支持 sync" |
| **slots==0 否决 (R2#2)** | fanout:1, running:4 | shouldDelegate=false, sessions=[], reason 含"无可用并发槽" |
| **cwd 过滤复用 (R2#3)** | existing: feat-auth@cwdA idle + feat-auth@cwdB idle, input.cwd=cwdA | 只 continue cwdA 的，不碰 cwdB |
| **全局 runningCount (R2#3)** | existing: 4 个 running 全在其他 cwd, input.cwd 无 running | slots=0 否决 (全局占用正确反映) |

**组合场景** (评审 #1 重点——验证多阶段叠加，不是 first-match):

| 用例 | 输入 | 期望 (验证叠加) |
|------|------|------|
| 否决优先于一切 | "反复调"+"删除"+fanout:3+high | shouldDelegate=false (阶段1 拦截，危险/复杂/容量都不生效) |
| 危险+高复杂度叠加 | "删除" + estComplexity:high | tools 不含 bash **且** thinking=high **且** runTimeoutMs 加倍 (阶段4 两修饰都生效) |
| 容量截断+续接复用 | fanout:3, 1个idle匹配+2个新建, running:2(只剩2槽) | 2 sessions (1 continue + 1 create), reason 含"分批" |
| busy session 被跳过但仍续接另一个 | 2个同名匹配:1 running 1 idle | continue idle 的，reason 标 busy 的被跳过 |
| 信号词+危险叠加 | "并行对比"+"删除" fanout:2 | async (阶段5) **且** tools 不含 bash (阶段4) |

组合用例的核心断言: **修饰规则不被前面的决策/容量规则"吃掉"**——这是 first-match 模型修掉的核心 bug。

**性质测试** (不变量，随机输入跑 **100 次**，不引第三方库，自写随机生成器):
- plan() 是纯函数: 相同输入永远相同输出
- sessions 总数 ≤ min(fanout, 4 - runningCount)
- shouldDelegate=false 时 plan.sessions 为空 (阶段1 terminal 不变量)
- action:"continue" 的 session 名必存在于 existingSessions
- 危险词触发时 constraints 不含 bash (tools 白名单无 bash，或 excludeTools 含 bash) (R2#7)
- 含反信号词时 shouldDelegate 必为 false (不管 fanout/复杂度/危险词如何)
- runningCount>=4 时 shouldDelegate 必为 false 且 sessions 为空 (R2#2)
- action:"continue" 的 session 必满足 cwd===input.cwd (R2#3)
- preferredMode=sync 且 fanout==1 时 mode 必为 sync；fanout>1 时 mode 必为 async (R2#1)

### 9.5 基础设施

- 框架: `node:test` + `node:assert` (零依赖)
- fixtures: `test/fixtures/`，pi 输出来自实测 commit 入库
- 假 pi: `test/fixtures/fake-pi.sh` (bash 脚本，argv 分支吐 NDJSON)
- 必须全覆盖分支的四块: 解析器、前置校验、并发控制、**plan() 决策**

## 9.6 Pi CLI argv 生成规则 (R4#10)

直接定义，降低实现偏差。**v1 明确不传** `--session-dir`、`--provider`、`--append-system-prompt` (见 §11)。

```ts
// delegate (sync/async 共用):
args = ["-p", prompt, "--mode", "json"];
if (续接已有session) args.push("--session-id", piSessionId);
if (constraints.tools?.length)       args.push("--tools", constraints.tools.join(","));
if (constraints.excludeTools?.length)args.push("--exclude-tools", constraints.excludeTools.join(","));
if (constraints.thinking)            args.push("--thinking", constraints.thinking);
if (constraints.model)               args.push("--model", constraints.model);
// 不传 --provider (v1 用 Pi 默认)
// 不传 --append-system-prompt (v1 prompt 规范在 Skill 层)
// 不传 --session-dir (用 spawn cwd 控工作目录，session 走 Pi 默认存储)
spawn(piBin, args, { cwd });
// runTimeoutMs 由 server 侧 setTimeout+kill 实现，不传给 pi

// fork:
args = ["--mode", "json", "--fork", source.piSessionId];
spawn(piBin, args, { cwd: source.cwd });  // R3#11: cwd 必须=源.cwd
// forkTimeoutMs 由 server 侧 setTimeout+kill 实现
```

## 10. 项目结构 (实现时)

```
pi-subagent/                        ← 新项目
├── src/
│   ├── server.ts                   ← MCP server 入口 (stdio)
│   ├── tools/
│   │   ├── delegate.ts             ← pi_delegate (sync+async)
│   │   ├── status.ts               ← pi_status (long-poll)
│   │   ├── plan.ts                 ← pi_plan 纯函数 ★
│   │   ├── session.ts              ← list/snapshot/fork
│   │   └── kill.ts                 ← pi_kill
│   ├── runner/
│   │   ├── spawn.ts                ← child_process.spawn pi (cwd 控工作目录)
│   │   ├── parse.ts                ← NDJSON 解析 (agent_end + tool_exec_end)
│   │   └── process-table.ts        ← runId↔child+AbortController
│   ├── registry/
│   │   ├── session.ts              ← SessionRecord + _snapshot + redaction
│   │   ├── run.ts                  ← Run registry (内存态)
│   │   └── persist.ts              ← registry.json 原子读写 + 启动加载 ★
│   ├── scheduler/
│   │   ├── plan.ts                 ← plan() 多阶段决策 ★
│   │   └── keywords.ts             ← 信号词/反信号词/危险词词表
│   └── errors.ts                   ← 错误 code 枚举
├── skills/
│   └── pi-subagent/                ← 软链到 ~/.agents/skills/
│       ├── SKILL.md
│       └── references/delegation-patterns.md
├── test/
│   ├── fixtures/
│   │   ├── pi-output-echo.jsonl    ← 实测录制
│   │   └── fake-pi.sh
│   ├── parse.test.ts
│   ├── registry.test.ts
│   ├── persist.test.ts             ← 原子写/启动加载/损坏恢复/重启置非running ★
│   ├── validation.test.ts
│   ├── concurrency.test.ts
│   ├── kill.test.ts
│   ├── scheduler.test.ts           ← 单阶段 + 组合 + 性质 (100次) ★
│   └── integration.test.ts         ← 假 pi 端到端
├── package.json
└── tsconfig.json
```

(★ = 用户特别强调的重点模块)

## 11. 不做 (YAGNI)

- 常驻 RPC server / pi --mode rpc 长连接
- 单进程多 agent handoff 图 (交给 host 编排)
- Store 抽象接口 (pi 自持久化; 我们只存小映射表)
- 内容审查 guardrail (用 cwd/tools 白名单沙箱替代)
- SSE 多订阅广播 (MCP 是请求-响应)
- "断线续跑" (server 退出即 kill，不持久化 run 表)
- UI 可视化
- **v1 不暴露 `--provider`** (R3#8): 用 Pi 默认 provider，避免 MCP 调用方切换模型带来不一致
- **v1 不暴露 `--append-system-prompt`** (R3#8): 避免调用方绕过 Skill 的 prompt 规范 / 扩大注入面；prompt 规范统一在 Skill 层管控
