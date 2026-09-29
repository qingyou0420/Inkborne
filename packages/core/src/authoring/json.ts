/**
 * Extract JSON objects from model text.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export function extractJsonSlice(text: string): string {
  const trimmed = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = (fence?.[1] ?? trimmed).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("模型输出里没有找到 JSON 对象。");
  }
  return candidate.slice(start, end + 1);
}

function repairInvalidJsonEscapes(raw: string): string {
  return raw.replace(/\\(?!["\\/bfnrtu]|u[0-9a-fA-F]{4})/g, "\\\\");
}

/** Only mend paired quotes embedded in explicitly permitted prose fields. */
function repairTextQuotes(raw: string, fields: readonly string[]): string | undefined {
  const field = /"([^"\\]+)"\s*:\s*"/g;
  const allowed = new Set(fields);
  let result = "";
  let copiedThrough = 0;
  let changed = false;
  for (let match = field.exec(raw); match; match = field.exec(raw)) {
    if (!allowed.has(match[1]!)) continue;
    const start = field.lastIndex;
    let body = "";
    let quotes = 0;
    let closed = false;
    for (let i = start; i < raw.length; i += 1) {
      const char = raw[i]!;
      if (char === "\\") {
        if (i + 1 >= raw.length) return undefined;
        body += char + raw[++i]!;
      } else if (char === '"') {
        const after = raw.slice(i + 1).trimStart();
        if (after.startsWith("}") || /^,\s*"[^"\\]+"\s*:/.test(after)) {
          if (quotes % 2 !== 0) return undefined;
          result += raw.slice(copiedThrough, start) + body + '"';
          copiedThrough = i + 1;
          field.lastIndex = copiedThrough;
          changed ||= quotes > 0;
          closed = true;
          break;
        }
        // Do not turn missing commas/fields or a truncated envelope into prose.
        if (!after || /^["\[\]{},:]/.test(after) || /\s/.test(raw[i + 1] ?? "")) return undefined;
        body += '\\"';
        quotes += 1;
      } else {
        if (char.charCodeAt(0) < 32) return undefined;
        body += char;
      }
    }
    if (!closed) return undefined;
  }
  return changed ? result + raw.slice(copiedThrough) : undefined;
}

export function extractJsonObject(
  text: string,
  options?: { readonly repairTextFields?: readonly string[] },
): Record<string, unknown> {
  const slice = extractJsonSlice(text);
  try {
    return JSON.parse(slice) as Record<string, unknown>;
  } catch (first) {
    try {
      const escaped = repairInvalidJsonEscapes(slice);
      try {
        return JSON.parse(escaped) as Record<string, unknown>;
      } catch {
        const repaired = options?.repairTextFields && repairTextQuotes(escaped, options.repairTextFields);
        if (repaired) return JSON.parse(repaired) as Record<string, unknown>;
        throw first;
      }
    } catch {
      const message = first instanceof Error ? first.message : String(first);
      throw new Error(`规划结果不是合法 JSON：${message}`);
    }
  }
}

export function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean);
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}
