/**
 * TXT 导出的可选排版。默认段间空一行、段首不缩进。
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useId, type KeyboardEvent, type MouseEvent } from "react";
import { useI18n } from "../hooks/use-i18n";
import { stepRangeField } from "../lib/export-range";

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
  onCommit,
  chapterCount,
  swapped = false,
}: {
  readonly isZh: boolean;
  readonly showRange: boolean;
  readonly from: string;
  readonly to: string;
  readonly layout: "combined" | "per-chapter";
  readonly blankLine: boolean;
  readonly indent: boolean;
  readonly onChange: (patch: Partial<FanqieFieldState>) => void;
  /** Blur and Enter pass the raw draft. A step passes the adjusted number. */
  readonly onCommit?: (patch: Partial<Pick<FanqieFieldState, "from" | "to">>) => void;
  readonly chapterCount?: number;
  readonly swapped?: boolean;
}) {
  const { t } = useI18n();
  const layoutName = useId();
  const bounds = chapterCount ?? 0;
  const applyStep = (field: "from" | "to", raw: string, delta: number) => {
    const stepped = stepRangeField(raw, delta, bounds, field);
    onChange({ [field]: stepped });
    onCommit?.({ [field]: stepped });
  };
  const onRangeKeyDown = (field: "from" | "to", event: KeyboardEvent<HTMLInputElement>) => {
    event.stopPropagation();
    if (event.key === "Enter") {
      event.preventDefault();
      onCommit?.({ [field]: event.currentTarget.value });
      return;
    }
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      applyStep(field, event.currentTarget.value, event.key === "ArrowUp" ? 1 : -1);
    }
  };
  return (
    <div className="space-y-2 border-t border-border/60 pt-2" data-testid="fanqie-export-fields">
      {showRange ? (
        <>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span>{isZh ? "从第" : "From"}</span>
            <span className="inline-flex items-center gap-0.5">
              <RangeStepButton label={t("export.rangeStepDown")} glyph="−" onStep={() => applyStep("from", from, -1)} />
              <input
                type="text"
                inputMode="numeric"
                value={from}
                placeholder={isZh ? "起" : "start"}
                aria-label={t("export.rangeFrom")}
                onChange={(event) => onChange({ from: event.target.value })}
                onBlur={(event) => onCommit?.({ from: event.target.value })}
                onKeyDown={(event) => onRangeKeyDown("from", event)}
                className="h-8 w-16 rounded-md border border-border bg-background px-2"
                data-testid="fanqie-from"
              />
              <RangeStepButton label={t("export.rangeStepUp")} glyph="+" onStep={() => applyStep("from", from, 1)} />
            </span>
            <span>{isZh ? "章到第" : "to"}</span>
            <span className="inline-flex items-center gap-0.5">
              <RangeStepButton label={t("export.rangeStepDown")} glyph="−" onStep={() => applyStep("to", to, -1)} />
              <input
                type="text"
                inputMode="numeric"
                value={to}
                placeholder={isZh ? "止" : "end"}
                aria-label={t("export.rangeTo")}
                onChange={(event) => onChange({ to: event.target.value })}
                onBlur={(event) => onCommit?.({ to: event.target.value })}
                onKeyDown={(event) => onRangeKeyDown("to", event)}
                className="h-8 w-16 rounded-md border border-border bg-background px-2"
                data-testid="fanqie-to"
              />
              <RangeStepButton label={t("export.rangeStepUp")} glyph="+" onStep={() => applyStep("to", to, 1)} />
            </span>
            <span>{isZh ? "章" : ""}</span>
          </div>
          {swapped ? <p className="text-xs leading-5 text-muted-foreground" data-testid="fanqie-range-swapped">{t("export.rangeSwapped")}</p> : null}
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

function RangeStepButton({
  label,
  glyph,
  onStep,
}: {
  readonly label: string;
  readonly glyph: string;
  readonly onStep: () => void;
}) {
  return (
    <button
      type="button"
      className="inline-flex h-8 w-6 shrink-0 items-center justify-center rounded-md border border-border bg-background text-sm leading-none"
      aria-label={label}
      // Keep the text field focused so blur does not commit, then step the same draft.
      onMouseDown={(event: MouseEvent<HTMLButtonElement>) => event.preventDefault()}
      onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
        if (event.key === "Enter" || event.key === "ArrowUp" || event.key === "ArrowDown") {
          event.stopPropagation();
        }
      }}
      onClick={onStep}
    >
      {glyph}
    </button>
  );
}
