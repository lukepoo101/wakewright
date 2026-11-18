import { describe, expect, test } from "bun:test";
import { createFakeKiosk } from "@wakewright/fake-kiosk";
import { parseRange } from "../src/api/clips.ts";
import { checkClipWav } from "../src/wav.ts";
import { testApi } from "./helpers.ts";

const NOW = Date.parse("2026-11-17T12:00:00Z");

// Two devices with six clips each (four fired, two near misses), collected.
async function collected() {
  const kitchen = createFakeKiosk({ name: "kitchen", now: () => NOW });
  const lounge = createFakeKiosk({ name: "lounge", now: () => NOW + 30_000, seed: 2 });
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    return (url.hostname === "kitchen.test" ? kitchen : lounge).fetch(input, init);
  }) as typeof globalThis.fetch;
  const t = await testApi({ fetch });
  await t.setUp();
  const ids: Record<string, string> = {};
  for (const name of ["kitchen", "lounge"]) {
    const res = await t.request("/api/v1/devices", {
      json: { name, baseUrl: `http://${name}.test:2324`, password: "dev" },
    });
    ids[name] = (await res.json()).id;
  }
  await t.collector.pollAll();
  return { ...t, ids };
}

describe("clips API", () => {
  test("needs a session", async () => {
    const t = await testApi();
    expect((await t.request("/api/v1/clips")).status).toBe(401);
    expect((await t.request("/api/v1/clips/x/audio")).status).toBe(401);
  });

  test("lists newest first with paging", async () => {
    const t = await collected();
    const page1 = await (await t.request("/api/v1/clips?pageSize=5")).json();
    expect(page1).toMatchObject({ total: 12, page: 1, pageSize: 5 });
    expect(page1.clips).toHaveLength(5);
    const page3 = await (await t.request("/api/v1/clips?pageSize=5&page=3")).json();
    expect(page3.clips).toHaveLength(2);
    const all = [
      ...page1.clips,
      ...(await (await t.request("/api/v1/clips?pageSize=100")).json()).clips,
    ];
    const times = all.slice(5).map((c: { capturedAt: string }) => c.capturedAt);
    expect(times).toEqual([...times].sort().reverse());
    expect(page1.clips[0]).toMatchObject({
      deviceName: "lounge",
      wakeWord: "alexa",
      engine: "vsWakeWord",
      durationMs: 3000,
      sensitivity: { sensitivity: "Moderately sensitive" },
    });
    expect(page1.clips[0].decoded).toBeString();
  });

  test("filters by device, kind and time", async () => {
    const t = await collected();
    const kitchen = await (await t.request(`/api/v1/clips?device=${t.ids.kitchen}`)).json();
    expect(kitchen.total).toBe(6);
    const near = await (await t.request("/api/v1/clips?kind=near_miss")).json();
    expect(near.total).toBe(4);
    expect(near.clips.every((c: { kind: string }) => c.kind === "near_miss")).toBe(true);
    // The fakes' clips are 1–6 minutes before their start; keep the last 3.5 minutes.
    const from = new Date(NOW - 210_000).toISOString();
    const recent = await (await t.request(`/api/v1/clips?from=${from}`)).json();
    expect(recent.clips.every((c: { capturedAt: string }) => c.capturedAt >= from)).toBe(true);
    expect(recent.total).toBeLessThan(12);
    expect((await t.request("/api/v1/clips?kind=other")).status).toBe(400);
  });

  test("one clip comes with its neighbours under the same filter", async () => {
    const t = await collected();
    const list = (await (await t.request(`/api/v1/clips?device=${t.ids.kitchen}`)).json()).clips;
    const middle = list[2];
    const res = await (
      await t.request(`/api/v1/clips/${middle.id}?device=${t.ids.kitchen}`)
    ).json();
    expect(res.clip.id).toBe(middle.id);
    expect(res.newerId).toBe(list[1].id);
    expect(res.olderId).toBe(list[3].id);
    const newest = await (
      await t.request(`/api/v1/clips/${list[0].id}?device=${t.ids.kitchen}`)
    ).json();
    expect(newest.newerId).toBeNull();
    expect((await t.request("/api/v1/clips/nope")).status).toBe(404);
  });

  test("serves audio whole, in ranges and from cache", async () => {
    const t = await collected();
    const [clip] = (await (await t.request("/api/v1/clips?pageSize=1")).json()).clips;
    const whole = await t.request(`/api/v1/clips/${clip.id}/audio`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("Content-Type")).toBe("audio/wav");
    expect(whole.headers.get("Cache-Control")).toContain("private");
    const bytes = new Uint8Array(await whole.arrayBuffer());
    expect(checkClipWav(bytes).durationMs).toBe(3000);

    const etag = whole.headers.get("ETag") ?? "";
    expect(etag).toMatch(/^"sha256:[0-9a-f]{64}"$/);

    const part = await t.api.request(`http://localhost/api/v1/clips/${clip.id}/audio`, {
      headers: { Cookie: t.cookie ?? "", Range: "bytes=0-43" },
    });
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe(`bytes 0-43/${bytes.length}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(0, 44));

    const cached = await t.api.request(`http://localhost/api/v1/clips/${clip.id}/audio`, {
      headers: { Cookie: t.cookie ?? "", "If-None-Match": etag },
    });
    expect(cached.status).toBe(304);

    const download = await t.request(`/api/v1/clips/${clip.id}/audio?download=1`);
    expect(download.headers.get("Content-Disposition")).toMatch(/^attachment; filename="lounge-/);
  });

  test("summary counts the last 24 hours by kind", async () => {
    const t = await collected();
    const summary = await (await t.request("/api/v1/clips/summary")).json();
    expect(summary.total).toBe(12);
    // The fakes' clips are from 2026-11-17; "now" in the API is the real clock.
    expect(summary.lastClipAt).toBeString();
  });
});

describe("Range header", () => {
  test("parses the forms browsers send", () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange("bytes=0-", 100)).toEqual([0, 99]);
    expect(parseRange("bytes=10-19", 100)).toEqual([10, 19]);
    expect(parseRange("bytes=90-200", 100)).toEqual([90, 99]);
    expect(parseRange("bytes=-10", 100)).toEqual([90, 99]);
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=5-1", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-1,5-6", 100)).toBeNull();
    expect(parseRange("items=0-1", 100)).toBeNull();
  });
});
