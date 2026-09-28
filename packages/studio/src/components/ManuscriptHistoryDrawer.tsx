/** SPDX-License-Identifier: AGPL-3.0-only */
import { useEffect, useState } from "react";
import { useApi } from "../hooks/use-api";
import type { AuthoringArtifact } from "../lib/authoring-workspace";
import { Drawer } from "./ui/drawer";
import { ManuscriptView } from "./ManuscriptView";

export function ManuscriptHistoryDrawer({ open, bookId, title, artifacts, currentId, adoptedId, isZh, busy, onClose, onRestore }: {
  open: boolean; bookId: string; title: string; artifacts: ReadonlyArray<AuthoringArtifact>;
  currentId?: string; adoptedId?: string; isZh: boolean; busy?: boolean; onClose: () => void;
  onRestore: (artifactId: string, body: string) => Promise<boolean>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useEffect(() => { if (!open) setSelectedId(null); }, [open]);
  const { data, loading, error, refetch } = useApi<{ body: string; meta: { artifactId: string } }>(open && selectedId ? `/authoring/artifacts/${encodeURIComponent(selectedId)}?bookId=${encodeURIComponent(bookId)}` : "");
  const current = data?.meta.artifactId === selectedId ? data : null;
  return <Drawer open={open} title={title} onClose={onClose}>
    <div className="space-y-5">
      <div className="divide-y divide-border">{[...artifacts].reverse().map((item) => <button key={item.artifactId} type="button" className="flex w-full items-center justify-between gap-4 py-3 text-left text-sm" aria-pressed={selectedId === item.artifactId} disabled={busy} onClick={() => setSelectedId(item.artifactId)}>
        <span>{item.label ?? `v${item.version}`}</span><small className="text-muted-foreground">{item.artifactId === adoptedId ? (isZh ? "已采用" : "Adopted") : item.artifactId === currentId ? (isZh ? "当前候选" : "Current candidate") : (isZh ? "历史稿" : "Previous draft")}</small>
      </button>)}</div>
      {artifacts.length === 0 ? <p className="text-sm text-muted-foreground">{isZh ? "还没有历史版本。" : "No versions yet."}</p> : null}
      {loading ? <p role="status">{isZh ? "正在读取…" : "Loading…"}</p> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}<button type="button" className="btn-ghost" onClick={() => void refetch()}>{isZh ? "重试" : "Retry"}</button></p> : null}
      {current && selectedId ? <>
        <ManuscriptView body={current.body} />
        <button type="button" className="btn-secondary" disabled={busy || selectedId === currentId} onClick={async () => { if (await onRestore(selectedId, current.body)) onClose(); }}>{isZh ? "另存为新候选" : "Restore as a new candidate"}</button>
      </> : null}
    </div>
  </Drawer>;
}
