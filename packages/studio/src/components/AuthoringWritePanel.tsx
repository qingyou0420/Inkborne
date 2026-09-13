/**
 * 落笔 authoring: generate candidate, review, adopt.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useRef, useState } from "react";
import { postApi, putApi, useApi } from "../hooks/use-api";
import { showToast } from "../lib/toast";
import type { AuthoringReport, AuthoringWorkspace } from "../lib/authoring-workspace";
import { currentWriteArtifact, reportForArtifact, resolveAdoptArtifactId, workspaceQuery } from "../lib/authoring-workspace";
import { AuthoringDiffDrawer } from "./AuthoringDiffDrawer";
import { AuthoringReviewDrawer } from "./AuthoringReviewDrawer";

export function AuthoringWritePanel({
  bookId,
  chapterNumber,
  chapterTitle,
  isZh,
  onChanged,
}: {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly chapterTitle?: string;
  readonly isZh: boolean;
  readonly onChanged?: () => void;
}) {
  const { data, refetch } = useApi<AuthoringWorkspace>(`/authoring/workspace?${workspaceQuery(bookId)}`);
  const scope = `chapter:${chapterNumber}`;
  const candidate = currentWriteArtifact(data, chapterNumber);
  const adoptedId = data?.manifest?.adopted?.write?.[String(chapterNumber)];
  const parentId = candidate?.parentArtifactId && candidate.parentArtifactId !== candidate.artifactId
    ? candidate.parentArtifactId
    : undefined;
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<AuthoringReport | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [requirement, setRequirement] = useState("");
  const [body, setBody] = useState("");
  const dirtyRef = useRef(false);
  const lastLoadedId = useRef<string>("");
  const artifactUrl = candidate
    ? `/authoring/artifacts/${encodeURIComponent(candidate.artifactId)}?bookId=${encodeURIComponent(bookId)}`
    : "";
  const { data: artifact } = useApi<{ body?: string; meta?: { artifactId?: string } }>(artifactUrl);
  const chapterUrl = !candidate
    ? `/books/${encodeURIComponent(bookId)}/chapters/${chapterNumber}`
    : "";
  const { data: existingChapter } = useApi<{ content?: string; title?: string; chapterNumber?: number }>(chapterUrl);
  const artifactForCurrent = artifact?.meta?.artifactId === candidate?.artifactId ? artifact : undefined;
  const chapterForCurrent = existingChapter?.chapterNumber === chapterNumber ? existingChapter : undefined;
  const savedBody = artifactForCurrent?.body ?? (!candidate ? chapterForCurrent?.content ?? "" : "");

  useEffect(() => {
    dirtyRef.current = false;
    lastLoadedId.current = "";
    setBody("");
    setReport(null);
    setReportOpen(false);
    setDiffOpen(false);
    setRequirement("");
  }, [bookId, chapterNumber]);

  useEffect(() => {
    const loadKey = candidate?.artifactId ?? `empty:${bookId}:${chapterNumber}`;
    if (dirtyRef.current && lastLoadedId.current === loadKey) return;
    if (candidate) {
      if (artifactForCurrent?.body == null) return;
      setBody(artifactForCurrent.body);
      dirtyRef.current = false;
      lastLoadedId.current = loadKey;
      return;
    }
    if (chapterForCurrent?.content) {
      setBody(chapterForCurrent.content);
      dirtyRef.current = false;
      lastLoadedId.current = loadKey;
      return;
    }
    if (lastLoadedId.current !== loadKey) {
      setBody("");
      lastLoadedId.current = loadKey;
    }
  }, [artifactForCurrent?.body, bookId, candidate, chapterForCurrent?.content, chapterNumber]);

  const persistIfDirty = async (): Promise<string | undefined> => {
    if (!dirtyRef.current) return candidate?.artifactId;
    if (candidate) {
      const saved = await putApi<{ artifactId?: string }>(`/authoring/artifacts/${candidate.artifactId}`, { bookId, body });
      dirtyRef.current = false;
      await refetch();
      return saved.artifactId ?? candidate.artifactId;
    }
    const saved = await postApi<{ artifactId: string }>("/authoring/write/hand", {
      bookId,
      chapterNumber,
      title: chapterTitle,
      body,
    });
    dirtyRef.current = false;
    await refetch();
    return saved.artifactId;
  };

  const run = async (label: string, fn: () => Promise<unknown>, notifyParent = false) => {
    setBusy(label);
    try {
      const result = await fn();
      await refetch();
      if (notifyParent) onChanged?.();
      return result;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const leftId = parentId && parentId !== candidate?.artifactId ? parentId : undefined;
  const workspaceReport = reportForArtifact(data?.reports, candidate?.artifactId) ?? null;
  const activeReport = report ?? workspaceReport;

  return (
    <section className="space-y-3 rounded-2xl border border-border/60 bg-card/70 p-4" data-testid="authoring-write-panel">
      <div>
        <h2 className="font-serif text-lg">
          {isZh ? `第 ${chapterNumber} 章` : `Chapter ${chapterNumber}`}
          {chapterTitle ? ` · ${chapterTitle}` : ""}
        </h2>
        <p className="text-sm text-muted-foreground">
          {candidate
            ? (isZh ? `候选 v${candidate.version}${adoptedId ? " · 已有采用稿" : ""}` : `Candidate v${candidate.version}${adoptedId ? " · adopted exists" : ""}`)
            : (isZh ? "还没有本章候选稿" : "No candidate yet")}
        </p>
        {data?.manifest?.watches?.some((watch) => !watch.acknowledged) ? (
          <p className="text-xs text-mark-text">
            {isZh ? "正典或设定已有新采用版，审查依据可能需要更新。" : "Canon or settings changed; review basis may be stale."}
          </p>
        ) : null}
      </div>
      <textarea
        className="min-h-[220px] w-full rounded-md border border-border bg-background px-3 py-2 font-serif text-sm leading-6"
        placeholder={isZh ? "候选正文会出现在这里，可直接修改。" : "Candidate text appears here and can be edited."}
        value={body}
        onChange={(event) => {
          dirtyRef.current = true;
          setBody(event.target.value);
        }}
        data-testid="write-candidate-body"
      />
      <button
        type="button"
        className="rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-40"
        disabled={Boolean(busy) || body === savedBody || !body.trim()}
        onClick={() => void run("save", () => persistIfDirty())}
      >
        {isZh ? "保存手改" : "Save edits"}
      </button>
      <textarea
        className="min-h-[72px] w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        placeholder={isZh ? "本章要求、重点场景、保持的文风（可选）" : "Optional chapter notes"}
        value={requirement}
        onChange={(event) => setRequirement(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40"
          disabled={Boolean(busy)}
          onClick={() => void run("generate", () => postApi("/authoring/write/generate", {
            bookId,
            chapterNumber,
            title: chapterTitle,
            requirements: requirement || undefined,
          }), true)}
        >
          {busy === "generate" ? (isZh ? "正在写…" : "Writing…") : (isZh ? "开始写本章" : "Write this chapter")}
        </button>
        <button
          type="button"
          className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40"
          disabled={(!candidate && !body.trim()) || Boolean(busy)}
          onClick={() => void run("review", async () => {
            const artifactId = await persistIfDirty() ?? candidate?.artifactId;
            if (!artifactId) throw new Error(isZh ? "先写本章或生成候选。" : "Write or generate a candidate first.");
            const next = await postApi<AuthoringReport>("/authoring/write/review", {
              bookId,
              artifactId,
              coverage: `第 ${chapterNumber} 章`,
            });
            setReport(next);
            setReportOpen(true);
            return next;
          })}
        >
          {isZh ? "审查本章" : "Review chapter"}
        </button>
        {workspaceReport && !reportOpen ? (
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-2 text-sm"
            onClick={() => {
              setReport(workspaceReport);
              setReportOpen(true);
            }}
          >
            {isZh ? "打开审查" : "Open review"}
          </button>
        ) : null}
        {candidate && leftId ? (
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-2 text-sm"
            onClick={() => setDiffOpen(true)}
          >
            {isZh ? "比较版本" : "Compare"}
          </button>
        ) : null}
        <button
          type="button"
          className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40"
          disabled={(!candidate && !body.trim()) || Boolean(busy)}
          onClick={() => void run("adopt", async () => {
            const artifactId = resolveAdoptArtifactId(await persistIfDirty(), candidate?.artifactId);
            const result = await postApi<{ message?: string; settled?: boolean }>("/authoring/write/adopt", {
              bookId,
              artifactId,
            });
            showToast(result.message ?? (isZh ? "章节已采用" : "Chapter adopted"), result.settled === false ? "info" : "success");
            return result;
          }, true)}
        >
          {isZh ? "采用此稿" : "Adopt draft"}
        </button>
      </div>

      <AuthoringReviewDrawer
        open={reportOpen}
        title={isZh ? `落笔审查 · 第 ${chapterNumber} 章` : `Write review · ch.${chapterNumber}`}
        report={activeReport}
        currentArtifactId={candidate?.artifactId}
        isZh={isZh}
        busy={busy === "revise"}
        onClose={() => setReportOpen(false)}
        onRevise={(issueIds, reuseStale) => {
          if (!candidate || !activeReport) return;
          void run("revise", async () => {
            const result = await postApi("/authoring/write/revise", {
              bookId,
              artifactId: candidate.artifactId,
              reportId: activeReport.reportId,
              selectedIssueIds: issueIds,
              reuseStale,
            });
            setDiffOpen(true);
            return result;
          });
        }}
      />
      <AuthoringDiffDrawer
        open={diffOpen}
        bookId={bookId}
        leftId={leftId}
        rightId={candidate?.artifactId}
        adoptedId={adoptedId && adoptedId !== leftId && adoptedId !== candidate?.artifactId ? adoptedId : undefined}
        isZh={isZh}
        onClose={() => setDiffOpen(false)}
        onKeep={() => {
          if (!leftId) {
            setDiffOpen(false);
            return;
          }
          void run("keep", async () => {
            await postApi("/authoring/write/select", {
              bookId,
              chapterNumber,
              artifactId: leftId,
            });
            dirtyRef.current = false;
            setDiffOpen(false);
          });
        }}
        onAdopt={() => {
          void run("adopt", async () => {
            const artifactId = resolveAdoptArtifactId(await persistIfDirty(), candidate?.artifactId);
            return postApi("/authoring/write/adopt", { bookId, artifactId });
          }, true);
          setDiffOpen(false);
        }}
      />
    </section>
  );
}
