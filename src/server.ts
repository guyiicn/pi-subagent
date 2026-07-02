#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { SessionRegistry } from "./registry/session.js";
import { RunRegistry } from "./registry/run.js";
import { ProcessTable } from "./runner/process-table.js";
import { loadRegistry, saveRegistry } from "./registry/persist.js";
import { loadTasks, saveTasks } from "./registry/task-persist.js";
import { TaskRegistry } from "./registry/task.js";
import { delegate } from "./tools/delegate.js";
import { status } from "./tools/status.js";
import { planTool } from "./tools/plan-tool.js";
import { sessionList, sessionSnapshot, sessionFork } from "./tools/session.js";
import { kill } from "./tools/kill.js";
import { taskCreate, taskList, taskPlan, taskStageRun, applyReviewResult } from "./tools/task.js";
import { join } from "node:path";
import { homedir } from "node:os";

const REGISTRY_PATH =
  process.env.PI_SUBAGENT_REGISTRY ?? join(homedir(), ".pi-subagent", "registry.json");
const TASKS_PATH =
  process.env.PI_SUBAGENT_TASKS ?? join(homedir(), ".pi-subagent", "tasks.json");

const sessions = new SessionRegistry();
const runs = new RunRegistry();
const procs = new ProcessTable();
const tasks = new TaskRegistry();

// 启动加载
const loaded = loadRegistry(REGISTRY_PATH);
sessions.loadAll(loaded.sessions);
const loadedTasks = loadTasks(TASKS_PATH);
tasks.loadAll(loadedTasks.tasks);

// session 持久化钩子
let savePending = false;
function persist() {
  if (savePending) return;
  savePending = true;
  queueMicrotask(() => {
    savePending = false;
    saveRegistry(REGISTRY_PATH, sessions.allPersistable()).catch(() => undefined);
  });
}

// task 持久化钩子
let taskSavePending = false;
function persistTasks() {
  if (taskSavePending) return;
  taskSavePending = true;
  queueMicrotask(() => {
    taskSavePending = false;
    saveTasks(TASKS_PATH, tasks.allPersistable()).catch(() => undefined);
  });
}
tasks.setPersistHook(persistTasks);

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
    {
      name: "pi_task_create",
      description: "建任务（host 已写好 _plan-draft.md）",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          goal: { type: "string" },
          cwd: { type: "string" },
          planDraftPath: { type: "string" },
          stages: { type: "array" },
        },
        required: ["taskId", "goal", "cwd", "planDraftPath", "stages"],
      },
    },
    {
      name: "pi_task_plan",
      description: "派审阅 Pi 审阅计划草案（两步拆解第2步）",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          constraints: { type: "object" },
          stallTimeoutMs: { type: "number" },
          runTimeoutMs: { type: "number" },
        },
        required: ["taskId"],
      },
    },
    {
      name: "pi_task_stage_run",
      description: "执行某阶段（含验收+最多3次重派+manual升级）",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          stageId: { type: "string" },
          constraints: { type: "object" },
          stallTimeoutMs: { type: "number" },
          runTimeoutMs: { type: "number" },
          maxAttempts: { type: "number" },
        },
        required: ["taskId", "stageId"],
      },
    },
    {
      name: "pi_task_list",
      description: "列任务（可按 taskId/status 过滤）",
      inputSchema: {
        type: "object",
        properties: {
          taskId: { type: "string" },
          status: { type: "string", enum: ["planning", "executing", "blocked_manual", "completed", "abandoned"] },
        },
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
      case "pi_task_create":
        result = taskCreate(args, { tasks, sessions, runs, procs, onTaskChange: persistTasks });
        break;
      case "pi_task_plan": {
        const r = await taskPlan(args, { tasks, sessions, runs, procs, onTaskChange: persistTasks });
        // async：host 之后用 pi_status(runId) 收割，收割后应调 applyReviewResult 解析 verdict
        result = r;
        break;
      }
      case "pi_task_stage_run":
        result = await taskStageRun(args, { tasks, sessions, runs, procs, onTaskChange: persistTasks });
        break;
      case "pi_task_list":
        result = taskList({ tasks, sessions, runs, procs }, { taskId: args.taskId, status: args.status });
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
