import path from "node:path";
import { publicPlatforms, publicRepository } from "./mock-debugger-candidate.mjs";

const releaseTagPattern = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;

export function validateReleaseTag(tag) {
  if (!releaseTagPattern.test(tag) || tag === "latest") {
    throw new Error("Expected a version tag such as 0.1.0 or 0.1.0-alpha.10; latest is forbidden.");
  }
  return tag;
}

export function releaseBuildArguments({ tag, metadataFile, contextDirectory, builderName }) {
  validateReleaseTag(tag);
  if (!/^[a-z0-9][a-z0-9_.-]*$/.test(builderName)) throw new Error("Expected a valid isolated Buildx builder name.");
  return [
    "buildx", "build",
    "--builder", builderName,
    "--platform", publicPlatforms.join(","),
    "--pull",
    "--tag", `${publicRepository}:${tag}`,
    "--metadata-file", path.resolve(metadataFile),
    "--push",
    "--file", path.join(path.resolve(contextDirectory), "Dockerfile"),
    path.resolve(contextDirectory),
  ];
}

export function digestFromBuildMetadata(metadata) {
  const digest = metadata?.["containerimage.digest"];
  if (!digestPattern.test(digest)) throw new Error("Docker did not return a valid multi-platform image digest.");
  return digest;
}

export function publicManifestReference(digest) {
  if (!digestPattern.test(digest)) throw new Error("Expected an immutable SHA-256 manifest digest.");
  return `${publicRepository}@${digest}`;
}

export function releasePlatformManifests(index) {
  if (!index || !Array.isArray(index.manifests)) throw new Error("The published image is not a multi-platform manifest.");
  const matches = new Map();
  for (const manifest of index.manifests) {
    const platform = manifest?.platform;
    const name = platform?.os && platform?.architecture ? `${platform.os}/${platform.architecture}` : null;
    if (name && publicPlatforms.includes(name) && digestPattern.test(manifest.digest)) {
      if (matches.has(name)) throw new Error(`Published image contains more than one ${name} manifest.`);
      matches.set(name, manifest.digest);
    }
  }
  const missing = publicPlatforms.filter(platform => !matches.has(platform));
  if (missing.length) throw new Error(`Published image is missing required platform(s): ${missing.join(", ")}.`);
  return publicPlatforms.map(platform => ({ platform, digest: matches.get(platform) }));
}
