/** SPDX-License-Identifier: AGPL-3.0-only */
import { useState } from "react";
import { useApi } from "../hooks/use-api";

export function ImportMaterialsPage({ isZh, onOpenAsk }: {
  readonly isZh: boolean;
  readonly onOpenAsk: (bookId?: string) => void;
}) {
  const { data, loading, error, refetch } = useApi<{ books: ReadonlyArray<{ id: string; title: string }> }>("/books");
  const [bookId, setBookId] = useState("");
  return <section className="space-y-6" data-testid="import-materials-page">
    <h1 className="font-serif text-[32px] font-medium">{isZh ? "导入资料" : "Import materials"}</h1>
    <p className="max-w-prose text-sm leading-7 text-muted-foreground">{isZh ? "把旧作、设定笔记或文风参考交给问心。说明你希望保留什么、重新整理什么，再检查整理出的候选正典。" : "Bring an existing manuscript, setting notes or style references into Ask. Describe what to preserve or revise, then review the proposed canon."}</p>
    <label className="block max-w-lg space-y-2 text-sm">
      <span>{isZh ? "资料用于" : "Use materials for"}</span>
      <select className="w-full h-11 rounded-lg border border-border bg-card px-3" value={bookId} onChange={(event) => setBookId(event.target.value)} disabled={loading || Boolean(error)}>
        <option value="">{isZh ? "一部新作品" : "A new work"}</option>
        {data?.books.map((book) => <option key={book.id} value={book.id}>{book.title}</option>)}
      </select>
    </label>
    {loading ? <p role="status" className="text-sm">{isZh ? "正在读取作品…" : "Loading works…"}</p> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{isZh ? "作品列表未能读取。" : "Could not load works."}<button className="btn-ghost ml-2" type="button" onClick={() => void refetch()}>{isZh ? "重试" : "Retry"}</button></p> : null}
    <button type="button" className="btn-primary" disabled={loading || Boolean(error)} onClick={() => onOpenAsk(bookId || undefined)}>{isZh ? "去问心上传资料" : "Upload materials in Ask"}</button>
    <p className="text-sm text-muted-foreground">{isZh ? "资料会保留原文件。整理结果由你确认采用，已有正文保持原样。" : "Original files are retained. You decide whether to adopt the result; existing chapters remain unchanged."}</p>
  </section>;
}
