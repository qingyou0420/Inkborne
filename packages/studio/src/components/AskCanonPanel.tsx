/**
 * 问心 right rail: editable canon candidate, review, adopt.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { postApi, putApi, useApi } from "../hooks/use-api";
import { showToast } from "../lib/toast";
import { chatSelectors, useChatStore } from "../store/chat";
import type { AuthoringWorkspace } from "../lib/authoring-workspace";
import { reportForArtifact, resolveAdoptArtifactId } from "../lib/authoring-workspace";
import { Drawer } from "./ui/drawer";

interface CanonDoc {
  readonly title?: string;
  readonly oneLine?: string;
  readonly proposition?: string;
  readonly protagonist?: string;
  readonly conflict?: string;
  readonly voice?: string;
  readonly boundaries?: string;
  readonly direction?: string;
  readonly openQuestions?: string[];
}

export function AskCanonPanel({
  bookId,
  isZh,
  onAdopted,
}: {
  readonly bookId?: string;
  readonly isZh: boolean;
  readonly onAdopted?: (bookId: string) => void;
}) {
  const sessionId = useChatStore((state) => state.activeSessionId);
  const messages = useChatStore(chatSelectors.activeMessages);
  const [draftId, setDraftId] = useState<string | undefined>(undefined);
  const query = bookId
    ? `bookId=${encodeURIComponent(bookId)}`
    : draftId
      ? `draftId=${encodeURIComponent(draftId)}`
      : "";
  const { data, refetch } = useApi<AuthoringWorkspace>(query ? `/authoring/workspace?${query}` : "");
  const [busy, setBusy] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [reuseStale, setReuseStale] = useState(false);
  const [editBody, setEditBody] = useState("");
  const dirtyRef = useRef(false);
  const lastLoadedId = useRef<string>("");
  const candidate = data?.candidateAsk;
  const adopted = data?.canon;
  const report = reportForArtifact(data?.reports, candidate?.artifactId) ?? data?.reports?.[0];
  const preview = candidate?.canon ?? (candidate ? undefined : adopted);

  useEffect(() => {
    if (bookId) return;
    let cancelled = false;
    void postApi<{ draftId: string }>("/authoring/drafts/ensure", { sessionId: sessionId ?? undefined })
      .then((draft) => {
        if (!cancelled) setDraftId(draft.draftId);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bookId, sessionId]);

  useEffect(() => {
    const loadKey = candidate?.artifactId ?? "empty";
    if (dirtyRef.current && lastLoadedId.current === loadKey) return;
    setEditBody(candidate?.body ?? "");
    dirtyRef.current = false;
    lastLoadedId.current = loadKey;
  }, [candidate?.artifactId, candidate?.body]);

  const conversation = useMemo(
    () => messages.map((message) => `${message.role}: ${message.content}`).join("\n"),
    [messages],
  );

  const run = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label);
    try {
      await fn();
      await refetch();
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const body = {
    bookId,
    draftId: bookId ? undefined : draftId,
  };

  const persistIfDirty = async (): Promise<string | undefined> => {
    if (!candidate) return undefined;
    if (!dirtyRef.current) return candidate.artifactId;
    const saved = await putApi<{ artifactId?: string }>(`/authoring/artifacts/${candidate.artifactId}`, {
      ...body,
      body: editBody,
    });
    dirtyRef.current = false;
    await refetch();
    return saved.artifactId ?? candidate.artifactId;
  };

  const historical = Boolean(report && candidate && !report.targetRefs.includes(candidate.artifactId));

  return (
    <aside className="flex h-full min-h-0 w-full max-w-[480px] flex-col border-l border-border bg-card/60">
      <div className="border-b border-border px-5 py-4">
        <h2 className="font-serif text-[26px] leading-tight">{isZh ? "故事正典" : "Canon"}</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          {candidate
            ? (isZh ? `候选 v${candidate.version} · ${candidate.status}` : `Candidate v${candidate.version} · ${candidate.status}`)
            : (isZh ? "还没有故事正典" : "No canon yet")}
          {data?.adoptedAskId && candidate && data.adoptedAskId !== candidate.artifactId
            ? (isZh ? " · 正式版尚未采用此稿" : " · adopted copy unchanged")
            : ""}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 text-[15px] leading-7">
        {preview || editBody ? (
          <>
            {preview ? <CanonPreview canon={preview} /> : null}
            <label className="mt-4 block text-xs font-semibold text-muted-foreground">
              {isZh ? "候选正文（可改）" : "Candidate (editable)"}
              <textarea
                className="mt-1 min-h-[180px] w-full rounded-md border border-border bg-background px-3 py-2 font-serif text-sm leading-6"
                value={editBody}
                onChange={(event) => {
                  dirtyRef.current = true;
                  setEditBody(event.target.value);
                }}
                data-testid="ask-candidate-body"
              />
            </label>
            {candidate ? (
              <button
                type="button"
                className="mt-2 rounded-lg border border-border px-3 py-1.5 text-sm disabled:opacity-40"
                disabled={Boolean(busy) || editBody === candidate.body}
                onClick={() => void run("save", () => putApi(`/authoring/artifacts/${candidate.artifactId}`, {
                  ...body,
                  body: editBody,
                }))}
              >
                {isZh ? "保存手改" : "Save edits"}
              </button>
            ) : null}
            {adopted && candidate && data?.adoptedAskId !== candidate.artifactId ? (
              <p className="mt-3 text-xs text-muted-foreground">
                {isZh ? `已采用正典仍是《${adopted.title ?? "未命名"}》` : `Adopted canon remains “${adopted.title ?? "untitled"}”`}
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            {isZh ? "还没有故事正典。先说一句你想写的故事，也可以粘贴已有构思。" : "Start with one sentence, or paste an existing premise."}
          </p>
        )}
      </div>
      <div className="space-y-2 border-t border-border px-5 py-4">
        <button
          type="button"
          className="w-full rounded-lg bg-primary px-3 py-[9px] text-sm text-primary-foreground disabled:opacity-40"
          disabled={Boolean(busy) || (!bookId && !draftId)}
          onClick={() => void run("generate", async () => {
            await persistIfDirty();
            await postApi("/authoring/ask/generate", { ...body, conversation });
          })}
        >
          {busy === "generate" ? (isZh ? "生成中…" : "Generating…") : (preview ? (isZh ? "更新正典" : "Update canon") : (isZh ? "生成故事正典" : "Generate canon"))}
        </button>
        <div className="flex gap-2">
          <button
            type="button"
            className="flex-1 rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40"
            disabled={!candidate || Boolean(busy)}
            onClick={() => void run("review", async () => {
              const artifactId = resolveAdoptArtifactId(await persistIfDirty(), candidate?.artifactId);
              await postApi("/authoring/ask/review", { ...body, artifactId, conversation });
              setReportOpen(true);
            })}
          >
            {isZh ? "审查正典" : "Review"}
          </button>
          <button
            type="button"
            className="flex-1 rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-40"
            disabled={!candidate || Boolean(busy)}
            onClick={() => void run("adopt", async () => {
              const artifactId = resolveAdoptArtifactId(await persistIfDirty(), candidate?.artifactId);
              const result = await postApi<{ message?: string; bookId?: string }>("/authoring/ask/adopt", {
                ...body,
                artifactId,
              });
              showToast(result.message ?? (isZh ? "正典已采用" : "Canon adopted"));
              if (result.bookId && !bookId) onAdopted?.(result.bookId);
            })}
          >
            {bookId ? (isZh ? "采用正典" : "Adopt canon") : (isZh ? "采用正典并建书" : "Adopt and create")}
          </button>
        </div>
      </div>

      <Drawer
        open={reportOpen}
        title={isZh ? "问心审查" : "Ask review"}
        onClose={() => setReportOpen(false)}
      >
        {report ? (
          <div className="space-y-3">
            <p className="text-sm">{report.summary}</p>
            <p className="text-xs text-muted-foreground">
              {report.actualReviewModel}
              {report.incomplete ? (isZh ? " · 结果不完整" : " · incomplete") : ""}
              {report.stale || historical ? (isZh ? " · 报告对应旧稿" : " · historical report") : ""}
            </p>
            {report.incomplete ? (
              <p className="text-sm text-mark-text">{isZh ? "本次审查结果不完整，请重试。" : "This review is incomplete. Retry."}</p>
            ) : null}
            {(historical || report.stale) ? (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={reuseStale} onChange={(event) => setReuseStale(event.target.checked)} />
                {isZh ? "沿用这些建议修改当前稿" : "Reuse these notes on the current draft"}
              </label>
            ) : null}
            {report.issues.map((issue) => (
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
                <span>
                  <strong>{issue.title}</strong>
                  {issue.suggestion ? <span className="block text-muted-foreground">{issue.suggestion}</span> : null}
                </span>
              </label>
            ))}
            <button
              type="button"
              className="w-full rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-40"
              disabled={!candidate || selected.length === 0 || !report || report.incomplete || ((historical || report.stale) && !reuseStale)}
              onClick={() => void run("revise", async () => {
                const artifactId = resolveAdoptArtifactId(await persistIfDirty(), candidate?.artifactId);
                await postApi("/authoring/ask/revise", {
                  ...body,
                  artifactId,
                  reportId: report.reportId,
                  selectedIssueIds: selected,
                  reuseStale,
                });
              })}
            >
              {isZh ? `按 ${selected.length} 条意见修改` : `Revise ${selected.length} issues`}
            </button>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{isZh ? "还没有审查报告。" : "No report yet."}</p>
        )}
      </Drawer>
    </aside>
  );
}

function CanonPreview({ canon }: { readonly canon: CanonDoc }) {
  const rows: Array<[string, string]> = [
    ["一句话故事", canon.oneLine ?? ""],
    ["核心命题", canon.proposition ?? ""],
    ["主角与核心欲望", canon.protagonist ?? ""],
    ["主要冲突", canon.conflict ?? ""],
    ["叙事视角与文风", canon.voice ?? ""],
    ["故事边界", canon.boundaries ?? ""],
    ["初始方向", canon.direction ?? ""],
  ];
  return (
    <div className="space-y-4">
      <h3 className="font-serif text-xl">{canon.title}</h3>
      {rows.filter(([, value]) => value).map(([label, value]) => (
        <section key={label}>
          <h4 className="text-xs font-semibold text-muted-foreground">{label}</h4>
          <p className="whitespace-pre-wrap">{value}</p>
        </section>
      ))}
      {canon.openQuestions && canon.openQuestions.length > 0 ? (
        <section>
          <h4 className="text-xs font-semibold text-muted-foreground">待定项</h4>
          <ul className="list-disc pl-5">
            {canon.openQuestions.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
