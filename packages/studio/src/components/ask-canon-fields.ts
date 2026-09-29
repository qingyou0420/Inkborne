/** Canon form fields preserve the original document outside the edited field.
 * SPDX-License-Identifier: AGPL-3.0-only */
export const canonFieldNames = ["title", "genre", "targetChapters", "chapterWordCount"] as const;
export type CanonFieldName = typeof canonFieldNames[number];

function splitCanon(body: string) {
  const match = /^(\uFEFF?---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/.exec(body);
  return match
    ? { prefix: match[1]!, meta: match[2]!, close: match[3]!, text: body.slice(match[0].length) }
    : { prefix: "---\n", meta: "", close: "\n---\n\n", text: body };
}

export function readCanonFields(body: string) {
  const split = splitCanon(body);
  const fields = Object.fromEntries(canonFieldNames.map((key) => [key, ""])) as Record<CanonFieldName, string>;
  for (const line of split.meta.split(/\r?\n/)) {
    const match = /^(title|genre|targetChapters|chapterWordCount):\s*(.*)$/.exec(line);
    if (!match) continue;
    const raw = match[2]!.trim();
    let value = raw;
    if (raw.startsWith('"') && raw.endsWith('"')) {
      try { value = String(JSON.parse(raw)); } catch { value = raw.slice(1, -1); }
    } else if (raw.startsWith("'") && raw.endsWith("'")) value = raw.slice(1, -1).replace(/''/g, "'");
    fields[match[1] as CanonFieldName] = value;
  }
  return { fields, text: split.text };
}

export function updateCanonField(body: string, field: CanonFieldName, value: string) {
  const split = splitCanon(body);
  const lines = split.meta ? split.meta.split(/\r?\n/) : [];
  const index = lines.findIndex((line) => line.startsWith(`${field}:`));
  const scalar = field === "targetChapters" || field === "chapterWordCount" ? value : JSON.stringify(value);
  if (!value.trim()) { if (index >= 0) lines.splice(index, 1); }
  else if (index >= 0) lines[index] = `${field}: ${scalar}`;
  else lines.push(`${field}: ${scalar}`);
  return `${split.prefix}${lines.join(split.prefix.includes("\r\n") ? "\r\n" : "\n")}${split.close}${split.text}`;
}

export function updateCanonText(body: string, text: string) {
  const match = /^(\uFEFF?---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$))/.exec(body);
  return match ? `${match[0]}${text}` : text;
}

export function canonLengthMissing(fields: Record<CanonFieldName, string>): boolean {
  return !fields.targetChapters.trim() || !fields.chapterWordCount.trim();
}

export function validateCanonFields(body: string, isZh: boolean, options?: { requireLength?: boolean }): string | undefined {
  const { fields } = readCanonFields(body);
  if (!fields.title.trim()) return isZh ? "请填写书名。" : "Enter a book title.";
  if (options?.requireLength && !fields.targetChapters.trim()) {
    return isZh ? "请填写预计章节，未填写不能建书。" : "Enter the target chapter count before creating the book.";
  }
  if (options?.requireLength && !fields.chapterWordCount.trim()) {
    return isZh ? "请填写每章字数，未填写不能建书。" : "Enter words per chapter before creating the book.";
  }
  if (fields.targetChapters && (!Number.isInteger(Number(fields.targetChapters)) || Number(fields.targetChapters) < 1)) {
    return isZh ? "预计章节须为大于 0 的整数，也可以留空。" : "Chapters must be a positive integer, or left empty.";
  }
  if (fields.chapterWordCount && (!Number.isInteger(Number(fields.chapterWordCount)) || Number(fields.chapterWordCount) < 100)) {
    return isZh ? "每章字数须为不少于 100 的整数，也可以留空。" : "Words per chapter must be an integer of at least 100, or left empty.";
  }
}
