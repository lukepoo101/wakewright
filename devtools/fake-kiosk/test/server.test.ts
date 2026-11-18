import { describe, expect, test } from "bun:test";
import {
  ActivationAudioData,
  ActivationsData,
  commandResult,
  Health,
  LoginResponse,
  SettingsPatchResponse,
  SettingsResponse,
  WakeSettingKeys,
} from "@wakewright/parent/kiosk/shapes";
import { BUFFER_SIZE, createFakeKiosk, type FakeKiosk } from "../src/server.ts";
import { CLIP_SECONDS, SAMPLE_RATE } from "../src/synth.ts";

const NOW = Date.parse("2026-11-17T12:00:00Z");

async function login(fake: FakeKiosk, body: object = { password: "dev" }) {
  const res = await fake.app.request("/api/login", { method: "POST", body: JSON.stringify(body) });
  expect(res.status).toBe(200);
  return LoginResponse.parse(await res.json()).token;
}

function command(fake: FakeKiosk, token: string, name: string, body?: unknown) {
  return fake.app.request(`/api/commands/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function list(fake: FakeKiosk, token: string) {
  const body = commandResult(ActivationsData).parse(
    await (await command(fake, token, "getWakeWordActivations")).json(),
  );
  if (!body.ok) throw new Error(body.error);
  return body.data;
}

describe("fake Kiosk Satellite", () => {
  test("rejects a wrong password, then throttles logins like the device", async () => {
    const fake = createFakeKiosk();
    const wrong = () =>
      fake.app.request("/api/login", { method: "POST", body: JSON.stringify({ password: "x" }) });
    for (let i = 0; i < 4; i++) expect((await wrong()).status).toBe(401);
    expect((await wrong()).status).toBe(401);
    expect((await wrong()).status).toBe(429);
  });

  test("scores use the engine's scale, some well over the threshold", async () => {
    const vs = createFakeKiosk({ now: () => NOW, initialClips: 10 });
    const vsData = await list(vs, await login(vs));
    const vsClips = [...vsData.activations, ...vsData.nearMisses];
    expect(vsClips.every((a) => a.engine === "vsWakeWord" && a.threshold === 10.5)).toBe(true);
    for (const a of vsData.activations) expect(a.score).toBeGreaterThanOrEqual(10.5);
    for (const a of vsData.nearMisses) expect(a.score).toBeLessThan(10.5);
    expect(vsData.activations.some((a) => (a.score ?? 0) > 2 * 10.5)).toBe(true);

    const micro = createFakeKiosk({ now: () => NOW, engine: "microWakeWord" });
    const microData = await list(micro, await login(micro));
    for (const a of [...microData.activations, ...microData.nearMisses]) {
      expect(a.engine).toBe("microWakeWord");
      expect(a.score).toBeLessThanOrEqual(1);
    }
  });

  test("health needs no token and matches the shape", async () => {
    const res = await createFakeKiosk({ name: "kitchen" }).app.request("/api/health");
    expect(Health.parse(await res.json())).toMatchObject({
      name: "kitchen",
      leader: false,
      follows: null,
    });
  });

  test("commands need a token, and tokens expire", async () => {
    let now = NOW;
    const fake = createFakeKiosk({ now: () => now });
    expect((await command(fake, "wrong", "getWakeWordActivations")).status).toBe(401);
    const token = await login(fake, { password: "dev", ttl_days: 1 });
    expect((await command(fake, token, "getWakeWordActivations")).status).toBe(200);
    now += 86_400_000;
    expect((await command(fake, token, "getWakeWordActivations")).status).toBe(401);
    const fresh = await login(fake);
    fake.expireTokens();
    expect((await command(fake, fresh, "getWakeWordActivations")).status).toBe(401);
  });

  test("lists activations and near misses, newest first, in the device's shape", async () => {
    const fake = createFakeKiosk({ now: () => NOW });
    const data = await list(fake, await login(fake));
    expect(data.activations.length).toBe(4);
    expect(data.nearMisses.length).toBe(2);
    expect(data.nearMisses.every((a) => a.nearMiss === true)).toBe(true);
    const ids = data.activations.map((a) => Number(a.id));
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(ids[0]).toBeLessThan(NOW);
  });

  test("keeps the last 10 of each kind: older entries roll off", async () => {
    let now = NOW;
    const fake = createFakeKiosk({ now: () => now, initialClips: 0 });
    const heard = [];
    for (let i = 0; i < 13; i++) {
      now += 1000;
      heard.push(fake.hear());
    }
    fake.hear({ nearMiss: true });
    const data = await list(fake, await login(fake));
    expect(data.activations.length).toBe(BUFFER_SIZE);
    expect(data.activations.map((a) => a.id)).toEqual(
      heard
        .slice(-BUFFER_SIZE)
        .reverse()
        .map((a) => a.id),
    );
    expect(data.nearMisses.length).toBe(1);
  });

  test("with diagnostics off, nothing is kept and settings say so", async () => {
    const fake = createFakeKiosk();
    const token = await login(fake);
    fake.setDiagnostics(false);
    fake.hear();
    expect(await list(fake, token)).toEqual({ enabled: false, activations: [], nearMisses: [] });
    const res = await fake.app.request("/api/settings", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const { settings } = SettingsResponse.parse(await res.json());
    expect(settings.find((s) => s.key === WakeSettingKeys.diagnostics)?.value).toBe(false);
  });

  test("hands over older clips from an earlier engine, and settings can change", async () => {
    const fake = createFakeKiosk({
      now: () => NOW,
      wakeWords: ["alexa", "alexa"],
      history: { engine: "microWakeWord", count: 3, daysAgo: 9 },
    });
    const token = await login(fake);
    const data = await list(fake, token);
    const all = [...data.activations, ...data.nearMisses];
    const old = all.filter((a) => a.engine === "microWakeWord");
    expect(old).toHaveLength(3);
    for (const a of old) {
      expect(Date.parse(a.at)).toBeLessThanOrEqual(NOW - 9 * 86_400_000);
      expect(a.threshold).toBe(0.6);
    }
    expect(all.filter((a) => a.engine === "vsWakeWord")).toHaveLength(6);

    const setting = async (key: string) => {
      const res = await fake.app.request("/api/settings", {
        headers: { Authorization: `Bearer ${token}` },
      });
      return SettingsResponse.parse(await res.json()).settings.find((s) => s.key === key)?.value;
    };
    expect(await setting(WakeSettingKeys.wakeWords)).toBe('["alexa","alexa"]');
    fake.setSettings({ engine: "microWakeWord", fineTune: 3 });
    expect(await setting(WakeSettingKeys.engine)).toBe("microwakeword");
    expect(await setting(WakeSettingKeys.fineTune)).toBe(3);
    expect(fake.hear().engine).toBe("microWakeWord");
  });

  test("makes some clips touch full scale at one sample and some clip", async () => {
    const fake = createFakeKiosk({ now: () => NOW, initialClips: 7 });
    const all = await list(fake, await login(fake));
    const clipped = [...all.activations, ...all.nearMisses]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((a) => a.clipped);
    expect(clipped[3]).toBe(1);
    expect(clipped[6]).toBeGreaterThan(3);
  });

  test("serves each clip as a 3 s, 16 kHz mono PCM16 WAV", async () => {
    const fake = createFakeKiosk({ now: () => NOW });
    const token = await login(fake);
    const data = await list(fake, token);
    for (const entry of [...data.activations, ...data.nearMisses]) {
      const res = await command(fake, token, "getWakeWordActivationAudio", { id: entry.id });
      const body = commandResult(ActivationAudioData).parse(await res.json());
      if (!body.ok) throw new Error(body.error);
      const wav = Uint8Array.fromBase64(body.data.base64);
      const v = new DataView(wav.buffer);
      const text = (at: number) => new TextDecoder().decode(wav.subarray(at, at + 4));
      expect([text(0), text(8), text(12), text(36)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
      expect(v.getUint16(20, true)).toBe(1); // PCM
      expect(v.getUint16(22, true)).toBe(1); // mono
      expect(v.getUint32(24, true)).toBe(SAMPLE_RATE);
      expect(v.getUint16(34, true)).toBe(16);
      expect(v.getUint32(40, true)).toBe(SAMPLE_RATE * CLIP_SECONDS * 2);
    }
  });

  test("an unknown clip id is a command failure", async () => {
    const fake = createFakeKiosk();
    const res = await command(fake, await login(fake), "getWakeWordActivationAudio", { id: "1" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "no such clip" });
  });

  test("commands outside the read surface fail", async () => {
    const fake = createFakeKiosk();
    const token = await login(fake);
    expect((await command(fake, token, "stageCustomWakeModel", {})).status).toBe(404);
    expect((await command(fake, token, "setWakeWordActive", { active: false })).status).toBe(404);
  });

  describe("settings writes", () => {
    const patch = (fake: FakeKiosk, token: string | undefined, body: unknown) =>
      fake.app.request("/api/settings", {
        method: "PATCH",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: JSON.stringify(body),
      });
    const values = async (fake: FakeKiosk, token: string) => {
      const res = await fake.app.request("/api/settings", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const list = SettingsResponse.parse(await res.json()).settings;
      return Object.fromEntries(list.map((s) => [s.key, s.value]));
    };

    test("need a token", async () => {
      expect((await patch(createFakeKiosk(), undefined, {})).status).toBe(401);
    });

    test("change the wake word settings, which the settings and later clips report", async () => {
      const fake = createFakeKiosk({ now: () => NOW, wakeWords: ["alexa"] });
      const token = await login(fake);
      const res = await patch(fake, token, {
        [WakeSettingKeys.engine]: "microwakeword",
        [WakeSettingKeys.sensitivity]: "very",
        [WakeSettingKeys.fineTune]: 10,
      });
      expect(SettingsPatchResponse.parse(await res.json())).toEqual({
        ok: true,
        rejected: [],
        errors: {},
      });
      expect(await values(fake, token)).toMatchObject({
        [WakeSettingKeys.engine]: "microwakeword",
        [WakeSettingKeys.sensitivity]: "very",
        [WakeSettingKeys.fineTune]: 10,
        [WakeSettingKeys.wakeWords]: '["alexa"]',
      });
      const heard = fake.hear();
      expect(heard).toMatchObject({ engine: "microWakeWord", wakeWord: "alexa" });
      expect(fake.writes).toHaveLength(1);
    });

    test("refuse bad values and other keys key by key, applying the rest", async () => {
      const fake = createFakeKiosk();
      const token = await login(fake);
      const res = await patch(fake, token, {
        [WakeSettingKeys.engine]: "pryon",
        [WakeSettingKeys.fineTune]: 11,
        [WakeSettingKeys.sensitivity]: "very",
        "screen.brightness": 10,
      });
      const body = SettingsPatchResponse.parse(await res.json());
      expect(body.ok).toBe(false);
      expect(body.rejected.sort()).toEqual(
        [WakeSettingKeys.engine, WakeSettingKeys.fineTune, "screen.brightness"].sort(),
      );
      expect(fake.settings).toMatchObject({
        engine: "vsWakeWord",
        sensitivity: "very",
        fineTune: 0,
      });
    });

    test("can be refused by a fault, or the device can be down", async () => {
      const fake = createFakeKiosk();
      const token = await login(fake);
      fake.faults.rejectKeys = new Set([WakeSettingKeys.sensitivity]);
      const body = SettingsPatchResponse.parse(
        await (await patch(fake, token, { [WakeSettingKeys.sensitivity]: "very" })).json(),
      );
      expect(body.rejected).toEqual([WakeSettingKeys.sensitivity]);
      expect(fake.settings.sensitivity).toBe("moderately");
      fake.faults.down = true;
      expect((await patch(fake, token, {})).status).toBe(503);
    });
  });

  test("the in-process fetch can be taken offline", async () => {
    const fake = createFakeKiosk();
    fake.faults.offline = true;
    expect(fake.fetch("http://fake/api/health")).rejects.toThrow(TypeError);
  });
});
