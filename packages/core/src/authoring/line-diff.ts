/**
 * Longest-common-subsequence line diff for version compare.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export interface DiffLine {
  readonly kind: "add" | "del" | "same";
  readonly text: string;
}

/**
 * Line-level diff. A paragraph inserted at the top stays an insertion;
 * the unchanged lines below are not marked as rewritten.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = before.replace(/\r\n/g, "\n").split("\n");
  const b = after.replace(/\r\n/g, "\n").split("\n");
  const n = a.length;
  const m = b.length;
  const cells = (n + 1) * (m + 1);
  if (cells > 4_000_000) return boundedLineDiff(a, b);
  const width = m + 1;
  const dp = new Uint32Array(cells);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const index = i * width + j;
      if (a[i] === b[j]) dp[index] = dp[(i + 1) * width + (j + 1)]! + 1;
      else dp[index] = Math.max(dp[(i + 1) * width + j]!, dp[i * width + (j + 1)]!);
    }
  }
  const rows: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      rows.push({ kind: "same", text: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * width + j]! >= dp[i * width + (j + 1)]!) {
      rows.push({ kind: "del", text: a[i]! });
      i += 1;
    } else {
      rows.push({ kind: "add", text: b[j]! });
      j += 1;
    }
  }
  while (i < n) {
    rows.push({ kind: "del", text: a[i]! });
    i += 1;
  }
  while (j < m) {
    rows.push({ kind: "add", text: b[j]! });
    j += 1;
  }
  return rows;
}

/** Windowed fallback so a huge paste cannot allocate a giant table. */
function boundedLineDiff(a: readonly string[], b: readonly string[]): DiffLine[] {
  const window = 400;
  const rows: DiffLine[] = [];
  const steps = Math.max(Math.ceil(a.length / window), Math.ceil(b.length / window), 1);
  for (let step = 0; step < steps; step += 1) {
    const left = a.slice(step * window, (step + 1) * window).join("\n");
    const right = b.slice(step * window, (step + 1) * window).join("\n");
    rows.push(...diffLines(left, right));
  }
  return rows;
}
