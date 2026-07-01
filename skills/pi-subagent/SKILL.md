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
| pi_session_list | 列 session（不传 cwd 取全量） |
| pi_session_snapshot | 看 session 详情 |
| pi_session_fork | 从已有 session 派生（试另一条路） |
| pi_kill | 中止 run |
