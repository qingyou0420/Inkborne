/**
 * 织卷 authoring: full-book chapter coverage generate / review / adopt.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useRef, useState } from "react";
import { fetchJson, postApi, putApi, useApi } from "../hooks/use-api";
import { showToast } from "../lib/toast";
import type { AuthoringReport, AuthoringWorkspace } from "../lib/authoring-workspace";
import { latestArtifact, resolveAdoptArtifactId, workspaceQuery } from "../lib/authoring-workspace";
import { AuthoringReviewDrawer } from "./AuthoringReviewDrawer";

interface WeaveRun {
  readonly runId: string;
  readonly status: string;
  readonly progressDone?: number;
  readonly progressTotal?: number;
  readonly progressLabel?: string;
  readonly error?: string;
}

export function AuthoringWeavePanel({
  bookId,
  targetChapters,
  isZh,
  onAdopted,
}: {
  readonly bookId: string;
  readonly targetChapters: number;
  readonly isZh: boolean;
  readonly onAdopted?: () => void;
}) {
  const { data, refetch } = useApi<AuthoringWorkspace>(`/authoring/workspace?${workspaceQuery(bookId)}`);
  const coverage = data?.manifest?.coverage;
  const candidate = latestArtifact(data?.artifacts, "weave");
  const lastWeave = data?.runs?.find((item) => item.stage === "weave");
  const [endChapter, setEndChapter] = useState(String(targetChapters || 36));
  const [startChapter, setStartChapter] = useState("1");
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<AuthoringReport | null>(null);
  const [editBody, setEditBody] = useState("");
  const dirtyRef = useRef(false);
  const lastLoadedId = useRef<string>("");
  const [activeRunId, setActiveRunId] = useState<string | null>(null);
  const [liveRun, setLiveRun] = useState<WeaveRun | null>(null);
  const pollRef = useRef<number | null>(null);
  const generated = coverage?.chaptersGenerated ?? 0;
  const target = coverage?.chaptersTarget || Number(endChapter) || targetChapters || 0;
  const run = liveRun ?? (activeRunId && lastWeave?.runId === activeRunId ? lastWeave : null);
  const running = Boolean(run && (run.status === "running" || run.status === "pausing" || busy === "generate"));

  useEffect(() => {
    const loadKey = data?.candidateWeave?.artifactId ?? "empty";
    if (dirtyRef.current && lastLoadedId.current === loadKey) return;
    setEditBody(data?.candidateWeave?.body ?? "");
    dirtyRef.current = false;
    lastLoadedId.current = loadKey;
  }, [data?.candidateWeave?.artifactId, data?.candidateWeave?.body]);

  useEffect(() => {
    if (activeRunId) return;
    if (lastWeave && (lastWeave.status === "running" || lastWeave.status === "paused" || lastWeave.status === "partial")) {
      setActiveRunId(lastWeave.runId);
      setLiveRun(lastWeave);
    }
  }, [activeRunId, lastWeave]);

  useEffect(() => {
    if (!activeRunId) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const next = await fetchJson<WeaveRun>(`/authoring/runs/${encodeURIComponent(activeRunId)}?bookId=${encodeURIComponent(bookId)}`);
        if (cancelled) return;
        setLiveRun(next);
        if (next.status === "running" || next.status === "pausing") return;
        await refetch();
        setBusy(null);
      } catch {
        /* keep last snapshot */
      }
    };
    void tick();
    pollRef.current = window.setInterval(() => void tick(), 1000);
    return () => {
      cancelled = true;
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [activeRunId, bookId, refetch]);

  const runAction = async (label: string, fn: () => Promise<unknown>, after?: "adopt") => {
    setBusy(label);
    try {
      const result = await fn();
      await refetch();
      if (after === "adopt") onAdopted?.();
      return result;
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const persistIfDirty = async (): Promise<string | undefined> => {
    if (!candidate) return undefined;
    if (!dirtyRef.current) return candidate.artifactId;
    const saved = await putApi<{ artifactId?: string }>(`/authoring/artifacts/${candidate.artifactId}`, {
      bookId,
      body: editBody,
    });
    dirtyRef.current = false;
    await refetch();
    return saved.artifactId ?? candidate.artifactId;
  };

  const startGenerate = async () => {
    setBusy("generate");
    try {
      await persistIfDirty();
      const result = await postApi<WeaveRun & { beats?: unknown }>( "/authoring/weave/generate", {
        bookId,
        startChapter: Number(startChapter) || 1,
        endChapter: Number(endChapter) || 36,
        targetChapters: Number(endChapter) || 36,
      });
      if (result.runId) {
        setActiveRunId(result.runId);
        setLiveRun({ runId: result.runId, status: result.status ?? "running", progressLabel: result.progressLabel });
      } else {
        await refetch();
        setBusy(null);
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), "error");
      setBusy(null);
    }
  };

  const rangeDone = run?.status === "completed";
  const canResume = Boolean(run && (run.status === "partial" || run.status === "paused" || run.status === "failed"));

  return (
    <section className="space-y-3 rounded-2xl border border-border/60 bg-card/70 p-4" data-testid="authoring-weave-panel">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-serif text-lg">{isZh ? "全书 / 卷 / 章规划" : "Book / volume / chapter plan"}</h2>
          <p className="text-sm text-muted-foreground">
            {isZh
              ? `全书已生成 ${generated}/${target || "—"} · 已采用 ${coverage?.chaptersAdopted ?? 0}`
              : `Book generated ${generated}/${target || "—"} · adopted ${coverage?.chaptersAdopted ?? 0}`}
            {run?.progressLabel ? ` · ${run.progressLabel}` : ""}
            {rangeDone ? (isZh ? " · 本次范围已完成" : " · this range complete") : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label>
            {isZh ? "从" : "From"}
            <input
              type="number"
              min={1}
              className="ml-1 w-16 rounded-md border border-border bg-background px-2 py-1"
              value={startChapter}
              onChange={(event) => setStartChapter(event.target.value)}
            />
          </label>
          <label>
            {isZh ? "到" : "to"}
            <input
              type="number"
              min={1}
              className="ml-1 w-16 rounded-md border border-border bg-background px-2 py-1"
              value={endChapter}
              onChange={(event) => setEndChapter(event.target.value)}
            />
          </label>
        </div>
      </div>
      {editBody || data?.candidateWeave?.body ? (
        <textarea
          className="min-h-[200px] w-full rounded-md border border-border bg-background px-3 py-2 font-serif text-sm leading-6"
          value={editBody}
          onChange={(event) => {
            dirtyRef.current = true;
            setEditBody(event.target.value);
          }}
          data-testid="weave-candidate-body"
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {isZh ? "还没有规划候选。生成后可在这里阅读和修改全书大纲、卷纲与章概要。" : "No outline candidate yet."}
        </p>
      )}
      {candidate ? (
        <button
          type="button"
          className="rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-40"
          disabled={Boolean(busy) || running || editBody === (data?.candidateWeave?.body ?? "")}
          onClick={() => void runAction("save", () => persistIfDirty())}
        >
          {isZh ? "保存手改" : "Save edits"}
        </button>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="outline-weave"
          className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40"
          disabled={running}
          onClick={() => void startGenerate()}
        >
          {running
            ? (isZh ? `正在规划… ${run?.progressLabel ?? ""}` : `Planning… ${run?.progressLabel ?? ""}`)
            : (isZh ? "规划全书每章概要" : "Plan every chapter")}
        </button>
        {canResume && !running ? (
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40"
            disabled={Boolean(busy)}
            onClick={() => void runAction("resume", async () => {
              await persistIfDirty();
              const result = await postApi<WeaveRun>(`/authoring/runs/${run!.runId}/resume`, { bookId });
              if (result.runId) {
                setActiveRunId(result.runId);
                setLiveRun(result);
              }
              return result;
            })}
          >
            {isZh ? "继续剩余范围" : "Resume remaining"}
          </button>
        ) : null}
        {running && activeRunId ? (
          <button
            type="button"
            data-testid="outline-weave-pause"
            className="rounded-lg border border-border px-3 py-2 text-sm"
            onClick={() => void postApi(`/authoring/runs/${activeRunId}/pause`, { bookId })}
          >
            {isZh ? "暂停" : "Pause"}
          </button>
        ) : null}
        <button
          type="button"
          className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40"
          disabled={!candidate || running}
          onClick={() => void runAction("review", async () => {
            const artifactId = resolveAdoptArtifactId(await persistIfDirty(), candidate?.artifactId);
            const next = await postApi<AuthoringReport>("/authoring/weave/review", {
              bookId,
              artifactId,
              coverage: `第 ${startChapter}-${endChapter} 章`,
            });
            setReport(next);
            return next;
          })}
        >
          {isZh ? "审查规划" : "Review outline"}
        </button>
        <button
          type="button"
          className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40"
          disabled={!candidate || running}
          onClick={() => void runAction("adopt", async () => {
            const artifactId = resolveAdoptArtifactId(await persistIfDirty(), candidate?.artifactId);
            const result = await postApi<{ message?: string }>("/authoring/weave/adopt", {
              bookId,
              artifactId,
            });
            showToast(result.message ?? (isZh ? "规划已采用" : "Outline adopted"), "success");
            return result;
          }, "adopt")}
        >
          {isZh ? "采用并去落笔" : "Adopt and write"}
        </button>
      </div>

      <AuthoringReviewDrawer
        open={Boolean(report)}
        title={isZh ? "织卷审查" : "Weave review"}
        report={report}
        currentArtifactId={candidate?.artifactId}
        isZh={isZh}
        busy={busy === "revise"}
        onClose={() => setReport(null)}
        onRevise={(issueIds, reuseStale) => {
          if (!candidate || !report) return;
          void runAction("revise", async () => {
            const artifactId = resolveAdoptArtifactId(await persistIfDirty(), candidate.artifactId);
            return postApi("/authoring/weave/revise", {
              bookId,
              artifactId,
              reportId: report.reportId,
              selectedIssueIds: issueIds,
              startChapter: Number(startChapter) || 1,
              endChapter: Number(endChapter) || target || 36,
              reuseStale,
            });
          });
        }}
      />
    </section>
  );
}
