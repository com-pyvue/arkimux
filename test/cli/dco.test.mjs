import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { checkCommitCertification, checkDcoRange } from "../../scripts/lib/dco.mjs";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const cli = path.join(repositoryRoot, "scripts/check-dco.mjs");
const authorName = "Synthetic Author", authorEmail = "author@example.invalid";
const signoff = `Signed-off-by: ${authorName} <${authorEmail}>`;
const certify = message => checkCommitCertification({ authorName, authorEmail, message }, { repositoryRoot });

test("DCO accepts a real matching trailer and rejects missing, mismatched and body-only text", () => {
  assert.equal(certify(`Synthetic change\n\n${signoff}\n`).passed, true);
  assert.deepEqual(certify("Synthetic unsigned change\n").reasons, ["author-sign-off-missing"]);
  assert.equal(certify("Synthetic change\n\nSigned-off-by: Someone Else <other@example.invalid>\n").passed, false);
  assert.equal(certify(`Synthetic change\n\nExample: ${signoff}\n\nThis is a body paragraph, not a trailer.\n`).passed, false);
  assert.equal(certify(`Synthetic change\n\n${signoff}\n---\nNot a trailer paragraph.\n`).passed, false);
  assert.equal(certify(`Synthetic change\n\n${signoff}\nNot a trailer paragraph.\n`).passed, false);
});

test("DCO checks co-authors, malformed identities, duplicates and conventional case/spacing", () => {
  const coauthor = "Synthetic Coauthor <coauthor@example.invalid>";
  assert.equal(certify(`Synthetic change\n\nCo-authored-by: ${coauthor}\n${signoff}\n`).passed, false);
  assert.equal(certify(`Synthetic change\n\nCo-authored-by: ${coauthor}\n${signoff}\nSigned-off-by: ${coauthor}\n`).passed, true);
  assert.ok(certify(`Synthetic change\n\nCo-authored-by: not-an-identity\n${signoff}\n`).reasons.includes("malformed-co-author"));
  assert.ok(certify(`Synthetic change\n\nSigned-off-by: author@example.invalid\n`).reasons.includes("malformed-sign-off"));
  assert.equal(certify(`Synthetic change\n\nsigned-off-by: synthetic   author <AUTHOR@example.invalid>\n`).passed, true);
  assert.equal(certify(`Synthetic change\n\n${signoff}\n${signoff}\n`).passed, true);
  assert.equal(certify("Synthetic change\0hidden").passed, false);
});

async function fixture(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "arkimux-dco-test-"));
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_AUTHOR_NAME: authorName, GIT_AUTHOR_EMAIL: authorEmail,
    GIT_COMMITTER_NAME: authorName, GIT_COMMITTER_EMAIL: authorEmail };
  const git = (args, input) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
    cwd: directory, input, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  try {
    git(["init", "--quiet"]);
    const tree = git(["mktree"], "");
    const commit = (message, parents = [], commitEnv = {}) => execFileSync("git",
      ["-c", "commit.gpgsign=false", "commit-tree", tree, ...parents.flatMap(parent => ["-p", parent])], {
        cwd: directory, env: { ...env, ...commitEnv }, input: message, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"],
      }).trim();
    await run({ directory, git, commit, env });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test("range checks only new commits, keeps every unsigned failure, and does not exempt merges", async () => {
  await fixture(async ({ directory, commit }) => {
    const base = commit("Historical unsigned baseline\n");
    const first = commit(`Signed change\n\n${signoff}\n`, [base]);
    assert.equal(checkDcoRange({ repositoryRoot: directory, base, head: first }).passed, true);
    const unsigned = commit("Unsigned contributed change\n", [first]);
    const last = commit(`Another signed change\n\n${signoff}\n`, [unsigned]);
    const result = checkDcoRange({ repositoryRoot: directory, base, head: last });
    assert.equal(result.commitCount, 3);
    assert.deepEqual(result.failures.map(row => row.commit), [unsigned]);
    const branch = commit(`Signed side branch\n\n${signoff}\n`, [base]);
    const merge = commit("Unsigned merge contribution\n", [last, branch]);
    const merged = checkDcoRange({ repositoryRoot: directory, base, head: merge });
    assert.ok(merged.failures.some(row => row.commit === merge));
    assert.ok(merged.failures.some(row => row.commit === unsigned));
    assert.equal(checkDcoRange({ repositoryRoot: directory, base, head: base }).commitCount, 0);
  });
});

test("bot identities have no exemption and unrelated or invalid history fails closed", async () => {
  await fixture(async ({ directory, commit }) => {
    const base = commit("Historical baseline\n");
    const bot = commit("Unsigned bot contribution\n", [base], { GIT_AUTHOR_NAME: "synthetic[bot]", GIT_AUTHOR_EMAIL: "bot@example.invalid" });
    assert.equal(checkDcoRange({ repositoryRoot: directory, base, head: bot }).passed, false);
    const otherRoot = commit("Unrelated root\n");
    assert.throws(() => checkDcoRange({ repositoryRoot: directory, base, head: otherRoot }));
    assert.throws(() => checkDcoRange({ repositoryRoot: directory, base: "--all", head: bot }));
    assert.throws(() => checkDcoRange({ repositoryRoot: directory, base, head: "f".repeat(40) }));
  });
});

test("CLI uses exit status, does not echo malicious messages, and fetches metadata without checkout", async () => {
  await fixture(async ({ directory, git, commit, env }) => {
    const base = commit("Historical baseline\n");
    const head = commit("::error::UNTRUSTED-CANARY $(touch should-not-exist)\n", [base]);
    const failure = spawnSync(process.execPath, [cli, "--base", base, "--head", head], { cwd: directory, env, encoding: "utf8" });
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /missing sign-off matching the commit author/);
    assert.doesNotMatch(failure.stderr + failure.stdout, /UNTRUSTED-CANARY|author@example/);
    const invalid = spawnSync(process.execPath, [cli, "--fetch-head", "--base", "--all", "--head", head], { cwd: directory, env, encoding: "utf8" });
    assert.equal(invalid.status, 2);
    git(["update-ref", "refs/heads/base", base]);
    git(["checkout", "--quiet", "base"]);
    git(["remote", "add", "origin", directory]);
    const signed = commit(`Signed contribution\n\n${signoff}\n`, [head]);
    git(["update-ref", "refs/heads/contributor", signed]);
    const fetched = spawnSync(process.execPath, [cli, "--fetch-head", "--base", base, "--head", signed], { cwd: directory, env, encoding: "utf8" });
    assert.equal(fetched.status, 1); // The earlier unsigned commit cannot hide behind a later sign-off.
    assert.equal(git(["rev-parse", "HEAD"]), base);
    await assert.rejects(access(path.join(directory, "should-not-exist")));
    assert.equal(spawnSync(process.execPath, [cli, "--help"], { cwd: directory, env }).status, 0);
    const validHead = commit(`Valid signed branch\n\n${signoff}\n`, [base]);
    const success = spawnSync(process.execPath, [cli, "--base", base, "--head", validHead], { cwd: directory, env, encoding: "utf8" });
    assert.equal(success.status, 0);
    assert.match(success.stdout, /DCO passed: 1 new/);
  });
});

test("workflow executes trusted base scripts with read-only permissions and no install step", async () => {
  const workflow = await readFile(path.join(repositoryRoot, ".github/workflows/dco.yml"), "utf8");
  assert.match(workflow, /\n  pull_request:/);
  assert.doesNotMatch(workflow, /pull_request_target:/);
  assert.match(workflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /name: DCO/);
  assert.doesNotMatch(workflow, /pull_request\.head\.ref|npm ci|npm install|secrets\.|write-all|contents: write/);
  assert.match(workflow, /--fetch-head --base "\$DCO_BASE_SHA" --head "\$DCO_HEAD_SHA"/);
});

test("contributor replacement of the checker is inspected as data, never executed", async () => {
  await fixture(async ({ directory, git, env }) => {
    await mkdir(path.join(directory, "scripts/lib"), { recursive: true });
    for (const file of ["scripts/check-dco.mjs", "scripts/lib/dco.mjs"]) {
      await writeFile(path.join(directory, file), await readFile(path.join(repositoryRoot, file)));
    }
    git(["add", "scripts"]);
    git(["commit", "--quiet", "-m", "Historical trusted checker"]);
    const base = git(["rev-parse", "HEAD"]);
    await writeFile(path.join(directory, "scripts/check-dco.mjs"),
      'import {writeFileSync} from "node:fs"; writeFileSync("untrusted-code-ran", "bad");\n');
    git(["add", "scripts/check-dco.mjs"]);
    git(["commit", "--quiet", "-m", "Unsigned contributor replacement"]);
    const head = git(["rev-parse", "HEAD"]);
    git(["checkout", "--quiet", "--detach", base]);
    const checked = spawnSync(process.execPath, ["scripts/check-dco.mjs", "--base", base, "--head", head], {
      cwd: directory, env, encoding: "utf8",
    });
    assert.equal(checked.status, 1);
    assert.match(checked.stderr, /missing sign-off/);
    await assert.rejects(access(path.join(directory, "untrusted-code-ran")));
    assert.equal(git(["rev-parse", "HEAD"]), base);
  });
});
