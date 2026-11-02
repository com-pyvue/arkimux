import { validateProjectSource } from "./projectSourceGuard.ts";

/** Same offline source checks used by project validate, before loading trusted runtime code. */
export async function validateArkiMuxProjectSource(projectRoot: string, options: { includeRenderers?: boolean } = {}): Promise<void> {
  await validateProjectSource(projectRoot, options);
}
