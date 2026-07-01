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

const REGISTRY_PATH =
  process.env.PI_SUBAGENT_REGISTRY ?? join(homedir(), ".pi-subagent", "registry.json");

const sessions = new SessionRegistry();
const runs = new RunRegistry();
const procs = new ProcessTable();

// 启动加载
const loaded = loadRegistry(REGISTRY_PATH);
sessions.loadAll(loaded.sessions);

// 持久化钩子：session 变更后落盘
let savePending = false;
function persist() {
  if (savePending) return;
  savePending = true;
  queueMicrotask(() => {
    savePending = false;
    saveRegistry(REGISTRY_PATH, sessions.allPersistable()).catch(() => undefined);
  });
}

const server = new Server(
  { name: "pi-subagent", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "pi_delegate",
      description: "委派任务给 Pi 子代理（默认 async）",
      inputSchema: {
        type: "object",
        properties: {
          prompt: { type: "string" },
          session: { type: "string" },
          cwd: { type: "string" },
          goal: { type: "string" },
          constraints: { type: "object" },
          mode: { type: "string", enum: ["sync", "async"] },
          runTimeoutMs: { type: "number" },
          allowUnknownTools: { type: "boolean" },
        },
        required: ["prompt", "session"],
      },
    },
    {
      name: "pi_status",
      description: "取 run 结果（long-poll）",
      inputSchema: {
        type: "object",
        properties: { runId: { type: "string" }, waitTimeoutMs: { type: "number" } },
        required: ["runId"],
      },
    },
    {
      name: "pi_plan",
      description: "调度决策：该不该委派、sync/async、开几个 session",
      inputSchema: {
        type: "object",
        properties: {
          task: { type: "string" },
          fanout: { type: "number" },
          estComplexity: { type: "string", enum: ["low", "medium", "high"] },
          cwd: { type: "string" },
          preferredMode: { type: "string", enum: ["sync", "async"] },
        },
        required: ["task", "cwd"],
      },
    },
    {
      name: "pi_session_list",
      description: "列 session（不传 cwd 取全量，供 pi_plan 用）",
      inputSchema: { type: "object", properties: { cwd: { type: "string" } } },
    },
    {
      name: "pi_session_snapshot",
      description: "取 session 详情",
      inputSchema: {
        type: "object",
        properties: { session: { type: "string" } },
        required: ["session"],
      },
    },
    {
      name: "pi_session_fork",
      description: "派生 session",
      inputSchema: {
        type: "object",
        properties: { from: { type: "string" }, to: { type: "string" } },
        required: ["from", "to"],
      },
    },
    {
      name: "pi_kill",
      description: "中止 run",
      inputSchema: {
        type: "object",
        properties: { runId: { type: "string" } },
        required: ["runId"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = (req.params.arguments ?? {}) as any;
  try {
    let result: unknown;
    switch (req.params.name) {
      case "pi_delegate":
        result = await delegate(args, { sessions, runs, procs, onSessionChange: persist });
        break;
      case "pi_status":
        result = await status(args, runs);
        break;
      case "pi_plan":
        result = planTool(args, sessions);
        break;
      case "pi_session_list":
        result = sessionList(sessions, args.cwd);
        break;
      case "pi_session_snapshot":
        result = sessionSnapshot(sessions, args.session);
        break;
      case "pi_session_fork":
        result = await sessionFork(args, { sessions, procs });
        break;
      case "pi_kill":
        result = kill(args, { runs, procs, sessions });
        break;
      default:
        return {
          content: [{ type: "text", text: JSON.stringify({ error: "unknown tool" }) }],
          isError: true,
        };
    }
    persist();
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (e: any) {
    const payload = e?.code ? e : { error: String(e), code: "internal" };
    return { content: [{ type: "text", text: JSON.stringify(payload) }], isError: true };
  }
});

// 退出清理：kill 所有 managed child
function cleanup() {
  procs.killAll();
}
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});
process.on("exit", cleanup);

const transport = new StdioServerTransport();
await server.connect(transport);
