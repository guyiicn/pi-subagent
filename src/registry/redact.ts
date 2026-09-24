// spec §4 redaction: best-effort，挡住常见明文泄露。
// 只打码"像密钥"的内容：已知格式 + 高熵兜底。不再笼统打码 20+ 字符长串——
// 那会误伤 UUID / 路径片段 / git sha，让 progress 难以阅读。

// PEM 私钥块（含未闭合的截断块）
const RE_PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g;
const RE_SENSITIVE_KV = /(password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization|credential)s?\s*[:=]\s*\S+/gi;
const RE_BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
// JWT（header 以 eyJ 开头的 base64url，含可选的 payload/signature 段）
const RE_JWT = /\beyJ[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]+){0,2}/g;
// 已知前缀的密钥格式
const RE_PREFIXED = new RegExp(
  [
    "\\bsk-[A-Za-z0-9_-]{16,}",           // OpenAI / Anthropic 等
    "\\bgh[pousr]_[A-Za-z0-9]{20,}",       // GitHub tokens
    "\\bgithub_pat_[A-Za-z0-9_]{20,}",
    "\\bglpat-[A-Za-z0-9_-]{20,}",         // GitLab
    "\\bxox[abprs]-[A-Za-z0-9-]{10,}",     // Slack
    "\\bAKIA[0-9A-Z]{16}\\b",              // AWS access key id
    "\\bAIza[0-9A-Za-z_-]{35}",            // Google API key
  ].join("|"),
  "g",
);
// 高熵兜底：≥32 字符且同时含大写、小写、数字。全小写 hex 的 UUID / git sha 天然不命中；
// 字符集不含 "/"，路径不会被连成一个长串
const RE_LONG_RUN = /[A-Za-z0-9_+=-]{32,}/g;
const looksHighEntropy = (s: string) => /[A-Z]/.test(s) && /[a-z]/.test(s) && /\d/.test(s);

export function redact(input: string, maxLen = 200): string {
  let s = input;
  s = s.replace(RE_PEM, "***");
  s = s.replace(RE_SENSITIVE_KV, "***");
  s = s.replace(RE_BEARER, "Bearer ***");
  s = s.replace(RE_JWT, "***");
  s = s.replace(RE_PREFIXED, "***");
  s = s.replace(RE_LONG_RUN, (m) => (looksHighEntropy(m) ? "***" : m));
  return s.length <= maxLen ? s : s.slice(0, maxLen);
}
