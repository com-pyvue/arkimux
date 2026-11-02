import type { InputHTMLAttributes } from "react";
import { cn } from "../lib/cn.ts";
import { useFieldControl } from "./form-validation.tsx";

export function Input({ className, type = "text", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  const field = useFieldControl();
  return (
    <input
      type={type}
      {...field}
      className={cn(
        "h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm outline-none transition focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive",
        className,
      )}
      {...props}
      aria-describedby={[props["aria-describedby"], field?.["aria-describedby"]].filter(Boolean).join(" ") || undefined}
    />
  );
}
