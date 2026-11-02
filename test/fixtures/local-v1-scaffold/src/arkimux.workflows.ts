import path from "node:path";
import { createDecisionBriefLocalRegistration } from "../workflows/decision-brief/src/local-registration.js";

/** Preserved Local V1 regression fixture; not shipped in newly generated projects. */
export async function loadProjectWorkflows(repositoryRoot: string = process.cwd()) {
  return [await createDecisionBriefLocalRegistration(path.resolve(repositoryRoot))];
}
