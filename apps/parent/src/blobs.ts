import { mkdirSync, rmSync } from "node:fs";
import { mkdir, open, rename, stat } from "node:fs/promises";
import { join } from "node:path";

// A content-addressed store of immutable files under
// <data>/blobs/sha256/ab/cd/<sha256>. A file is written to <data>/tmp,
// fsynced and renamed into place, so a crash never leaves a partial blob
// under its name. Storing the same bytes twice is a no-op.

export class BlobStore {
  readonly root: string;
  readonly tmp: string;

  constructor(dataDir: string) {
    this.root = join(dataDir, "blobs", "sha256");
    this.tmp = join(dataDir, "tmp");
  }

  /** Creates the directories and clears files left in tmp by a crash. */
  init(): void {
    mkdirSync(this.root, { recursive: true });
    rmSync(this.tmp, { recursive: true, force: true });
    mkdirSync(this.tmp, { recursive: true });
  }

  path(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Not a SHA-256: ${sha256}`);
    return join(this.root, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }

  async put(bytes: Uint8Array): Promise<{ sha256: string; size: number }> {
    const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
    const final = this.path(sha256);
    if (await exists(final)) return { sha256, size: bytes.length };

    const temp = join(this.tmp, `${sha256}.${crypto.randomUUID()}`);
    const handle = await open(temp, "wx", 0o640);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await mkdir(join(this.root, sha256.slice(0, 2), sha256.slice(2, 4)), { recursive: true });
    await rename(temp, final);
    return { sha256, size: bytes.length };
  }

  file(sha256: string) {
    return Bun.file(this.path(sha256));
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
