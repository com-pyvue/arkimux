import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactStreamSequenceConflictError,
  ArtifactStreamSequenceGapError,
  FileRunArtifactStore,
  JsonlRunEventSink,
} from "../../core/src/index.ts";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "agent-execution-artifacts-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => (
    fs.rm(directory, { recursive: true, force: true })
  )));
});

describe("file run artifact store", () => {
  it("writes scoped JSON, text, and JSON Lines artifacts", async () => {
    const directory = await temporaryDirectory();
    const artifacts = new FileRunArtifactStore(directory).scope("state", "framework");

    const json = await artifacts.writeJson("result.json", { accepted: true });
    const text = await artifacts.writeText("summary.md", "accepted");
    await artifacts.appendRecord("events.jsonl", 0, { status: "started" });
    await artifacts.appendRecord("events.jsonl", 1, { status: "completed" });

    await expect(fs.readFile(path.join(directory, "state", "framework", "result.json"), "utf8"))
      .resolves.toBe('{\n  "accepted": true\n}\n');
    await expect(fs.readFile(path.join(directory, "state", "framework", "summary.md"), "utf8"))
      .resolves.toBe("accepted\n");
    await expect(fs.readFile(path.join(directory, "state", "framework", "events.jsonl"), "utf8"))
      .resolves.toBe('{"status":"started"}\n{"status":"completed"}\n');
    expect(json).toMatchObject({
      key: "state/framework/result.json",
      mediaType: "application/json",
      sizeBytes: Buffer.byteLength('{\n  "accepted": true\n}\n'),
    });
    expect(json.sha256).toBe(createHash("sha256").update('{\n  "accepted": true\n}\n').digest("hex"));
    expect(text).toMatchObject({
      key: "state/framework/summary.md",
      mediaType: "text/plain; charset=utf-8",
      sizeBytes: Buffer.byteLength("accepted\n"),
    });
    expect(text.sha256).toBe(createHash("sha256").update("accepted\n").digest("hex"));
  });

  it("rejects absolute, nested, and traversal path components", async () => {
    const directory = await temporaryDirectory();
    const artifacts = new FileRunArtifactStore(directory);

    expect(() => artifacts.scope("..")).toThrow("Artifact scope segment must be a single non-empty path segment");
    expect(() => artifacts.scope("nested/scope")).toThrow("Artifact scope segment must be a single non-empty path segment");
    await expect(artifacts.writeText("../outside.txt", "no"))
      .rejects.toThrow("Artifact name must be a single non-empty path segment");
  });

  it("makes ordered stream retries idempotent and rejects conflicts and gaps", async () => {
    const directory = await temporaryDirectory();
    const artifacts = new FileRunArtifactStore(directory);

    await artifacts.appendRecord("events.jsonl", 0, { status: "started" });
    await artifacts.appendRecord("events.jsonl", 0, { status: "started" });
    await artifacts.appendRecord("events.jsonl", 1, { status: "completed" });

    await expect(fs.readFile(path.join(directory, "events.jsonl"), "utf8"))
      .resolves.toBe('{"status":"started"}\n{"status":"completed"}\n');
    await expect(artifacts.appendRecord("events.jsonl", 1, { status: "failed" }))
      .rejects.toBeInstanceOf(ArtifactStreamSequenceConflictError);
    await expect(artifacts.appendRecord("events.jsonl", 3, { status: "late" }))
      .rejects.toBeInstanceOf(ArtifactStreamSequenceGapError);
    await expect(artifacts.appendRecord("events.jsonl", -1, { status: "invalid" }))
      .rejects.toThrow("non-negative integer");
  });

  it("persists workflow-owned events through the generic JSONL sink", async () => {
    const directory = await temporaryDirectory();
    const artifacts = new FileRunArtifactStore(directory);
    const events = new JsonlRunEventSink<{
      type: "started" | "completed";
      workflow: string;
    }>(artifacts);

    await events.emit({ type: "started", workflow: "fixture.workflow" });
    await events.emit({ type: "completed", workflow: "fixture.workflow" });

    await expect(fs.readFile(path.join(directory, "events.jsonl"), "utf8"))
      .resolves.toBe([
        '{"type":"started","workflow":"fixture.workflow"}',
        '{"type":"completed","workflow":"fixture.workflow"}',
        "",
      ].join("\n"));
  });
});
