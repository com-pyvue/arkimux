export function runStatusLabel(status: string): string {
  if (status === "waiting_for_input") return "Waiting for input";
  if (status === "resume_queued") return "Resume queued";
  if (status === "cancelled") return "Cancelled";
  return status;
}

export function runStatusVariant(status: string): "primary" | "success" | "error" | "warning" | "secondary" {
  if (status === "running" || status === "resume_queued") return "primary";
  if (status === "waiting_for_input") return "warning";
  if (status === "complete") return "success";
  if (status === "failed") return "error";
  if (status === "cancelled") return "secondary";
  return "secondary";
}
