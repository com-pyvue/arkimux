import { credentialSecretValues, redactExternalSecrets } from "../../core/src/application/externalError.ts";

export function installationDiagnostic(result: {
  stdout?: string | null; stderr?: string | null; error?: Error;
}, environment: NodeJS.ProcessEnv) {
  const secrets = credentialSecretValues(environment);
  return {
    stdout: redactExternalSecrets(result.stdout ?? "", secrets),
    stderr: redactExternalSecrets(result.stderr ?? "", secrets),
    ...(result.error ? { startupError: "npm could not start. Check that Node.js and npm are installed." } : {}),
  };
}
