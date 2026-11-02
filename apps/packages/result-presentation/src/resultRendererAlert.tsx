import { useId } from "react";

/** A persistent result-view notice; colour is reinforced by an icon and title. */
export function ResultRendererAlert({ message, tone = "error" }: { message: string; tone?: "error" | "warning" }) {
  const titleId = useId();
  const colours = tone === "warning"
    ? "border-amber-500 bg-amber-50 text-amber-950 dark:border-amber-400 dark:bg-amber-950/40 dark:text-amber-100"
    : "border-red-500 bg-red-50 text-red-950 dark:border-red-400 dark:bg-red-950/40 dark:text-red-100";
  return <div role="alert" aria-labelledby={titleId} className={`flex items-start gap-3 rounded-lg border border-l-4 p-4 ${colours}`}>
    <svg aria-hidden="true" focusable="false" className="mt-0.5 h-5 w-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3 2 21h20L12 3Z" /><path d="M12 9v4" /><path d="M12 17h.01" />
    </svg>
    <div className="space-y-1">
      <h4 id={titleId} className="font-semibold">{tone === "warning" ? "Could not load renderer" : "Result renderer failed"}</h4>
      <p className="text-sm leading-relaxed">{message}</p>
    </div>
  </div>;
}
