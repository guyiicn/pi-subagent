import { ERROR_CODES } from "./types.js";

export interface ToolError {
  error: string;
  code: string;
  detail?: unknown;
}

export function makeError(code: string, message: string, detail?: unknown): ToolError {
  const e: ToolError = { error: message, code };
  if (detail !== undefined) e.detail = detail;
  return e;
}

// 便捷构造器（均为 ToolError，可被 throw）
export const Errors = {
  invalidArg: (msg: string, detail?: unknown) => makeError(ERROR_CODES.INVALID_ARG, msg, detail),
  goalRequired: () => makeError(ERROR_CODES.GOAL_REQUIRED, "goal required to create session"),
  cwdInvalid: (cwd: string) => makeError(ERROR_CODES.CWD_INVALID, `cwd does not exist or not a directory: ${cwd}`),
  cwdMismatch: (name: string, existing: string) => makeError(ERROR_CODES.CWD_MISMATCH, `session ${name} already bound to cwd ${existing}`),
  sessionBusy: (name: string, runId: string) => makeError(ERROR_CODES.SESSION_BUSY, `session ${name} is running`, { runId }),
  unknownTool: (name: string) => makeError(ERROR_CODES.UNKNOWN_TOOL, `unknown tool name: ${name}`),
  notFound: (what: string) => makeError(ERROR_CODES.NOT_FOUND, `not found: ${what}`),
  conflict: (what: string) => makeError(ERROR_CODES.CONFLICT, `already exists: ${what}`),
  resourceBusy: () => makeError(ERROR_CODES.RESOURCE_BUSY, "concurrency limit (4) reached"),
  forkTimeout: () => makeError(ERROR_CODES.FORK_TIMEOUT, "fork process timed out"),
  runExpired: (runId: string) => makeError(ERROR_CODES.RUN_EXPIRED, `run expired: ${runId}`),
};
