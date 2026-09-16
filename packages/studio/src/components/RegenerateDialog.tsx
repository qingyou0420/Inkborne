/** SPDX-License-Identifier: AGPL-3.0-only */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Drawer } from "./ui/drawer";

export function RegenerateDialog({ open, title, scopeLabel, isZh, busy, error, reportSummary, children, onClose, onConfirm }: {
  readonly open: boolean;
  readonly title: string;
  readonly scopeLabel?: string;
  readonly isZh: boolean;
  readonly busy?: boolean;
  readonly error?: string | null;
  readonly reportSummary?: string;
  readonly children?: ReactNode;
  readonly onClose: () => void;
  readonly onConfirm: (requirements: string) => Promise<boolean | void>;
}) {
  const [keep, setKeep] = useState("");
  const [change, setChange] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const submitting = useRef(false);
  useEffect(() => {
    if (open) { setKeep(""); setChange(""); setFailure(null); }
  }, [open]);
  const working = Boolean(busy || pending);
  const submit = async () => {
    if (working || submitting.current) return;
    submitting.current = true;
    setPending(true);
    setFailure(null);
    const requirements = [keep.trim() && `${isZh ? "保留内容" : "Preserve"}：\n${keep.trim()}`, change.trim() && `${isZh ? "修改重点" : "Change"}：\n${change.trim()}`].filter(Boolean).join("\n\n");
    try {
      if (await onConfirm(requirements) !== false) onClose();
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally { submitting.current = false; setPending(false); }
  };
  return <Drawer open={open} title={title} placement="center" onClose={() => { if (!working) onClose(); }}>
    <form className="space-y-5" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {scopeLabel ? <p className="text-sm text-muted-foreground">{scopeLabel}</p> : null}
      {children}
      {reportSummary ? <details className="text-sm leading-7"><summary>{isZh ? "本次参考的审查意见" : "Review notes"}</summary><p className="whitespace-pre-wrap">{reportSummary}</p></details> : null}
      <label className="block text-sm">{isZh ? "保留内容" : "Preserve"}<textarea className="ink-task-input" rows={3} value={keep} onChange={(event) => setKeep(event.target.value)} disabled={working} placeholder={isZh ? "哪些设定、情节或文字希望保留" : "Details, plot points, or wording to keep"} /></label>
      <label className="block text-sm">{isZh ? "修改重点" : "Change"}<textarea className="ink-task-input" rows={4} value={change} onChange={(event) => setChange(event.target.value)} disabled={working} placeholder={isZh ? "希望这次调整什么" : "What should change this time"} /></label>
      {failure || error ? <p role="alert" className="text-sm text-destructive">{failure || error}</p> : null}
      <div className="flex justify-end gap-3"><button className="btn-ghost" type="button" disabled={working} onClick={onClose}>{isZh ? "取消" : "Cancel"}</button><button className="btn-primary" type="submit" disabled={working}>{working ? (isZh ? "正在生成…" : "Generating…") : (isZh ? "生成新候选" : "Generate candidate")}</button></div>
    </form>
  </Drawer>;
}
