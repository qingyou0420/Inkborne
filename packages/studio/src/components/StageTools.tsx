/**
 * Per-stage 创作模型 / 审查模型 / 依据 / 专注.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useState } from "react";
import { useApi } from "../hooks/use-api";
import type { TFunction } from "../hooks/use-i18n";
import type { AuthoringRoleId } from "../lib/authoring-roles";
import type { AuthoringWorkspace } from "../lib/authoring-workspace";
import { workspaceQuery } from "../lib/authoring-workspace";
import type { StudioStageId } from "../lib/appearance";
import { AuthoringRolesPanel } from "./AuthoringRolesPanel";
import { Drawer } from "./ui/drawer";

export function StageTools({
  bookId,
  stage,
  isZh,
  t,
  onFocusMode,
  onOpenTruth,
}: {
  readonly bookId: string;
  readonly stage: StudioStageId | "study";
  readonly isZh: boolean;
  readonly t: TFunction;
  readonly onFocusMode?: () => void;
  readonly onOpenTruth?: () => void;
}) {
  const [role, setRole] = useState<AuthoringRoleId | null>(null);
  const [basisOpen, setBasisOpen] = useState(false);
  const roleStage: StudioStageId = stage === "study" ? "ask" : stage;
  useEffect(() => { setRole(null); setBasisOpen(false); }, [bookId, stage]);

  return (
    <div className="stage-tools">
      <button
        type="button"
        className="model-trigger"
        data-testid="stage-create-model"
        onClick={() => setRole(`${roleStage}.main`)}
      >
        {t("nav.createModel")}
      </button>
      <button
        type="button"
        className="model-trigger review-model-trigger"
        data-testid="stage-review-model"
        onClick={() => setRole(`${roleStage}.review`)}
      >
        {t("nav.reviewModel")}
      </button>
      <button
        type="button"
        className="model-trigger"
        data-testid="stage-basis"
        onClick={() => setBasisOpen(true)}
      >
        {t("nav.basis")}
      </button>
      {stage === "write" && onFocusMode ? (
        <button
          type="button"
          className="model-trigger"
          data-testid="stage-focus"
          onClick={onFocusMode}
        >
          {t("nav.focusMode")}
        </button>
      ) : null}
      {role ? (
        <AuthoringRolesPanel
          isZh={isZh}
          startRole={role}
          compact
          onEditorClose={() => setRole(null)}
        />
      ) : null}
      <StageBasisDrawer
        key={bookId}
        bookId={bookId}
        open={basisOpen}
        onClose={() => setBasisOpen(false)}
        isZh={isZh}
        t={t}
        onOpenTruth={onOpenTruth}
      />
    </div>
  );
}

function StageBasisDrawer({
  bookId,
  open,
  onClose,
  isZh,
  t,
  onOpenTruth,
}: {
  readonly bookId: string;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly isZh: boolean;
  readonly t: TFunction;
  readonly onOpenTruth?: () => void;
}) {
  const { data, loading, error, refetch } = useApi<AuthoringWorkspace>(
    open ? `/authoring/workspace?${workspaceQuery(bookId)}` : "",
  );
  const coverage = data?.manifest?.coverage;
  const rows = [
    {
      label: isZh ? "故事正典" : "Canon",
      value: data?.adoptedAskId
        ? (data.canon?.title?.trim() || (isZh ? "已采用" : "Adopted"))
        : (isZh ? "尚未采用" : "Not adopted"),
    },
    {
      label: isZh ? "设定" : "Settings",
      value: isZh
        ? `${coverage?.settingsAdopted ?? 0} / ${coverage?.settingsTarget ?? "—"} 已采用`
        : `${coverage?.settingsAdopted ?? 0} / ${coverage?.settingsTarget ?? "—"} adopted`,
    },
    {
      label: isZh ? "规划" : "Plan",
      value: isZh
        ? `${coverage?.chaptersAdopted ?? 0} / ${coverage?.chaptersTarget ?? "—"} 已采用`
        : `${coverage?.chaptersAdopted ?? 0} / ${coverage?.chaptersTarget ?? "—"} adopted`,
    },
    {
      label: isZh ? "正文" : "Prose",
      value: isZh
        ? `${coverage?.chaptersWrittenAdopted ?? 0} / ${coverage?.chaptersTarget ?? "—"} 已采用`
        : `${coverage?.chaptersWrittenAdopted ?? 0} / ${coverage?.chaptersTarget ?? "—"} adopted`,
    },
  ];

  return (
    <Drawer open={open} title={t("nav.basis")} onClose={onClose} testId="stage-basis-drawer">
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          {isZh
            ? "当前阶段可引用的已采用成果。生成不会自动改写正式版。"
            : "Adopted results this stage can use. Generating does not overwrite the formal version."}
        </p>
        {error ? <p role="alert" className="text-sm text-destructive">{error}<button type="button" className="btn-ghost ml-2" disabled={loading} onClick={() => void refetch()}>{isZh ? "重试" : "Retry"}</button></p> : null}
        {!data && loading ? <p role="status" className="text-sm text-muted-foreground">{isZh ? "正在读取创作依据…" : "Loading adopted results…"}</p> : null}
        {data && !error ? <ul className="space-y-3">
          {rows.map((row) => (
            <li key={row.label} className="border-b border-border pb-3">
              <div className="text-[12px] text-muted-foreground">{row.label}</div>
              <div className="mt-1 text-[15px]">{row.value}</div>
            </li>
          ))}
        </ul> : null}
        {onOpenTruth ? (
          <button type="button" className="btn-secondary" onClick={() => { onOpenTruth(); onClose(); }}>
            {isZh ? "打开真相文件" : "Open truth files"}
          </button>
        ) : null}
      </div>
    </Drawer>
  );
}
