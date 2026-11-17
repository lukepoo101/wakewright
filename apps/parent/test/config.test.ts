import { expect, test } from "bun:test";
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
