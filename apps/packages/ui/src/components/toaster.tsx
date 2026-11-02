import { useEffect, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { Toast, type ToastProps } from "./toast.tsx";

export type Notification = Omit<ToastProps, "onDismiss">;
type QueuedNotification = Notification & { id: number };
let nextId = 0;
let queue: readonly QueuedNotification[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };

/** All operation notifications use this dispatcher, never a page-owned Toast. */
export function notify(notification: Notification): number {
  const existing = queue.find(item => item.title === notification.title && item.description === notification.description && item.variant === notification.variant);
  if (existing) return existing.id;
  const id = ++nextId;
  // Bound the queue during outages. Keep the visible item and the latest failures.
  queue = [...(queue.length >= 10 ? [queue[0]!, ...queue.slice(-8)] : queue), { ...notification, id }];
  // A background status notice must not hide the error from the user's action.
  if (notification.variant === "error" && queue[0]?.variant !== "error") queue = [queue.at(-1)!, ...queue.slice(0, -1)];
  emit();
  return id;
}

export function dismissNotification(id: number) { queue = queue.filter(item => item.id !== id); emit(); }

/** Mount once at the app root. Portal into a modal so native dialog inertness
 * cannot hide the notification or disable its copy/dismiss controls. */
export function Toaster() {
  const notifications = useSyncExternalStore(subscribe, () => queue, () => queue);
  const [dialog, setDialog] = useState<HTMLDialogElement | null>(null);
  useEffect(() => {
    const update = () => setDialog([...document.querySelectorAll<HTMLDialogElement>("dialog[open]")].at(-1) ?? null);
    update();
    const observer = new MutationObserver(update);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
    return () => { observer.disconnect(); queue = []; emit(); };
  }, []);
  const first = notifications[0];
  const content = first ? <Toast key={first.id} {...first} onDismiss={() => dismissNotification(first.id)} /> : null;
  return dialog ? createPortal(content, dialog) : content;
}

/** Bridge query/render error states to the same dispatcher. Stable text avoids
 * repeated notifications on background refetches. Field validation stays inline. */
export function ErrorNotification({ description, title = "Could not complete this action" }: { description?: string; title?: string }) {
  useEffect(() => { if (description) notify({ title, description, variant: "error" }); }, [title, description]);
  return null;
}
