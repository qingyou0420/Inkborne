/**
 * S07: version compare before adopt.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useApi } from "../hooks/use-api";
import { Drawer } from "./ui/drawer";

interface DiffResponse {
  readonly left?: { readonly version: number; readonly label?: string; readonly status?: string };
  readonly right?: { readonly version: number; readonly label?: string; readonly status?: string };
  readonly hunks?: ReadonlyArray<{ readonly kind: "add" | "del" | "same"; readonly text: string }>;
}

export function AuthoringDiffDrawer({
  open,
  bookId,
  leftId,
  rightId,
  adoptedId,
  isZh,
  onClose,
  onKeep,
  onAdopt,
}: {
  readonly open: boolean;
  readonly bookId: string;
  readonly leftId?: string;
  readonly rightId?: string;
  readonly adoptedId?: string;
  readonly isZh: boolean;
  readonly onClose: () => void;
  readonly onKeep?: () => void;
  readonly onAdopt?: () => void;
}) {
  const query = leftId && rightId && leftId !== rightId
    ? `/authoring/diff?bookId=${encodeURIComponent(bookId)}&left=${encodeURIComponent(leftId)}&right=${encodeURIComponent(rightId)}`
    : "";
  const { data } = useApi<DiffResponse>(query);
  const hunks = data?.hunks ?? [];

  return (
    <Drawer open={open} title={isZh ? "版本比较" : "Compare versions"} onClose={onClose} testId="authoring-diff-drawer">
      <div className="space-y-3">
        <p className="text-xs text-muted-foreground">
          {leftId && rightId && leftId !== rightId
            ? `${isZh ? "左：修改前" : "Left: before"} v${data?.left?.version ?? "—"} · ${isZh ? "右：新稿" : "Right: new"} v${data?.right?.version ?? "—"}`
            : (isZh ? "没有可比较的修改前稿。" : "No earlier baseline to compare.")}
          {adoptedId ? (isZh ? " · 正式采用稿另有一份" : " · adopted copy is separate") : ""}
        </p>
        <div className="max-h-[55vh] overflow-auto rounded-lg border border-border bg-background p-3 font-serif text-[14px] leading-6">
          {hunks.length === 0 ? (
            <p className="text-sm text-muted-foreground">{isZh ? "没有可比较的差异。" : "No diff yet."}</p>
          ) : hunks.map((hunk, index) => (
            <div
              key={`${hunk.kind}-${index}`}
              className={
                hunk.kind === "add"
                  ? "bg-[oklch(0.95_0.016_160)] px-1"
                  : hunk.kind === "del"
                    ? "bg-mark-soft px-1 line-through"
                    : "px-1"
              }
            >
              <span className="mr-2 text-[11px] text-muted-foreground">
                {hunk.kind === "add" ? (isZh ? "新增" : "add") : hunk.kind === "del" ? (isZh ? "删除" : "del") : (isZh ? "保留" : "keep")}
              </span>
              {hunk.text || " "}
            </div>
          ))}
        </div>
        <div className="flex gap-2">
          {onKeep ? (
            <button type="button" className="rounded-lg border border-border px-3 py-2 text-sm" onClick={onKeep}>
              {isZh ? "保留原稿" : "Keep original"}
            </button>
          ) : null}
          {onAdopt ? (
            <button type="button" className="flex-1 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground" onClick={onAdopt}>
              {isZh ? "采用新稿" : "Adopt new"}
            </button>
          ) : null}
        </div>
      </div>
    </Drawer>
  );
}
