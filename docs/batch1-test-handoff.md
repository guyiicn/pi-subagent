# pi-subagent 批次 1 测试手册（handoff）

> 给接手测试的进程/人。本机已实现 pi-subagent 批次 1（停滞检测 + Task 编排 + 11 个 MCP 工具，122 测试全过）。
> 目标：重启 ZCode 后，验证 11 个工具被识别 + 关键能力在**真 pi** 上工作。
> 项目：`/home/guyii/code/pi-subagent`，分支 `feat/pi-subagent`，spec：`docs/design-batch1.md`。

## 前置：本机环境（已就绪，无需改动）

- pi-subagent 代码在 `/home/guyii/code/pi-subagent`
- MCP 配置已写入 `~/.agents/mcp.json`（启动命令 `node .../tsx/dist/cli.mjs .../src/server.ts`）
- Skill 软链：`~/.agents/skills/pi-subagent`、`~/.pi/agent/skills/pi-subagent`
- `pi` CLI 已装（`@earendil-works/pi-coding-agent@0.77.0`）
- 当前测试状态：批次 1 代码完成，**尚未在真 pi 上验证**

## 第 0 步：重启 ZCode

完全退出 ZCode 进程（不只关窗口），重新打开。这是为了让它重新加载 MCP 配置。

重启后，**先验证 server 能启动**（在终端跑，应输出 11 个工具名）：
```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"t","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | timeout 8 node /home/guyii/code/pi-subagent/node_modules/tsx/dist/cli.mjs /home/guyii/code/pi-subagent/src/server.ts 2>/dev/null \
  | grep -oE '"name":"pi_[a-z_]+"' | sort -u
```
**预期**：输出 11 行（pi_delegate / pi_kill / pi_plan / pi_session_fork / pi_session_list / pi_session_snapshot / pi_status / pi_task_create / pi_task_list / pi_task_plan / pi_task_stage_run）。
**若失败**：server 起不来，看 stderr。

---

## 场景 1：验证 ZCode 识别 11 个工具

在 ZCode **新对话**里发：
> 列出你现在能用的所有 pi_ 开头的工具

**预期**：列出 11 个工具名。

**若只看到 7 个**（缺 pi_task_*）：MCP 没重新加载。排查：
```bash
grep -E "mcpServerCount|mcpServerNames" ~/.zcode/v2/logs/$(date +%F).log | tail -5
```
看最新一条 session 的 `mcpServerCount` 是否为 1、`mcpServerNames` 是否含 "pi-subagent"。若为 0，ZCode 没读到 `~/.agents/mcp.json`——检查文件是否还在、JSON 是否合法。

---

## 场景 2：单次委派（基础链路 + 真 pi）

新对话发：
> 用 pi_delegate 在 /tmp/pi-test-simple/ 里委派：创建 hello.txt，内容 "hello from pi"。用 async 模式，然后用 pi_status 收割结果。

**预期**：
- `pi_delegate`（async）→ 返回 runId + status:running
- `pi_status(runId)` → status:completed
- `/tmp/pi-test-simple/hello.txt` 存在，内容正确

**观察点**：Pi **不应联网**（任务是写文件）。若 Pi 又去 curl，记录它的行为——这是 prompt 约束问题，批次 2 修。

**报错排查**：
- `session_create_failed` + spawn EACCES → 真 pi 权限问题（不太可能，pi 是 npm 装的）
- 长时间 running → 看下面"卡住怎么办"

---

## 场景 3：停滞检测（批次 1 新能力）

新对话发：
> 用 pi_delegate 委派到 /tmp/pi-test-stall/，让 Pi "持续监控 /tmp/never-exists.log 直到该文件出现"。设 stallTimeoutMs: 30000。然后每 10 秒轮询 pi_status，直到状态不再是 running。

**预期**：
- Pi 会卡住（日志文件永不出现）
- ~30-40 秒后，`pi_status` 返回 status:error、error.code:"stalled"
- **不会**干等 10 分钟

**验证点**：这证明 stallTimeoutMs 在真 pi 上生效。若 30 秒后仍 running，说明参数没传进 delegate，或 stall 检测周期未触发——查 delegate.ts 的 stallChecker。

---

## 场景 4：完整任务流程（批次 1 核心，重点）

### 4.1 准备文件

让 ZCode 跑这段 bash（或自己跑）：
```bash
mkdir -p /tmp/pi-task-test
cat > /tmp/pi-task-test/_plan-draft.md <<'EOF'
# 任务：生成两章 HTML 课件

## 阶段 1：intro
- 目标：写一个 HTML 文件介绍"什么是 AI 子代理"
- 输出：01-intro.html

## 阶段 2：summary
- 目标：写一个 HTML 文件做全文总结
- 输出：02-summary.html
EOF
echo "准备完成"
```

### 4.2 建任务 + 执行

新对话发：
> 我在 /tmp/pi-task-test/ 准备好了 _plan-draft.md。请：
> 1. 用 pi_task_create 建任务：taskId="test-courseware"，goal="生成两章 HTML 课件"，cwd="/tmp/pi-task-test"，planDraftPath="_plan-draft.md"
> 2. stages 含两个：stageId "1"（title "intro"，objective "写介绍子代理的 HTML"，inputFiles ["_plan-draft.md"]，outputFile "01-intro.html"，dependsOn []，parallelizable true）；stageId "2"（title "summary"，objective "写总结 HTML"，inputFiles ["_plan-draft.md"]，outputFile "02-summary.html"，dependsOn ["1"]，parallelizable false）
> 3. 用 pi_task_stage_run 执行阶段 1，完成后告诉我结果
> 4. 再执行阶段 2，完成后告诉我结果
> 5. 最后用 pi_task_list 看任务总状态

**预期流程**：
1. `pi_task_create` → 任务建立，status:"planning"
2. `pi_task_stage_run(stageId:"1")` → Pi 写 01-intro.html → outcome:"passed"，stage status:"passed"
3. `pi_task_stage_run(stageId:"2")` → Pi 写 02-summary.html → outcome:"passed"
4. 任务 status:"completed"
5. `pi_task_list` → 显示 1 个 completed 任务
6. `/tmp/pi-task-test/` 下 3 个文件：_plan-draft.md + 01-intro.html + 02-summary.html

### 4.3 关键观察点（务必记录）

| 观察项 | 期望 | 若不符 |
|--------|------|--------|
| Pi 有没有联网 | 不该联网（任务自包含） | 若 curl 绕圈，记下 Pi 行为；看是否 120s 后 stalled |
| HTML 质量 | 有实质内容，非空壳 | 若空/TODO，prompt 模板需加强（批次 2） |
| 每阶段耗时 | < 2 分钟 | 超长说明 Pi 在纠结 |
| 阶段 2 是否真依赖阶段 1 | 串行执行 | 若并发跑 stage 2（依赖未满足）应被 dependency_unmet 拒 |

### 4.4 检查产出

```bash
ls -la /tmp/pi-task-test/
echo "=== 01-intro.html 前 20 行 ==="
head -20 /tmp/pi-task-test/01-intro.html
echo "=== 02-summary.html 前 20 行 ==="
head -20 /tmp/pi-task-test/02-summary.html
```

---

## 场景 5（可选）：重派 / manual 验证

如果场景 4 某阶段**第一次失败**（比如 Pi 没写文件），观察：
- `pi_task_stage_run` 是否**自动重试**（最多 3 次）
- 第二次的 Pi prompt 是否含"上次失败：未生成输出文件，必须用 write..."
- 若 3 次都失败，是否进 manual + 返回决策面板（options: retry_with_new_hint / skip / abort_task / manual_write）

如果想**主动触发 manual**，用一个 Pi 做不到的任务：
> 用 pi_task_stage_run 执行 stageId "1"，但 objective 改成"求解 P=NP 并写到 01.html"。设 maxAttempts: 3。

Pi 大概率 3 次都失败 → manual + 决策面板。

---

## 卡住怎么办

### ZCode 看不到工具
```bash
# 1. server 能否启动（见第 0 步）
# 2. mcp.json 在不在
cat ~/.agents/mcp.json
# 3. ZCode 日志
grep -E "mcpServer|mcp" ~/.zcode/v2/logs/$(date +%F).log | tail -10
```

### pi_delegate 长时间 running
```bash
# 看 pi 进程在干嘛
ps aux | grep "pi -p" | grep -v grep
# 看是否有僵尸 pi
pgrep -f "pi -p" | xargs -r kill
```

### 测试后清理
```bash
rm -rf /tmp/pi-test-simple /tmp/pi-test-stall /tmp/pi-task-test
# 清 session registry（可选）
rm -f ~/.pi-subagent/registry.json ~/.pi-subagent/tasks.json
```

---

## 结果记录模板

每个场景测完，填这张表（发给后续分析）：

| 场景 | 结果（通过/失败/部分） | 关键观察 | Pi 行为（联网?卡住?） | 耗时 |
|------|---------------------|---------|---------------------|------|
| 1. 工具识别 | | | — | |
| 2. 单次委派 | | | | |
| 3. 停滞检测 | | | | |
| 4. 完整流程 | | | | |
| 5. 重派/manual | | | | |

**批次 2 的输入**：场景 4 的"Pie 有没有联网""HTML 质量"直接决定批次 2 SKILL.md 的 prompt 模板要加什么约束。务必如实记录。

---

## 批次 2 预告（测试后做）

根据本测试结果，批次 2 将：
1. 实测 Pi 装了哪些 web 工具（`pi -p --tools ?` 或看 extension），写进 excludeTools 词表。
2. 重写 SKILL.md 为"任务编排协议"（C 模式禁联网 + 两步拆解 + 磁盘契约 + IOAC）。
3. 用真实课件任务端到端验证（这次不该卡——禁联网 + 阶段拆分 + 停滞兜底）。

spec：`/home/guyii/code/pi-subagent/docs/design-batch1.md` 的"不做（留给批次2）"节。
