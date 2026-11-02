import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { createServer, type Server } from "node:net";
import path from "node:path";

/** Internal same-machine writer guard. No requests or data are served over this socket.
 * The OS releases ownership on process death, unlike an unconditionally deleted PID file.
 * Port collisions fail closed; never choose another port for the same canonical root.
 * Network/shared filesystems and hostile same-user filesystem changes are not supported.
 */
export class LocalFileAuthority {
  readonly root: string;
  readonly #server: Server;
  #tail: Promise<unknown> = Promise.resolve();
  #closing = false;
  private constructor(root: string, server: Server) { this.root = root; this.#server = server; }

  static async open(directory: string): Promise<LocalFileAuthority> {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    const root = await fs.realpath(directory);
    const digest = createHash("sha256").update(process.platform === "win32" ? root.toLowerCase() : root).digest();
    const port = 49152 + digest.readUInt16BE(0) % 16384;
    const server = createServer(socket => socket.destroy());
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen({ host: "127.0.0.1", port, exclusive: true }, () => { server.removeListener("error", reject); resolve(); });
      });
    } catch (cause) {
      server.close();
      throw new Error(`Local retained storage needs exclusive writer ownership (loopback guard port ${port}). Stop its other writer or resolve the port conflict; no data was changed.`, { cause });
    }
    server.unref();
    return new LocalFileAuthority(root, server);
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.#closing) throw new Error("Local retained storage is closed.");
    const result = this.#tail.then(work);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async close(): Promise<void> {
    if (this.#closing) return;
    this.#closing = true;
    await this.#tail;
    await new Promise<void>((resolve, reject) => this.#server.close(error => error ? reject(error) : resolve()));
  }
}

/** A crash leaves either the old committed JSON or the new one, never a partial record. */
export async function replaceDurableJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally { await fs.rm(temporary, { force: true }); }
}

/** A crash leaves either no finalized object or the complete supplied bytes. */
export async function replaceDurableBytes(file: string, value: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(value); await handle.sync(); } finally { await handle.close(); }
    await fs.rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } finally { await fs.rm(temporary, { force: true }); }
}

/** Flush directory entries where Node/the local filesystem supports it. */
export async function syncDirectory(root: string): Promise<void> {
  const directory = await fs.open(root, "r").catch(error => {
    if (process.platform === "win32" && ["EPERM", "EISDIR", "EACCES"].includes(error.code)) return undefined;
    throw error;
  });
  try { await directory?.sync(); } finally { await directory?.close(); }
}

export async function readDurableJson(file: string): Promise<unknown | undefined> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("Retained storage record must be a regular file.");
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
