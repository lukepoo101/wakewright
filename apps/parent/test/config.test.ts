import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../src/config.ts";

test("defaults", () => {
  const config = loadConfig({});
  expect(config.server.port).toBe(8080);
  expect(config.storage.dataDir).toBe(resolve("data"));
  expect(config.storage.dbPath).toBe(join(resolve("data"), "db", "wakewright.sqlite3"));
});

test("reads WAKEWRIGHT__ variables", () => {
  const config = loadConfig({
    WAKEWRIGHT__SERVER__PORT: "9000",
    WAKEWRIGHT__STORAGE__DATA_DIR: "/data",
  });
  expect(config.server.port).toBe(9000);
  expect(config.storage.dbPath).toBe("/data/db/wakewright.sqlite3");
});

test("rejects invalid values with the variable's name", () => {
  expect(() => loadConfig({ WAKEWRIGHT__SERVER__PORT: "http" })).toThrow(
    /WAKEWRIGHT__SERVER__PORT/,
  );
});

describe("secrets", () => {
  const dir = mkdtempSync(join(tmpdir(), "wakewright-config-"));
  const key = Buffer.alloc(32, 7).toString("base64");

  test("read from a _FILE, dropping one trailing newline", () => {
    writeFileSync(join(dir, "password"), "a long admin password\n");
    writeFileSync(join(dir, "key"), `${key}\n`);
    const config = loadConfig({
      WAKEWRIGHT__ADMIN__PASSWORD_FILE: join(dir, "password"),
      WAKEWRIGHT__SECRET_KEY_FILE: join(dir, "key"),
    });
    expect(config.admin).toEqual({ username: "admin", password: "a long admin password" });
    expect(config.secretKey).toEqual(new Uint8Array(32).fill(7));
  });

  test("absent means first-run setup and a generated key", () => {
    const config = loadConfig({});
    expect(config.admin.password).toBeUndefined();
    expect(config.secretKey).toBeUndefined();
  });

  test("refuse both forms, a short password, a bad key and an unreadable file", () => {
    expect(() =>
      loadConfig({ WAKEWRIGHT__SECRET_KEY: key, WAKEWRIGHT__SECRET_KEY_FILE: "/x" }),
    ).toThrow(/not both/);
    expect(() => loadConfig({ WAKEWRIGHT__ADMIN__PASSWORD: "short" })).toThrow(/at least 12/);
    expect(() => loadConfig({ WAKEWRIGHT__SECRET_KEY: "dG9vIHNob3J0" })).toThrow(/32 bytes/);
    expect(() => loadConfig({ WAKEWRIGHT__SECRET_KEY: "not base64!" })).toThrow(/32 bytes/);
    expect(() => loadConfig({ WAKEWRIGHT__ADMIN__PASSWORD_FILE: join(dir, "missing") })).toThrow(
      /cannot read WAKEWRIGHT__ADMIN__PASSWORD_FILE/,
    );
  });

  test("an https public URL is parsed", () => {
    const config = loadConfig({ WAKEWRIGHT__SERVER__PUBLIC_URL: "https://ww.example.lan" });
    expect(config.server.publicUrl?.origin).toBe("https://ww.example.lan");
    expect(() => loadConfig({ WAKEWRIGHT__SERVER__PUBLIC_URL: "ftp://x" })).toThrow();
  });
});

describe("auth mode", () => {
  test("is local by default", () => {
    expect(loadConfig({}).auth.mode).toBe("local");
  });

  test("none turns sign-in off", () => {
    expect(loadConfig({ WAKEWRIGHT__AUTH__MODE: "none" }).auth.mode).toBe("none");
  });

  test("rejects an unknown mode", () => {
    expect(() => loadConfig({ WAKEWRIGHT__AUTH__MODE: "proxy" })).toThrow(/WAKEWRIGHT__AUTH__MODE/);
  });

  test("none refuses an admin password, which would protect nothing", () => {
    expect(() =>
      loadConfig({
        WAKEWRIGHT__AUTH__MODE: "none",
        WAKEWRIGHT__ADMIN__PASSWORD: "a long admin password",
      }),
    ).toThrow(/has no effect when WAKEWRIGHT__AUTH__MODE is none/);
  });
});
