/** SPDX-License-Identifier: AGPL-3.0-only */
export function NewWorkPage({ isZh, onNovel, onShort }: {
  readonly isZh: boolean;
  readonly onNovel: () => void;
  readonly onShort: () => void;
}) {
  return <section className="mx-auto w-full max-w-2xl px-8 py-12 space-y-8" data-testid="new-work-page">
    <h1 className="font-serif text-[32px] font-medium">{isZh ? "新建作品" : "New work"}</h1>
    <div className="divide-y divide-border">
      <div className="flex flex-wrap items-center justify-between gap-5 py-6">
        <div><h2 className="text-lg font-medium">{isZh ? "小说" : "Novel"}</h2><p className="mt-2 text-sm text-muted-foreground">{isZh ? "从问心开始，逐步整理设定、规划章节与写作。" : "Begin in Ask, then develop settings, chapter plans and prose."}</p></div>
        <button type="button" className="btn-primary" onClick={onNovel} data-testid="create-novel">{isZh ? "进入问心" : "Enter Ask"}</button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-5 py-6">
        <div><h2 className="text-lg font-medium">{isZh ? "短篇" : "Short story"}</h2><p className="mt-2 text-sm text-muted-foreground">{isZh ? "写一篇独立故事，从构思到正文。" : "Develop a standalone story from premise to manuscript."}</p></div>
        <button type="button" className="btn-secondary" onClick={onShort} data-testid="create-short">{isZh ? "开始短篇" : "Start a short story"}</button>
      </div>
    </div>
  </section>;
}
