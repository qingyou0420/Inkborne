/**
 * S06: version-bound review drawer with selectable issues.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useState } from "react";
import type { AuthoringReport } from "../lib/authoring-workspace";
import { severityLabel } from "../lib/authoring-workspace";
import { ReadingSidePanel } from "./ReadingSidePanel";

export function AuthoringReviewDrawer({
  open,
  title,
  report,
  currentArtifactId,
  isZh,
  busy,
  onClose,
  onRevise,
  error,
  onRetry,
  reviseDisabled,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly report: AuthoringReport | null;
  readonly currentArtifactId?: string;
  readonly isZh: boolean;
  readonly busy?: boolean;
  readonly onClose: () => void;
  readonly onRevise: (selectedIssueIds: ReadonlyArray<string>, reuseStale?: boolean) => void;
  readonly error?: string | null;
  readonly onRetry?: () => void;
  readonly reviseDisabled?: boolean;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [reuseStale, setReuseStale] = useState(false);
  const issues = report?.issues ?? [];
  useEffect(() => {
    setSelected([]);
    setReuseStale(false);
  }, [report?.reportId, currentArtifactId]);
  const historical = Boolean(report && currentArtifactId && !report.targetRefs.includes(currentArtifactId));
  const blocked = Boolean(report?.incomplete || ((report?.stale || historical) && !reuseStale));

  return (
    <ReadingSidePanel open={open} title={title} onClose={onClose} testId="authoring-review-drawer">
      {busy ? <p role="status" className="mb-4 text-sm text-muted-foreground">{isZh ? "正在审查，可继续对照文稿…" : "Reviewing. You can keep reading the manuscript…"}</p> : null}
      {error ? <p role="alert" className="mb-4 text-sm text-destructive">{error}</p> : null}
      {onRetry && (report || error) ? <button type="button" className="btn-ghost mb-4" disabled={busy || reviseDisabled} onClick={onRetry}>{isZh ? "重新审查" : "Retry review"}</button> : null}
      {!report ? (
        <p className="text-sm text-muted-foreground">{isZh ? "还没有审查报告。" : "No report yet."}</p>
      ) : (
        <div className="space-y-3">
          <p className="text-sm leading-6">{report.summary}</p>
          <p className="text-xs text-muted-foreground">
            {report.coverage} · {report.actualReviewModel}
            {report.incomplete ? (isZh ? " · 结果不完整" : " · incomplete") : ""}
            {report.stale || historical ? (isZh ? " · 这份报告对应旧稿" : " · historical report") : ""}
          </p>
          {report.staleReason ? <p className="text-xs text-mark-text">{report.staleReason}</p> : null}
          {report.incomplete ? (
            <p className="text-sm text-mark-text">{isZh ? "本次审查结果不完整，请重试。" : "This review is incomplete. Retry."}</p>
          ) : null}
          {(report.stale || historical) && !report.incomplete ? (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={reuseStale} onChange={(event) => setReuseStale(event.target.checked)} />
              {isZh ? "沿用这些建议修改当前稿" : "Reuse these notes on the current draft"}
            </label>
          ) : null}
          {issues.length === 0 && !report.incomplete ? (
            <p className="text-sm">{isZh ? "本次未发现需修改的问题。" : "No issues to fix."}</p>
          ) : issues.length === 0 ? null : (
            issues.map((issue) => (
              <label key={issue.issueId} className="flex gap-2 rounded-lg border border-border p-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.includes(issue.issueId)}
                  onChange={(event) => {
                    setSelected((prev) => event.target.checked
                      ? [...prev, issue.issueId]
                      : prev.filter((id) => id !== issue.issueId));
                  }}
                />
                <span className="space-y-1">
                  <span className="block">
                    <span className="mr-2 text-xs text-muted-foreground">{severityLabel(issue.severity, isZh)}</span>
                    <strong>{issue.title}</strong>
                  </span>
                  {issue.target ? <span className="mr-2 text-xs text-muted-foreground">{issue.target}</span> : null}
                  {issue.evidence ? <span className="block text-muted-foreground">{issue.evidence}</span> : null}
                  {issue.suggestion ? <span className="block">{issue.suggestion}</span> : null}
                </span>
              </label>
            ))
          )}
          {issues.length > 0 ? <div className="flex gap-2 pt-2">
            <button
              type="button"
              className="rounded-lg border border-border px-3 py-2 text-sm"
              onClick={() => setSelected(issues.map((issue) => issue.issueId))}
            >
              {isZh ? "全选" : "Select all"}
            </button>
            <button
              type="button"
              className="flex-1 rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40"
              disabled={busy || reviseDisabled || selected.length === 0 || blocked}
              onClick={() => onRevise(selected, reuseStale)}
            >
              {isZh ? `按 ${selected.length} 条意见修改` : `Revise ${selected.length} issues`}
            </button>
          </div> : null}
        </div>
      )}
    </ReadingSidePanel>
  );
}
