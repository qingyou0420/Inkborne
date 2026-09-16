/** SPDX-License-Identifier: AGPL-3.0-only */
import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "../components/ui/dialog";

export type DraftDecision = "save" | "discard" | "cancel";

/** Ask before leaving an edited manuscript; never silently save or discard it. */
export function useDraftDecision(isZh: boolean) {
  const [open, setOpen] = useState(false);
  const pending = useRef<((decision: DraftDecision) => void) | null>(null);
  const settle = useCallback((decision: DraftDecision) => {
    const resolve = pending.current;
    pending.current = null;
    setOpen(false);
    resolve?.(decision);
  }, []);
  useEffect(() => () => { pending.current?.("cancel"); pending.current = null; }, []);
  const ask = useCallback(() => {
    // A second navigation gesture does not replace the first pending decision.
    if (pending.current) return Promise.resolve<DraftDecision>("cancel");
    return new Promise<DraftDecision>((resolve) => { pending.current = resolve; setOpen(true); });
  }, []);
  const dialog = <Dialog open={open} onOpenChange={(next) => { if (!next) settle("cancel"); }}>
    <DialogContent showCloseButton={false}>
      <DialogTitle>{isZh ? "保留这次修改吗？" : "Keep your changes?"}</DialogTitle>
      <DialogDescription>{isZh ? "文稿还有未保存的修改。" : "This manuscript has unsaved changes."}</DialogDescription>
      <DialogFooter>
        <button type="button" className="btn-ghost" onClick={() => settle("cancel")}>{isZh ? "继续编辑" : "Keep editing"}</button>
        <button type="button" className="btn-secondary" onClick={() => settle("discard")}>{isZh ? "放弃修改" : "Discard changes"}</button>
        <button type="button" className="btn-primary" onClick={() => settle("save")}>{isZh ? "保存" : "Save"}</button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
  return { ask, dialog };
}
