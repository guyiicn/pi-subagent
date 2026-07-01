import type { Constraints } from "../types.js";

export interface DelegateArgsInput {
  prompt: string;
  sessionId?: string;       // undefined = 创建新 session
  constraints: Constraints;
}

export function buildDelegateArgs(input: DelegateArgsInput): string[] {
  const args = ["-p", input.prompt, "--mode", "json"];
  if (input.sessionId) args.push("--session-id", input.sessionId);
  const c = input.constraints;
  if (c.tools?.length) args.push("--tools", c.tools.join(","));
  if (c.excludeTools?.length) args.push("--exclude-tools", c.excludeTools.join(","));
  if (c.thinking) args.push("--thinking", c.thinking);
  if (c.model) args.push("--model", c.model);
  // v1 不传: --session-dir, --provider, --append-system-prompt (spec §11)
  return args;
}

export function buildForkArgs(sourceSessionId: string): string[] {
  return ["--mode", "json", "--fork", sourceSessionId];
}
