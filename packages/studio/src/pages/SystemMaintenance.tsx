/** SPDX-License-Identifier: AGPL-3.0-only */
import { useState } from "react";
import { useApi } from "../hooks/use-api";
import { getDesktopBridge } from "../lib/desktop-bridge";
import { PRODUCT_VERSION } from "../lib/product-version";

export function SystemMaintenance({ isZh, bookId, nav }: {
  readonly isZh: boolean;
  readonly bookId?: string;
  readonly nav: {
    toLogs: () => void; toDoctor: () => void; toCheckUpdate: () => void;
    toTruth: (id: string) => void;
  };
}) {
  const { data, loading, error, refetch } = useApi<{ books: ReadonlyArray<{ id: string; title: string }> }>("/books");
  const [selected, setSelected] = useState(bookId ?? "");
  const [notice, setNotice] = useState("");
  const openFolder = async (kind: "logs" | "project") => {
    setNotice("");
    const bridge = getDesktopBridge();
    const open = kind === "logs" ? bridge?.openLogDir : bridge?.openProjectDir;
    if (!open) { setNotice(isZh ? "请在桌面版使用此功能。" : "This action is available in the desktop app."); return; }
    try {
      const result = await open();
      if (result.ok === false) setNotice(result.message || (isZh ? "目录未能打开。" : "Could not open the folder."));
    } catch (err) { setNotice(err instanceof Error ? err.message : String(err)); }
  };
  return <section className="space-y-8" data-testid="system-maintenance">
    <div><h1 className="font-serif text-[32px] font-medium">{isZh ? "系统维护" : "System maintenance"}</h1><p className="mt-2 text-sm text-muted-foreground">轻光之集 · {PRODUCT_VERSION}</p></div>
    <div className="space-y-3 border-b border-border pb-6">
      <h2 className="text-base font-medium">{isZh ? "运行与排错" : "Activity and diagnostics"}</h2>
      <div className="flex flex-wrap gap-3"><button className="btn-secondary" type="button" onClick={nav.toLogs}>{isZh ? "实时动态与日志" : "Activity and logs"}</button><button className="btn-secondary" type="button" onClick={nav.toDoctor}>{isZh ? "环境诊断" : "Diagnostics"}</button></div>
    </div>
    <div className="space-y-3 border-b border-border pb-6">
      <h2 className="text-base font-medium">{isZh ? "本机资料" : "Local files"}</h2>
      <div className="flex flex-wrap gap-3"><button className="btn-secondary" type="button" onClick={() => void openFolder("project")}>{isZh ? "打开项目目录" : "Open project folder"}</button><button className="btn-secondary" type="button" onClick={() => void openFolder("logs")}>{isZh ? "打开日志目录" : "Open log folder"}</button></div>
      {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
      <label className="block max-w-lg space-y-2 text-sm"><span>{isZh ? "查看作品原始资料" : "Inspect source files"}</span><select className="h-10 w-full rounded-lg border border-border bg-card px-3" value={selected} onChange={(event) => setSelected(event.target.value)} disabled={loading || Boolean(error)}><option value="">{isZh ? "选择作品" : "Choose a work"}</option>{data?.books.map((book) => <option key={book.id} value={book.id}>{book.title}</option>)}</select></label>
      {error ? <p role="alert" className="text-sm text-destructive">{isZh ? "作品列表未能读取。" : "Could not load works."}<button className="btn-ghost" type="button" onClick={() => void refetch()}>{isZh ? "重试" : "Retry"}</button></p> : null}
      <button className="btn-secondary" type="button" disabled={!selected || loading || Boolean(error)} onClick={() => nav.toTruth(selected)}>{isZh ? "打开原始资料" : "Open source files"}</button>
    </div>
    <div className="space-y-3"><h2 className="text-base font-medium">{isZh ? "关于与更新" : "About and updates"}</h2><button className="btn-secondary" type="button" onClick={nav.toCheckUpdate}>{isZh ? "检查更新" : "Check for updates"}</button><p className="text-xs text-muted-foreground">Lightbound · InkOS · AGPL-3.0-only</p></div>
  </section>;
}
