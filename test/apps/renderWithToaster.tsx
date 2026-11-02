import { render, type RenderOptions } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";
import { Toaster } from "../../apps/packages/ui/src/index.ts";

/** Feature tests supply the notification host that the real app mounts once. */
export function renderWithToaster(ui: ReactElement, options?: RenderOptions) {
  const Wrapper = options?.wrapper;
  return render(ui, { ...options, wrapper: ({ children }: { children: ReactNode }) => <><Toaster />{Wrapper ? <Wrapper>{children}</Wrapper> : children}</> });
}
