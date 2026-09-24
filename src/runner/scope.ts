import { readdirSync, statSync } from "node:fs";
import { join, relative, isAbsolute, basename, sep } from "node:path";

// 阶段写入范围检查：run 前后对任务 cwd 做快照 diff，找出 Pi 写了 outputFile 以外的哪些文件。
// 新建多余文件 → stray（默认只警告）；改/删不属于本阶段的既有文件 → violation（判失败）。

// 必然产生的副产品目录/文件，不纳入快照
const IGNORE_DIRS = new Set([".git", "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".venv", "venv"]);
const IGNORE_FILE = (name: string) => name.endsWith(".pyc") || name === ".DS_Store";

export const MAX_SNAPSHOT_FILES = 5000;

export interface DirSnapshot {
  files: Map<string, { mtimeMs: number; size: number }>;  // key: 相对 cwd 的路径（/ 分隔）
  truncated: boolean;                                       // 文件数超上限，快照不完整
}

export function snapshotDir(root: string, maxFiles = MAX_SNAPSHOT_FILES): DirSnapshot {
  const files: DirSnapshot["files"] = new Map();
  let truncated = false;
  const walk = (dir: string) => {
    if (truncated) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) {
        if (!IGNORE_DIRS.has(e.name)) walk(abs);
      } else if (e.isFile() && !IGNORE_FILE(e.name)) {
        if (files.size >= maxFiles) { truncated = true; return; }
        try {
          const st = statSync(abs);
          files.set(toRel(root, abs), { mtimeMs: st.mtimeMs, size: st.size });
        } catch {
          // 竞态删除，忽略
        }
      }
      if (truncated) return;
    }
  };
  walk(root);
  return { files, truncated };
}

export interface ScopeDiff {
  created: string[];
  modified: string[];
  deleted: string[];
}

export function diffSnapshots(before: DirSnapshot, after: DirSnapshot): ScopeDiff {
  const created: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];
  for (const [p, a] of after.files) {
    const b = before.files.get(p);
    if (!b) created.push(p);
    else if (b.mtimeMs !== a.mtimeMs || b.size !== a.size) modified.push(p);
  }
  for (const p of before.files.keys()) if (!after.files.has(p)) deleted.push(p);
  return { created: created.sort(), modified: modified.sort(), deleted: deleted.sort() };
}

// 简易 glob：** 任意层级，* 不跨目录，? 单字符；以 / 结尾表示目录前缀
export function globToRegExp(glob: string): RegExp {
  const g = glob.endsWith("/") ? `${glob}**` : glob;
  let re = "";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        i++;
        if (g[i + 1] === "/") { i++; re += "(?:.*/)?"; } else re += ".*";
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

export interface ScopeRules {
  cwd: string;
  outputFiles: string[];       // 本阶段 + 并发重叠阶段的产出（绝对或相对 cwd）
  allowExtraFiles?: string[];  // 额外允许的 glob（相对 cwd）
}

export interface ScopeCheck {
  stray: string[];        // 新建的多余文件
  violations: string[];   // 被改/删的不属于本阶段的文件（形如 "modified: a.py"）
}

export function checkScope(diff: ScopeDiff, rules: ScopeRules): ScopeCheck {
  const outputs = new Set(
    rules.outputFiles
      .map((p) => (isAbsolute(p) ? toRel(rules.cwd, p) : p.split(sep).join("/")))
      .filter((p) => !p.startsWith("../")),
  );
  const globs = (rules.allowExtraFiles ?? []).map(globToRegExp);
  const allowed = (p: string) =>
    outputs.has(p) || basename(p).startsWith("_") || globs.some((re) => re.test(p));
  return {
    stray: diff.created.filter((p) => !allowed(p)),
    violations: [
      ...diff.modified.filter((p) => !allowed(p)).map((p) => `modified: ${p}`),
      ...diff.deleted.filter((p) => !allowed(p)).map((p) => `deleted: ${p}`),
    ],
  };
}

function toRel(root: string, abs: string): string {
  return relative(root, abs).split(sep).join("/");
}
