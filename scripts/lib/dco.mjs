import { execFileSync } from "node:child_process";

const objectId = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const maximumCommits = 10_000;

function git(repositoryRoot, args, input) {
  return execFileSync("git", ["--no-pager", "--no-replace-objects", "-c", "color.ui=false", ...args], {
    cwd: repositoryRoot, input, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1" },
  });
}

function requireObjectId(value) {
  if (typeof value !== "string" || !objectId.test(value)) throw new Error("Use full hexadecimal base and head commit IDs.");
}

function identity(value) {
  if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value)) return null;
  const parsed = /^([^<>]+?)\s+<([^<>\s@]+@[^<>\s@]+)>$/.exec(value.trim());
  if (!parsed || !parsed[1].trim()) return null;
  return `${parsed[1].trim().replace(/\s+/g, " ").toLowerCase()}\0${parsed[2].toLowerCase()}`;
}

/** Uses Git's trailer parser, not a substring search through arbitrary message text. */
export function checkCommitCertification({ authorName, authorEmail, message }, { repositoryRoot = process.cwd() } = {}) {
  const author = identity(`${authorName} <${authorEmail}>`);
  if (!author || typeof message !== "string" || message.includes("\0") || Buffer.byteLength(message) > 128 * 1024) {
    return { passed: false, reasons: ["invalid-commit-metadata"] };
  }
  // Git also accepts format-patch sign-offs before a --- divider. Our policy
  // requires an actual final trailer block in the commit, not an embedded patch.
  const footer = message.trimEnd().split(/\r?\n[ \t]*\r?\n/).at(-1);
  if (!footer.split(/\r?\n/).every(line => /^[A-Za-z0-9-]+[ \t]*:/.test(line) || /^[ \t]+\S/.test(line))) {
    return { passed: false, reasons: ["author-sign-off-missing"] };
  }
  const trailers = git(repositoryRoot, ["interpret-trailers", "--parse", "--no-divider"], message)
    .split("\n").filter(Boolean).map(line => {
      const colon = line.indexOf(":");
      return { key: line.slice(0, colon).trim().toLowerCase(), value: line.slice(colon + 1).trim() };
    });
  const signed = trailers.filter(row => row.key === "signed-off-by").map(row => identity(row.value));
  const coauthors = trailers.filter(row => row.key === "co-authored-by").map(row => identity(row.value));
  const reasons = [];
  if (signed.includes(null)) reasons.push("malformed-sign-off");
  if (coauthors.includes(null)) reasons.push("malformed-co-author");
  if (!signed.includes(author)) reasons.push("author-sign-off-missing");
  if (coauthors.some(person => person && !signed.includes(person))) reasons.push("co-author-sign-off-missing");
  return { passed: reasons.length === 0, reasons };
}

/** Fetches Git objects only. Never checks out or executes the contributor's files. */
export function fetchDcoHead({ repositoryRoot = process.cwd(), head }) {
  requireObjectId(head);
  git(repositoryRoot, ["fetch", "--quiet", "--no-tags", "--no-recurse-submodules", "origin", head]);
}

/** Existing base history is outside the range; merges and bots have no automatic exemption. */
export function checkDcoRange({ repositoryRoot = process.cwd(), base, head }) {
  requireObjectId(base); requireObjectId(head);
  for (const sha of [base, head]) {
    const resolved = git(repositoryRoot, ["rev-parse", "--verify", "--end-of-options", `${sha}^{commit}`]).trim();
    if (resolved !== sha) throw new Error("The range must identify actual commit objects.");
  }
  git(repositoryRoot, ["merge-base", base, head]);
  const commits = git(repositoryRoot, ["rev-list", "--reverse", `${base}..${head}`]).trim().split("\n").filter(Boolean);
  if (commits.length > maximumCommits || commits.some(sha => !objectId.test(sha))) {
    throw new Error("The DCO range exceeds its validation bound.");
  }
  const failures = [];
  for (const commit of commits) {
    const raw = git(repositoryRoot, ["show", "--no-patch", "--no-show-signature", "--no-notes",
      "--format=%an%x00%ae%x00%B", commit, "--"]);
    const [authorName, authorEmail, ...body] = raw.split("\0");
    const result = checkCommitCertification({ authorName, authorEmail, message: body.join("\0") }, { repositoryRoot });
    if (!result.passed) failures.push({ commit, reasons: result.reasons });
  }
  return { passed: failures.length === 0, commitCount: commits.length, failures };
}
