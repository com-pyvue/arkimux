import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../../", import.meta.url);
const docs = ["README.md", "GENERATED_PROJECTS.md", "THIRD_PARTY_NOTICES.md",
  "bootstrap/README.md", "cli/README.md", "cli/scaffold/README.md", "local/README.md",
  "docs/agent-provider-compatibility.md", "docs/durable-workflow-engine.md", "docs/error-diagnostics.md",
  "test/provider-conformance/README.md", "docs/legal/README.md", "docs/legal/LICENSE-AND-NOTICES.md",
  "docs/legal/RESPONSIBILITY-MATRIX.md", "docs/legal/PRIVACY-NOTICE.md",
  "docs/legal/SUPPORT-AND-LIFECYCLE.md", "SECURITY.md", "CONTRIBUTING.md", "TRADEMARKS.md"];
const read = file => readFile(new URL(file, root), "utf8");

test("public guidance has working local links and no internal review notes", async () => {
  for (const file of docs) {
    const text = await read(file);
    assert.doesNotMatch(text, /draft (?:proposal )?for owner review|decisions still needed|dev-3 walkthrough|per-artifact legal approval|journey:local-v2:|this is a private candidate|dirty-worktree inventory|in this review branch/i, file);
    assert.doesNotMatch(text, /\/Users\/|arkimux-platform|roadmap\/|ACCEPT-\d/, file);
    for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(?:https?:\/\/|mailto:|#)/.test(target)) continue;
      await readFile(new URL(target.split("#")[0], new URL(file, root)));
    }
  }
});

test("third-party notices point to the archive recorded in the lockfile", async () => {
  const { packages: records } = JSON.parse(await read("licenses/dependency-inventory.json"));
  const { packages: lock } = JSON.parse(await read("package-lock.json"));
  const rows = (await read("THIRD_PARTY_NOTICES.md")).split("\n").filter(line => line.startsWith("| ")).slice(2);
  assert.equal(rows.length, records.length);
  for (const [i, pkg] of records.entries()) {
    assert.ok(rows[i].startsWith(`| ${pkg.name} | ${pkg.version} |`));
    if (rows[i].includes("Exact package URL in inventory")) assert.ok(pkg.packageUrl, pkg.name);
  }
  for (const [location, child] of Object.entries(lock).filter(([, entry]) => entry.inBundle)) {
    const parent = location.split("/node_modules/").slice(0, -1);
    while (parent.length && lock[parent.join("/node_modules/")]?.inBundle) parent.pop();
    const archive = lock[parent.join("/node_modules/")];
    assert.ok(archive?.resolved, location);
    const name = archive.name ?? parent.at(-1).split("node_modules/").at(-1);
    const expected = { name, version: archive.version, packageUrl: archive.resolved };
    const childName = child.name ?? location.split("node_modules/").at(-1);
    const index = records.findIndex(pkg => pkg.name === childName && pkg.version === child.version && pkg.bundledIn?.packageUrl === archive.resolved);
    assert.notEqual(index, -1, location);
    assert.deepEqual(records[index].bundledIn, expected);
    assert.ok(rows[index].includes(`[${name}@${archive.version}](${archive.resolved})`), location);
  }
});

test("package README links stay inside the package or point to public repository files", async () => {
  const githubMain = "https://github.com/com-pyvue/arkimux/blob/main/";
  for (const pkg of ["cli", "local"]) {
    const packageUrl = new URL(pkg + "/", root);
    for (const [, target] of (await read(pkg + "/README.md")).matchAll(/\]\(([^)]+)\)/g)) {
      if (target.startsWith(githubMain)) {
        await read(target.slice(githubMain.length).split("#")[0]);
      } else if (!/^(?:https?:\/\/|mailto:|#)/.test(target)) {
        const file = new URL(target.split("#")[0], packageUrl);
        assert.ok(file.href.startsWith(packageUrl.href), `${pkg}/README.md: link leaves the installed package: ${target}`);
      }
    }
  }
});

test("documented npm scripts exist in the project where the reader runs them", async () => {
  for (const [manifest, files] of [
    ["cli/scaffold/package.json", ["cli/scaffold/README.md", "cli/README.md", "local/README.md"]],
    ["package.json", ["README.md", "docs/agent-provider-compatibility.md", "test/provider-conformance/README.md"]],
  ]) {
    const { scripts } = JSON.parse(await read(manifest));
    for (const file of files) {
      for (const [, name] of (await read(file)).matchAll(/\bnpm run\s+([\w:-]+)/g)) {
        assert.ok(Object.hasOwn(scripts, name), `${file}: npm run ${name} is missing from ${manifest}`);
      }
    }
  }
});

test("security and contributor instructions link directly to private vulnerability reporting", async () => {
  const form = "https://github.com/com-pyvue/arkimux/security/advisories/new";
  for (const file of ["SECURITY.md", "CONTRIBUTING.md"]) {
    assert.ok((await read(file)).includes(`](${form})`), file);
  }
});

test("privacy and contributor docs disclose Local limits and contribution terms", async () => {
  const privacy = await read("docs/legal/PRIVACY-NOTICE.md");
  for (const token of ["Pyvue LLC", "privacy@arkimux.ai", "No error report", "100 events", "256 KiB", "20 records",
    "Do not share", "Delete shared data", "OS credential store", "0600", "pseudonymous",
    "not evidence that a person viewed", "GitHub issues are public", "recipient", "CI"]) {
    assert.ok(privacy.includes(token), `Missing disclosure: ${token}`);
  }
  for (const [version, rule] of [
    ["installation-retention-180d-v1", /180 consecutive days.*No archive/],
    ["dev-sandbox-archive-v1", /five inactive minutes.*fresh Yes.*random ID groups the steps from that installation/],
    ["usage-with-withdrawal-archive-v1-disclosed", /no inactivity cutoff.*fresh Yes.*random ID groups the steps in each sequence/],
    ["usage-only-withdrawal-v1", /no inactivity cutoff.*No archive/],
  ]) {
    const row = privacy.split("\n").find(line => line.startsWith("| `" + version + "`"));
    assert.match(row ?? "", rule, version);
  }
  assert.match(await read("TRADEMARKS.md"), /use the ArkiMux name and logo without asking permission/);
  assert.match(await read("docs/legal/SUPPORT-AND-LIFECYCLE.md"), /Support is best-effort/i);
  const diagnostics = await read("local/src/localFrameworkDiagnostics.ts");
  assert.match(diagnostics, /MAX_RECORDS = 20/);
  assert.match(diagnostics, /MAX_BYTES = 256 \* 1_024/);
  const contributor = await read("CONTRIBUTING.md");
  assert.match(contributor, /DCO 1\.1/);
  assert.match(contributor, /No additional CLA is required/);
});
