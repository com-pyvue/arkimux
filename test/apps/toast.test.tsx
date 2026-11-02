// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Toast, type ToastProps } from "../../apps/packages/ui/src/components/toast.tsx";

const manualCopyMessage = "Could not copy. Select the error text and copy it manually.";
let originalClipboard: PropertyDescriptor | undefined;

beforeEach(() => {
  originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
  else Reflect.deleteProperty(navigator, "clipboard");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function stubClipboard(writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined)) {
  const readText = vi.fn();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText, readText } });
  return { writeText, readText };
}

function toastProps(overrides: Partial<ToastProps> = {}): ToastProps {
  return { title: "Connection failed", description: "The provider could not connect.", variant: "error", onDismiss: vi.fn(), durationMs: 0, ...overrides };
}

function deferredWrite() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function copyError() {
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Copy error" })); });
}

function advanceTime(milliseconds: number) {
  act(() => { vi.advanceTimersByTime(milliseconds); });
}

describe("Toast", () => {
  it("copies the exact title and multiline description using an icon-only native button", async () => {
    const { writeText, readText } = stubClipboard();
    const props = toastProps({ title: "Connection failed\nProvider response", description: "First line\n\n  Indented detail\nLast line\n" });
    render(<Toast {...props} />);

    const button = screen.getByRole("button", { name: "Copy error" });
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("type")).toBe("button");
    expect(button.getAttribute("title")).toBe("Copy error");
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(screen.getByRole("alert").getAttribute("aria-live")).toBe("assertive");

    await copyError();

    expect(writeText).toHaveBeenCalledExactlyOnceWith(`${props.title}\n\n${props.description}`);
    expect(readText).not.toHaveBeenCalled();
    expect(props.onDismiss).not.toHaveBeenCalled();
  });

  it.each(["success", "warning"] as const)("keeps %s notifications free of the copy control", (variant) => {
    render(<Toast {...toastProps({ variant })} />);
    expect(screen.queryByRole("button", { name: "Copy error" })).toBeNull();
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
    expect(screen.getByRole("button", { name: "Dismiss notification" })).toBeTruthy();
  });

  it("shows copied feedback for two seconds and then allows another copy", async () => {
    const { writeText } = stubClipboard();
    render(<Toast {...toastProps()} />);
    const copyIcon = screen.getByRole("button", { name: "Copy error" }).querySelector("svg")?.outerHTML;

    await copyError();

    const copied = screen.getByRole("button", { name: "Copied" });
    expect(copied.getAttribute("title")).toBe("Copied");
    expect(copied.querySelector("svg")?.outerHTML).not.toBe(copyIcon);
    advanceTime(1_999);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    advanceTime(1);
    expect(screen.getByRole("button", { name: "Copy error" }).getAttribute("title")).toBe("Copy error");

    await copyError();
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it("can copy using the keyboard without dismissing the notification", async () => {
    vi.useRealTimers();
    const user = userEvent.setup();
    const { writeText } = stubClipboard();
    const props = toastProps();
    render(<Toast {...props} />);
    act(() => { screen.getByRole("button", { name: "Copy error" }).focus(); });

    await user.keyboard("{Enter}");

    expect(writeText).toHaveBeenCalledExactlyOnceWith(`${props.title}\n\n${props.description}`);
    expect(props.onDismiss).not.toHaveBeenCalled();
  });

  it("pauses auto-dismiss while hovered and resumes after the pointer leaves", () => {
    const props = toastProps({ durationMs: 8_000 });
    render(<Toast {...props} />);
    advanceTime(7_000);

    fireEvent.mouseEnter(screen.getByRole("alert"));
    advanceTime(24_000);
    expect(props.onDismiss).not.toHaveBeenCalled();

    fireEvent.mouseLeave(screen.getByRole("alert"));
    advanceTime(8_000);
    expect(props.onDismiss).toHaveBeenCalledOnce();
  });

  it("stays visible while focus moves between its controls and resumes when focus leaves", () => {
    const props = toastProps({ durationMs: 8_000 });
    render(<><Toast {...props} /><button type="button">Outside</button></>);
    act(() => { screen.getByRole("button", { name: "Copy error" }).focus(); });
    advanceTime(24_000);
    expect(props.onDismiss).not.toHaveBeenCalled();

    act(() => { screen.getByRole("button", { name: "Dismiss notification" }).focus(); });
    advanceTime(24_000);
    expect(props.onDismiss).not.toHaveBeenCalled();

    act(() => { screen.getByRole("button", { name: "Outside" }).focus(); });
    advanceTime(8_000);
    expect(props.onDismiss).toHaveBeenCalledOnce();
  });

  it("does not resume on pointer leave when a control still has keyboard focus", () => {
    const props = toastProps({ durationMs: 8_000 });
    render(<><Toast {...props} /><button type="button">Outside</button></>);
    fireEvent.mouseEnter(screen.getByRole("alert"));
    act(() => { screen.getByRole("button", { name: "Copy error" }).focus(); });

    fireEvent.mouseLeave(screen.getByRole("alert"));
    advanceTime(24_000);
    expect(props.onDismiss).not.toHaveBeenCalled();

    act(() => { screen.getByRole("button", { name: "Outside" }).focus(); });
    advanceTime(8_000);
    expect(props.onDismiss).toHaveBeenCalledOnce();
  });

  it("keeps a pending clipboard request visible until it finishes", async () => {
    const pending = deferredWrite();
    stubClipboard(vi.fn().mockReturnValue(pending.promise));
    const props = toastProps({ durationMs: 8_000 });
    render(<Toast {...props} />);

    await copyError();
    advanceTime(24_000);
    expect(props.onDismiss).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();

    await act(async () => { pending.resolve(); });
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    advanceTime(2_000);
    expect(props.onDismiss).not.toHaveBeenCalled();
    advanceTime(8_000);
    expect(props.onDismiss).toHaveBeenCalledOnce();
  });

  it("keeps rejected copies visible, hides the raw error, and supports retry", async () => {
    const { writeText } = stubClipboard(vi.fn<(text: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Sensitive browser failure detail"))
      .mockResolvedValue(undefined));
    const props = toastProps({ durationMs: 8_000 });
    render(<Toast {...props} />);

    await copyError();
    expect(screen.getByText(manualCopyMessage)).toBeTruthy();
    expect(screen.getByText(props.title).textContent).toBe(props.title);
    expect(screen.getByText(props.description).textContent).toBe(props.description);
    expect(screen.queryByText("Sensitive browser failure detail")).toBeNull();
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
    advanceTime(24_000);
    expect(props.onDismiss).not.toHaveBeenCalled();

    await copyError();
    expect(writeText).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(screen.queryByText(manualCopyMessage)).toBeNull();
    expect(props.onDismiss).not.toHaveBeenCalled();
  });

  it("offers manual copying when the clipboard is unavailable and retains manual dismissal", async () => {
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: undefined });
    const props = toastProps({ durationMs: 8_000 });
    render(<Toast {...props} />);

    await copyError();
    expect(screen.getByText(manualCopyMessage)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Copy error" }).hasAttribute("disabled")).toBe(false);
    advanceTime(24_000);
    expect(props.onDismiss).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
    expect(props.onDismiss).toHaveBeenCalledOnce();
  });

  it("ignores an old successful clipboard request after the message changes", async () => {
    const oldWrite = deferredWrite();
    const newWrite = deferredWrite();
    const { writeText } = stubClipboard(vi.fn<(text: string) => Promise<void>>()
      .mockReturnValueOnce(oldWrite.promise)
      .mockReturnValueOnce(newWrite.promise));
    const props = toastProps();
    const view = render(<Toast {...props} />);
    await copyError();

    const next = { ...props, title: "Another error", description: "Another error description" };
    view.rerender(<Toast {...next} />);
    await copyError();
    await act(async () => { oldWrite.resolve(); });
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();

    await act(async () => { newWrite.resolve(); });
    expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy();
    expect(writeText.mock.calls).toEqual([[`${props.title}\n\n${props.description}`], [`${next.title}\n\n${next.description}`]]);
  });

  it("ignores an old clipboard rejection without pinning the next notification", async () => {
    const pending = deferredWrite();
    stubClipboard(vi.fn().mockReturnValue(pending.promise));
    const props = toastProps({ durationMs: 8_000 });
    const view = render(<Toast {...props} />);
    await copyError();

    view.rerender(<Toast {...props} description="A new error" />);
    await act(async () => { pending.reject(new Error("Old clipboard request failed")); });

    expect(screen.queryByText(manualCopyMessage)).toBeNull();
    advanceTime(8_000);
    expect(props.onDismiss).toHaveBeenCalledOnce();
  });

  it("cleans up timers and ignores clipboard completion after unmount", async () => {
    const pending = deferredWrite();
    stubClipboard(vi.fn().mockReturnValue(pending.promise));
    const props = toastProps({ durationMs: 8_000 });
    const view = render(<Toast {...props} />);
    await copyError();
    view.unmount();
    expect(vi.getTimerCount()).toBe(0);

    render(<Toast {...toastProps({ title: "New notification" })} />);
    await act(async () => { pending.resolve(); });
    expect(screen.queryByRole("button", { name: "Copied" })).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    advanceTime(24_000);
    expect(props.onDismiss).not.toHaveBeenCalled();
  });

  it("cleans up the copied feedback timer when unmounted", async () => {
    stubClipboard();
    const view = render(<Toast {...toastProps()} />);
    await copyError();
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    view.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
