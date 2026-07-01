// spec §4 redaction: best-effort，挡住常见明文泄露
const RE_TOKEN = /[A-Za-z0-9_\-]{20,}/g;
const RE_SENSITIVE_KV = /(password|passwd|secret|token|api[_-]?key|access[_-]?key|authorization|credential)s?\s*[:=]\s*\S+/gi;

export function redact(input: string, maxLen = 200): string {
  let s = input;
  s = s.replace(RE_TOKEN, "***");
  s = s.replace(RE_SENSITIVE_KV, "***");
  return s.length <= maxLen ? s : s.slice(0, maxLen);
}
