import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseSecretKey } from "./config.ts";
import type { Logger } from "./log.ts";

// Encryption of stored secrets (device passwords) with AES-256-GCM from
// crypto.subtle. Each value gets a random 96-bit IV, and the row it belongs
// to is bound in as additional data, so a ciphertext copied into another
// row does not decrypt. The key never enters the database.

export const KEY_VERSION = 1;

export class SecretBox {
  private constructor(private readonly key: CryptoKey) {}

  static async create(rawKey: Uint8Array): Promise<SecretBox> {
    if (rawKey.length !== 32) throw new Error("The secret key must be 32 bytes");
    const key = await crypto.subtle.importKey("raw", rawKey.slice(), "AES-GCM", false, [
      "encrypt",
      "decrypt",
    ]);
    return new SecretBox(key);
  }

  /** IV || ciphertext || tag. */
  async seal(plaintext: string, context: string): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(context) },
      this.key,
      new TextEncoder().encode(plaintext),
    );
    const out = new Uint8Array(12 + sealed.byteLength);
    out.set(iv);
    out.set(new Uint8Array(sealed), 12);
    return out;
  }

  /** Throws SecretUnreadable when the key or context is wrong or the bytes changed. */
  async open(sealed: Uint8Array, context: string): Promise<string> {
    try {
      const plain = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: sealed.slice(0, 12),
          additionalData: new TextEncoder().encode(context),
        },
        this.key,
        sealed.slice(12),
      );
      return new TextDecoder().decode(plain);
    } catch {
      throw new SecretUnreadable();
    }
  }
}

export class SecretUnreadable extends Error {
  constructor() {
    super(
      "The stored password cannot be decrypted with the current secret key. " +
        "Edit the device and enter its password again.",
    );
    this.name = "SecretUnreadable";
  }
}

/**
 * The configured key, or the one in `<data dir>/secret.key`, created on
 * first start. A generated key sits beside the database, so it protects
 * database copies and backups but not a copy of the whole data directory.
 */
export function loadSecretKey(
  configured: Uint8Array | undefined,
  dataDir: string,
  log: Logger,
): Uint8Array {
  if (configured) return configured;
  const path = join(dataDir, "secret.key");
  if (existsSync(path)) return parseSecretKey(readFileSync(path, "utf8"), path);
  const key = crypto.getRandomValues(new Uint8Array(32));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${key.toBase64()}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  log.info("generated a secret key for stored device passwords; keep it with your backups", {
    path,
  });
  return key;
}
