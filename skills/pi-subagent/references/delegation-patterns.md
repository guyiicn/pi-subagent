# 委派模式参考

这些规则已在 `pi_plan` 中实现，此处仅供理解。

## 模式 1：探索 fan-out

任务如"调研 A/B/C 三个方案的优劣"。
- `pi_plan({ task: "...", fanout: 3, cwd })` → 返回 3 个 SessionSpec，mode=async。
- 为每个 spec 填自包含 prompt，依次 `pi_delegate(mode:async)`。
- 注意并发上限 4：fanout>4 会被截断分批。
- 逐个 `pi_status(waitTimeoutMs:30000)` 收割，综合各 result 做决策。

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
