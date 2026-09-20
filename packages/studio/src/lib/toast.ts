/**
 * Lightweight toast bus. Replaces window.alert in Studio UI.
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export type ToastVariant = "info" | "success" | "error";

export interface ToastAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface ToastItem {
  readonly id: number;
  readonly message: string;
  readonly variant: ToastVariant;
  readonly action?: ToastAction;
}

type Listener = (toasts: ReadonlyArray<ToastItem>) => void;

let nextId = 1;
let toasts: ToastItem[] = [];
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener(toasts);
}

export function showToast(message: string, variant: ToastVariant = "info", action?: ToastAction): void {
  const text = message.trim();
  if (!text) return;
  const item: ToastItem = { id: nextId++, message: text, variant, ...(action?.label.trim() ? { action } : {}) };
  toasts = [...toasts, item];
  emit();
  window.setTimeout(() => dismissToast(item.id), item.action ? 8000 : 4200);
}

export function dismissToast(id: number): void {
  const next = toasts.filter((item) => item.id !== id);
  if (next.length === toasts.length) return;
  toasts = next;
  emit();
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}
