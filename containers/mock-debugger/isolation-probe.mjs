import { spawnSync } from "node:child_process";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { Worker } from "node:worker_threads";

const denied = async operation => {
  try {
    await operation();
    return false;
  } catch {
    return true;
  }
};

const readText = async file => {
  try { return (await readFile(file, "utf8")).trim(); }
  catch { return null; }
};

const input = JSON.parse(await readFile("/work/input/probe.json", "utf8"));
if (input.schemaVersion !== 1 || typeof input.nonce !== "string" || input.nonce.length < 16) {
  throw new Error("Invalid isolation probe input.");
}

const scratch = `/work/scratch/${input.nonce}.txt`;
await writeFile(scratch, input.nonce, { flag: "wx", mode: 0o600 });
const scratchRoundTrip = await readFile(scratch, "utf8");

let childProcessDenied = false;
try {
  const child = spawnSync("/bin/true", [], { stdio: "ignore" });
  childProcessDenied = Boolean(child.error) || child.status !== 0;
} catch {
  childProcessDenied = true;
}

const workerDenied = await new Promise(resolve => {
  try {
    const worker = new Worker("process.exit(0)", { eval: true });
    worker.once("online", () => { void worker.terminate().finally(() => resolve(false)); });
    worker.once("error", () => resolve(true));
  } catch {
    resolve(true);
  }
});

let networkDenied = false;
try {
  await fetch("http://1.1.1.1", { signal: AbortSignal.timeout(1_500) });
} catch {
  networkDenied = true;
}

const interfaces = Object.entries(networkInterfaces())
  .flatMap(([name, values]) => (values ?? []).map(value => ({ name, address: value.address, internal: value.internal })))
  .sort((left, right) => `${left.name}/${left.address}`.localeCompare(`${right.name}/${right.address}`));
const onlyLoopback = interfaces.length > 0 && interfaces.every(value => value.internal || value.name === "lo");

const status = await readText("/proc/self/status");
const capabilityMatch = status?.match(/^CapEff:\s*([0-9a-f]+)$/mi);
const noNewPrivilegesMatch = status?.match(/^NoNewPrivs:\s*(\d+)$/mi);
const mounts = await readText("/proc/mounts");
const mountLines = mounts?.split("\n") ?? [];
const mountOptions = target => mountLines.find(line => line.split(" ")[1] === target)?.split(" ")[3]?.split(",") ?? [];
const rootOptions = mountOptions("/");
const retainedInputOptions = mountOptions("/work/input");
const tmpOptions = mountOptions("/tmp");
const scratchOptions = mountOptions("/work/scratch");

const memoryMax = await readText("/sys/fs/cgroup/memory.max");
const cpuMax = await readText("/sys/fs/cgroup/cpu.max");
const pidsMax = await readText("/sys/fs/cgroup/pids.max");
const sensitiveEnvironmentKeys = Object.keys(process.env)
  .filter(key => /(token|secret|password|credential|api[_-]?key|auth)/i.test(key))
  .sort();

const checks = {
  nodeMajor24: Number(process.versions.node.split(".")[0]) === 24,
  brokerIsPidOne: process.pid === 1,
  nonRootUid: process.getuid?.() === 65532,
  nonRootGid: process.getgid?.() === 65532,
  retainedInputRead: input.nonce,
  retainedInputReadOnly: retainedInputOptions.includes("ro"),
  retainedInputWriteDenied: await denied(() => writeFile("/work/input/write-canary", "blocked", { flag: "wx" })),
  rootReadOnly: rootOptions.includes("ro"),
  rootWriteDenied: await denied(() => writeFile("/opt/arkimux/write-canary", "blocked", { flag: "wx" })),
  scratchWritable: scratchRoundTrip === input.nonce,
  outsideReadDenied: await denied(() => readFile("/etc/passwd", "utf8")),
  childProcessDenied,
  workerDenied,
  networkDenied,
  onlyLoopback,
  dockerSocketAbsent: await denied(() => access("/var/run/docker.sock")),
  hostPathsDenied: await Promise.all(["/Users", "/workspace", "/project"].map(value => denied(() => stat(value)))).then(values => values.every(Boolean)),
  credentialPathsDenied: await Promise.all(["/run/secrets", "/root/.config", "/home/node/.config"].map(value => denied(() => stat(value)))).then(values => values.every(Boolean)),
  sensitiveEnvironmentKeys,
  capabilitiesDropped: capabilityMatch?.[1] === "0000000000000000",
  noNewPrivileges: noNewPrivilegesMatch?.[1] === "1",
  tmpNoExec: tmpOptions.includes("noexec"),
  tmpNoSuid: tmpOptions.includes("nosuid"),
  scratchNoExec: scratchOptions.includes("noexec"),
  scratchNoSuid: scratchOptions.includes("nosuid"),
  memoryMax,
  cpuMax,
  pidsMax,
};

const ok = checks.nodeMajor24
  && checks.brokerIsPidOne
  && checks.nonRootUid
  && checks.nonRootGid
  && checks.retainedInputRead === input.nonce
  && checks.retainedInputReadOnly
  && checks.retainedInputWriteDenied
  && checks.rootReadOnly
  && checks.rootWriteDenied
  && checks.scratchWritable
  && checks.outsideReadDenied
  && checks.childProcessDenied
  && checks.workerDenied
  && checks.networkDenied
  && checks.onlyLoopback
  && checks.dockerSocketAbsent
  && checks.hostPathsDenied
  && checks.credentialPathsDenied
  && checks.sensitiveEnvironmentKeys.length === 0
  && checks.capabilitiesDropped
  && checks.noNewPrivileges
  && checks.tmpNoExec
  && checks.tmpNoSuid
  && checks.scratchNoExec
  && checks.scratchNoSuid
  && checks.memoryMax === "268435456"
  && checks.cpuMax === "100000 100000"
  && checks.pidsMax === "64";

process.stdout.write(JSON.stringify({ schemaVersion: 1, kind: "arkimux-mock-debugger-isolation", ok, checks }) + "\n");
if (!ok) process.exitCode = 1;
