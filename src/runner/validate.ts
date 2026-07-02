import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { execSync } from "node:child_process";
import type { ValidateRule } from "../types.js";

// 默认验收规则（design-batch1.md §C.2）
export const DEFAULT_VALIDATE_RULES: ValidateRule[] = [
  { kind: "file_exists" },
  { kind: "file_nonempty" },
  { kind: "not_contains", pattern: "TODO" },
];

export interface ValidateResult {
  passed: boolean;
  failedRule?: ValidateRule;   // 第一条失败的规则（passed=false 时有）
  detail?: string;             // 失败原因
}

// 按规则列表顺序检查；任一 fail 即返回（短路）
export function validateFile(filePath: string, rules?: ValidateRule[]): ValidateResult {
  const rs = rules ?? DEFAULT_VALIDATE_RULES;
  for (const rule of rs) {
    const r = checkOne(filePath, rule);
    if (!r.passed) return r;
  }
  return { passed: true };
}

// 多文件验收（P0 问题2）：outputFile 可能是逗号/分号分隔的多路径
// 对每个文件独立用相同规则检查，任一失败即返回（含失败文件路径）
export function validateFiles(outputSpec: string, cwd: string, rules?: ValidateRule[]): ValidateResult {
  const files = splitOutputFiles(outputSpec, cwd);
  for (const f of files) {
    const r = validateFile(f, rules);
    if (!r.passed) {
      return { ...r, detail: `${f}: ${r.detail ?? "validation failed"}` };
    }
  }
  return { passed: true };
}

// 拆分 outputFile 字符串为绝对路径数组（支持逗号/分号分隔，trim 空白）
export function splitOutputFiles(outputSpec: string, cwd: string): string[] {
  return outputSpec
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => (isAbsolute(p) ? p : join(cwd, p)));
}

function checkOne(filePath: string, rule: ValidateRule): ValidateResult {
  // file_exists: 文件须存在且是普通文件
  if (rule.kind === "file_exists") {
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return { passed: false, failedRule: rule, detail: `file does not exist: ${filePath}` };
    }
    return { passed: true };
  }
  // 其余规则都需要读内容；若文件不存在统一判 fail（覆盖 file_nonempty 等的前置）
  if (!existsSync(filePath) || !statSync(filePath).isFile()) {
    return { passed: false, failedRule: rule, detail: `file does not exist: ${filePath}` };
  }
  const content = readFileSync(filePath, "utf8");

  switch (rule.kind) {
    case "file_nonempty":
      return content.trim().length > 0
        ? { passed: true }
        : { passed: false, failedRule: rule, detail: "file is empty" };
    case "contains":
      return content.includes(rule.pattern ?? "")
        ? { passed: true }
        : { passed: false, failedRule: rule, detail: `missing pattern: ${rule.pattern}` };
    case "not_contains":
      return !content.includes(rule.pattern ?? "")
        ? { passed: true }
        : { passed: false, failedRule: rule, detail: `forbidden pattern present: ${rule.pattern}` };
    case "regex":
      try {
        const re = new RegExp(rule.pattern ?? "");
        return re.test(content)
          ? { passed: true }
          : { passed: false, failedRule: rule, detail: `regex not matched: ${rule.pattern}` };
      } catch (e) {
        return { passed: false, failedRule: rule, detail: `invalid regex: ${(e as Error).message}` };
      }
    case "run_check":
      // 运行时语法检查（增强建议）。pattern 指定检查器命令前缀
      return runCheck(filePath, rule.pattern ?? "node");
    default:
      return { passed: false, failedRule: rule, detail: `unknown rule kind` };
  }
}

// 运行时语法检查（同步 execSync，超时 10s）
function runCheck(filePath: string, checker: string): ValidateResult {
  const rule: ValidateRule = { kind: "run_check", pattern: checker };
  let cmd: string;
  if (checker === "node") {
    cmd = `node --check "${filePath}"`;
  } else if (checker === "bash" || checker === "bash -n") {
    cmd = `bash -n "${filePath}"`;
  } else {
    // 自定义：直接当 shell 命令，{} 替换为文件路径
    cmd = checker.includes("{}") ? checker.replace(/\{\}/g, `"${filePath}"`) : `${checker} "${filePath}"`;
  }
  try {
    execSync(cmd, { timeout: 10000, stdio: ["ignore", "pipe", "pipe"] });
    return { passed: true };
  } catch (e: any) {
    const stderr = (e.stderr ?? e.stdout ?? "").toString().slice(0, 200);
    return { passed: false, failedRule: rule, detail: `${checker} failed: ${stderr || e.message}` };
  }
}
