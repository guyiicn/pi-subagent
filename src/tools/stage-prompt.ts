import { join } from "node:path";
import type { Stage, Task, StageAttempt } from "../types.js";

// design-batch1.md §F.3 / §G：IOAC 执行 prompt + 升级指令

export interface PrevFailure {
  failureType: StageAttempt["failureType"];
  failureDetail: string;
}

// 阶段执行 prompt（IOAC）
export function buildStagePrompt(
  stage: Stage,
  task: Task,
  attemptNo: number,
  prevFailure?: PrevFailure,
): string {
  const abs = (p: string) => join(task.cwd, p);
  const inputs = (stage.inputFiles ?? []).map(abs);   // 防御 undefined
  const output = abs(stage.outputFile ?? "output.txt");

  const lines: string[] = [];
  lines.push("【输入】读以下文件获取上下文（不要联网，资料已提供）：");
  for (const f of inputs) lines.push(`  - ${f}`);
  if (task.planReviewedPath) lines.push(`  - ${abs(task.planReviewedPath)}（审阅后的计划，含技术要点校准）`);

  lines.push("");
  lines.push(`【目标】${stage.objective}（章节：${stage.title}）`);

  lines.push("");
  lines.push("【约束】");
  lines.push("- 不要联网搜索，所有需要的资料已在输入文件中。");
  lines.push(`- 只写这一个文件：${output}。不要修改其他任何文件。`);
  lines.push("");
  lines.push("【工作节奏（必须遵守，否则会被判停滞中止）】");
  lines.push("- 第1步：read 输入文件。");
  lines.push("- 第2步：立即用 write 创建文件骨架（空结构 + 各小节标题），不要先想完整内容。");
  lines.push("- 第3步起：用 edit 每次只填充 1 个小节，连续做直到填完。");
  lines.push("- 每个 edit/write/read 都是独立 tool 调用，中间绝不要长时间纯思考——频繁调用工具保持进度。");
  if (stage.promptHint) lines.push(`- 特别注意：${stage.promptHint}`);

  // 升级指令（attempt > 1）
  if (attemptNo > 1 && prevFailure) {
    lines.push("");
    lines.push("【上次失败与改进】");
    lines.push(buildUpgradeHint(prevFailure.failureType, prevFailure.failureDetail));
  }

  lines.push("");
  lines.push("【验收】完成后自查：");
  lines.push(`- 文件 ${output} 已存在且非空`);
  lines.push("- 不含 TODO 占位符");
  lines.push("- 内容完整覆盖目标");

  return lines.join("\n");
}

// design-batch1.md §G：按 failureType 套升级模板
export function buildUpgradeHint(
  failureType: StageAttempt["failureType"],
  failureDetail: string,
): string {
  switch (failureType) {
    case "no_output":
      return `上次失败：未生成输出文件。你必须在本次第一步就用 write 工具创建文件骨架，再逐步填充。不要只回复内容，必须落盘。（详情：${failureDetail}）`;
    case "incomplete":
      return `上次失败：输出不完整（${failureDetail}）。请补全缺失部分。完成后重读文件确认无 TODO/占位。`;
    case "wrong_content":
      return `上次失败：内容不符验收（${failureDetail}）。请对照验收规则修正。`;
    case "timeout":
      return `上次失败：超时（可能是步骤过多或卡住）。本次请减少步骤：先写最小可用版本落盘，再迭代。不要在单步上反复。`;
    case "stalled":
      return `上次失败：长时间无进展被中止（疑似卡在某工具调用）。本次每完成一步就推进，避免在单一操作上停滞。`;
    case "pi_refused":
      return `上次失败：你表示无法完成（${failureDetail}）。材料已在输入文件中。请基于已有材料直接产出，不要要求更多信息。`;
    default:
      return `上次失败（${failureType}）：${failureDetail}。请调整方法，确保本次产出落盘。`;
  }
}

// design-batch1.md §F.2：审阅 prompt
export function buildReviewPrompt(task: Task): string {
  const abs = (p: string) => join(task.cwd, p);
  const reviewedPath = abs("_plan-reviewed.md");
  const draftPath = abs(task.planDraftPath);
  const refsPath = abs("_refs.md");

  return [
    "【输入】读以下文件：",
    `  - ${draftPath}（host 写的工程草案，含阶段划分）`,
    `  - ${refsPath}（参考资料，若存在）`,
    "",
    "【目标】你是领域审阅者（不是重写者）。从领域正确性角度审阅草案：",
    "1. 章节划分合理吗？有没有遗漏的关键概念？",
    "2. 各阶段的技术要点准确吗？",
    "3. 阶段间的依赖顺序对吗？",
    "4. 哪些阶段可以并行、哪些必须串行？",
    "只在领域正确性上提修改，不要动工程结构。最多提 3 处修改。",
    "",
    "【约束】",
    "- 不要联网。",
    `- 只写一个文件：${reviewedPath}。不要改草案，不要改其他文件。`,
    "",
    "【验收】产出文件必须以这行开头（三选一）：",
    "  verdict: approve",
    "  verdict: approve_with_changes",
    "  verdict: reject",
    "随后列出审阅意见和修改建议（如有）。",
  ].join("\n");
}
