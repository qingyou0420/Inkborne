/**
 * 落笔 authoring: generate candidate, review, adopt.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { collapseDuplicateChapterHeadings } from "@actalk/inkos-core/chapter-heading";
import { postApi, putApi, retryingBookBusy, useApi } from "../hooks/use-api";
import { postAuthoringStream, type AuthoringStreamResult } from "../lib/authoring-stream";
import { formatTokenCount, type TokenUsage } from "../lib/token-usage";
import { chapterEditRequest, trackChapterEdit } from "../lib/pending-chapter-edit";
import { registerUnsavedCheck, registerUnsavedFlush } from "../lib/unsaved-edits";
import { showToast } from "../lib/toast";
import type { AuthoringReport, AuthoringWorkspace } from "../lib/authoring-workspace";
import { currentWriteArtifact, reportForArtifact, resolveAdoptArtifactId, workspaceQuery } from "../lib/authoring-workspace";
import { AuthoringDiffDrawer } from "./AuthoringDiffDrawer";
import { AuthoringReviewDrawer } from "./AuthoringReviewDrawer";

const AUTOSAVE_MS = 1500;

interface WriteBasis {
  readonly title?: string;
  readonly summary?: string;
  readonly goal?: string;
  readonly previousEnding?: string;
  readonly progress?: string;
  readonly targetWordCount?: number;
}

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes <= 0) return `已用 ${rest} 秒`;
  return `已用 ${minutes} 分 ${rest} 秒`;
}

function countChars(text: string): number {
  return text.replace(/\s+/g, "").length;
}

export interface AuthoringWritePanelHandle {
  flush: () => Promise<void>;
}

export const AuthoringWritePanel = forwardRef<AuthoringWritePanelHandle, {
  readonly bookId: string;
  readonly chapterNumber: number;
  readonly chapterTitle?: string;
  readonly isZh: boolean;
  readonly generateNonce?: number;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly onChanged?: () => void;
}>(function AuthoringWritePanel({
  bookId,
  chapterNumber,
  chapterTitle,
  isZh,
  generateNonce = 0,
  onBusyChange,
  onChanged,
}, ref) {
  const { data, refetch } = useApi<AuthoringWorkspace>(`/authoring/workspace?${workspaceQuery(bookId)}`);
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
  const [lengthNote, setLengthNote] = useState("");
  const [generateChoice, setGenerateChoice] = useState(false);
  const [usage, setUsage] = useState<TokenUsage | undefined>();
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [stopping, setStopping] = useState(false);
  const dirtyRef = useRef(false);
  const composingRef = useRef(false);
  const runIdRef = useRef("");
  const pendingEditRef = useRef<ReturnType<typeof trackChapterEdit>>(null);
  const inflightRef = useRef<Promise<string | undefined> | null>(null);
  const bodyRef = useRef("");
  const lastLoadedId = useRef<string>("");
  const timerRef = useRef<number | null>(null);
  const seenGenerate = useRef(generateNonce);
  const candidateRef = useRef(candidate);
  const chapterTitleRef = useRef(chapterTitle);
  bodyRef.current = body;
  candidateRef.current = candidate;
  chapterTitleRef.current = chapterTitle;
  const artifactUrl = candidate
    ? `/authoring/artifacts/${encodeURIComponent(candidate.artifactId)}?bookId=${encodeURIComponent(bookId)}`
    : "";
  const { data: artifact } = useApi<{ body?: string; meta?: { artifactId?: string } }>(artifactUrl);
  const chapterUrl = !candidate
    ? `/books/${encodeURIComponent(bookId)}/chapters/${chapterNumber}`
    : "";
  const { data: existingChapter } = useApi<{ content?: string; title?: string; chapterNumber?: number }>(chapterUrl);
  const { data: basis } = useApi<WriteBasis>(
    `/authoring/write/basis?bookId=${encodeURIComponent(bookId)}&chapterNumber=${chapterNumber}`,
  );
  const artifactForCurrent = artifact?.meta?.artifactId === candidate?.artifactId ? artifact : undefined;
  const chapterForCurrent = existingChapter?.chapterNumber === chapterNumber ? existingChapter : undefined;
  const rawSaved = artifactForCurrent?.body ?? (!candidate ? chapterForCurrent?.content ?? "" : "");
  const savedBody = collapseDuplicateChapterHeadings(rawSaved, { chapterNumber, title: chapterTitle });

  useEffect(() => {
    onBusyChange?.(Boolean(busy));
  }, [busy, onBusyChange]);

  useEffect(() => registerUnsavedCheck(() => dirtyRef.current || pendingEditRef.current !== null), []);

  useEffect(() => {
    if (!startedAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);

  useEffect(() => {
    setUsage(undefined);
  }, [bookId, chapterNumber]);

  useEffect(() => {
    const loadKey = candidate?.artifactId ?? `empty:${bookId}:${chapterNumber}`;
    if (dirtyRef.current || composingRef.current) return;
    if (candidate) {
      if (artifactForCurrent?.body == null) return;
      setBody(collapseDuplicateChapterHeadings(artifactForCurrent.body, { chapterNumber, title: chapterTitle }));
      lastLoadedId.current = loadKey;
      return;
    }
    if (chapterForCurrent?.content) {
      setBody(collapseDuplicateChapterHeadings(chapterForCurrent.content, { chapterNumber, title: chapterTitle }));
      lastLoadedId.current = loadKey;
      return;
    }
    if (lastLoadedId.current !== loadKey) {
      setBody("");
      lastLoadedId.current = loadKey;
    }
  }, [artifactForCurrent?.body, bookId, candidate, chapterForCurrent?.content, chapterNumber, chapterTitle]);

  const persistSnapshot = async (
    pending: NonNullable<ReturnType<typeof trackChapterEdit>>,
  ): Promise<string | undefined> => {
    const target = chapterEditRequest(pending);
    if (target.artifactId) {
      const saved = await retryingBookBusy(() => putApi<{ artifactId?: string }>(
        `/authoring/artifacts/${target.artifactId}`,
        { bookId: target.bookId, body: target.content },
        { silentBookBusy: true },
      ));
      await refetch();
      return saved.artifactId ?? target.artifactId;
    }
    if (!target.content.trim()) return undefined;
    const saved = await retryingBookBusy(() => postApi<{ artifactId: string }>("/authoring/write/hand", {
      bookId: target.bookId,
      chapterNumber: target.chapterNumber,
      title: chapterTitleRef.current,
      body: target.content,
    }, { silentBookBusy: true }));
    await refetch();
    return saved.artifactId;
  };

  const persistIfDirty = async (): Promise<string | undefined> => {
    const previous = inflightRef.current;
    if (previous) await previous.catch(() => undefined);
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const pending = pendingEditRef.current;
    if (!pending) return candidateRef.current?.artifactId;
    pendingEditRef.current = null;
    dirtyRef.current = false;
    const sourceArtifactId = pending.artifactId;
    const holder: { current?: Promise<string | undefined> } = {};
    holder.current = (async () => {
      try {
        const savedId = await persistSnapshot(pending);
        const newer = pendingEditRef.current;
        if (
          savedId
          && newer
          && newer.bookId === pending.bookId
          && newer.chapterNumber === pending.chapterNumber
          && newer.artifactId === sourceArtifactId
        ) {
          pendingEditRef.current = { ...newer, artifactId: savedId };
        }
        return savedId;
      } catch (error) {
        if (!pendingEditRef.current) {
          pendingEditRef.current = pending;
          dirtyRef.current = true;
        }
        throw error;
      } finally {
        if (inflightRef.current === holder.current) inflightRef.current = null;
      }
    })();
    inflightRef.current = holder.current;
    return holder.current;
  };

  const persistRef = useRef(persistIfDirty);
  persistRef.current = persistIfDirty;
  useEffect(() => registerUnsavedFlush(() => persistRef.current().then(() => undefined)), []);
  useImperativeHandle(ref, () => ({
    flush: async () => {
      await persistRef.current();
    },
  }), []);

  useEffect(() => {
    if (!dirtyRef.current || composingRef.current) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      void persistIfDirty().catch((error) => {
        const busy = error instanceof Error && /BOOK_BUSY|正在写|写入被占用/.test(error.message);
        if (busy) return;
        showToast(error instanceof Error ? error.message : String(error), "error");
      });
    }, AUTOSAVE_MS);
    return () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [body]);

  useEffect(() => {
    return () => {
      const runId = runIdRef.current;
      if (composingRef.current && runId) {
        void postApi(`/authoring/runs/${encodeURIComponent(runId)}/cancel`, { bookId }).catch(() => undefined);
      }
      void persistRef.current();
    };
  }, [bookId, chapterNumber]);

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

  const stopWriting = () => {
    const runId = runIdRef.current;
    if (!runId) return;
    setStopping(true);
    void postApi(`/authoring/runs/${encodeURIComponent(runId)}/cancel`, { bookId }).catch((error) => {
      showToast(error instanceof Error ? error.message : String(error), "error");
    });
  };

  const runStream = async (
    label: "generate" | "revise",
    path: string,
    payload: unknown,
    snapshot: string,
  ): Promise<AuthoringStreamResult | undefined> => {
    setBusy(label);
    setStopping(false);
    setStartedAt(Date.now());
    composingRef.current = true;
    runIdRef.current = "";
    let streamed = "";
    try {
      const result = await postAuthoringStream(path, payload, {
        onStart: (runId) => {
          runIdRef.current = runId;
        },
        onDelta: (delta) => {
          streamed += delta;
          setBody(streamed);
        },
      });
      if (result.status === "cancelled" && !result.artifactId) {
        setBody(snapshot);
        showToast(isZh ? "已停下。还没写出字，没有留下半截稿。" : "Stopped before any words were written.", "info");
      } else {
        setBody(result.body || streamed);
        dirtyRef.current = false;
        pendingEditRef.current = null;
        if (result.usage?.totalTokens) setUsage(result.usage);
        setLengthNote(result.lengthNote ?? "");
        if (result.lengthNote) showToast(result.lengthNote, "info");
        if (result.status === "cancelled") {
          showToast(isZh ? "已停下。写到这里的内容留在候选稿里，这本书没有锁住。" : "Stopped. The words so far stay in the draft.", "info");
        }
      }
      await refetch();
      onChanged?.();
      return result;
    } catch (error) {
      setBody(snapshot);
      dirtyRef.current = false;
      pendingEditRef.current = null;
      showToast(error instanceof Error ? error.message : String(error), "error");
      return undefined;
    } finally {
      composingRef.current = false;
      runIdRef.current = "";
      setStartedAt(null);
      setStopping(false);
      setBusy(null);
    }
  };

  const startGenerate = (mode: "hand" | "fresh") => {
    setGenerateChoice(false);
    void (async () => {
      const snapshot = bodyRef.current;
      const hand = mode === "hand";
      try {
        const parentArtifactId = await persistIfDirty();
        await runStream("generate", "/authoring/write/generate/stream", {
          bookId,
          chapterNumber,
          title: chapterTitle,
          requirements: requirement || undefined,
          ...(hand && snapshot.trim() ? { baseBody: snapshot } : {}),
          ...(parentArtifactId ? { parentArtifactId } : {}),
        }, snapshot);
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), "error");
      }
    })();
  };

  const requestGenerate = () => {
    const handEdited = dirtyRef.current || candidate?.source === "hand" || (body.trim() !== "" && body !== savedBody);
    if (handEdited) {
      setGenerateChoice(true);
      return;
    }
    startGenerate("fresh");
  };

  useEffect(() => {
    if (generateNonce === seenGenerate.current) return;
    seenGenerate.current = generateNonce;
    requestGenerate();
  }, [generateNonce]);

  const editorLocked = busy === "generate" || busy === "revise";
  const liveCount = countChars(body);
  const elapsedLabel = startedAt ? formatElapsed(now - startedAt) : "";
  const progressLabel = editorLocked
    ? `${stopping ? (isZh ? "正在停下" : "Stopping") : (busy === "revise" ? (isZh ? "正在按意见改" : "Revising") : (isZh ? "正在写" : "Writing"))} · ${elapsedLabel} · ${isZh ? `已写 ${liveCount.toLocaleString("zh-CN")} 字` : `${liveCount.toLocaleString("en-US")} chars`}`
    : "";
  const runUsage = data?.runs?.find((run) => run.runId && run.runId === candidate?.runId)?.usage;
  const shownUsage = usage ?? runUsage;
  const usageLabel = shownUsage?.totalTokens ? formatTokenCount(shownUsage.totalTokens, isZh) : "";
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
      <details className="rounded-xl border border-border/70 bg-background/60 px-3 py-2" data-testid="write-chapter-basis">
        <summary className="cursor-pointer text-sm">{isZh ? "本章依据" : "This chapter"}</summary>
        <div className="mt-3 space-y-2 text-sm leading-6">
          <p>
            <span className="text-muted-foreground">{isZh ? "这一章要写" : "Plan"} · </span>
            {(basis?.title || chapterTitle) ? `${basis?.title || chapterTitle}。` : ""}
            {basis?.summary || (isZh ? "还没有章纲。" : "No chapter plan yet.")}
          </p>
          {basis?.goal ? (
            <p>
              <span className="text-muted-foreground">{isZh ? "本卷目标" : "Volume"} · </span>
              {basis.goal}
            </p>
          ) : null}
          <p>
            <span className="text-muted-foreground">{isZh ? "上一章结尾" : "Previous ending"} · </span>
            {basis?.previousEnding || (isZh ? "这是开头，没有上一章。" : "This is the opening.")}
          </p>
          {basis?.progress ? (
            <p>
              <span className="text-muted-foreground">{isZh ? "写到哪了" : "Progress"} · </span>
              {basis.progress}
            </p>
          ) : null}
          <p>
            <span className="text-muted-foreground">{isZh ? "字数" : "Length"} · </span>
            {isZh
              ? `现在 ${liveCount.toLocaleString("zh-CN")} 字${basis?.targetWordCount ? `，这一章打算写 ${basis.targetWordCount.toLocaleString("zh-CN")} 字` : ""}`
              : `${liveCount.toLocaleString("en-US")}${basis?.targetWordCount ? ` / ${basis.targetWordCount.toLocaleString("en-US")}` : ""}`}
          </p>
        </div>
      </details>
      {progressLabel ? (
        <p className="text-sm text-muted-foreground" data-testid="write-progress">{progressLabel}</p>
      ) : null}
      <textarea
        className="min-h-[220px] w-full rounded-md border border-border bg-background px-3 py-2 font-serif text-sm leading-6"
        placeholder={isZh ? "候选正文会出现在这里，可直接修改。" : "Candidate text appears here and can be edited."}
        value={body}
        disabled={editorLocked}
        onChange={(event) => {
          const next = event.target.value;
          pendingEditRef.current = trackChapterEdit(bookId, chapterNumber, next, savedBody, candidate?.artifactId);
          dirtyRef.current = pendingEditRef.current !== null;
          setBody(next);
        }}
        data-testid="write-candidate-body"
      />
      <p className="text-xs text-muted-foreground">
        {isZh ? "停笔一会儿会自动保存手改。换章或离开前也会先存下来。" : "Edits save automatically after a short pause, and before you leave."}
      </p>
        {lengthNote ? <p className="text-sm text-mark-text">{lengthNote}</p> : null}
        {usageLabel ? (
          <p className="text-xs text-muted-foreground" data-testid="write-token-usage">
            {isZh ? `这次用了 ${usageLabel}` : `This pass used ${usageLabel}`}
          </p>
        ) : null}
      {generateChoice ? (
        <div className="space-y-2 rounded-xl border border-border bg-background px-3 py-3" data-testid="write-generate-choice">
          <p className="text-sm">{isZh ? "这一章有手改。要基于手改继续写，还是另起一稿？" : "This chapter has hand edits. Rewrite from them, or start a fresh draft?"}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground" onClick={() => startGenerate("hand")}>
              {isZh ? "基于当前手改改写" : "Rewrite from edits"}
            </button>
            <button type="button" className="rounded-lg border border-border px-3 py-2 text-sm" onClick={() => startGenerate("fresh")}>
              {isZh ? "另起一稿" : "Start fresh"}
            </button>
            <button type="button" className="rounded-lg border border-border px-3 py-2 text-sm" onClick={() => setGenerateChoice(false)}>
              {isZh ? "取消" : "Cancel"}
            </button>
          </div>
        </div>
      ) : null}
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
        disabled={editorLocked}
        onChange={(event) => setRequirement(event.target.value)}
      />
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40"
          disabled={Boolean(busy)}
          onClick={requestGenerate}
          data-testid="write-generate"
        >
          {busy === "generate" ? (isZh ? "正在写…" : "Writing…") : (isZh ? "开始写本章" : "Write this chapter")}
        </button>
        {editorLocked ? (
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-2 text-sm"
            onClick={stopWriting}
            disabled={stopping || (!runIdRef.current && !startedAt)}
            data-testid="write-stop"
          >
            {stopping ? (isZh ? "正在停下…" : "Stopping…") : (isZh ? "停止" : "Stop")}
          </button>
        ) : null}
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
            const result = await postApi<{ message?: string; settled?: boolean; lengthNote?: string }>("/authoring/write/adopt", {
              bookId,
              artifactId,
            });
            if (result.lengthNote) {
              setLengthNote(result.lengthNote);
              showToast(result.lengthNote, "info");
            }
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
          void (async () => {
            const snapshot = bodyRef.current;
            const result = await runStream("revise", "/authoring/write/revise/stream", {
              bookId,
              artifactId: candidate.artifactId,
              reportId: activeReport.reportId,
              selectedIssueIds: issueIds,
              reuseStale,
            }, snapshot);
            if (result?.artifactId) setDiffOpen(true);
          })();
        }}
        progressLabel={progressLabel}
        onStop={stopWriting}
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
            pendingEditRef.current = null;
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
});
