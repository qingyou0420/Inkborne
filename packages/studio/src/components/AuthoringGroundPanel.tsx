/**
 * 研墨 authoring: catalog, scoped generate, review, adopt.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { postApi, putApi, useApi } from "../hooks/use-api";
import { showToast } from "../lib/toast";
import type { AuthoringReport, AuthoringWorkspace } from "../lib/authoring-workspace";
import { workspaceQuery } from "../lib/authoring-workspace";
import { AuthoringReviewDrawer } from "./AuthoringReviewDrawer";

export function AuthoringGroundPanel({
  bookId,
  isZh,
}: {
  readonly bookId: string;
  readonly isZh: boolean;
}) {
  const { data, refetch } = useApi<AuthoringWorkspace>(`/authoring/workspace?${workspaceQuery(bookId)}`);
  const entries = data?.catalog?.entries ?? [];
  const coverage = data?.manifest?.coverage;
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<AuthoringReport | null>(null);
  const visible = entries.filter((entry) => !entry.archived);
  const selectedIds = selected.length ? selected : visible.map((entry) => entry.id);
  const missing = visible.filter((entry) => !entry.adoptedArtifactId && !entry.candidateArtifactId).length;
  const focusedId = selected[0] ?? visible[0]?.id;
  const focused = visible.find((entry) => entry.id === focusedId);
  const focusedArtifactId = focused?.candidateArtifactId ?? focused?.adoptedArtifactId;
  const focusedUrl = focusedArtifactId
    ? `/authoring/artifacts/${encodeURIComponent(focusedArtifactId)}?bookId=${encodeURIComponent(bookId)}`
    : "";
  const { data: focusedArtifact, refetch: refetchFocused } = useApi<{ body?: string }>(focusedUrl);
  const [editBody, setEditBody] = useState("");
  const dirtyRef = useRef(false);
  const lastLoadedId = useRef<string>("");

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      const result = await fn();
      await refetch();
      return result;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const generateLabel = missing > 0 && selected.length === 0
    ? (isZh ? `补全剩余 ${missing} 项` : `Fill remaining ${missing}`)
    : (isZh ? `生成 ${selectedIds.length} 项设定` : `Generate ${selectedIds.length} settings`);

  useEffect(() => {
    const loadKey = focusedArtifactId ?? "empty";
    if (dirtyRef.current && lastLoadedId.current === loadKey) return;
    setEditBody(focusedArtifact?.body ?? "");
    dirtyRef.current = false;
    lastLoadedId.current = loadKey;
  }, [focusedArtifact?.body, focusedArtifactId]);

  const persistIfDirty = async (): Promise<string | undefined> => {
    if (!focusedArtifactId) return undefined;
    if (!dirtyRef.current) return focusedArtifactId;
    const saved = await putApi<{ artifactId?: string }>(`/authoring/artifacts/${focusedArtifactId}`, {
      bookId,
      body: editBody,
    });
    dirtyRef.current = false;
    await refetchFocused();
    await refetch();
    return saved.artifactId ?? focusedArtifactId;
  };

  const grouped = useMemo(() => {
    const map = new Map<string, typeof visible>();
    for (const entry of visible) {
      const list = map.get(entry.category) ?? [];
      list.push(entry);
      map.set(entry.category, list);
    }
    return [...map.entries()];
  }, [visible]);

  return (
    <section className="space-y-3 rounded-2xl border border-border/60 bg-card/70 p-4" data-testid="authoring-ground-panel">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-serif text-lg">{isZh ? "设定目录" : "Setting catalog"}</h2>
          <p className="text-sm text-muted-foreground">
            {isZh
              ? `已生成 ${coverage?.settingsGenerated ?? 0}/${coverage?.settingsTarget ?? visible.length} · 已采用 ${coverage?.settingsAdopted ?? 0}`
              : `Generated ${coverage?.settingsGenerated ?? 0}/${coverage?.settingsTarget ?? visible.length} · adopted ${coverage?.settingsAdopted ?? 0}`}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40"
            disabled={Boolean(busy)}
            onClick={() => void run("catalog", () => postApi("/authoring/ground/catalog", { bookId }))}
          >
            {busy === "catalog" ? (isZh ? "拟定中…" : "Planning…") : (isZh ? "根据正典拟定设定目录" : "Propose catalog")}
          </button>
          <button
            type="button"
            className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40"
            disabled={Boolean(busy) || visible.length === 0}
            onClick={() => void run("generate", () => postApi("/authoring/ground/generate", {
              bookId,
              entryIds: selected.length ? selected : undefined,
            }))}
          >
            {busy === "generate" ? (isZh ? "生成中…" : "Generating…") : generateLabel}
          </button>
        </div>
      </div>

      {grouped.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {isZh ? "还没有设定目录。先根据正典拟定。" : "No catalog yet. Propose one from the canon."}
        </p>
      ) : grouped.map(([category, items]) => (
        <div key={category} className="space-y-1">
          <div className="text-[13px] font-medium text-muted-foreground">{category}</div>
          {items.map((entry) => (
            <label key={entry.id} className="flex items-center justify-between gap-2 rounded-lg bg-background/70 px-3 py-2 text-sm">
              <span className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={selected.includes(entry.id)}
                  onChange={(event) => {
                    setSelected((prev) => event.target.checked
                      ? [...prev, entry.id]
                      : prev.filter((id) => id !== entry.id));
                  }}
                />
                {entry.name}
              </span>
              <span className="text-xs text-muted-foreground">
                {entry.candidateArtifactId && !entry.adoptedArtifactId
                  ? (isZh ? "候选" : "candidate")
                  : entry.adoptedArtifactId
                    ? (isZh ? "已采用" : "adopted")
                    : (isZh ? "未生成" : "empty")}
              </span>
            </label>
          ))}
        </div>
      ))}

      {focused ? (
        <div className="space-y-2">
          <div className="text-sm font-medium">{isZh ? `条目正文 · ${focused.name}` : `Entry · ${focused.name}`}</div>
          <textarea
            className="min-h-[160px] w-full rounded-md border border-border bg-background px-3 py-2 font-serif text-sm leading-6"
            value={editBody}
            onChange={(event) => {
              dirtyRef.current = true;
              setEditBody(event.target.value);
            }}
            placeholder={isZh ? "生成后可在这里阅读和修改" : "Generated text can be read and edited here"}
            data-testid="ground-entry-body"
          />
          {focusedArtifactId ? (
            <button
              type="button"
              className="rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-40"
              disabled={Boolean(busy) || editBody === (focusedArtifact?.body ?? "")}
              onClick={() => void run("save", () => persistIfDirty())}
            >
              {isZh ? "保存手改" : "Save edits"}
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40"
          disabled={Boolean(busy) || selectedIds.length === 0}
          onClick={() => void run("review", async () => {
            await persistIfDirty();
            const next = await postApi<AuthoringReport>("/authoring/ground/review", { bookId, entryIds: selectedIds });
            setReport(next);
            return next;
          })}
        >
          {isZh ? "审查所选" : "Review selected"}
        </button>
        <button
          type="button"
          className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40"
          disabled={Boolean(busy) || selectedIds.length === 0}
          onClick={() => void run("adopt", async () => {
            await persistIfDirty();
            const result = await postApi<{ adopted: string[] }>("/authoring/ground/adopt", { bookId, entryIds: selectedIds });
            showToast(isZh ? `已采用 ${result.adopted.length} 项` : `Adopted ${result.adopted.length}`, "success");
            return result;
          })}
        >
          {isZh ? `采用所选 ${selectedIds.length} 项` : `Adopt ${selectedIds.length}`}
        </button>
      </div>

      <AuthoringReviewDrawer
        open={Boolean(report)}
        title={isZh ? "研墨审查" : "Ground review"}
        report={report}
        isZh={isZh}
        busy={busy === "revise"}
        onClose={() => setReport(null)}
        currentArtifactId={focusedArtifactId}
        onRevise={(issueIds, reuseStale) => {
          if (!report) return;
          void run("revise", async () => {
            await persistIfDirty();
            return postApi("/authoring/ground/revise", {
              bookId,
              reportId: report.reportId,
              selectedIssueIds: issueIds,
              reuseStale,
            });
          });
        }}
      />
    </section>
  );
}
