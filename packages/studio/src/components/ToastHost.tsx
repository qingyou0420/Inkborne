/**
 * Global toast host for Studio. Replaces window.alert.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { useEffect, useState } from "react";
import { dismissToast, subscribeToasts, type ToastItem } from "../lib/toast";

export function ToastHost() {
  const [toasts, setToasts] = useState<ReadonlyArray<ToastItem>>([]);

  useEffect(() => subscribeToasts(setToasts), []);

  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-6 top-16 z-[120] flex w-[min(22rem,calc(100vw-2rem))] flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          data-testid="studio-toast"
          data-variant={toast.variant}
          className={`pointer-events-auto rounded-xl border px-4 py-3 text-left text-sm leading-6 shadow-soft fade-in ${
            toast.variant === "error"
              ? "border-destructive/30 bg-destructive/10 text-destructive"
              : toast.variant === "success"
                ? "border-primary/25 bg-card text-foreground"
                : "border-border bg-card text-foreground"
          }`}
        >
          <button type="button" className="block w-full text-left" onClick={() => dismissToast(toast.id)}>
            {toast.message}
          </button>
          {toast.action ? (
            <button
              type="button"
              data-testid="studio-toast-action"
              className="mt-2 text-sm font-medium underline underline-offset-2"
              onClick={() => {
                toast.action?.onClick();
                dismissToast(toast.id);
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
