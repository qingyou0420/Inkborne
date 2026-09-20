/**
 * Optional notes beside a first-generate button. Regenerates still use RegenerateDialog.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useState } from "react";

export function GenerationRequirements({
  value,
  onChange,
  isZh,
  disabled,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly isZh: boolean;
  readonly disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="inline-flex flex-col items-start gap-2">
      <button
        type="button"
        className="quiet"
        disabled={disabled}
        aria-expanded={open}
        data-testid="generation-requirements-toggle"
        onClick={() => setOpen((current) => !current)}
      >
        {isZh ? "要求" : "Notes"}
      </button>
      {open ? (
        <textarea
          className="ink-task-input min-w-[16rem]"
          rows={3}
          value={value}
          disabled={disabled}
          data-testid="generation-requirements"
          placeholder={isZh ? "这次生成要特别注意什么（可选）" : "Optional notes for this generation"}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
    </div>
  );
}
