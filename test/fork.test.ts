import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionRegistry } from "../src/registry/session.js";
import { ProcessTable } from "../src/runner/process-table.js";
import { sessionFork } from "../src/tools/session.js";

test("fork to 已存在 → conflict", async () => {
  const sessions = new SessionRegistry();
  sessions.create({ name: "src", piSessionId: "u1", cwd: "/p", goal: "g" });
  sessions.create({ name: "dst", piSessionId: "u2", cwd: "/p", goal: "g" });
  await assert.rejects(
    () => sessionFork({ from: "src", to: "dst" }, { sessions, procs: new ProcessTable() }),
    (e: any) => e.code === "conflict",
  );
});

test("fork from 不存在 → not_found", async () => {
  const sessions = new SessionRegistry();
  await assert.rejects(
    () => sessionFork({ from: "nope", to: "dst" }, { sessions, procs: new ProcessTable() }),
    (e: any) => e.code === "not_found",
  );
});
