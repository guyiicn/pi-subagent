import { test } from "node:test";
import assert from "node:assert/strict";
import { ERROR_CODES, PI_BUILTIN_TOOLS } from "../src/types.js";

test("ERROR_CODES 包含全部稳定码", () => {
  const codes = Object.values(ERROR_CODES);
  for (const required of [
    "invalid_arg", "goal_required", "cwd_invalid", "cwd_mismatch", "session_busy",
    "unknown_tool", "not_found", "conflict", "run_expired", "resource_busy",
    "fork_timeout", "session_create_failed", "session_start_timeout", "interrupted_by_restart",
  ]) {
    assert.ok(codes.includes(required as never), `missing code: ${required}`);
  }
});

test("PI_BUILTIN_TOOLS 含 read/bash/edit/write", () => {
  assert.deepEqual([...PI_BUILTIN_TOOLS].sort(), ["bash", "edit", "read", "write"]);
});
