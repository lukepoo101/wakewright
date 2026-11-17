import { describe, expect, test } from "bun:test";
import {
  ActivationAudioData,
  ActivationsData,
  commandResult,
  Health,
  LoginResponse,
} from "@wakewright/parent/kiosk/shapes";
import { createFakeKiosk } from "../src/server.ts";
import { CLIP_SECONDS, SAMPLE_RATE } from "../src/synth.ts";

const NOW = Date.parse("2026-11-17T12:00:00Z");

async function login(app: ReturnType<typeof createFakeKiosk>) {
  const res = await app.request("/api/login", {
    method: "POST",
    body: JSON.stringify({ password: "dev" }),
  });
  expect(res.status).toBe(200);
  return LoginResponse.parse(await res.json()).token;
}

function command(
  app: ReturnType<typeof createFakeKiosk>,
  token: string,
  name: string,
  body?: unknown,
) {
  return app.request(`/api/commands/${name}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("fake Kiosk Satellite", () => {
  test("rejects a wrong password", async () => {
    const app = createFakeKiosk();
    const res = await app.request("/api/login", {
      method: "POST",
      body: JSON.stringify({ password: "x" }),
    });
    expect(res.status).toBe(401);
  });

  test("health needs no token and matches the shape", async () => {
    const res = await createFakeKiosk({ name: "kitchen" }).request("/api/health");
    expect(Health.parse(await res.json())).toMatchObject({
      name: "kitchen",
      leader: false,
      follows: null,
    });
  });

  test("commands need a token", async () => {
    const res = await command(createFakeKiosk(), "wrong", "getWakeWordActivations");
    expect(res.status).toBe(401);
  });

  test("lists activations and near misses, newest first, in the device's shape", async () => {
    const app = createFakeKiosk({ now: () => NOW });
    const res = await command(app, await login(app), "getWakeWordActivations");
    const body = commandResult(ActivationsData).parse(await res.json());
    if (!body.ok) throw new Error(body.error);
    expect(body.data.activations.length).toBe(4);
    expect(body.data.nearMisses.length).toBe(2);
    expect(body.data.nearMisses.every((a) => a.nearMiss === true)).toBe(true);
    const ids = body.data.activations.map((a) => Number(a.id));
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(ids[0]).toBeLessThan(NOW);
  });

  test("serves each clip as a 3 s, 16 kHz mono PCM16 WAV", async () => {
    const app = createFakeKiosk({ now: () => NOW });
    const token = await login(app);
    const list = commandResult(ActivationsData).parse(
      await (await command(app, token, "getWakeWordActivations")).json(),
    );
    if (!list.ok) throw new Error(list.error);
    for (const entry of [...list.data.activations, ...list.data.nearMisses]) {
      const res = await command(app, token, "getWakeWordActivationAudio", { id: entry.id });
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
    const app = createFakeKiosk();
    const res = await command(app, await login(app), "getWakeWordActivationAudio", { id: "1" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "no such clip" });
  });

  test("anything outside the read surface fails, writes included", async () => {
    const app = createFakeKiosk();
    const token = await login(app);
    expect((await command(app, token, "stageCustomWakeModel", {})).status).toBe(404);
    const patch = await app.request("/api/settings", {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}` },
      body: "{}",
    });
    expect(patch.status).toBe(404);
  });
});
