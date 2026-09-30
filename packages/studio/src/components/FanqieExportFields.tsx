/**
 * TXT 导出的可选排版。默认段间空一行、段首不缩进。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useId } from "react";

export interface FanqieFieldState {
  readonly from: string;
  readonly to: string;
  readonly layout: "combined" | "per-chapter";
  readonly blankLine: boolean;
  readonly indent: boolean;
}

export function FanqieExportFields({
  isZh,
  showRange,
  from,
  to,
  layout,
  blankLine,
  indent,
  onChange,
}: {
  readonly isZh: boolean;
  readonly showRange: boolean;
  readonly from: string;
  readonly to: string;
  readonly layout: "combined" | "per-chapter";
  readonly blankLine: boolean;
  readonly indent: boolean;
  readonly onChange: (patch: Partial<FanqieFieldState>) => void;
}) {
  const layoutName = useId();
  return (
    <div className="space-y-2 border-t border-border/60 pt-2" data-testid="fanqie-export-fields">
      {showRange ? (
        <>
          <div className="flex items-center gap-2 text-sm">
            <span>{isZh ? "从第" : "From"}</span>
            <input
              type="number"
              min={1}
              value={from}
              placeholder={isZh ? "起" : "start"}
              onChange={(event) => onChange({ from: event.target.value })}
              className="h-8 w-16 rounded-md border border-border bg-background px-2"
              data-testid="fanqie-from"
            />
            <span>{isZh ? "章到第" : "to"}</span>
            <input
              type="number"
              min={1}
              value={to}
              placeholder={isZh ? "止" : "end"}
              onChange={(event) => onChange({ to: event.target.value })}
              className="h-8 w-16 rounded-md border border-border bg-background px-2"
              data-testid="fanqie-to"
            />
            <span>{isZh ? "章" : ""}</span>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={layoutName}
              checked={layout === "combined"}
              onChange={() => onChange({ layout: "combined" })}
            />
            {isZh ? "合成一个文件" : "One file"}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={layoutName}
              checked={layout === "per-chapter"}
              onChange={() => onChange({ layout: "per-chapter" })}
              data-testid="fanqie-per-chapter"
            />
            {isZh ? "一章一个文件" : "One file per chapter"}
          </label>
        </>
      ) : null}
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={blankLine}
          onChange={(event) => onChange({ blankLine: event.target.checked })}
          data-testid="fanqie-blank-line"
        />
        {isZh ? "段间空一行" : "Blank line between paragraphs"}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={indent}
          onChange={(event) => onChange({ indent: event.target.checked })}
          data-testid="fanqie-indent"
        />
        {isZh ? "段首空两格" : "Indent paragraphs"}
      </label>
      <p className="text-xs leading-5 text-muted-foreground">
        {isZh
          ? "默认段间空一行、段首不缩进。空行是为了贴进番茄等平台后台时能分成一段一段；阅读器自己会缩进，再空两格容易叠成两层。预览段距太大，就把空行关掉。"
          : "Default: a blank line between paragraphs and no indent, so pasting into a platform editor can split paragraphs. Turn the blank line off if the preview looks too loose."}
      </p>
    </div>
  );
}
