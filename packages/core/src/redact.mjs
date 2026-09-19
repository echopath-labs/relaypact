const sensitiveAssignment = /\b[A-Za-z0-9_]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|password|secret)\s*[:=]\s*[^\s,;]+/gi;
const bearerValue = /\bBearer\s+[A-Za-z0-9._~+\/-]+/gi;
const likelyKey = /\b(sk-[A-Za-z0-9_-]{8,}|gh[opusr]_[A-Za-z0-9_]{8,})\b/g;
const MAX_URL_PATH_DECODE_DEPTH = 2;

export class SensitiveUrlDecodeBudgetError extends Error {
  constructor() {
    super("Provider URL path exceeds the supported percent-decoding bound.");
    this.name = "SensitiveUrlDecodeBudgetError";
  }
}

export class SensitiveUrlEncodingError extends Error {
  constructor() {
    super("Provider URL path contains malformed percent encoding.");
    this.name = "SensitiveUrlEncodingError";
  }
}

export function containsExactSensitiveValue(text, sensitiveValues = []) {
  const candidate = String(text ?? "");
  return sensitiveValues.some((value) =>
    typeof value === "string" && value.length > 0 && candidate.includes(value)
  );
}

function addPathRepresentations(value, candidates, depth = 0) {
  if (typeof value !== "string" || value.length === 0) return;
  candidates.add(value);
  for (const segment of value.split(/[\\/]/u).filter(Boolean)) candidates.add(segment);
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new SensitiveUrlEncodingError();
  }
  if (decoded === value) return;
  if (depth >= MAX_URL_PATH_DECODE_DEPTH) throw new SensitiveUrlDecodeBudgetError();
  addPathRepresentations(decoded, candidates, depth + 1);
}

export function sensitiveUrlValues(value) {
  const parsed = new URL(value);
  const candidates = new Set([value, parsed.toString(), parsed.hostname, parsed.pathname]);
  const raw = value.match(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/u);
  if (raw) {
    const rawAuthority = raw[1];
    const rawHostPort = rawAuthority.slice(rawAuthority.lastIndexOf("@") + 1);
    const rawHost = rawHostPort.startsWith("[")
      ? rawHostPort.slice(0, rawHostPort.indexOf("]") + 1)
      : rawHostPort.replace(/:\d+$/u, "");
    candidates.add(rawAuthority);
    candidates.add(rawHostPort);
    candidates.add(rawHost);
    for (const label of rawHost.replace(/^\[|\]$/gu, "").split(".")) candidates.add(label);
    addPathRepresentations(raw[2], candidates);
  }
  for (const label of parsed.hostname.split(".")) candidates.add(label);
  candidates.add(parsed.host);
  candidates.add(parsed.username);
  candidates.add(parsed.password);
  candidates.add(parsed.search);
  candidates.add(parsed.hash);
  for (const [, parameter] of parsed.searchParams) candidates.add(parameter);
  addPathRepresentations(parsed.pathname, candidates);
  return [...candidates].filter((candidate) => typeof candidate === "string" && candidate.length >= 4);
}

export function redact(text, sensitiveValues = []) {
  let safe = String(text ?? "");
  for (const value of sensitiveValues) {
    if (typeof value !== "string" || value.length === 0) continue;
    safe = safe.split(value).join("[REDACTED_EXACT_VALUE]");
  }
  return safe
    .replace(sensitiveAssignment, "[REDACTED_CREDENTIAL]")
    .replace(bearerValue, "Bearer [REDACTED]")
    .replace(likelyKey, "[REDACTED]");
}

export function conciseOutput(text, maxLength = 4000, sensitiveValues = []) {
  const safe = redact(text, sensitiveValues).trim();
  if (safe.length <= maxLength) return safe;
  let end = maxLength;
  const high = safe.charCodeAt(end - 1);
  const low = safe.charCodeAt(end);
  // Only back up when truncation would split a well-formed UTF-16 surrogate pair.
  if (high >= 0xD800 && high <= 0xDBFF && low >= 0xDC00 && low <= 0xDFFF) end -= 1;
  return `${safe.slice(0, end)}\n[output truncated]`;
}
