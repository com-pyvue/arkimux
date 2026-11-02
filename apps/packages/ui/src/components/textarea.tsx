import type { TextareaHTMLAttributes } from "react";
import { cn } from "../lib/cn.ts";
import { useFieldControl } from "./form-validation.tsx";

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const field = useFieldControl();
  return (
    <textarea
      {...field}
      className={cn(
        "min-h-40 w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm shadow-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        className,
      )}
      {...props}
      aria-describedby={[props["aria-describedby"], field?.["aria-describedby"]].filter(Boolean).join(" ") || undefined}
    />
  );
}
