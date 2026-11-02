import { createContext, useContext, type ButtonHTMLAttributes, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn.ts";

interface TabsContextValue {
  value: string;
  onValueChange(value: string): void;
}

const TabsContext = createContext<TabsContextValue | undefined>(undefined);

export interface TabsProps extends Omit<HTMLAttributes<HTMLDivElement>, "onChange"> {
  value: string;
  onValueChange(value: string): void;
  children: ReactNode;
}

export function Tabs({ value, onValueChange, children, ...props }: TabsProps) {
  return <TabsContext value={{ value, onValueChange }}><div {...props}>{children}</div></TabsContext>;
}

export function TabsList({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div role="tablist" className={cn("inline-flex h-9 items-center rounded-lg bg-muted p-1", className)} {...props} />;
}

export interface TabsTriggerProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  value: string;
}

export function TabsTrigger({ value, className, ...props }: TabsTriggerProps) {
  const tabs = useTabs();
  const selected = tabs.value === value;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className={cn(
        "rounded-md px-3 py-1 text-sm transition",
        selected ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
        className,
      )}
      onClick={() => tabs.onValueChange(value)}
      {...props}
    />
  );
}

export interface TabsContentProps extends HTMLAttributes<HTMLDivElement> {
  value: string;
}

export function TabsContent({ value, ...props }: TabsContentProps) {
  const tabs = useTabs();
  return tabs.value === value ? <div role="tabpanel" {...props} /> : null;
}

function useTabs(): TabsContextValue {
  const value = useContext(TabsContext);
  if (!value) throw new Error("Tabs components must be rendered inside Tabs.");
  return value;
}
