import { existsSync, readFileSync, statSync } from "node:fs";
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
    default:
      return { passed: false, failedRule: rule, detail: `unknown rule kind` };
  }
}
