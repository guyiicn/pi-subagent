import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// fake-pi.sh 的绝对路径（用 bash 调用，绕开可执行权限依赖）
const FAKE_PI = `bash ${resolve(process.cwd(), "test/fixtures/fake-pi.sh")}`;

// 提供临时 cwd + 设 PI_BIN/FAKE_PI_MODE
export function fakePiEnv(
  mode: "success" | "no_session" | "hang" | "error_exit" | "stall" | "stage_success" | "stage_success_secondtry" = "success",
) {
  return {
    PI_BIN: FAKE_PI,
    FAKE_PI_MODE: mode,
  };
}

export function tmpCwd(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-sub-cwd-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export async function withEnv(env: Record<string, string>, fn: () => Promise<void>): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    process.env[k] = env[k];
  }
  try {
    await fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}
