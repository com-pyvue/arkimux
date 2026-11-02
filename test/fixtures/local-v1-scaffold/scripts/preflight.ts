import { readFile } from "node:fs/promises";
import path from "node:path";
import { preflightDecisionBrief } from "../workflows/decision-brief/src/local-registration.js";

const repositoryRoot = process.cwd();
const configuration = JSON.parse(await readFile(
  path.join(repositoryRoot, "workflows/decision-brief/run-configurations/codex-native-v1.json"),
  "utf8",
)) as unknown;
const readiness = await preflightDecisionBrief(repositoryRoot, configuration);
console.log(JSON.stringify(readiness, null, 2));
if (!readiness.available) process.exitCode = 2;
