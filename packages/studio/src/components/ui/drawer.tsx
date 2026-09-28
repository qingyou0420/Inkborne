/**
 * Right-side drawer: ESC, themed overlay, 420 width, 18px serif title.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export function Drawer({
  open,
  title,
  onClose,
  children,
  testId,
  placement = "side",
}: {
  readonly open: boolean;
  readonly title: string;
  readonly onClose: () => void;
  readonly children: ReactNode;
  readonly testId?: string;
  readonly placement?: "side" | "center";
}) {
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (!panel) return;
    const focusable = () => Array.from(panel.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]',
    )).filter((element) => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const handleKey = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== panel) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key === "Tab") {
        const items = focusable();
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) { event.preventDefault(); panel.focus(); return; }
        if (!panel.contains(document.activeElement) || (event.shiftKey && document.activeElement === first)) {
          event.preventDefault(); (event.shiftKey ? last : first).focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault(); first.focus();
        }
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("keydown", handleKey);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open]);

  if (!open) return null;
  if (typeof document === "undefined") return null;

  return createPortal(
    <div
      className={`fixed inset-0 z-[80] flex bg-foreground/20 fade-in-150 ${placement === "center" ? "items-center justify-center p-6" : "justify-end"}`}
      onClick={onClose}
      data-testid={testId}
    >
      <aside
        ref={panelRef}
        tabIndex={-1}
        className={`flex w-full flex-col overflow-y-auto border-border bg-card px-6 py-6 ${placement === "center" ? "max-h-[90vh] max-w-[560px] rounded-lg border" : "h-full max-w-[420px] border-l"}`}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="mb-5 flex items-center justify-between gap-3">
          <h2 className="font-serif text-[18px] font-medium leading-[26px]">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost rounded-lg"
            aria-label={/[\u3400-\u9fff]/.test(title) ? "关闭" : "Close"}
          >
            <X size={16} />
          </button>
        </div>
        {children}
      </aside>
    </div>,
    document.body,
  );
}
