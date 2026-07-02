# 委派模式参考（v2）

任务编排协议的详细模式与示例。配合 SKILL.md 使用。

## 模式 1：文档/课件生成（典型 C+B 流程）

任务："生成注意力机制 HTML 课件"。

```
# 1. host 判断要外部数据 → 联网拿资料
host 用 WebSearch/webReader 搜 "attention mechanism tutorial" 
→ 整理成 /proj/attention-courseware/_refs.md

# 2. host 拆阶段 → 写草案
cat > /proj/attention-courseware/_plan-draft.md <<'EOF'
# 阶段 1: intro        → 01-intro.html       (无依赖)
# 阶段 2: scaled-dot   → 02-scaled.html      (依赖 1)
# 阶段 3: multi-head   → 03-multihead.html   (依赖 2)
# 阶段 4: summary      → 04-summary.html     (依赖 1,2,3)
EOF

# 3. pi_task_create(taskId="attention-courseware", cwd, planDraftPath, stages=[...])
# 4. pi_task_plan(taskId) → Pi 审阅 → _plan-reviewed.md (verdict)
#    host 看 verdict，Pi 可能建议"阶段3拆成3a/3b"→ host 改 stages 或不改
# 5. 依次 pi_task_stage_run(各阶段) → 每 stage 写一个 html
# 6. 全 passed → completed，4 个 html 文件落盘
```

每阶段的 Pi prompt 由工具按 IOAC 生成，含：
- 读 `_refs.md` + 骨架文件（Pi 不会联网，材料已给）
- 只写 `0N-xxx.html`
- promptHint 注入领域要点（如"强调 scale=1/√d_k 的数值稳定性"）

## 模式 2：并行 fan-out（独立章节）

阶段间无依赖时可并行。`pi_task_stage_run` 是阻塞调用，host 并行发起多个：

```
# 阶段 2/3/4 互不依赖（都只依赖阶段1的骨架）
await Promise.all([
  pi_task_stage_run({taskId, stageId:"2"}),
  pi_task_stage_run({taskId, stageId:"3"}),
  pi_task_stage_run({taskId, stageId:"4"}),
]);
```

注意并发上限 4（pi_delegate 层）。fanout>4 会被截断分批。

## 模式 3：代码实现（分而治之）

任务："给项目加用户认证模块"。

```
_plan-draft.md:
# 阶段 1: data-layer    → src/auth/db.ts        (无依赖)
# 阶段 2: middleware     → src/auth/middleware.ts (依赖 1)
# 阶段 3: routes         → src/auth/routes.ts    (依赖 1,2)
# 阶段 4: tests          → src/auth/auth.test.ts (依赖 1,2,3)
```

每阶段 validateRules 可加技术检查，如：
```json
"validateRules": [
  {"kind":"contains","pattern":"export "},
  {"kind":"not_contains","pattern":"TODO"}
]
```

## 模式 4：危险操作隔离

任务含删除/重置。Pi 执行阶段默认禁 skill，但你可额外收紧：
```
pi_task_stage_run({taskId, stageId, constraints:{ excludeTools:["bash"], noSkills:true }})
```
注意：`excludeTools:["bash"]` 会让 Pi 无法跑命令（只能 read/edit/write），仅用于纯文本生成阶段。

## 模式 5：长任务后台跑 + 停滞兜底

不确定时长的阶段。`pi_task_stage_run` 内部 delegate 带 `stallTimeoutMs`（默认 120s）：
- Pi 卡住（无新 progress）120s → 自动 kill + 标 stalled → 计入 attempt 失败
- 3 次 stalled → manual，决策面板给人

你可在 stage_run 传 `stallTimeoutMs` 覆盖默认。

## sync vs async 怎么选

- `pi_task_stage_run` **总是 async**（内部 delegate async + 等完成）。host 调用是阻塞的（await），但 Pi 在后台跑。
- 直接用 `pi_delegate` 时：单任务要立刻拿结果 → `mode:"sync"`；fan-out/不确定时长 → async（默认）。

## 重派升级机制（工具自动）

stage 第 N 次失败（N>1）时，工具按上次 failureType 自动在 prompt 追加：

| failureType | 升级指令要点 |
|-------------|------------|
| no_output | "必须第一步用 write 创建骨架，不要只回复" |
| incomplete | "补全缺失部分，重读确认无 TODO" |
| timeout | "减少步骤，先写最小版本" |
| stalled | "每步推进，别在单一操作停滞" |
| pi_refused | "材料已在输入文件，直接产出" |

你不用手写升级指令，但要理解：失败原因是累积传递给 Pi 的。

## manual 决策（3次失败后）

`pi_task_stage_run` 返回 `outcome:"manual"` 时附 `manualPanel`：
```json
{
  "taskId": "attention-courseware",
  "stageId": "3",
  "attempts": ["...3次失败记录..."],
  "lastPiResult": "Pi 最后回复摘要",
  "availableFiles": ["_plan-draft.md","_refs.md"],
  "options": ["retry_with_new_hint","skip","abort_task","manual_write"]
}
```

host 应把这个呈现给人（你），人选：
- **retry_with_new_hint**：人给新的 promptHint，host 改 stage 再 stage_run（status=manual 允许重试）
- **skip**：跳过（标 skipped，下游依赖若只依赖它会 unmet）
- **abort_task**：整个任务 abandoned
- **manual_write**：人自己写 outputFile，然后标 passed

## v1 底层工具的简单用法（不拆阶段的场景）

小任务（改一行、查个东西）不必走 task 编排，直接：
```
pi_delegate({prompt, session, cwd, goal, mode:"async"}) → pi_status(runId) 收割
```
但同样遵守：prompt 自包含、明确禁联网（constraints.noSkills=true）。
