import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn.ts";

export type ToastVariant = "success" | "warning" | "error";

export interface ToastProps {
  title: string;
  description: string;
  variant: ToastVariant;
  onDismiss(): void;
  durationMs?: number;
}

const variants: Record<ToastVariant, string> = {
  success: "border-emerald-500/30 bg-background text-emerald-800 dark:text-emerald-200",
  warning: "border-amber-500/30 bg-background text-amber-800 dark:text-amber-200",
  error: "border-destructive/30 bg-background text-destructive",
};

export function Toast({ title, description, variant, onDismiss, durationMs = 8_000 }: ToastProps) {
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const copyRequest = useRef(0);
  const dismiss = useRef(onDismiss); dismiss.current = onDismiss;
  const text = `${title}\n\n${description}`;
  const currentText = useRef(text); currentText.current = text;
  const currentVariant = useRef(variant); currentVariant.current = variant;
  const paused = hovered || focused || copyState !== "idle";

  useEffect(() => {
    setCopyState("idle");
    // Retire pending clipboard requests when the notification changes or closes.
    copyRequest.current++;
    return () => { copyRequest.current++; };
  }, [title, description, variant]);

  useEffect(() => {
    if (durationMs <= 0 || paused) return;
    const timeout = window.setTimeout(() => dismiss.current(), durationMs);
    return () => window.clearTimeout(timeout);
  }, [durationMs, paused, title, description, variant]);

  useEffect(() => {
    if (copyState !== "copied") return;
    const timeout = window.setTimeout(() => setCopyState("idle"), 2_000);
    return () => window.clearTimeout(timeout);
  }, [copyState]);

  async function copyError() {
    if (variant !== "error" || copyState === "copying") return;
    const request = ++copyRequest.current;
    setCopyState("copying");
    try {
      await navigator.clipboard.writeText(text);
      if (request === copyRequest.current && currentText.current === text && currentVariant.current === "error") setCopyState("copied");
    } catch {
      if (request === copyRequest.current && currentText.current === text && currentVariant.current === "error") setCopyState("failed");
    }
  }

  const copyLabel = copyState === "copied" ? "Copied" : "Copy error";

  return <div
    role={variant === "error" ? "alert" : "status"}
    aria-live={variant === "error" ? "assertive" : "polite"}
    onMouseEnter={() => setHovered(true)}
    onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)}
    onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}
    className={cn("fixed bottom-5 right-5 z-50 grid max-w-md grid-cols-[1fr_auto] gap-x-4 gap-y-1 rounded-lg border p-4 shadow-lg", variants[variant])}
  >
    <p className="font-semibold">{title}</p>
    <div className="flex items-start gap-2">
      {variant === "error" ? <button type="button" title={copyLabel} aria-label={copyLabel}
        disabled={copyState === "copying"} onClick={() => void copyError()}
        className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50">
        <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          {copyState === "copied" ? <path d="m5 12 4 4 10-10" /> : <>
            <rect x="8" y="8" width="12" height="12" rx="2" />
            <path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" />
          </>}
        </svg>
      </button> : null}
      <button type="button" className="rounded p-1 text-xl leading-none text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" aria-label="Dismiss notification" onClick={onDismiss}>×</button>
    </div>
    <p className="col-span-2 select-text whitespace-pre-wrap break-words text-sm text-foreground">{description}</p>
    <span className="sr-only" aria-live="polite">{copyState === "copied" ? "Error copied." : ""}</span>
    {copyState === "failed" ? <p className="col-span-2 select-text text-sm text-foreground" aria-live="polite">
      Could not copy. Select the error text and copy it manually.
    </p> : null}
  </div>;
}
