# pi-subagent

把 [Pi CLI](https://pi.dev)（`@earendil-works/pi-coding-agent`）当作可被任意 MCP host 调用的**编程子代理**。提供 7 个 MCP 工具：委派任务、收割结果、调度决策、管理具名 session、中止进程。

- **进程隔离**：每次委派 = 一个 `pi -p` 子进程，Pi 崩了只影响该次调用。
- **全 session 化**：每个任务绑定具名 session，自动续接。
- **sync / async 双模**：默认 async（规避 host tool-call 超时），可用 `pi_status` long-poll 收割。
- **调度决策**：`pi_plan` 纯函数，多阶段决策（否决/容量/复用/修饰/mode），可测。
- **通用 MCP**：任何标准 MCP 客户端可加载（ZCode、Claude Code、Cursor 等）。

## 安装

```bash
git clone <this-repo> && cd pi-subagent
npm install
npm run build   # 可选；运行用 tsx 即可
```

前置：已安装 `pi` CLI（`npm i -g @earendil-works/pi-coding-agent`）。

## 配置 MCP host

在 MCP 客户端配置里加：

```json
{
  "mcpServers": {
    "pi-subagent": {
      "command": "npx",
      "args": ["tsx", "/abs/path/to/pi-subagent/src/server.ts"]
    }
  }
}
```

可选环境变量：
- `PI_SUBAGENT_REGISTRY`：session 注册表路径（默认 `~/.pi-subagent/registry.json`）。
- `PI_BIN`：覆盖 pi 可执行路径（测试用）。

## 工具

| 工具 | 用途 |
|------|------|
| `pi_plan` | 决策：该不该委派、sync/async、开几个 session |
| `pi_delegate` | 派任务（默认 async；新 session 等握手后返回） |
| `pi_status` | 收割 run 结果（long-poll） |
| `pi_session_list` | 列 session（不传 cwd 取全量） |
| `pi_session_snapshot` | 看 session 详情 |
| `pi_session_fork` | 从已有 session 派生（试另一条路） |
| `pi_kill` | 中止 run |

## Session 模型

- 每个 session 有人类可读名（如 `feat-auth`）+ pi 的 UUID + cwd + goal。
- 首次 `pi_delegate` 创建 session（必须传 `goal`），后续自动续接。
- session 注册表持久化到 `~/.pi-subagent/registry.json`（原子写，重启加载时修正中断的 running）。
- 并发上限 4 个 running run；同一 session 不并发。

## 测试

```bash
npm test           # 全量（79 个测试）
npm run test:fast  # dot 格式
```

测试用假 pi（`test/fixtures/fake-pi.sh`）覆盖：async/sync、超时、kill、session 创建失败、多等待者、progress 上限、调度规则、持久化等。

## 设计文档

- 完整设计 spec：`docs/superpowers/specs/2026-07-01-pi-subagent-design.md`（经 4 轮评审）
- 实现计划：`docs/superpowers/plans/2026-07-01-pi-subagent.md`

## License

MIT
