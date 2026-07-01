// spec §6 信号词词表（加词即加测试，不改逻辑）
export const REJECT_WORDS = ["精修", "反复调", "我亲自", "亲手"] as const;
export const DELEGATE_WORDS = ["探索整个", "并行对比", "独立实现", "同时调研"] as const;
export const DANGER_WORDS = ["删除", "rm ", "rm -", "force", "reset --hard", "drop table"] as const;

export function containsAny(text: string, words: readonly string[]): boolean {
  const lower = text.toLowerCase();
  return words.some(w => lower.includes(w.toLowerCase()));
}
