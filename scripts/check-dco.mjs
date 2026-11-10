import { checkDcoRange, fetchDcoHead } from "./lib/dco.mjs";

const reasonLabels = {
  "invalid-commit-metadata": "invalid author or commit metadata",
  "malformed-sign-off": "malformed Signed-off-by trailer",
  "malformed-co-author": "malformed Co-authored-by trailer",
  "author-sign-off-missing": "missing sign-off matching the commit author",
  "co-author-sign-off-missing": "missing sign-off for a named co-author",
};
const usage = "Usage: node scripts/check-dco.mjs --base <full-commit-id> --head <full-commit-id> [--fetch-head]";
try {
  const flags = new Map();
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { console.log(usage); }
  else {
    for (let index = 0; index < args.length; index++) {
      const key = args[index];
      if (!["--base", "--head", "--fetch-head"].includes(key) || flags.has(key)) throw new Error("Invalid arguments.");
      if (key === "--fetch-head") flags.set(key, true);
      else {
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new Error("Missing commit ID.");
        flags.set(key, value);
      }
    }
    if (!flags.has("--base") || !flags.has("--head")) throw new Error("Missing commit IDs.");
    const range = { base: flags.get("--base"), head: flags.get("--head") };
    // Validate both IDs before any optional network operation.
    if (![range.base, range.head].every(value => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))) throw new Error("Invalid commit IDs.");
    if (flags.has("--fetch-head")) fetchDcoHead(range);
    const result = checkDcoRange(range);
    if (result.passed) console.log(`DCO passed: ${result.commitCount} new contributed commit(s).`);
    else {
      console.error(`DCO failed: ${result.failures.length} of ${result.commitCount} new commit(s) need attention.`);
      for (const failure of result.failures.slice(0, 20)) {
        console.error(`- ${failure.commit.slice(0, 12)}: ${failure.reasons.map(reason => reasonLabels[reason]).join("; ")}.`);
      }
      if (result.failures.length > 20) console.error("Additional failing commits omitted from this log; inspect the full PR commit range.");
      console.error("Read CONTRIBUTING.md. Add a sign-off only if you can truthfully certify the DCO; do not sign for another contributor.");
      process.exitCode = 1;
    }
  }
} catch {
  // Do not echo arbitrary commit messages, identities, remote errors or supplied arguments into workflow logs.
  console.error(`DCO could not validate this range. Check that both complete commit IDs and their history are available.\n${usage}`);
  process.exitCode = 2;
}
