import { describe, expect, test } from "bun:test";
import { createFakeKiosk, type FakeKiosk, type FakeKioskOptions } from "@wakewright/fake-kiosk";
import { getDevice } from "../src/db/devices.ts";
import { boostedDevices, getSession, listWrites } from "../src/db/sessions.ts";
import { WakeSettingKeys } from "../src/kiosk/shapes.ts";
import { CollectionSessions, SessionError } from "../src/sessions.ts";
import { quietLog, testApi, testParts } from "./helpers.ts";

// Collection sessions against the fake device, in-process, on a fake
// clock: the loop is driven with tick(), so nothing waits on a timer.

const NOW = Date.parse("2026-11-18T12:00:00Z");
const ORIGINAL = { engine: "vsWakeWord", sensitivity: "moderately", fineTune: 3 } as const;

async function setup(fakeOptions: FakeKioskOptions = {}) {
  let now = NOW;
  const fake = createFakeKiosk({
    now: () => now,
    wakeWords: ["alexa"],
    sensitivity: ORIGINAL.sensitivity,
    fineTune: ORIGINAL.fineTune,
    ...fakeOptions,
  });
  const parts = await testParts({ fetch: fake.fetch, now: () => now });
  const id = await parts.devices.create({
    name: "Kitchen",
    source: "kiosk_satellite",
    config: { baseUrl: "http://kitchen.test:2324" },
    password: "dev",
  });
  const device = () => getDevice(parts.db, id) ?? fail("no device");
  const start = (extra: { engine?: string; limitSeconds?: number } = {}) =>
    parts.sessions.startSession(device(), {
      deviceId: id,
      limitSeconds: 600,
      note: "mixed",
      userId: null,
      ...extra,
    });
  return {
    ...parts,
    fake,
    id,
    device,
    start,
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
    session: (sessionId: string) => getSession(parts.db, sessionId) ?? fail("no session"),
  };
}

function fail(message: string): never {
  throw new Error(message);
}

function settingsOf(fake: FakeKiosk) {
  const { engine, sensitivity, fineTune } = fake.settings;
  return { engine, sensitivity, fineTune };
}

describe("collection options", () => {
  test("recommend microWakeWord at its most sensitive, keeping the wake word", async () => {
    const t = await setup();
    const options = await t.sessions.options(t.device());
    expect(options.ready).toBe(true);
    expect(options.defaultEngine).toBe("microwakeword");
    expect(options.current).toMatchObject({
      engine: "vswakeword",
      fineTune: 3,
      wakeWords: ["alexa"],
    });
    const micro = options.engines.find((e) => e.value === "microwakeword");
    expect(micro?.changes.map((c) => [c.key, c.from, c.to])).toEqual([
      [WakeSettingKeys.engine, "vswakeword", "microwakeword"],
      [WakeSettingKeys.sensitivity, "moderately", "very"],
      [WakeSettingKeys.fineTune, 3, 10],
    ]);
    // The current engine is always offered, changing only its sensitivity.
    const vs = options.engines.find((e) => e.value === "vswakeword");
    expect(vs?.available).toBe(true);
    expect(vs?.changes.map((c) => c.key)).toEqual([
      WakeSettingKeys.sensitivity,
      WakeSettingKeys.fineTune,
    ]);
  });

  test("leave out an engine without the device's wake word", async () => {
    const t = await setup({ wakeWords: ["hey_alfred"] });
    const options = await t.sessions.options(t.device());
    const micro = options.engines.find((e) => e.value === "microwakeword");
    expect(micro?.available).toBe(false);
    expect(micro?.reason).toContain("hey_alfred");
    expect(options.defaultEngine).toBe("vswakeword");
  });

  test("on a fleet member raise only the fine-tune, which a fleet never syncs", async () => {
    const t = await setup({ fleet: { follows: "Hall tablet" } });
    const options = await t.sessions.options(t.device());
    expect(options.fleet).toEqual({ role: "follower", leader: "Hall tablet" });
    expect(options.engines.filter((e) => e.available).map((e) => e.value)).toEqual(["vswakeword"]);
    expect(
      options.engines.find((e) => e.value === "vswakeword")?.changes.map((c) => c.key),
    ).toEqual([WakeSettingKeys.fineTune]);
  });

  test("are not ready while wake word diagnostics are off", async () => {
    const t = await setup({ diagnostics: false });
    const options = await t.sessions.options(t.device());
    expect(options.ready).toBe(false);
    expect(options.problems.join(" ")).toContain("diagnostics are off");
    await expect(t.start()).rejects.toThrow(/diagnostics are off/);
    expect(t.fake.writes).toEqual([]);
  });
});

describe("a collection session", () => {
  test("saves the settings, then writes only the wake word keys and confirms them", async () => {
    const t = await setup();
    const session = await t.start();
    expect(session.state).toBe("running");
    expect(JSON.parse(session.snapshot_json)).toEqual({
      [WakeSettingKeys.engine]: "vswakeword",
      [WakeSettingKeys.sensitivity]: "moderately",
      [WakeSettingKeys.fineTune]: 3,
    });
    expect(settingsOf(t.fake)).toEqual({
      engine: "microWakeWord",
      sensitivity: "very",
      fineTune: 10,
    });
    expect(t.fake.writes).toEqual([
      {
        [WakeSettingKeys.engine]: "microwakeword",
        [WakeSettingKeys.sensitivity]: "very",
        [WakeSettingKeys.fineTune]: 10,
      },
    ]);
    expect(listWrites(t.db, session.id).map((w) => [w.purpose, w.outcome])).toEqual([
      ["apply", "ok"],
    ]);
    expect(session.ends_at).toBe(new Date(t.now() + 600_000).toISOString());
    expect(boostedDevices(t.db).has(t.id)).toBe(true);
    // One session per device.
    await expect(t.start()).rejects.toMatchObject({ code: "busy" });
  });

  test("tags the clips recorded in it, with the boosted settings", async () => {
    const t = await setup();
    await t.collector.pollDevice(t.id);
    const before = t.db.query("SELECT count(*) AS n FROM clips").get() as { n: number };
    t.advance(1000);
    const session = await t.start();
    t.advance(1000);
    t.fake.hear();
    t.fake.hear({ nearMiss: true });
    t.advance(1000);
    expect((await t.collector.pollDevice(t.id)).stored).toBe(2);
    const rows = t.db
      .query<{ collection_session_id: string | null; sensitivity_json: string | null }, []>(
        "SELECT collection_session_id, sensitivity_json FROM clips ORDER BY captured_at",
      )
      .all();
    expect(rows.slice(0, before.n).every((r) => r.collection_session_id === null)).toBe(true);
    const tagged = rows.slice(before.n);
    expect(tagged.map((r) => r.collection_session_id)).toEqual([session.id, session.id]);
    expect(JSON.parse(tagged[0]?.sensitivity_json ?? "null")).toEqual({
      engine: "microWakeWord",
      wakeWords: ["alexa"],
      sensitivity: "Very sensitive",
      fineTune: 10,
    });
    expect(t.session(session.id)).toMatchObject({ fired: 1, near_miss: 1 });
  });

  test("Stop puts every changed key back and confirms it by reading the device", async () => {
    const t = await setup();
    const session = await t.start();
    await t.sessions.stopSession(session.id);
    expect(settingsOf(t.fake)).toEqual(ORIGINAL);
    expect(t.session(session.id)).toMatchObject({
      state: "ended",
      end_reason: "stopped",
      restored_at: expect.any(String),
    });
    expect(listWrites(t.db, session.id).map((w) => [w.purpose, JSON.parse(w.values_json)])).toEqual(
      [
        [
          "apply",
          {
            [WakeSettingKeys.engine]: "microwakeword",
            [WakeSettingKeys.sensitivity]: "very",
            [WakeSettingKeys.fineTune]: 10,
          },
        ],
        [
          "restore",
          {
            [WakeSettingKeys.engine]: "vswakeword",
            [WakeSettingKeys.sensitivity]: "moderately",
            [WakeSettingKeys.fineTune]: 3,
          },
        ],
      ],
    );
    expect(boostedDevices(t.db).has(t.id)).toBe(false);
  });

  test("ends at its time limit, enforced by the parent", async () => {
    const t = await setup();
    const session = await t.start({ limitSeconds: 30 });
    t.advance(29_000);
    await t.sessions.tick();
    expect(t.session(session.id).state).toBe("running");
    t.advance(1000);
    await t.sessions.tick();
    expect(t.session(session.id)).toMatchObject({ state: "ended", end_reason: "time_limit" });
    expect(settingsOf(t.fake)).toEqual(ORIGINAL);
  });

  test("left open by a crash is restored when the parent starts again", async () => {
    const t = await setup();
    const session = await t.start();
    // A new parent on the same database, as after a crash.
    const restarted = new CollectionSessions({
      db: t.db,
      devices: t.devices,
      log: quietLog,
      paused: () => false,
      now: t.now,
    });
    restarted.start();
    await restarted.stop();
    expect(t.session(session.id)).toMatchObject({ state: "ended", end_reason: "parent_restart" });
    expect(settingsOf(t.fake)).toEqual(ORIGINAL);
  });

  test("keeps retrying an unreachable device with backoff until the restore is confirmed", async () => {
    const t = await setup();
    const session = await t.start();
    t.fake.faults.offline = true;
    await t.sessions.stopSession(session.id);
    expect(t.session(session.id)).toMatchObject({
      state: "restoring",
      restore_attempts: 1,
      next_restore_at: new Date(t.now() + 5000).toISOString(),
    });
    expect(t.session(session.id).last_error).toContain("Cannot connect");
    t.advance(4000);
    await t.sessions.tick();
    expect(t.session(session.id).restore_attempts).toBe(1);
    t.advance(1000);
    await t.sessions.tick();
    expect(t.session(session.id)).toMatchObject({
      restore_attempts: 2,
      next_restore_at: new Date(t.now() + 10_000).toISOString(),
    });
    t.fake.faults.offline = false;
    t.advance(10_000);
    await t.sessions.tick();
    expect(t.session(session.id)).toMatchObject({
      state: "ended",
      restored_at: expect.any(String),
    });
    expect(settingsOf(t.fake)).toEqual(ORIGINAL);
  });

  test("refused by the device fails to start with nothing left changed", async () => {
    const t = await setup();
    t.fake.faults.rejectKeys = new Set([WakeSettingKeys.sensitivity]);
    const error = await t.start().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SessionError);
    expect((error as SessionError).message).toContain("Nothing was changed on the device");
    expect(settingsOf(t.fake)).toEqual(ORIGINAL);
    const session = t.session((error as SessionError).sessionId ?? "");
    expect(session).toMatchObject({ state: "ended", end_reason: "start_failed" });
    expect(listWrites(t.db, session.id).map((w) => [w.purpose, w.outcome])).toEqual([
      ["apply", "rejected"],
      ["undo_start", "ok"],
    ]);
    // The undo wrote back only what the device had changed.
    expect(t.fake.writes[1]).toEqual({
      [WakeSettingKeys.engine]: "vswakeword",
      [WakeSettingKeys.fineTune]: 3,
    });
  });

  test("an unreachable device fails to start without a session or a write", async () => {
    const t = await setup();
    t.fake.faults.offline = true;
    await expect(t.start()).rejects.toMatchObject({ code: "device" });
    expect(t.db.query("SELECT count(*) AS n FROM collection_sessions").get()).toEqual({ n: 0 });
  });

  test("with damaged saved settings writes nothing and asks the user", async () => {
    const t = await setup();
    const session = await t.start();
    t.db
      .query("UPDATE collection_sessions SET snapshot_json = ? WHERE id = ?")
      .run('{"voice.wake_word_fine_tune":-10}', session.id);
    await t.sessions.stopSession(session.id);
    expect(t.session(session.id).state).toBe("needs_attention");
    expect(t.fake.writes).toHaveLength(1);
    expect(boostedDevices(t.db).has(t.id)).toBe(false);
    t.sessions.resolveByHand(session.id);
    expect(t.session(session.id)).toMatchObject({
      state: "ended",
      restored_at: null,
      resolved_by_hand_at: expect.any(String),
    });
  });

  test("ends when collection is paused, and cannot start while paused", async () => {
    const t = await testApi({ fetch: createFakeKiosk({ wakeWords: ["alexa"] }).fetch });
    await t.setUp();
    const add = await t.request("/api/v1/devices", {
      json: { name: "Kitchen", baseUrl: "http://kitchen.test", password: "dev" },
    });
    const deviceId = ((await add.json()) as { id: string }).id;
    const started = await t.request("/api/v1/collection-sessions", {
      json: { deviceId, limitSeconds: 600, note: "wake_word" },
    });
    expect(started.status).toBe(201);
    const id = ((await started.json()) as { id: string }).id;
    await t.request("/api/v1/collection", { method: "PUT", json: { paused: true } });
    await t.sessions.tick();
    const after = (await (await t.request(`/api/v1/collection-sessions/${id}`)).json()) as {
      session: { state: string; endReason: string };
    };
    expect(after.session).toMatchObject({ state: "ended", endReason: "paused" });
    const again = await t.request("/api/v1/collection-sessions", {
      json: { deviceId, limitSeconds: 600 },
    });
    expect(again.status).toBe(409);
  });
});

describe("collection session API", () => {
  async function api(fakeOptions: FakeKioskOptions = {}) {
    const fake = createFakeKiosk({ wakeWords: ["alexa"], ...fakeOptions });
    const t = await testApi({ fetch: fake.fetch });
    await t.setUp();
    const add = await t.request("/api/v1/devices", {
      json: { name: "Kitchen", baseUrl: "http://kitchen.test", password: "dev" },
    });
    return { ...t, fake, deviceId: ((await add.json()) as { id: string }).id };
  }

  test("lists the options, starts, shows the session on the device and keeps the device", async () => {
    const t = await api();
    const options = (await (
      await t.request(`/api/v1/devices/${t.deviceId}/collection-options`)
    ).json()) as { ok: boolean; options: { defaultEngine: string } };
    expect(options).toMatchObject({ ok: true, options: { defaultEngine: "microwakeword" } });

    const started = await t.request("/api/v1/collection-sessions", {
      json: { deviceId: t.deviceId, limitSeconds: 300, note: "not_wake_word" },
    });
    expect(started.status).toBe(201);
    const session = (await started.json()) as { id: string; changes: { toLabel: string }[] };
    expect(session.changes.map((c) => c.toLabel)).toEqual([
      "microWakeWord",
      "Very sensitive",
      "+10",
    ]);
    const devices = (await (await t.request("/api/v1/devices")).json()) as {
      devices: { collectionSession: { id: string; state: string } | null }[];
    };
    expect(devices.devices[0]?.collectionSession).toMatchObject({
      id: session.id,
      state: "running",
    });

    // The device cannot be removed, or moved, until its settings are back.
    const remove = await t.request(`/api/v1/devices/${t.deviceId}`, { method: "DELETE" });
    expect(remove.status).toBe(409);
    const move = await t.request(`/api/v1/devices/${t.deviceId}`, {
      method: "PATCH",
      json: { baseUrl: "http://elsewhere.test" },
    });
    expect(move.status).toBe(409);

    const stopped = await t.request(`/api/v1/collection-sessions/${session.id}/stop`, {
      method: "POST",
    });
    expect(await stopped.json()).toMatchObject({ state: "ended", restoredAt: expect.any(String) });
    expect((await t.request(`/api/v1/devices/${t.deviceId}`, { method: "DELETE" })).status).toBe(
      204,
    );
  });

  test("filters clips by session and shows the session on a clip", async () => {
    const t = await api();
    const started = (await (
      await t.request("/api/v1/collection-sessions", {
        json: { deviceId: t.deviceId, limitSeconds: 300, note: "wake_word" },
      })
    ).json()) as { id: string };
    t.fake.hear();
    await t.collector.pollDevice(t.deviceId);
    const any = (await (await t.request("/api/v1/clips?session=any")).json()) as {
      clips: { id: string; collectionSession: { id: string; note: string } | null }[];
      total: number;
    };
    expect(any.total).toBe(1);
    expect(any.clips[0]?.collectionSession).toMatchObject({ id: started.id, note: "wake_word" });
    const one = (await (await t.request(`/api/v1/clips?session=${started.id}`)).json()) as {
      total: number;
    };
    expect(one.total).toBe(1);
    const all = (await (await t.request("/api/v1/clips")).json()) as { total: number };
    expect(all.total).toBeGreaterThan(1);
  });

  test("a refused start answers 422 and says nothing was changed", async () => {
    const t = await api();
    t.fake.faults.rejectKeys = new Set([WakeSettingKeys.engine]);
    const res = await t.request("/api/v1/collection-sessions", {
      json: { deviceId: t.deviceId, limitSeconds: 300 },
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { message: string }).message).toContain(
      "Nothing was changed on the device",
    );
    expect(t.fake.settings).toMatchObject({ engine: "vsWakeWord", sensitivity: "moderately" });
  });

  test("refuses a time limit outside 30 s to 60 minutes", async () => {
    const t = await api();
    for (const limitSeconds of [29, 3601]) {
      const res = await t.request("/api/v1/collection-sessions", {
        json: { deviceId: t.deviceId, limitSeconds },
      });
      expect(res.status).toBe(400);
    }
    expect(t.fake.writes).toEqual([]);
  });
});
