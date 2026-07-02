---
name: pi-subagent
version: 2.0.0
description: "把 Pi 当编程子代理，按任务编排协议委派工作。host 拆任务→Pi 领域审阅→分阶段执行（禁联网、磁盘契约、3次重派、停滞兜底）。用于生成文档/课件、实现多模块功能、并行探索等可拆分的编程任务。"
metadata:
  requires:
    mcps: ["pi-subagent"]
---

# pi-subagent v2 — 任务编排协议

把 Pi 当作**可委派的编程子代理**。核心思想：host 负责**拆分 + 不可控 I/O（联网）**，Pi 负责**可控的编码/写作**（禁联网、专注落盘）。

## 三条铁律（必须遵守）

1. **不可控 I/O 收回 host（C 模式）**：联网搜索、外部 API 调用由 host（你/ZCode）做，结果写进任务目录的 `_refs.md`。**绝不让 Pi 自己联网**——它会绕圈（实测：UltimateSearch skill 会诱导 Pi 反复搜索）。
2. **大任务必须拆分（B 模式）**：不要一次性委派"生成整个课件"。用 `pi_task_create` 拆成阶段，每阶段产出独立文件，host 在阶段间验证。
3. **Pi 执行阶段禁 skill**：`pi_task_plan` / `pi_task_stage_run` 默认 `noSkills:true`（防联网诱导）。保留 bash/read/edit/write 让 Pi 干活。

## 标准任务流程（6 步）

```
1. host 判断：要不要外部数据？
   ├─ 要 → host 自己联网（WebSearch/webReader）→ 写 <cwd>/_refs.md
   └─ 不要 → 跳过

2. host 拆任务为阶段 → 写 <cwd>/_plan-draft.md（章节划分 + 每阶段目标/输入/输出/依赖）

3. pi_task_create(taskId, goal, cwd, planDraftPath, stages)
   → 任务建立，status=planning

4. pi_task_plan(taskId)  ← 两步拆解第2步：派 Pi 领域审阅
   → async 返回 runId
   → pi_status(runId) 收割 → Pi 产出 _plan-reviewed.md（含 verdict）
   → host 读 verdict：approve / approve_with_changes / reject
   → host 决定：接受修改建议就改 stages（pi_task 不自动改），否则按原计划

5. 依次（或并行）pi_task_stage_run(taskId, stageId)
   → 工具内部：delegate(禁skill) → 验收 → 失败按类型升级重派(最多3次) → 3次失败进 manual
   → 返回 outcome: passed | manual

6. 全部 stage passed → task completed
   若某 stage manual → task blocked_manual，工具返回决策面板，host 呈现给人
```

## IOAC prompt 原则（工具已内置，理解即可）

每个阶段的 Pi prompt 由工具按 IOAC 模板生成：
- **Input**：读哪些文件（绝对路径，替代 Pi 的"记忆"）
- **Objective**：这阶段产出什么（一句话可验证）
- **Action 约束**：禁联网、只写 outputFile、先落盘骨架
- **Check**：验收规则（文件存在+非空+无TODO，或 host 给的 validateRules）

你（host）在 `pi_task_create` 的 stages 里给 `promptHint`（领域要点），工具会注入 Action 段。

## 命名约定

| 对象 | 约定 | 示例 |
|------|------|------|
| taskId | `<topic>` | `attention-courseware` |
| 文件 | `_plan-draft.md` / `_plan-reviewed.md` / `_refs.md` / `<stageId>-<slug>.html` | `02-scaled.html` |

## 工具速查（11 个）

**任务编排（v2 新增，优先用）：**
| 工具 | 用途 |
|------|------|
| pi_task_create | 建任务（host 已写 _plan-draft.md） |
| pi_task_plan | 派 Pi 审阅计划（两步拆解第2步） |
| pi_task_stage_run | 执行阶段（含验收+3次重派+manual） |
| pi_task_list | 看任务全貌（可按 taskId/status 过滤） |

**底层工具（task 工具内部用，也可直接调）：**
| 工具 | 用途 |
|------|------|
| pi_delegate | 派单个任务（默认 async） |
| pi_status | 收割 run 结果（long-poll） |
| pi_kill | 中止 run |
| pi_plan | 简单调度决策（该不该委派/几个session） |
| pi_session_list / pi_session_snapshot / pi_session_fork | session 管理 |

## 反模式（禁止）

- ❌ 让 Pi 自己联网（用 UltimateSearch 等）—— 会绕圈。host 先做 I/O 写 _refs.md。
- ❌ 一次性委派大任务不拆 —— 用 pi_task_create 拆阶段。
- ❌ 委派后不读结果 —— 每阶段看 outcome，failed/manual 要处理。
- ❌ stage 失败原样重跑 —— 工具已自动按 failureType 升级 prompt，但你要看 manual 面板决策。

## 重要行为说明（实测得出）

**status 轮询（应对 host 30s 工具超时）：**
MCP host（ZCode）对单次工具调用有 30s 硬超时。`pi_status` 默认 `waitTimeoutMs=25000`（低于上限）。
- async delegate 后，反复调 `pi_status(runId)` 收割，每次最多等 25s。
- **不要**给 `waitTimeoutMs>28000`——会被 host 掐断成"Tool execution timed out"。
- 收割到 status 非 running（completed/error/stalled/killed）即结束。

**session 复用与隔离：**
- 同名 session 多次 delegate 会**累积 progress**（session 是连续对话）。
- **重派失败任务时用新 session 名**（如 `math-2`、`frontier-3`），避免历史 progress 混入。
- `pi_status(runId)` 返回的是**单次 run 的 progress**（Run 级隔离），不受 session 历史影响——优先用 runId 收割。

**stall 与长内容生成：**
- Pi 生成长内容（>5KB HTML）时，"构思全文"阶段无 tool 调用，可能被判 stalled。
- 工具已在 stage prompt 强制"先骨架→逐节 edit"节奏（每步都调 tool 保持进度）。
- 若仍 stall，传 `stallTimeoutMs` 调大（默认已 300s）。

## 失败处理（manual 面板）

stage 连续 3 次失败 → `pi_task_stage_run` 返回 `outcome:manual` + 决策面板：
- `retry_with_new_hint`：你改 stage 的 promptHint 再调 stage_run
- `skip`：跳过这阶段
- `abort_task`：放弃整个任务
- `manual_write`：你自己写这个文件

详细模式与示例见 `references/delegation-patterns.md`。
