import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const docs = ["docs/legal/README.md", "docs/legal/LICENSE-AND-NOTICES.md",
  "docs/legal/RESPONSIBILITY-MATRIX.md", "docs/legal/PRIVACY-NOTICE.md",
  "docs/legal/SUPPORT-AND-LIFECYCLE.md", "SECURITY.md", "CONTRIBUTING.md", "TRADEMARKS.md"];
const read = file => readFile(new URL(file, root), "utf8");

test("Local responsibility drafts are clearly marked and their local links resolve", async () => {
  for (const file of docs) {
    const text = await read(file);
    if (file === "CONTRIBUTING.md") assert.match(text, /Contribution policy adopted/, file);
    else if (file !== "SECURITY.md") assert.match(text, /Draft (?:for|proposal for) owner review/, file);
    assert.doesNotMatch(text, /\/Users\/|arkimux-platform|roadmap\/|ACCEPT-\d/, file);
    for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^https?:\/\//.test(target) || target.startsWith("#")) continue;
      await readFile(new URL(target.split("#")[0], new URL(file, root)));
    }
  }
});

test("security and contributor instructions link directly to private vulnerability reporting", async () => {
  const form = "https://github.com/com-pyvue/arkimux/security/advisories/new";
  for (const file of ["SECURITY.md", "CONTRIBUTING.md"]) {
    assert.ok((await read(file)).includes(`](${form})`), file);
  }
});

test("privacy draft matches the current usage-only wire fields and local diagnostic limits", async () => {
  const privacy = await read("docs/legal/PRIVACY-NOTICE.md");
  for (const token of ["No error report", "100 events", "256 KiB", "20 records", "No automatic expiry",
    "Do not share", "Delete shared data", "OS credential store", "0600", "pseudonymous",
    "not evidence that a person viewed", "GitHub issues are public", "recipient", "CI"]) {
    assert.ok(privacy.includes(token), `Missing disclosure: ${token}`);
  }
  const events = await read("contracts/telemetry/events.ts");
  assert.match(events, /z\.strictObject/);
  assert.doesNotMatch(events.split("const base =")[1].split("}).superRefine")[0], /(?:message|stack|prompt|payload|user_id):/);
  const diagnostics = await read("local/src/localFrameworkDiagnostics.ts");
  assert.match(diagnostics, /MAX_RECORDS = 20/);
  assert.match(diagnostics, /MAX_BYTES = 256 \* 1_024/);
  const contributor = await read("CONTRIBUTING.md");
  assert.match(contributor, /Contribution policy adopted 5 November 2026/);
  assert.match(contributor, /No additional CLA is required/);
});
