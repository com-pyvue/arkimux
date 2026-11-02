// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, screen, waitFor } from "@testing-library/react";
import { renderWithToaster as render } from "./renderWithToaster.tsx";
import userEvent from "@testing-library/user-event";
import { z } from "zod";
import axe from "axe-core";
import { Field, FormValidation, Input, Select, Textarea, fieldError, validationMessage } from "../../apps/packages/ui/src/index.ts";
import { AgentAuthenticationApiClient } from "../../apps/packages/agent-authentication/contract/src/index.ts";
import { AgentAuthenticationFeature } from "../../apps/packages/agent-authentication/react/src/index.ts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

afterEach(cleanup);

it("top-aligns fields and their label/control tracks regardless of error height", async () => {
  render(<FormValidation error={fieldError("id", "This field is required.")}><div className="grid grid-cols-2">
    <Field name="type">Type<Select><option>API key</option></Select></Field>
    <Field name="id">ID<Input /></Field>
    <Field name="name" className="grid gap-1 text-sm md:col-span-2">Name<Input /></Field>
  </div></FormValidation>);
  await screen.findByText("This field is required.");
  for (const name of ["Type", "ID", "Name"]) {
    const label = screen.getByLabelText(name).closest("label")!;
    expect(label.classList.contains("content-start")).toBe(true);
    expect(label.parentElement?.classList.contains("self-start")).toBe(true);
    expect(label.parentElement?.classList.contains("content-start")).toBe(true);
  }
  expect(screen.getByLabelText("Name").closest("label")?.parentElement?.classList.contains("md:col-span-2")).toBe(true);
});

it("maps nested schema issues below fields, focuses the first error and clears only edited errors", async () => {
  const schema = z.object({ definition: z.object({ credentialId: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/), displayName: z.string().min(1) }) });
  function Form() {
    const [error, setError] = useState<unknown>();
    const [name, setName] = useState("");
    return <FormValidation error={error}><form onSubmit={event => { event.preventDefault(); const result = schema.safeParse({ definition: { credentialId: name, displayName: "" } }); setError(result.error); }}>
      <Field name="definition.credentialId">Credential ID<Input value={name} onChange={event => setName(event.target.value)} /></Field>
      <Field name="definition.displayName">Display name<Input /></Field><button>Save</button>
    </form></FormValidation>;
  }
  render(<Form />);
  await userEvent.click(screen.getByText("Save"));
  const id = screen.getByLabelText("Credential ID"), name = screen.getByLabelText("Display name");
  expect(id.getAttribute("aria-invalid")).toBe("true");
  expect(document.activeElement).toBe(id);
  const message = document.getElementById(id.getAttribute("aria-describedby")!);
  expect(message?.textContent).toContain("This field is required.");
  expect(message?.textContent).toBe("This field is required.");
  expect(id.compareDocumentPosition(message!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await userEvent.type(id, "valid-id");
  expect(id.getAttribute("aria-invalid")).toBeNull();
  expect(name.getAttribute("aria-invalid")).toBe("true");
  await userEvent.clear(id);
  await userEvent.click(screen.getByText("Save"));
  expect(id.getAttribute("aria-invalid")).toBe("true");
  expect(document.body.textContent).not.toContain('"code"');
});

it("maps API issue arrays to the most specific field, and unknown JSON properties to the JSON editor", async () => {
  const error = new Error(JSON.stringify([{ path: ["agents", "writer", "execution", "parameters", "model"], code: "invalid_value", message: "Invalid input" }, { path: ["unknownProperty"], code: "custom", message: "Remove this property." }]));
  const { container } = render(<FormValidation error={error}>
    <Field name="definition.agents.writer.execution.parameters.model">Model<Select><option value="">Choose</option></Select></Field>
    <details><summary>Advanced JSON</summary><Field name="definition">JSON<Textarea /></Field></details>
  </FormValidation>);
  await waitFor(() => expect(screen.getByLabelText("Model").getAttribute("aria-invalid")).toBe("true"));
  expect(screen.getByText("Choose a supported value.").parentElement?.textContent).toContain("Model");
  expect(screen.getByText("Remove this property.").parentElement?.textContent).toContain("JSON");
  expect((await axe.run(container, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
});

it("opens Advanced JSON for syntax failures and keeps non-field service failures separate", async () => {
  const { rerender } = render(<FormValidation error={fieldError("definition", "Enter valid JSON.")}><details><summary>Advanced JSON</summary><Field name="definition">JSON<Textarea /></Field></details></FormValidation>);
  await waitFor(() => expect(screen.getByText("Advanced JSON").parentElement?.hasAttribute("open")).toBe(true));
  expect(document.activeElement).toBe(screen.getByLabelText("JSON"));
  rerender(<FormValidation error={new Error("Service unavailable. Try again.")}><Field name="definition">JSON<Textarea /></Field></FormValidation>);
  expect(screen.getByRole("alert").textContent).toContain("Service unavailable. Try again.");
  expect(screen.getByRole("button", { name: "Copy error" })).toBeTruthy();
  expect(screen.getByLabelText("JSON").getAttribute("aria-invalid")).toBeNull();
});

it("targets Advanced JSON after a raw edit instead of marking stale structured values", async () => {
  render(<FormValidation error={fieldError("definition.title", "Enter a title.")} targetField="definition"><Field name="definition.title">Title<Input value="Previous title" readOnly /></Field><Field name="definition">JSON<Textarea /></Field></FormValidation>);
  await waitFor(() => expect(screen.getByLabelText("JSON").getAttribute("aria-invalid")).toBe("true"));
  expect(screen.getByLabelText("Title").getAttribute("aria-invalid")).toBeNull();
});

it("does not describe arbitrary regexes as ID rules or numeric limits as text length", () => {
  expect(validationMessage({ path: [], message: "Invalid", code: "invalid_format", format: "regex", pattern: "/^secret-.+$/" })).toBe("Use the required format.");
  expect(validationMessage({ path: [], message: "Invalid", code: "too_small", origin: "number", minimum: 1 })).toBe("Enter a number of at least 1.");
  expect(validationMessage({ path: [], message: "Invalid", code: "too_small", origin: "number", minimum: 0, inclusive: false })).toBe("Enter a number greater than 0.");
});

it("reproduces the credential screenshot without a request, raw diagnostic or exposed key", async () => {
  const writes: string[] = [];
  const client = new AgentAuthenticationApiClient({ baseUrl: "http://fixture.test", fetch: async (input, init) => {
    if (init?.method && init.method !== "GET") writes.push(String(input));
    return new Response(JSON.stringify(String(input).endsWith("/metadata") ? { credentialPresets: [{ presetId: "anthropic", label: "Anthropic API key", modelProvider: "anthropic" }], authProviderPresets: [], nativeSessionPresets: [] } : { items: [], pagination: {} }), { headers: { "content-type": "application/json" } });
  } });
  const query = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={query}><AgentAuthenticationFeature client={client} connectionsFirst /></QueryClientProvider>);
  await screen.findByText("No credentials configured.");
  await userEvent.click(screen.getByRole("button", { name: "Add credential" }));
  await userEvent.type(screen.getByLabelText("API key"), "dummy-test-only-not-a-key");
  await userEvent.click(screen.getByRole("button", { name: "Save credential" }));
  await waitFor(() => expect(screen.getByLabelText("Credential ID").getAttribute("aria-invalid")).toBe("true"));
  expect(screen.getByLabelText("Display name").getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByLabelText("API key").getAttribute("type")).toBe("password");
  expect(document.body.textContent).not.toContain("dummy-test-only-not-a-key");
  expect(document.body.textContent).not.toContain('"origin"');
  expect(writes).toEqual([]);
});
