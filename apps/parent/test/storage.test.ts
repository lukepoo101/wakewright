import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeWav, synthesize } from "@wakewright/fake-kiosk/synth";
import { backupDatabase, KEEP } from "../src/backup.ts";
import { BlobStore } from "../src/blobs.ts";
import { loadSecretKey, SecretBox, SecretUnreadable } from "../src/crypto.ts";
import { openDatabase } from "../src/db/db.ts";
import { checkClipWav, readWav, WavError } from "../src/wav.ts";
import { migratedDb, quietLog, TEST_KEY, tempDir } from "./helpers.ts";

const clip = () => encodeWav(synthesize({ kind: "tone", hz: 440 }));

describe("WAV header reader", () => {
  test("reads a Kiosk-style clip", () => {
    expect(checkClipWav(clip())).toMatchObject({
      format: 1,
      channels: 1,
      sampleRate: 16_000,
      bitsPerSample: 16,
      dataOffset: 44,
      dataBytes: 96_000,
      durationMs: 3000,
    });
  });

  test("walks past extra chunks, including odd-sized ones", () => {
    const wav = clip();
    const extra = new Uint8Array([...new TextEncoder().encode("LIST"), 3, 0, 0, 0, 1, 2, 3, 0]);
    const joined = new Uint8Array(wav.length + extra.length);
    joined.set(wav.subarray(0, 36));
    joined.set(extra, 36);
    joined.set(wav.subarray(36), 36 + extra.length);
    expect(readWav(joined).dataOffset).toBe(44 + extra.length);
  });

  test("refuses other formats with a reason", () => {
    const stereo = clip();
    new DataView(stereo.buffer).setUint16(22, 2, true);
    expect(() => checkClipWav(stereo)).toThrow("2 channels, not mono");
    const fast = encodeWav(synthesize({ kind: "tone", hz: 440 }), 48_000);
    expect(() => checkClipWav(fast)).toThrow("48000 Hz, not 16000 Hz");
    const float = clip();
    new DataView(float.buffer).setUint16(20, 3, true);
    expect(() => checkClipWav(float)).toThrow("format 3 is not PCM");
    expect(() => checkClipWav(clip().subarray(0, 1000))).toThrow("data chunk is truncated");
    expect(() => checkClipWav(new TextEncoder().encode("not a wav file"))).toThrow(
      "not a RIFF/WAVE file",
    );
  });

  test("fuzz: random and mutated input only ever raises WavError", () => {
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const base = clip().subarray(0, 200);
    for (let i = 0; i < 5000; i++) {
      const bytes =
        i % 2 === 0
          ? Uint8Array.from({ length: Math.floor(random() * 80) }, () => Math.floor(random() * 256))
          : base.map((b) => (random() < 0.05 ? Math.floor(random() * 256) : b));
      try {
        readWav(bytes);
      } catch (error) {
        expect(error).toBeInstanceOf(WavError);
      }
    }
  });
});

describe("secret box", () => {
  test("round-trips, with a fresh IV each time", async () => {
    const box = await SecretBox.create(TEST_KEY);
    const a = await box.seal("device password", "ctx");
    const b = await box.seal("device password", "ctx");
    expect(a).not.toEqual(b);
    expect(new TextDecoder().decode(a)).not.toContain("device password");
    expect(await box.open(a, "ctx")).toBe("device password");
  });

  test("a wrong key, a wrong row or changed bytes do not decrypt", async () => {
    const box = await SecretBox.create(TEST_KEY);
    const sealed = await box.seal("pw", "row-1");
    expect(box.open(sealed, "row-2")).rejects.toBeInstanceOf(SecretUnreadable);
    const other = await SecretBox.create(new Uint8Array(32).fill(1));
    expect(other.open(sealed, "row-1")).rejects.toBeInstanceOf(SecretUnreadable);
    const tampered = sealed.slice();
    tampered[20] = (tampered[20] ?? 0) ^ 1;
    expect(box.open(tampered, "row-1")).rejects.toBeInstanceOf(SecretUnreadable);
  });

  test("without a configured key, one is generated once in the data directory", () => {
    const dir = tempDir();
    const first = loadSecretKey(undefined, dir, quietLog);
    const path = join(dir, "secret.key");
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadSecretKey(undefined, dir, quietLog)).toEqual(first);
    expect(readFileSync(path, "utf8").trim()).toBe(first.toBase64());
    // A configured key wins and nothing is written.
    const other = tempDir();
    expect(loadSecretKey(TEST_KEY, other, quietLog)).toEqual(TEST_KEY);
    expect(existsSync(join(other, "secret.key"))).toBe(false);
  });
});

describe("blob store", () => {
  test("stores by SHA-256 under sha256/ab/cd/, once", async () => {
    const store = new BlobStore(tempDir());
    store.init();
    const bytes = clip();
    const a = await store.put(bytes);
    const b = await store.put(bytes);
    expect(a).toEqual(b);
    expect(a.sha256).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
    expect(store.path(a.sha256)).toEndWith(
      join("blobs", "sha256", a.sha256.slice(0, 2), a.sha256.slice(2, 4), a.sha256),
    );
    expect(Buffer.from(await store.file(a.sha256).arrayBuffer()).equals(bytes)).toBe(true);
    expect(readdirSync(store.tmp)).toEqual([]);
  });

  test("clears partial files a crash left in tmp", () => {
    const dir = tempDir();
    const store = new BlobStore(dir);
    store.init();
    writeFileSync(join(store.tmp, "half-written"), "x");
    new BlobStore(dir).init();
    expect(readdirSync(store.tmp)).toEqual([]);
  });

  test("refuses a path that is not a hash", () => {
    expect(() => new BlobStore(tempDir()).path("../../etc/passwd")).toThrow();
  });
});

describe("backups", () => {
  test("VACUUM INTO a dated file and keep the newest 14", () => {
    const db = migratedDb();
    const dir = tempDir();
    for (let day = 1; day <= KEEP + 3; day++) {
      backupDatabase(db, dir, new Date(Date.UTC(2026, 10, day, 3, 30)));
    }
    const files = readdirSync(dir).sort();
    expect(files.length).toBe(KEEP);
    expect(files[0]).toBe("wakewright-20261104.sqlite3");
    expect(files.at(-1)).toBe("wakewright-20261117.sqlite3");
    // A second run on the same day replaces that day's file.
    backupDatabase(db, dir, new Date(Date.UTC(2026, 10, 17, 9)));
    const copy = openDatabase(join(dir, "wakewright-20261117.sqlite3"));
    expect(copy.query("SELECT count(*) AS n FROM instance").get()).toEqual({ n: 1 });
  });
});
