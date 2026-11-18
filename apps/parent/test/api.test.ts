import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { openDatabase } from "../src/db/db.ts";
import { mountSpa } from "../src/spa.ts";
import { version } from "../src/version.ts";
import { testApi } from "./helpers.ts";

async function migratedApi() {
  return (await testApi()).api;
}

describe("health", () => {
  test("/healthz reports the version", async () => {
    const res = await (await migratedApi()).request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version });
  });

  test("/readyz is ready once migrated", async () => {
    const res = await (await migratedApi()).request("/readyz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: "ready" });
  });

  test("/readyz is not ready on an unmigrated database", async () => {
    const res = await (await testApi({ db: openDatabase(":memory:") })).api.request("/readyz");
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ status: "not_ready" });
  });
});

describe("API", () => {
  test("serves an OpenAPI 3.1 document describing its routes", async () => {
    const res = await (await migratedApi()).request("/api/openapi.json");
    const doc = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/healthz", "/readyz"]));
  });

  test("unknown API paths answer JSON 404", async () => {
    const res = await (await migratedApi()).request("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
  });
});

const spaApi = await migratedApi();

describe("SPA", () => {
  const dir = mkdtempSync(join(tmpdir(), "wakewright-spa-"));
  writeFileSync(join(dir, "index.html"), "<!doctype html><title>t</title>");
  writeFileSync(join(dir, "app-abc123.js"), "console.log(1)");
  const app = new Hono().route("/", spaApi);
  mountSpa(app, dir);

  test("hashed assets are cached for a year", async () => {
    const res = await app.request("/app-abc123.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toContain("immutable");
  });

  test("client routes get index.html, revalidated on every load", async () => {
    const res = await app.request("/devices/abc");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(await res.text()).toContain("<title>t</title>");
  });

  test("API paths are never answered with index.html", async () => {
    expect((await app.request("/api/nope")).status).toBe(404);
    expect(await (await app.request("/healthz")).json()).toMatchObject({ status: "ok" });
  });

  test("does nothing without a build", () => {
    expect(mountSpa(new Hono(), join(dir, "missing"))).toBe(false);
  });
});
