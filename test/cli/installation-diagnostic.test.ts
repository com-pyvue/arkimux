import { describe, expect, it } from "vitest";
import { installationDiagnostic } from "../../cli/src/installationDiagnostic.ts";

describe("npm failure records", () => {
  it("keeps complete stdout/stderr and line breaks while scrubbing credentials", () => {
    const stderr = 'npm error E401\nSee https://registry.example/help\n' + 'detail\n'.repeat(1000) + 'opaque-fixture-key';
    const record = installationDiagnostic({ stdout: "install script diagnostic\n", stderr }, { NPM_TOKEN: "opaque-fixture-key" });
    expect(record.stderr).toBe(stderr.replace("opaque-fixture-key", "[redacted]"));
    expect(record.stdout).toBe("install script diagnostic\n");
  });
  it("does not publish internal spawn stacks or paths", () => {
    expect(installationDiagnostic({ error: new Error("private /host/path") }, {})).toEqual({ stdout: "", stderr: "", startupError: "npm could not start. Check that Node.js and npm are installed." });
  });
});
