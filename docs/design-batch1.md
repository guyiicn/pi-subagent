# pi-subagent 设计增量 · 批次 1：任务编排 + 停滞检测

> 基线：`docs/design.md`（v1，已过 4 轮评审，7 工具已实现，81 测试通过）。
> 本文档是**增量**，只描述新增/修改部分，其余沿用基线。
> 状态：设计待用户确认 → 然后实现。
> 起因：真实测试中 Pi 子代理联网绕圈 10 分钟无产出，暴露"全权委托 + 干等"模式的缺陷。讨论后定方向：**模式 C（不可控 I/O 收回 host）+ 模式 B（host 拆阶段）+ 两步拆解（host 草案 / Pi 领域审阅）+ 磁盘契约 + 3 次重派升级 + 任务对象持久化**。

## A. 本批次范围

**做：**
1. 停滞检测（stall timeout）——Run 级能力，兜底子代理软卡死。
2. Task 对象 + tasks.json 持久化。
3. 4 个 task 工具：`pi_task_create` / `pi_task_plan` / `pi_task_stage_run` / `pi_task_list` + `pi_task_get`（合并成 list 带 taskId 过滤）。
4. `pi_task_stage_run` 内封装：delegate → 等完成 → 验收 → 失败按类型自动升级重派（最多 3 次）→ 3 次失败置 manual。

**不做（留给批次 2）：**
- SKILL.md 重写为编排协议。
- Pi web 工具名实测 + excludeTools 词表。
- 真实课件端到端验证。

**验收标准：** 假 pi 下能跑完整流程：建任务 → 审阅计划 → 执行阶段（含成功/重派/进 manual 三种路径）→ 重启后任务进度恢复。

## B. 停滞检测（改 Run + delegate + collectOutput）

### B.1 Run 加 lastProgressAt

基线 `Run`（design.md §4）新增字段：
```ts
interface Run {
  // ... 基线字段 ...
  lastProgressAt: number;   // 收到最近一次 tool_execution_end 的时间；create 时 = startedAt
}
```

`RunRegistry.appendProgress` 时更新 `run.lastProgressAt = Date.now()`。

### B.2 delegate 加 stallTimeoutMs

基线 `pi_delegate`（design.md §5.1）input 新增：
```ts
stallTimeoutMs?: number;   // 默认 120000 (2min)。超过这么久无新 progress → 自动 kill + 标 stalled
```

**机制：** delegate 内启动一个**周期检查**（每 ~5s），若 `now - run.lastProgressAt > stallTimeoutMs` 且 run 仍 running：
- `markManualKill`（同 pi_kill 路径，但 error.code 用 `STALLED` 而非 `KILLED`）。
- 进程 SIGTERM → finalize 时 status=`error`，error.code=`stalled`。

**与 runTimeoutMs 区别：**
- `runTimeoutMs`：整体最长存活（默认 10min），到点必杀。
- `stallTimeoutMs`：无进展超时（默认 2min），有进展就不断续期。

两者可同时生效，先触发哪个算哪个。

### B.3 错误码新增

`ERROR_CODES` 加：`STALLED: "stalled"`（run.error.code）。

### B.4 不动 collectOutput

停滞检测在 delegate 层做（基于 RunRegistry 的 lastProgressAt 周期查），不改 collectOutput 的流读取逻辑。collectOutput 仍是被动读 stdout 直到 exit。

## C. Task 对象

### C.1 数据结构

```ts
interface Task {
  taskId: string;              // 人类可读，host 提供，唯一。如 "attention-courseware"
  goal: string;                // 任务总目标
  cwd: string;                 // 任务工作目录（所有计划/产出文件落在此）
  status: "planning" | "executing" | "blocked_manual" | "completed" | "abandoned";

  // 两步拆解产物
  planDraftPath: string;       // host 写的工程草案相对 cwd 的路径，如 "_plan-draft.md"
  planReviewedPath?: string;   // Pi 审阅产出，如 "_plan-reviewed.md"
  planVerdict?: "approve" | "approve_with_changes" | "reject";

  stages: Stage[];

  reviewSession?: string;      // 审阅 session 名（保留闲置，可后续 continue）
  reviewRunId?: string;        // 审阅那次 delegate 的 runId（便于查 result）

  createdAt: number;
  updatedAt: number;
}

interface Stage {
  stageId: string;             // host 给，如 "1"/"2"/"3a"。Task 内唯一
  title: string;
  objective: string;           // 阶段目标（一句话）
  inputFiles: string[];        // 读哪些（相对 cwd）
  outputFile: string;          // 写哪个（相对 cwd）
  dependsOn: string[];         // 依赖的 stageId（决定顺序；非依赖的可并行）
  parallelizable: boolean;     // host 草案标，Pi 审阅可修正
  promptHint?: string;         // host 给该阶段的额外提示（技术要点等，注入 IOAC 的 Action 段）

  // 验收
  validateRules?: ValidateRule[];   // host 给的验收规则；无则用默认

  // 执行状态
  status: "pending" | "running" | "passed" | "failed" | "manual" | "skipped";
  session?: string;            // 执行 session 名（命名约定见 §E）
  attempts: StageAttempt[];
  lastFailureReason?: string;  // 最近失败原因摘要（给人看）
}

interface StageAttempt {
  attemptNo: number;           // 1..3
  runId: string;
  status: "passed" | "failed";
  failureType?: "no_output" | "incomplete" | "wrong_content" | "timeout" | "stalled" | "pi_refused";
  failureDetail: string;
  ts: number;
}

interface ValidateRule {
  kind: "file_exists" | "file_nonempty" | "contains" | "not_contains" | "regex";
  pattern?: string;            // contains/not_contains/regex 用
}
```

### C.2 默认验收规则

stage 无 `validateRules` 时，`pi_task_stage_run` 用默认：
```ts
[
  { kind: "file_exists" },
  { kind: "file_nonempty" },
  { kind: "not_contains", pattern: "TODO" },
]
```

### C.3 Task 脱敏快照（_snapshot_task）

Task 工具返回时不暴露内部运行态 runId（reviewRunId 保留，便于查），其余同 Task。Task 持久化时**整体落盘**（含 stages/attempts，这些是任务进度，不是瞬时运行态）。

## D. Task 持久化

### D.1 文件

```
~/.pi-subagent/tasks.json
{
  version: 1,
  tasks: Task[]
}
```

### D.2 写入策略

复用基线 persist 模式（design.md §4 持久化契约）：
- 原子写（tmp + rename）。
- 写串行化（promise queue）。
- mkdir -p。

触发时机：任何 Task/Stage 状态变更后（create/plan 完成/stage attempt 结束/stage 状态变）。

### D.3 加载策略

- 文件不存在 → 空。
- 整文件 JSON 损坏 → 备份 `.corrupt-<ts>` + 空。
- 单条 task 损坏 → 跳过该条（记日志），不阻断其他。
- 加载修正：stage.status=="running" 的 → 置 "failed" + attempts 末条标 failureType="interrupted_by_restart"（同基线 session 的 running 修正思想）。task.status=="executing" 且无 running stage → 保持 executing（下次 host 继续派未完成 stage）。

### D.4 与 session registry 的关系

- 独立文件、独立内存对象。
- Task 引用 session 名（reviewSession / stage.session），**不拥有** session。
- 删 Task 不删 session（session 可能复用）。
- Task 持久化不触发 session 持久化（各管各）。

## E. 命名约定（写进 SKILL.md，工具不强制）

| 对象 | 约定 | 示例 |
|------|------|------|
| taskId | `<topic>` | `attention-courseware` |
| reviewSession | `<topic>-review` | `attention-courseware-review` |
| stage.session | `<topic>-<stageId>` | `attention-courseware-3a` |
| 计划文件 | `_plan-draft.md` / `_plan-reviewed.md` | （相对 cwd） |
| 参考资料 | `_refs.md`（host 联网产出） | |
| 骨架 | `_skeleton.md`（阶段1产出） | |
| 阶段产出 | `<stageId>-<slug>.<ext>` | `03a-qkv.html` |

工具不校验命名（host 自由），SKILL.md 推荐。

## F. 工具契约（4 个新工具）

现有 7 工具保留不变。新增：

### F.1 `pi_task_create`

```ts
input: {
  taskId: string;        // 必填，唯一
  goal: string;          // 必填
  cwd: string;           // 必填，须存在
  planDraftPath: string; // 必填，相对 cwd，如 "_plan-draft.md"（host 应已写好）
  stages: Array<Pick<Stage, "stageId"|"title"|"objective"|"inputFiles"|"outputFile"|"dependsOn"|"parallelizable"|"promptHint"|"validateRules">>;
                         // host 拆好的阶段（草案，待审阅后可能修）
}
output: { task: TaskSnapshot }
// 校验: taskId 重复 → conflict; cwd 不存在 → cwd_invalid; planDraftPath 在 cwd 下不存在 → invalid_arg
// status 初始 = "planning"（等审阅）
```

### F.2 `pi_task_plan`（两步拆解第 2 步：派审阅 Pi）

```ts
input: {
  taskId: string;
  constraints?: Constraints;  // 默认禁联网（excludeTools 含 web 工具，批次2实测后填）
  stallTimeoutMs?: number;
  runTimeoutMs?: number;
}
output: {
  runId: string;              // 审阅 delegate 的 runId（async）
  verdict?: string;           // 审阅完成后有（host 也可 pi_status(runId) 拿）
  task: TaskSnapshot;
}
```

**内部：**
- 建 reviewSession（`<taskId>-review`，或复用已存在的）。
- 拼 IOAC 审阅 prompt：
  - Input: 读 `<cwd>/_refs.md`（若存在）+ `<cwd>/<planDraftPath>`
  - Objective: 从领域角度审阅草案，产出 `_plan-reviewed.md`，含 `verdict:` 行 + 修改建议
  - Action: 禁联网；只写 `_plan-reviewed.md`；不改草案
  - Check: 文件含 `verdict:` 行（approve/approve_with_changes/reject）
- delegate(async)。完成后：
  - 读 `_plan-reviewed.md`，解析 verdict 行 → 写 task.planVerdict / planReviewedPath。
  - **不自动改 stages**（审阅建议由 host 决定接受与否；工具只把 verdict 和文件路径返回给 host）。
- task.status 仍 "planning"（host 看 verdict 后决定是否手动调 stage 再执行）。

**为何不自动应用修改：** 审阅建议可能有多条、可能互相冲突、host 可能有自己的工程考量。自动应用会越权。工具把判断权交回 host（你定的"失败原因要给我决策"原则的延伸）。

### F.3 `pi_task_stage_run`（核心：执行 + 验收 + 重派）

```ts
input: {
  taskId: string;
  stageId: string;
  constraints?: Constraints;   // 默认禁联网
  stallTimeoutMs?: number;
  runTimeoutMs?: number;
  maxAttempts?: number;        // 默认 3
}
output: {
  stage: StageSnapshot;
  outcome: "passed" | "manual";
  attempts: StageAttempt[];    // 全部尝试记录
  manualPanel?: ManualPanel;   // outcome=manual 时给决策面板
}
```

**内部流程：**
```
读 task + stage
前置: stage.status in [pending, failed, manual]（manual 允许人在决策后重试）
      stage 的 dependsOn 都已 passed（否则 invalid_arg: dependency_unmet）
建/复用 stage.session
for attempt in 1..maxAttempts:
  拼 IOAC 执行 prompt:
    Input: 读 inputFiles（绝对路径化）+ 若 attempt>1 读上次的失败上下文
    Objective: stage.objective
    Action: 禁联网；只写 outputFile；不改其他；promptHint 注入
    Check: 验收规则明示
  追加升级指令（attempt>1 时，按上次 failureType 套模板，见 §G）
  delegate(async, stallTimeoutMs, runTimeoutMs)
  等完成
  验收（按 validateRules 或默认）
  记 attempt
  if passed: stage.status=passed; task 若所有 stage passed → completed; return passed
  else: 拼 attempt+1 的失败上下文
stage.status=manual; task.status=blocked_manual
return manual + manualPanel
```

**验收失败类型判定（§G 详）：**
- 文件不存在 → no_output
- 文件空 → incomplete
- 含 TODO / 缺 required 标记 → incomplete
- timeout/stalled → 对应类型
- Pi result 含"我需要"/"无法"/"拒绝" → pi_refused

### F.4 `pi_task_list` / `pi_task_get`

```ts
// pi_task_list
input: { status?: Task["status"] }   // 可选过滤
output: { tasks: TaskSnapshot[] }    // 按 updatedAt 倒序

// pi_task_get
input: { taskId: string }
output: { task: TaskSnapshot }        // 含完整 stages/attempts
```

### F.5 工具矩阵更新：7 → 11

| # | 工具 | 备注 |
|---|------|------|
| 1-7 | (基线 7 工具) | 不变 |
| 8 | pi_task_create | 建任务 |
| 9 | pi_task_plan | 派审阅 |
| 10 | pi_task_stage_run | 执行+验收+重派 |
| 11 | pi_task_list | list(+get 靠 taskId 参数) |

`pi_task_get` 合并进 list：`pi_task_list({ taskId })` 返回单个。少一个工具。

## G. 重派升级 prompt 模板（工具自动拼）

attempt > 1 时，在 IOAC 的 Action 段后追加（按上次 failureType）：

| failureType | 追加指令 |
|-------------|---------|
| no_output | `上次失败：未生成输出文件。你必须在本次第一步就用 write 工具创建 <outputFile> 的骨架，再逐步填充。不要只回复内容，必须落盘。` |
| incomplete | `上次失败：输出不完整（<failureDetail>）。请补全：明确包含 <缺失项>。完成后重读文件确认无 TODO/占位。` |
| wrong_content | `上次失败：内容不符验收（<failureDetail>）。请对照修正。<可选 host 给的 validateRules>` |
| timeout | `上次失败：超时（可能是步骤过多或卡住）。本次请减少步骤：先写最小可用版本落盘，再迭代。不要在单步上反复。` |
| stalled | `上次失败：长时间无进展被中止（疑似卡在某工具调用）。本次每完成一步就推进，避免在单一操作上停滞。` |
| pi_refused | `上次失败：你表示无法完成（<failureDetail 摘要>）。材料已在 <inputFiles>。请基于已有材料直接产出，不要要求更多信息。` |

所有升级指令都强调**先落盘**（防 Pi"想完美再写"导致无产出）。

## H. 决策面板（manual 时）

`pi_task_stage_run` 返回 `outcome=manual` 时附：

```ts
interface ManualPanel {
  taskId: string;
  stageId: string;
  attempts: StageAttempt[];      // 3 次
  lastPiResult?: string;         // 最近一次 Pi 回复（截断 500）
  availableFiles: string[];      // [planDraftPath, planReviewedPath, inputFiles...]
  options: ["retry_with_new_hint", "skip", "abort_task", "manual_write"];
  // host 呈现给人，人选后：
  //   retry_with_new_hint → host 改 stage.promptHint 再调 pi_task_stage_run（status=manual 允许重试）
  //   skip → stage.status=skipped
  //   abort_task → task.status=abandoned
  //   manual_write → 人自己写，host 标 stage.status=passed（或新工具 pi_task_stage_mark）
}
```

注意：面板是**数据**，host 怎么呈现给人由 host 决定（ZCode 会渲染成卡片/文本）。工具只保证信息齐全。

## I. 错误码新增

`ERROR_CODES` 加：
- `STALLED`（run.error.code，停滞）
- `TASK_NOT_FOUND`
- `STAGE_NOT_FOUND`
- `DEPENDENCY_UNMET`（stage 依赖未满足）
- `TASK_CONFLICT`（taskId 重复）
- `PLAN_DRAFT_MISSING`（planDraftPath 不存在）

## J. 项目结构增量

```
src/
├── types.ts              ← 改：加 Task/Stage/StageAttempt/ValidateRule/ManualPanel + 新错误码 + Run.lastProgressAt + stallTimeoutMs
├── registry/
│   ├── task.ts           ← 新：TaskRegistry（CRUD + 持久化触发）
│   └── task-persist.ts   ← 新：tasks.json 原子写 + 加载修正（仿 persist.ts）
├── runner/
│   └── validate.ts       ← 新：按 ValidateRule 验收文件
├── tools/
│   ├── task.ts           ← 新：pi_task_create / pi_task_plan / pi_task_stage_run / pi_task_list
│   └── stage-prompt.ts   ← 新：IOAC 模板 + 升级指令模板（§G）
├── scheduler/            ← 不变
└── server.ts             ← 改：注册 4 个新工具 + TaskRegistry 持久化钩子
test/
├── stall.test.ts         ← 新：停滞检测
├── task-registry.test.ts ← 新
├── task-persist.test.ts  ← 新
├── validate.test.ts      ← 新
├── stage-prompt.test.ts  ← 新：升级指令模板
├── task-tools.test.ts    ← 新：create/plan/stage_run/list（假 pi）
└── task-integration.test.ts ← 新：完整流程（建→计划→执行→重派→manual→重启恢复）
```

## K. 测试策略（批次 1）

沿用基线三层（单元/集成假 pi/E2E 可选）。重点新增：

**单元：**
- 停滞检测：run 长时间无 progress → delegate 自动标 stalled（用快时钟/短 stallTimeoutMs）。
- TaskRegistry CRUD + tasks.json 往返 + 单条 task 损坏跳过 + stage running 加载修正。
- validate：各 ValidateRule（file_exists/nonempty/contains/not_contains/regex）。
- stage-prompt：各 failureType 的升级指令正确拼接；IOAC 模板含输入/目标/约束/验收。

**集成（假 pi）：**
- 完整成功路径：create → plan（verdict=approve）→ stage_run 成功 → task completed。
- 重派路径：stage 第 1 次失败（no_output）→ 第 2 次成功（升级 prompt 生效）。
- manual 路径：stage 连续 3 次失败 → manual + 决策面板齐全。
- 停滞路径：stage 执行时 Pi 卡（hang 模式 + 无 progress）→ stalled → 计入 attempt。
- 依赖：stage 依赖未 passed → DEPENDENCY_UNMET。
- 重启恢复：执行到一半杀 server → 重启 → task 进度在、running stage 标 failed(interrupted)。

**E2E（真实 pi，批次2 做）：** 不在本批次。

## L. 不做（YAGNI，本批次）

- Task 删除工具（abandoned 状态够了，不物理删）。
- 自动应用审阅建议（host 决策）。
- stage 并行的自动调度（host 自己并行调多个 pi_task_stage_run；工具不内置 DAG 调度器）。
- 跨 task 的资源隔离（多 task 共享 4 并发上限）。
