import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode, type SelectHTMLAttributes } from "react";
import { cn } from "../lib/cn.ts";
import { ErrorNotification } from "./toaster.tsx";

type Issue = { path: (string | number)[]; message: string; code?: string; minimum?: number; maximum?: number; inclusive?: boolean; format?: string; origin?: string; pattern?: string };
export function fieldError(path: string, message: string) { return { issues: [{ path: path.split("."), message, code: "custom" }] }; }

/** Consume structured issues, never render the validator's serialized diagnostic. */
export function validationIssues(error: unknown): Issue[] {
  if (!error || typeof error !== "object") return [];
  const value = error as { issues?: unknown; details?: { issues?: unknown }; message?: unknown };
  let issues = value.issues ?? value.details?.issues;
  // Some existing APIs return Zod's serialized message. Decode only an issue array,
  // without changing the API contract or printing its input/regex/debug metadata.
  if (!issues && typeof value.message === "string" && value.message.trim().startsWith("[")) {
    try { issues = JSON.parse(value.message); } catch { /* ordinary API message */ }
  }
  return Array.isArray(issues) ? issues.filter((issue): issue is Issue =>
    issue && Array.isArray(issue.path) && issue.path.every((part: unknown) => typeof part === "string" || typeof part === "number") && typeof issue.message === "string") : [];
}

export function validationMessage(issue: Issue): string {
  if (issue.code === "too_small") return issue.origin === "number" ? `Enter a number ${issue.inclusive === false ? "greater than" : "of at least"} ${issue.minimum}.` : issue.minimum === 1 ? "This field is required." : `Enter at least ${issue.minimum} ${issue.origin === "array" ? "items" : "characters"}.`;
  if (issue.code === "too_big") return issue.origin === "number" ? `Enter a number ${issue.inclusive === false ? "less than" : "no greater than"} ${issue.maximum}.` : `Use at most ${issue.maximum} ${issue.origin === "array" ? "items" : "characters"}.`;
  if (issue.code === "invalid_format") return issue.pattern === "/^[a-z][a-z0-9-]*$/" ? "Start with a lowercase letter; use only lowercase letters, numbers and hyphens." : issue.format === "email" ? "Enter a valid email address." : "Use the required format.";
  if (issue.code === "invalid_type") return "Enter a value of the required type.";
  if (issue.code === "invalid_value") return "Choose a supported value.";
  if (issue.code === "custom") return issue.message;
  return "Check this value.";
}

type ValidationContext = { issuesFor(name: string): Issue[]; dismissed: Set<string>; clear(name: string): void; register(name: string): () => void };
const Context = createContext<ValidationContext | undefined>(undefined);
const Control = createContext<{ id: string; "aria-invalid"?: true; "aria-describedby"?: string } | undefined>(undefined);
export function useFieldControl() { return useContext(Control); }
const normalize = (path: string) => path === "definition" ? "" : path.replace(/^definition\./, "");
const matches = (name: string, issue: Issue) => { const path = normalize(issue.path.join(".")); name = normalize(name); return !name || path === name || path.startsWith(`${name}.`); };

export function FormValidation({ error, children, fallbackField, targetField }: { error?: unknown; children: ReactNode; fallbackField?: string; targetField?: string }) {
  let issues = validationIssues(error);
  if (!issues.length && fallbackField && error instanceof Error && (error as Error & { code?: string }).code === "invalid-request") {
    issues = validationIssues(fieldError(fallbackField, error.message));
  }
  const [fields, setFields] = useState<Record<string, number>>({});
  const [edited, setEdited] = useState<{ error: unknown; names: Set<string> }>({ error: undefined, names: new Set() });
  const dismissed = edited.error === error ? edited.names : new Set<string>();
  const root = useRef<HTMLDivElement>(null);
  const register = useRef((name: string) => {
    setFields(current => ({ ...current, [name]: (current[name] ?? 0) + 1 }));
    return () => setFields(current => { const next = { ...current }; if ((next[name] ?? 0) <= 1) delete next[name]; else next[name]!--; return next; });
  }).current;
  useEffect(() => {
    if (!error) return;
    const field = root.current?.querySelector<HTMLElement>('[aria-invalid="true"]:not([disabled])');
    if (field) { let parent = field.parentElement; while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; } field.focus(); }
  }, [error, fields]);
  const owner = (issue: Issue) => (targetField && fields[targetField] ? targetField : undefined) ?? Object.keys(fields).filter(name => matches(name, issue)).sort((a, b) => b.length - a.length)[0] ?? (fallbackField && fields[fallbackField] ? fallbackField : undefined);
  const unmatched = issues.filter(issue => !owner(issue));
  const general = error && !issues.length ? (error instanceof Error ? error.message : typeof error === "string" ? error : "Could not complete this action. Please try again.") : undefined;
  return <Context.Provider value={{ issuesFor: name => issues.filter(issue => owner(issue) === name), dismissed, register, clear: name => setEdited(current => ({ error, names: new Set([...(current.error === error ? current.names : []), name]) })) }}>
    <div ref={root} className="contents" onSubmitCapture={() => setEdited({ error, names: new Set() })}>
      {children}
      <ErrorNotification description={general} />
      {unmatched.length ? <div role="alert" className="col-span-full rounded-md border border-destructive bg-destructive/5 p-3 text-sm text-destructive">Check the form values.<ul>{unmatched.map((issue, index) => <li key={index}>{validationMessage(issue)}</li>)}</ul></div> : null}
    </div>
  </Context.Provider>;
}

/** Field paths use the request schema, including definition and nested slot names. */
export function Field({ name, children, className = "grid gap-1 text-sm font-medium" }: { name: string; children: ReactNode; className?: string }) {
  const context = useContext(Context);
  const id = useId();
  useEffect(() => context?.register(name), [context?.register, name]);
  const issues = context?.dismissed.has(name) ? [] : context?.issuesFor(name) ?? [];
  const allMessages = [...new Set(issues.map(validationMessage))];
  const messages = allMessages.includes("This field is required.") ? ["This field is required."] : allMessages;
  return <Control.Provider value={{ id, ...(messages.length ? { "aria-invalid": true as const, "aria-describedby": `${id}-error` } : {}) }}>
    <div className={cn(className, "self-start content-start")} onChangeCapture={() => context?.clear(name)}><label htmlFor={id} className="grid content-start gap-1">{children}</label>
      {messages.length ? <span id={`${id}-error`} role="alert" className="block text-sm font-normal text-destructive">{messages.join(" ")}</span> : null}
    </div>
  </Control.Provider>;
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  const field = useFieldControl();
  return <select {...field} {...props} className={`${props.className ?? ""} aria-invalid:border-destructive`} aria-describedby={[props["aria-describedby"], field?.["aria-describedby"]].filter(Boolean).join(" ") || undefined} />;
}
