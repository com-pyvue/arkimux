import {
  validateExternalIdentity,
  type RunDispatcher,
  type TrustedRunCommand,
} from "@com-pyvue/agent-execution-core";
import type {
  ApplicationAuthenticationAdapterFactory,
  ApplicationAuthenticationProvider,
  RunDispatchAdapterFactory,
} from "./adapters.ts";

interface LocalFixedIdentityOptions {
  providerId: string;
  subjectIdEnvironmentVariable: string;
}

function fixedIdentityOptions(value: unknown): Record<string, unknown> & LocalFixedIdentityOptions {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("local-fixed-identity@1 options must be an object.");
  }
  const options = value as Record<string, unknown>;
  const unknown = Object.keys(options).filter((key) => (
    key !== "providerId" && key !== "subjectIdEnvironmentVariable"
  ));
  if (unknown.length > 0) throw new Error(`local-fixed-identity@1 has unknown options [${unknown.join(", ")}].`);
  if (typeof options.providerId !== "string" || options.providerId.length === 0) {
    throw new Error("local-fixed-identity@1 providerId must be a non-empty string.");
  }
  if (
    typeof options.subjectIdEnvironmentVariable !== "string"
    || !/^[A-Z_][A-Z0-9_]*$/.test(options.subjectIdEnvironmentVariable)
  ) {
    throw new Error("local-fixed-identity@1 subjectIdEnvironmentVariable must be an environment variable name.");
  }
  return options as Record<string, unknown> & LocalFixedIdentityOptions;
}

class LocalFixedIdentityProvider implements ApplicationAuthenticationProvider {
  constructor(
    private readonly options: LocalFixedIdentityOptions,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  async authenticate(_request: unknown) {
    const subjectId = this.environment[this.options.subjectIdEnvironmentVariable];
    if (!subjectId) {
      throw new Error(`Local identity environment variable ${this.options.subjectIdEnvironmentVariable} is not set.`);
    }
    return validateExternalIdentity({ providerId: this.options.providerId, subjectId });
  }
}

class LocalWorkflowDispatcher implements RunDispatcher<unknown> {
  constructor(
    private readonly execute: (command: TrustedRunCommand<unknown>) => Promise<void>,
    private readonly onError: (error: Error) => void,
  ) {}

  async dispatch(command: TrustedRunCommand<unknown>): Promise<void> {
    queueMicrotask(() => {
      void this.execute(command).catch((error: unknown) => {
        this.onError(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }
}

function emptyOptions(value: unknown, adapterId: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${adapterId} options must be an object.`);
  }
  const keys = Object.keys(value);
  if (keys.length > 0) throw new Error(`${adapterId} does not support options [${keys.join(", ")}].`);
  return {};
}

export function createLocalAuthenticationAdapterFactory(): ApplicationAuthenticationAdapterFactory {
  return {
    adapterId: "local-fixed-identity@1",
    role: "request-authentication",
    validateConfig: fixedIdentityOptions,
    async create(context) {
      return new LocalFixedIdentityProvider(fixedIdentityOptions(context.options), context.environment);
    },
    async preflight(provider) {
      try {
        await provider.authenticate(undefined);
        return { adapterId: "local-fixed-identity@1", role: "request-authentication", available: true };
      } catch (error) {
        return {
          adapterId: "local-fixed-identity@1",
          role: "request-authentication",
          available: false,
          message: (error as Error).message,
        };
      }
    },
  };
}

export function createLocalRunDispatchAdapterFactory(): RunDispatchAdapterFactory {
  return {
    adapterId: "local-workflow-dispatch@1",
    role: "run-dispatch",
    validateConfig: (options) => emptyOptions(options, "local-workflow-dispatch@1"),
    async create(context) {
      emptyOptions(context.options, "local-workflow-dispatch@1");
      return new LocalWorkflowDispatcher(
        (command) => context.workflows.execute(command),
        context.onBackgroundError,
      );
    },
    async preflight() {
      return { adapterId: "local-workflow-dispatch@1", role: "run-dispatch", available: true };
    },
  };
}
