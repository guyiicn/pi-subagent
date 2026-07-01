import type { ProgressEvent, Usage } from "../types.js";
import { redact } from "../registry/redact.js";

// 分类后的事件（只保留关心的）
export interface PiEvent {
  type: string;
  sessionId?: string;
  // tool_execution_end:
  toolName?: string;
  toolResultText?: string;
  // agent_end:
  messages?: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
  usage?: Usage;
}

// 解析单行；坏行返回 null（不抛）
export function classifyLine(line: string): PiEvent | null {
  if (!line || !line.trim()) return null;
  let obj: any;
  try { obj = JSON.parse(line); } catch { return null; }
  if (!obj || typeof obj.type !== "string") return null;

  switch (obj.type) {
    case "session":
      return { type: "session", sessionId: obj.id };
    case "tool_execution_end":
      return {
        type: "tool_execution_end",
        toolName: obj.toolName,
        toolResultText: extractToolText(obj.result),
      };
    case "agent_end":
      return { type: "agent_end", messages: obj.messages, usage: extractUsage(obj.messages) };
    default:
      return { type: obj.type };  // 其余 (delta/turn_*/message_*) 只记类型，内容丢弃
  }
}

function extractToolText(result: any): string | undefined {
  if (!result?.content) return undefined;
  const texts = result.content.filter((c: any) => c.type === "text").map((c: any) => c.text ?? "");
  return texts.join("\n") || undefined;
}

function extractUsage(messages: any[] | undefined): Usage | undefined {
  if (!messages) return undefined;
  // usage 通常在最后一条 assistant message 上
  for (let i = messages.length - 1; i >= 0; i--) {
    const u = messages[i]?.usage;
    if (u) {
      return {
        inputTokens: u.input,
        outputTokens: u.output,
        totalTokens: u.totalTokens,
        cost: u.cost?.total,
      };
    }
  }
  return undefined;
}

export interface Extracted {
  result: string | null;
  progress: ProgressEvent[];
  usage?: Usage;
}

// 从完整 NDJSON 行数组提取结果
export function extractResult(lines: string[]): Extracted {
  let result: string | null = null;
  let usage: Usage | undefined;
  const progress: ProgressEvent[] = [];

  for (const line of lines) {
    const ev = classifyLine(line);
    if (!ev) continue;
    if (ev.type === "tool_execution_end" && ev.toolResultText) {
      progress.push({ ts: Date.now(), tool: ev.toolName, summary: redact(ev.toolResultText) });
    } else if (ev.type === "agent_end") {
      usage = ev.usage;
      result = extractFinalAssistantText(ev.messages);
    }
  }
  return { result, progress, usage };
}

// 取最后一条 assistant 消息的文本
export function extractFinalAssistantText(messages?: PiEvent["messages"]): string | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant") {
      const text = m.content.filter(c => c.type === "text").map(c => c.text ?? "").join("");
      if (text.trim()) return text;
    }
  }
  return null;
}
