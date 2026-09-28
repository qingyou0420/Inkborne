import { useEffect, useState } from "react";
import { BOOK_BUSY_EVENT, postApi, type StudioApiError } from "../hooks/use-api";
import { pageErrorText } from "../lib/error-copy";

function busySentence(heldMs?: number): string {
  if (heldMs == null || heldMs < 0) return "这本书正在被写入";
  const seconds = Math.max(1, Math.round(heldMs / 1000));
  if (seconds < 60) return `这本书正在被写入（已 ${seconds} 秒）`;
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `这本书正在被写入（已 ${minutes} 分钟）`;
}

export function BookBusyCard() {
  const [error, setError] = useState<StudioApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    const onBusy = (event: Event) => {
      const detail = (event as CustomEvent<StudioApiError>).detail;
      setError(detail);
      setNote(null);
    };
    window.addEventListener(BOOK_BUSY_EVENT, onBusy);
    return () => window.removeEventListener(BOOK_BUSY_EVENT, onBusy);
  }, []);

  if (!error) return null;
  const bookId = error.owner?.bookId;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-foreground/20 fade-in-150">
      <div className="w-full max-w-lg mx-4 rounded-2xl border border-border bg-card p-6 space-y-4">
        <p className="text-base font-medium">{busySentence(error.owner?.heldMs)}</p>
        {note ? <p className="text-sm text-muted-foreground">{note}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-2 text-sm"
            onClick={() => setError(null)}
          >
            等它写完
          </button>
          <button
            type="button"
            disabled={!bookId || busy}
            className="rounded-lg bg-destructive px-3 py-2 text-sm font-medium text-destructive-foreground disabled:opacity-50"
            onClick={async () => {
              if (!bookId) return;
              setBusy(true);
              try {
                await postApi(`/books/${bookId}/lock/force-release`);
                setNote("已经放开。可以重试刚才的操作。");
                setError(null);
              } catch (err) {
                setNote(pageErrorText(err instanceof Error ? err.message : String(err)));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "放开中…" : "强制放开"}
          </button>
          <button
            type="button"
            className="rounded-lg border border-border px-3 py-2 text-sm"
            onClick={() => setError(null)}
          >
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
