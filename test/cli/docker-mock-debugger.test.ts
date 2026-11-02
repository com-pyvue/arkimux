import { describe, expect, it } from "vitest";
import {
  dockerMockDebuggerRunSecurityArgs,
  ensureDebugImage,
  preflightDockerMockDebugger,
  type DebugImageDependencies,
  type DockerCommandRunner,
} from "../../cli/src/dockerMockDebugger.ts";

const image = "registry.example/arkimux/mock-debug@sha256:" + "a".repeat(64);
const candidate = {
  kind: "candidate-archive" as const,
  archiveUrl: "https://candidate.example/arkimux/mock-debug.tar",
  archiveSha256: "b".repeat(64),
  imageReference: "arkimux/mock-debug:candidate-1",
  imageId: "sha256:" + "c".repeat(64),
};
const runner = (responses: readonly { code: number | null; stdout?: string; stderr?: string }[]): DockerCommandRunner => {
  let index = 0;
  return async () => {
    const response = responses[index++] ?? { code: null };
    return { code: response.code, stdout: response.stdout ?? "", stderr: response.stderr ?? "" };
  };
};

describe("Docker mock-debugger preflight", () => {
  it("accepts only an installed image at the exact immutable digest", async () => {
    const calls: string[][] = [];
    const run: DockerCommandRunner = async args => {
      calls.push([...args]);
      return calls.length === 1
        ? { code: 0, stdout: "29.3.1\n", stderr: "" }
        : { code: 0, stdout: JSON.stringify([image]) + "\n", stderr: "" };
    };

    await expect(preflightDockerMockDebugger(image, run)).resolves.toEqual({
      imageReference: image, imageDigest: "a".repeat(64), dockerServerVersion: "29.3.1",
    });
    expect(calls).toEqual([
      ["version", "--format", "{{.Server.Version}}"],
      ["image", "inspect", image, "--format", "{{json .RepoDigests}}"],
    ]);
  });

  it.each([
    ["tag", "registry.example/arkimux/mock-debug:latest", [], /valid pinned Docker mock-debug image/],
    ["Docker unavailable", image, [{ code: null, stdout: "" }], /Docker is not available/],
    ["image missing", image, [{ code: 0, stdout: "29.3.1" }, { code: 1, stdout: "" }], /image is not installed/],
    ["invalid digest response", image, [{ code: 0, stdout: "29.3.1" }, { code: 0, stdout: "not-json" }], /could not verify/],
    ["different digest", image, [{ code: 0, stdout: "29.3.1" }, { code: 0, stdout: JSON.stringify([image.replace(/a$/, "b")]) }], /does not match/],
  ] as const)("fails closed when %s", async (_name, reference, responses, message) => {
    await expect(preflightDockerMockDebugger(reference, runner(responses))).rejects.toMatchObject({
      code: "debugger_unavailable", message: expect.stringMatching(message), retry: "after_action",
    });
  });

  it("defines no-network, non-root, read-only launch controls before any image or code argument", () => {
    expect(dockerMockDebuggerRunSecurityArgs).toEqual([
      "run", "--rm", "--interactive", "--network", "none", "--read-only", "--user", "65532:65532",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges=true", "--pids-limit", "64",
      "--memory", "256m", "--cpus", "1", "--tmpfs", "/tmp:rw,noexec,nosuid,size=16m",
      "--tmpfs", "/work/scratch:rw,noexec,nosuid,size=64m",
    ]);
  });
});

describe("Docker mock-debugger image acquisition", () => {
  const candidateDependencies = (
    run: DockerCommandRunner,
    overrides: Partial<DebugImageDependencies> = {},
  ): Partial<DebugImageDependencies> => ({
    run,
    downloadCandidateArchive: async () => candidate.archiveSha256,
    makeTemporaryDirectory: async () => "/tmp/arkimux-debug-image-test",
    removeTemporaryDirectory: async () => undefined,
    ...overrides,
  });

  it("reuses an exact candidate image without downloading it", async () => {
    let downloads = 0;
    const run = runner([
      { code: 0, stdout: "29.3.1" },
      { code: 0, stdout: candidate.imageId },
    ]);
    await expect(ensureDebugImage(candidate, candidateDependencies(run, {
      downloadCandidateArchive: async () => { downloads += 1; return candidate.archiveSha256; },
    }))).resolves.toEqual({
      sourceKind: "candidate-archive", manifestReference: candidate.imageReference, runtimeReference: candidate.imageId,
      imageIdentity: candidate.imageId, dockerServerVersion: "29.3.1", acquired: false,
    });
    expect(downloads).toBe(0);
  });

  it("rejects a non-HTTPS candidate archive before contacting Docker", async () => {
    let dockerCalls = 0;
    const run: DockerCommandRunner = async () => {
      dockerCalls += 1;
      return { code: 0, stdout: "29.3.1", stderr: "" };
    };
    await expect(ensureDebugImage({ ...candidate, archiveUrl: "http://candidate.example/mock-debug.tar" }, { run }))
      .rejects.toMatchObject({ code: "debugger_unavailable", message: expect.stringMatching(/must use HTTPS/) });
    expect(dockerCalls).toBe(0);
  });

  it("downloads, verifies and loads a missing candidate image once", async () => {
    const calls: string[][] = [], removed: string[] = [];
    const responses = [
      { code: 0, stdout: "29.3.1" },
      { code: 1, stdout: "" },
      { code: 0, stdout: "Loaded image" },
      { code: 0, stdout: candidate.imageId },
    ];
    const run: DockerCommandRunner = async args => {
      calls.push([...args]);
      const response = responses.shift()!;
      return { ...response, stderr: "" };
    };
    await expect(ensureDebugImage(candidate, candidateDependencies(run, {
      removeTemporaryDirectory: async directory => { removed.push(directory); },
    }))).resolves.toMatchObject({ acquired: true, imageIdentity: candidate.imageId });
    expect(calls).toEqual([
      ["version", "--format", "{{.Server.Version}}"],
      ["image", "inspect", candidate.imageReference, "--format", "{{.Id}}"],
      ["load", "--input", "/tmp/arkimux-debug-image-test/mock-debug-image.tar"],
      ["image", "inspect", candidate.imageReference, "--format", "{{.Id}}"],
    ]);
    expect(removed).toEqual(["/tmp/arkimux-debug-image-test"]);
  });

  it("rejects a candidate archive before Docker load when its hash differs", async () => {
    const calls: string[][] = [];
    const run: DockerCommandRunner = async args => {
      calls.push([...args]);
      return calls.length === 1
        ? { code: 0, stdout: "29.3.1", stderr: "" }
        : { code: 1, stdout: "", stderr: "missing" };
    };
    await expect(ensureDebugImage(candidate, candidateDependencies(run, {
      downloadCandidateArchive: async () => "d".repeat(64),
    }))).rejects.toMatchObject({ code: "debugger_unavailable", message: expect.stringMatching(/SHA-256/) });
    expect(calls.some(args => args[0] === "load")).toBe(false);
  });

  it("fails closed when the temporary candidate archive cannot be removed", async () => {
    const run = runner([
      { code: 0, stdout: "29.3.1" },
      { code: 1, stdout: "" },
      { code: 0, stdout: "Loaded image" },
      { code: 0, stdout: candidate.imageId },
    ]);
    await expect(ensureDebugImage(candidate, candidateDependencies(run, {
      removeTemporaryDirectory: async () => { throw new Error("fixture cleanup failure"); },
    }))).rejects.toMatchObject({
      code: "debugger_unavailable", message: expect.stringMatching(/could not remove the temporary/),
    });
  });

  it("rejects a conflicting local candidate tag without downloading or overwriting it", async () => {
    let downloads = 0;
    const run = runner([
      { code: 0, stdout: "29.3.1" },
      { code: 0, stdout: "sha256:" + "d".repeat(64) },
    ]);
    await expect(ensureDebugImage(candidate, candidateDependencies(run, {
      downloadCandidateArchive: async () => { downloads += 1; return candidate.archiveSha256; },
    }))).rejects.toMatchObject({ code: "debugger_unavailable", message: expect.stringMatching(/different Docker image/) });
    expect(downloads).toBe(0);
  });

  it("pulls a missing registry digest and verifies it before returning", async () => {
    const calls: string[][] = [];
    const run: DockerCommandRunner = async args => {
      calls.push([...args]);
      if (calls.length === 1) return { code: 0, stdout: "29.3.1", stderr: "" };
      if (calls.length === 2) return { code: 1, stdout: "", stderr: "missing" };
      if (calls.length === 3) return { code: 0, stdout: "pulled", stderr: "" };
      return { code: 0, stdout: JSON.stringify([image]), stderr: "" };
    };
    await expect(ensureDebugImage({ kind: "registry", imageReference: image }, { run })).resolves.toEqual({
      sourceKind: "registry", manifestReference: image, runtimeReference: image, imageIdentity: "sha256:" + "a".repeat(64),
      dockerServerVersion: "29.3.1", acquired: true,
    });
    expect(calls[2]).toEqual(["pull", image]);
  });

  it("fails closed when a pulled registry image still lacks the pinned digest", async () => {
    const run = runner([
      { code: 0, stdout: "29.3.1" },
      { code: 1, stdout: "" },
      { code: 0, stdout: "pulled" },
      { code: 0, stdout: JSON.stringify([image.replace(/a$/, "b")]) },
    ]);
    await expect(ensureDebugImage({ kind: "registry", imageReference: image }, { run })).rejects.toMatchObject({
      code: "debugger_unavailable", message: expect.stringMatching(/could not be acquired or verified/),
    });
  });
});
