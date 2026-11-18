import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { createFakeKiosk, type FakeKiosk, type FakeKioskOptions } from "@wakewright/fake-kiosk";
import { endPause, startPause } from "../src/db/collection.ts";
import { getDevice } from "../src/db/devices.ts";
import { type Parts, testParts } from "./helpers.ts";

// The collector against the fake device, in-process: each poll is run by
// hand, so nothing waits on a timer.

const NOW = Date.parse("2026-11-17T12:00:00Z");

async function setup(
  options: { fake?: FakeKiosk; fakeOptions?: FakeKioskOptions; parts?: Partial<Parts> } = {},
) {
  let now = NOW;
  const fake = options.fake ?? createFakeKiosk({ now: () => now, ...options.fakeOptions });
  const parts = await testParts({ fetch: fake.fetch, now: () => now, ...options.parts });
  const id = await parts.devices.create({
    name: "Kitchen",
    source: "kiosk_satellite",
    config: { baseUrl: "http://kitchen.test:2324" },
    password: "dev",
  });
  return {
    ...parts,
    fake,
    id,
    advance(ms: number) {
      now += ms;
    },
    clips: () =>
      parts.db
        .query<{ source_ref: string; capture_reason: string }, []>(
          "SELECT source_ref, capture_reason FROM clips ORDER BY source_ref",
        )
        .all(),
    device: () => getDevice(parts.db, id),
  };
}

describe("collector", () => {
  test("stores every clip once, with its metadata and audio", async () => {
    const t = await setup();
    expect(await t.collector.pollDevice(t.id)).toEqual({ stored: 6, discarded: 0 });
    expect(await t.collector.pollDevice(t.id)).toEqual({ stored: 0, discarded: 0 });
    expect(t.clips().length).toBe(6);
    expect(t.clips().filter((c) => c.capture_reason === "near_miss").length).toBe(2);

    const row = t.db
      .query<{ audio_sha256: string; duration_ms: number; sensitivity_json: string }, []>(
        "SELECT audio_sha256, duration_ms, sensitivity_json FROM clips ORDER BY captured_at DESC LIMIT 1",
      )
      .get();
    expect(row?.duration_ms).toBe(3000);
    expect(JSON.parse(row?.sensitivity_json ?? "{}")).toMatchObject({
      engine: "vsWakeWord",
      sensitivity: "Moderately sensitive",
    });
    expect(await t.blobs.file(row?.audio_sha256 ?? "").exists()).toBe(true);

    const device = t.device();
    expect(device?.last_error_code).toBeNull();
    expect(device?.clips).toBe(6);
    expect(JSON.parse(device?.reported_json ?? "{}")).toMatchObject({ diagnosticsEnabled: true });
  });

  test("keeps the device's settings only for clips recorded close to when they were read", async () => {
    const t = await setup({
      fakeOptions: {
        wakeWords: ["alexa", "alexa"],
        history: { engine: "microWakeWord", count: 3, daysAgo: 10 },
      },
    });
    const settings = () =>
      t.db
        .query<{ engine: string; captured_at: string; sensitivity_json: string | null }, []>(
          "SELECT engine, captured_at, sensitivity_json FROM clips ORDER BY captured_at",
        )
        .all()
        .map((r) => ({
          engine: r.engine,
          minutesBefore: Math.round((NOW - Date.parse(r.captured_at)) / 60_000),
          settings: r.sensitivity_json === null ? null : JSON.parse(r.sensitivity_json),
        }));

    await t.collector.pollDevice(t.id);
    const first = settings();
    // Clips handed over from days ago, and the one recorded six minutes
    // before the settings were read, have unknown settings.
    expect(first.filter((c) => c.settings === null)).toEqual([
      ...first.filter((c) => c.engine === "microWakeWord"),
      { engine: "vsWakeWord", minutesBefore: 6, settings: null },
    ]);
    expect(first.filter((c) => c.engine === "microWakeWord")).toHaveLength(3);
    // The rest have the settings read now, each wake word once.
    expect(first.at(-1)?.settings).toEqual({
      engine: "vsWakeWord",
      wakeWords: ["alexa"],
      sensitivity: "Moderately sensitive",
      fineTune: 0,
    });

    // The user changes a setting a minute later; the next clip is stored
    // with the new value, because new clips make the collector read the
    // settings again.
    t.advance(60_000);
    t.fake.setSettings({ fineTune: 3 });
    t.fake.hear();
    await t.collector.pollDevice(t.id);
    expect(settings().at(-1)?.settings).toMatchObject({ fineTune: 3 });

    // Settings that name another engine than the clip's are not its settings.
    t.advance(60_000);
    t.fake.hear();
    t.fake.setSettings({ engine: "microWakeWord" });
    await t.collector.pollDevice(t.id);
    expect(settings().at(-1)).toMatchObject({ engine: "vsWakeWord", settings: null });
  });

  test("measures the longest run of full-scale samples in each clip", async () => {
    const t = await setup();
    t.fake.hear(); // the fake's seventh clip is loud enough to clip
    await t.collector.pollDevice(t.id);
    const rows = t.db
      .query<{ clipped_samples: number; clipped_longest_run: number }, []>(
        "SELECT clipped_samples, clipped_longest_run FROM clips ORDER BY captured_at",
      )
      .all();
    // The fourth touches full scale at one sample; the seventh clips.
    expect(rows[3]).toEqual({ clipped_samples: 1, clipped_longest_run: 1 });
    expect(rows[6]?.clipped_longest_run).toBeGreaterThanOrEqual(3);
    expect(
      rows.filter((r) => r.clipped_samples === 0).every((r) => r.clipped_longest_run === 0),
    ).toBe(true);
  });

  test("picks up new clips as they arrive and survives the buffer rolling over", async () => {
    const t = await setup();
    await t.collector.pollDevice(t.id);
    for (let i = 0; i < 4; i++) {
      t.advance(1000);
      t.fake.hear();
    }
    t.fake.hear({ nearMiss: true });
    expect((await t.collector.pollDevice(t.id)).stored).toBe(5);
    expect(t.device()?.gaps).toBe(0);

    // Twelve wake words between polls: the device keeps only the last ten.
    for (let i = 0; i < 12; i++) {
      t.advance(1000);
      t.fake.hear();
    }
    expect((await t.collector.pollDevice(t.id)).stored).toBe(10);
    expect(t.device()?.gaps).toBe(1);
    expect(t.clips().length).toBe(21);
  });

  test("a restart in the middle of a download loses nothing and duplicates nothing", async () => {
    const t = await setup();
    t.fake.faults.dropAudio = 1;
    const first = await t.collector.pollDevice(t.id);
    expect(first.error?.code).toBe("unreachable");
    expect(t.clips().length).toBe(0);

    // A new collector on the same data, as after a restart.
    const restarted = await testParts({ db: t.db, dataDir: t.dataDir, fetch: t.fake.fetch });
    expect((await restarted.collector.pollDevice(t.id)).stored).toBe(6);
    expect(t.clips().length).toBe(6);
    expect(readdirSync(restarted.blobs.tmp)).toEqual([]);
  });

  test("skips a clip with invalid audio without holding up the others", async () => {
    const t = await setup();
    const poll = await t.devices
      .connect("kiosk_satellite", { baseUrl: "http://kitchen.test:2324" }, "dev")
      .poll(null);
    const victim = poll.entries[2]?.ref ?? "";
    t.fake.faults.badAudio.add(victim);
    expect((await t.collector.pollDevice(t.id)).stored).toBe(5);
    expect(t.clips().map((c) => c.source_ref)).not.toContain(victim);
    expect(t.device()?.last_error_code).toBeNull();
  });

  test("an offline device is marked failing, then recovers", async () => {
    const t = await setup();
    t.fake.faults.offline = true;
    const outcome = await t.collector.pollDevice(t.id);
    expect(outcome.error?.code).toBe("unreachable");
    await t.collector.pollDevice(t.id);
    expect(t.device()).toMatchObject({ last_error_code: "unreachable", failures: 2 });

    t.fake.faults.offline = false;
    expect((await t.collector.pollDevice(t.id)).stored).toBe(6);
    expect(t.device()).toMatchObject({ last_error_code: null, failures: 0 });
    expect(t.device()?.last_success_at).not.toBeNull();
  });

  test("a wrong stored password is reported as auth_failed", async () => {
    const fake = createFakeKiosk({ password: "changed-on-the-device" });
    const t = await setup({ fake });
    expect((await t.collector.pollDevice(t.id)).error?.code).toBe("auth_failed");
    expect(t.device()?.last_error).toContain("rejected the password");
  });

  test("a device with diagnostics off is healthy but says so", async () => {
    const t = await setup();
    t.fake.setDiagnostics(false);
    expect((await t.collector.pollDevice(t.id)).stored).toBe(0);
    expect(JSON.parse(t.device()?.reported_json ?? "{}")).toMatchObject({
      diagnosticsEnabled: false,
    });
  });

  test("pausing stops polling, and clips from the paused window are never stored", async () => {
    const t = await setup();
    await t.collector.pollDevice(t.id);
    const iso = (ms: number) => new Date(ms).toISOString();

    t.advance(60_000);
    startPause(t.db, { id: "p1", at: iso(NOW + 60_000), userId: null });
    t.advance(1000);
    t.fake.hear(); // said while paused
    expect(await t.collector.pollDevice(t.id)).toEqual({ stored: 0, discarded: 0 });

    t.advance(60_000);
    endPause(t.db, iso(NOW + 121_000));
    t.advance(1000);
    t.fake.hear(); // said after resuming
    expect(await t.collector.pollDevice(t.id)).toEqual({ stored: 1, discarded: 1 });
    expect(t.clips().length).toBe(7);
  });

  test("polls of the same device never overlap", async () => {
    const t = await setup();
    const [a, b] = await Promise.all([t.collector.pollDevice(t.id), t.collector.pollDevice(t.id)]);
    expect(a).toBe(b);
    expect(t.clips().length).toBe(6);
  });

  test("the scheduler polls on start and stops cleanly", async () => {
    const t = await setup();
    t.collector.start();
    for (let i = 0; i < 50 && t.clips().length < 6; i++) await Bun.sleep(10);
    await t.collector.stop();
    expect(t.clips().length).toBe(6);
  });
});
