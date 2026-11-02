// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it } from "vitest";
import { ErrorNotification, Toaster, notify } from "../../apps/packages/ui/src/index.ts";

afterEach(cleanup);
it("deduplicates notifications from separate consumers and queues distinct errors", async () => {
  render(<><Toaster /><ErrorNotification description="One failure" /><ErrorNotification description="One failure" /></>);
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  act(() => { notify({ title: "Second failure", description: "Another operation", variant: "error" }); });
  await userEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  expect(screen.getByRole("alert").textContent).toContain("Another operation");
  await userEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
  expect(screen.queryByRole("alert")).toBeNull();
});
it("keeps an error across page changes and above an open dialog, with copy and dismiss", async () => {
  const view = render(<><Toaster /><section><ErrorNotification description="Could not delete shared data." /></section><dialog open aria-label="Confirmation" /></>);
  await waitFor(() => expect(within(screen.getByRole("dialog")).getByRole("alert")).toBeTruthy());
  expect(within(screen.getByRole("alert")).getByRole("button", { name: "Copy error" })).toBeTruthy();
  view.rerender(<><Toaster /><section>Another page</section><dialog aria-label="Confirmation" /></>);
  await waitFor(() => expect(screen.getByRole("alert").closest("dialog")).toBeNull());
  expect(screen.getByRole("alert").textContent).toContain("Could not delete shared data.");
});
it("prioritizes an action error over a background warning and clears on app unmount", () => {
  const view = render(<Toaster />);
  act(() => { notify({ title: "Offline", description: "Retrying", variant: "warning" }); });
  act(() => { notify({ title: "Deletion failed", description: "Try again", variant: "error" }); });
  expect(screen.getByRole("alert").textContent).toContain("Deletion failed");
  view.unmount(); render(<Toaster />);
  expect(screen.queryByRole("alert")).toBeNull();
});
