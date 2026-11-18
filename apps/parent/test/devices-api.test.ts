import { describe, expect, test } from "bun:test";
import { createFakeKiosk } from "@wakewright/fake-kiosk";
import { testApi } from "./helpers.ts";

const BASE = "http://kitchen.test:2324";

async function signedIn(fake = createFakeKiosk()) {
  const t = await testApi({ fetch: fake.fetch });
  await t.setUp();
  return { ...t, fake };
}

async function add(t: Awaited<ReturnType<typeof signedIn>>, body: object = {}) {
  return t.request("/api/v1/devices", {
    json: { name: "Kitchen", baseUrl: BASE, password: "dev", ...body },
  });
}

describe("devices API", () => {
  test("needs a session", async () => {
    const t = await testApi();
    expect((await t.request("/api/v1/devices")).status).toBe(401);
    expect((await t.request("/api/v1/collection")).status).toBe(401);
  });

  test("adds a device after a successful test and never returns its password", async () => {
    const t = await signedIn();
    const res = await add(t);
    expect(res.status).toBe(201);
    const device = await res.json();
    expect(device).toMatchObject({ name: "Kitchen", baseUrl: BASE, source: "kiosk_satellite" });
    expect(JSON.stringify(device)).not.toContain('"dev"');

    await t.collector.pollDevice(device.id);
    const list = await (await t.request("/api/v1/devices")).json();
    expect(list.devices).toHaveLength(1);
    expect(list.devices[0]).toMatchObject({
      clips: 6,
      status: { health: "ok", error: null },
      reported: {
        engine: "vsWakeWord",
        diagnosticsEnabled: true,
        sensitivity: "Moderately sensitive",
      },
    });

    // The password is stored encrypted, not in clear.
    const secret = t.db
      .query<{ ciphertext: Uint8Array }, []>("SELECT ciphertext FROM secrets")
      .get();
    expect(Buffer.from(secret?.ciphertext ?? []).toString("latin1")).not.toContain("dev");
  });

  test("refuses a wrong password, and an unreachable device unless asked to save anyway", async () => {
    const t = await signedIn();
    const wrong = await add(t, { password: "nope" });
    expect(wrong.status).toBe(422);
    expect(await wrong.json()).toMatchObject({ error: "auth_failed" });
    expect((await add(t, { password: "nope", skipTest: true })).status).toBe(422);

    t.fake.faults.offline = true;
    const offline = await add(t);
    expect(offline.status).toBe(422);
    expect(await offline.json()).toMatchObject({ error: "unreachable" });
    expect((await add(t, { skipTest: true })).status).toBe(201);
  });

  test("names must be unique and addresses valid", async () => {
    const t = await signedIn();
    await add(t);
    expect((await add(t, { name: "kitchen" })).status).toBe(409);
    const bad = await add(t, { name: "Other", baseUrl: "http://x/with/path" });
    expect(bad.status).toBe(400);
  });

  test("tests a connection without saving", async () => {
    const t = await signedIn();
    const ok = await (
      await t.request("/api/v1/devices/test", {
        json: { baseUrl: "kitchen.test", password: "dev" },
      })
    ).json();
    // A bare host gets the Kiosk port; the fake answers whatever host it is given.
    expect(ok).toMatchObject({ ok: true, clips: 6, reported: { name: "fake-kiosk" } });
    const bad = await (
      await t.request("/api/v1/devices/test", { json: { baseUrl: BASE, password: "x" } })
    ).json();
    expect(bad).toMatchObject({ ok: false, error: { code: "auth_failed" } });
    expect((await (await t.request("/api/v1/devices")).json()).devices).toHaveLength(0);
  });

  test("edits a device, keeping the stored password unless a new one is given", async () => {
    const t = await signedIn();
    const { id } = await (await add(t)).json();
    const renamed = await t.request(`/api/v1/devices/${id}`, {
      method: "PATCH",
      json: { name: "Kitchen Portal" },
    });
    expect(renamed.status).toBe(200);
    expect((await renamed.json()).name).toBe("Kitchen Portal");

    const retest = await (
      await t.request("/api/v1/devices/test", { json: { baseUrl: BASE, deviceId: id } })
    ).json();
    expect(retest.ok).toBe(true);

    const wrong = await t.request(`/api/v1/devices/${id}`, {
      method: "PATCH",
      json: { password: "wrong" },
    });
    expect(wrong.status).toBe(422);
    expect(t.db.query("SELECT count(*) AS n FROM secrets").get()).toEqual({ n: 1 });
  });

  test("removing a device keeps its clips and forgets its password", async () => {
    const t = await signedIn();
    const { id } = await (await add(t)).json();
    await t.collector.pollDevice(id);
    expect((await t.request(`/api/v1/devices/${id}`, { method: "DELETE" })).status).toBe(204);
    expect((await (await t.request("/api/v1/devices")).json()).devices).toHaveLength(0);
    expect(t.db.query("SELECT count(*) AS n FROM clips").get()).toEqual({ n: 6 });
    expect(t.db.query("SELECT count(*) AS n FROM secrets").get()).toEqual({ n: 0 });
    // The name is free again.
    expect((await add(t)).status).toBe(201);
  });

  test("poll now returns the fresh status", async () => {
    const t = await signedIn();
    const { id } = await (await add(t)).json();
    const polled = await (await t.request(`/api/v1/devices/${id}/poll`, { json: {} })).json();
    expect(polled).toMatchObject({ clips: 6, status: { health: "ok" } });
  });

  test("pauses and resumes collection", async () => {
    const t = await signedIn();
    expect(await (await t.request("/api/v1/collection")).json()).toMatchObject({
      paused: false,
      pausedSince: null,
      intervalSeconds: 10,
    });
    const paused = await t.request("/api/v1/collection", { method: "PUT", json: { paused: true } });
    expect(await paused.json()).toMatchObject({ paused: true });
    // Pausing twice keeps the first pause.
    const since = (await (await t.request("/api/v1/collection")).json()).pausedSince;
    await t.request("/api/v1/collection", { method: "PUT", json: { paused: true } });
    expect((await (await t.request("/api/v1/collection")).json()).pausedSince).toBe(since);
    const resumed = await t.request("/api/v1/collection", {
      method: "PUT",
      json: { paused: false },
    });
    expect(await resumed.json()).toMatchObject({ paused: false, pausedSince: null });
  });
});
