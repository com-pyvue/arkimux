/** Private Local debugger plumbing. Never read debugger settings from workflow configuration. */
import { isAbsolute } from "node:path";
import { statSync } from "node:fs";

export const debuggerEnvironmentNames = ["NODE_OPTIONS", "VSCODE_INSPECTOR_OPTIONS", "JB_IDE_PORT", "JB_IDE_HOST", "JETBRAINS_NODE_BIND_HOST"] as const;
export type LocalDebugger = { readonly environment: Readonly<Record<string, string>> };

export function withoutDebuggerEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean = { ...environment };
  for (const name of debuggerEnvironmentNames) delete clean[name];
  return clean;
}

/** Explicit IDE debug mode only. Accept the two tested IDE preload mechanisms,
 * not arbitrary NODE_OPTIONS, inspector addresses or user code preloads. */
export function captureLocalDebugger(environment: NodeJS.ProcessEnv): LocalDebugger {
  // js-debug also suppresses stderr inspector URLs with this non-listening flag.
  const rawOptions = environment.NODE_OPTIONS?.trim() ?? "";
  const publishHttp = /\s+--inspect-publish-uid=http$/.test(rawOptions);
  const options = rawOptions.replace(/\s+--inspect-publish-uid=http$/, "");
  const match = /^(?:--require(?:=|\s+)|-r\s+)(?:"([^"]+)"|'([^']+)'|(\S+))$/.exec(options);
  const helper = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!helper || !isAbsolute(helper) || !statSync(helper, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("Start ArkiMux Local Debug from your IDE with child-process debugging enabled. No supported IDE debugger preload was found.");
  }
  const normalized = helper.replaceAll("\\", "/");
  const result: Record<string, string> = { NODE_OPTIONS: `--require ${JSON.stringify(helper)}${publishHttp ? " --inspect-publish-uid=http" : ""}` };
  if (normalized.endsWith("/ms-vscode.js-debug/src/bootloader.js") || normalized.endsWith("/js-debug/src/bootloader.js")) {
    if (!environment.VSCODE_INSPECTOR_OPTIONS) throw new Error("The IDE debugger session settings are missing.");
    result.VSCODE_INSPECTOR_OPTIONS = environment.VSCODE_INSPECTOR_OPTIONS;
  } else if (normalized.endsWith("/nodeDebugInitializer/debugConnector.js")) {
    if (!/^\d+$/.test(environment.JB_IDE_PORT ?? "") || Number(environment.JB_IDE_PORT) < 1 || Number(environment.JB_IDE_PORT) > 65535) {
      throw new Error("The JetBrains debugger session port is missing or invalid.");
    }
    for (const name of ["JB_IDE_HOST", "JETBRAINS_NODE_BIND_HOST"] as const) {
      if (environment[name] && !["127.0.0.1", "localhost", "::1"].includes(environment[name]!)) throw new Error("Local debugging requires a loopback debugger address.");
    }
    result.JB_IDE_PORT = environment.JB_IDE_PORT!;
    result.JB_IDE_HOST = "127.0.0.1";
    result.JETBRAINS_NODE_BIND_HOST = "127.0.0.1";
  } else throw new Error("This IDE debugger preload is not supported by ArkiMux Local Debug.");
  return Object.freeze({ environment: Object.freeze(result) });
}
