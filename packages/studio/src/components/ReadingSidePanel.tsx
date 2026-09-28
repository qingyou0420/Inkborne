/** SPDX-License-Identifier: AGPL-3.0-only */
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

let openPanels = 0;

/** Non-modal: writers can keep reading and selecting the manuscript beside the review. */
export function ReadingSidePanel({ open, title, onClose, children, testId }: {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly testId?: string;
}) {
  const titleId = useId();
  const [top, setTop] = useState<number>();
  const closeButton = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    openPanels += 1;
    document.documentElement.dataset.inkReviewOpen = "true";
    const workspace = document.querySelector<HTMLElement>(".ink-main");
    const position = () => { if (workspace) setTop(Math.max(0, workspace.getBoundingClientRect().top)); };
    position();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(position);
    if (workspace) observer?.observe(workspace);
    window.addEventListener("resize", position);
    closeButton.current?.focus();
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector('[role="dialog"][aria-modal="true"]')) {
        event.preventDefault();
        onCloseRef.current();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      window.removeEventListener("resize", position);
      observer?.disconnect();
      openPanels -= 1;
      if (!openPanels) delete document.documentElement.dataset.inkReviewOpen;
      if (previous?.isConnected && !document.querySelector('[role="dialog"][aria-modal="true"]')) previous.focus();
    };
  }, [open]);
  if (!open || typeof document === "undefined") return null;
  return createPortal(
    <aside className="ink-review-pane" style={top === undefined ? undefined : { top }} aria-labelledby={titleId} data-testid={testId}>
      <header className="ink-review-heading">
        <h2 id={titleId}>{title}</h2>
        <button ref={closeButton} type="button" className="btn-ghost" onClick={onClose} aria-label={/[\u3400-\u9fff]/.test(title) ? "收起审查" : "Close review"}><X size={18} /></button>
      </header>
      <div className="ink-review-content">{children}</div>
    </aside>, document.body,
  );
}
