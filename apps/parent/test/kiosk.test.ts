import { describe, expect, test } from "bun:test";
import { createFakeKiosk } from "@wakewright/fake-kiosk";
import { KioskClient } from "../src/kiosk/client.ts";
import { KIOSK_BUFFER_SIZE, kioskSource, normaliseBaseUrl } from "../src/kiosk/source.ts";
import { SourceError } from "../src/source.ts";

const URL = "http://kitchen.test:2324";
const NOW = Date.parse("2026-11-17T12:00:00Z");

function connect(fake: ReturnType<typeof createFakeKiosk>, password = "dev", timeoutMs = 2000) {
  return kioskSource.connect(
    { config: { baseUrl: URL }, password },
    { fetch: fake.fetch, timeoutMs },
  );
}

async function failure(promise: Promise<unknown>): Promise<SourceError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SourceError) return error;
    throw error;
  }
  throw new Error("expected a SourceError");
}

describe("Kiosk Satellite client", () => {
  test("logs in once with a one-day token and reuses it", async () => {
    const fake = createFakeKiosk();
    const connection = connect(fake);
    await connection.poll(null);
    await connection.poll(null);
    expect(fake.calls.filter((c) => c === "POST /api/login").length).toBe(1);
  });

  test("logs in again when the token has expired", async () => {
    const fake = createFakeKiosk();
    const connection = connect(fake);
    await connection.poll(null);
    fake.expireTokens();
    const result = await connection.poll(null);
    expect(result.entries.length).toBe(6);
    expect(fake.calls.filter((c) => c === "POST /api/login").length).toBe(2);
  });

  test("names each failure", async () => {
    const wrong = await failure(connect(createFakeKiosk(), "wrong").poll(null));
    expect(wrong.code).toBe("auth_failed");

    const offline = createFakeKiosk();
    offline.faults.offline = true;
    expect((await failure(connect(offline).readState())).code).toBe("unreachable");

    const slow = createFakeKiosk();
    slow.faults.slowMs = 300;
    expect((await failure(connect(slow, "dev", 50).poll(null))).code).toBe("timeout");

    const malformed = createFakeKiosk();
    malformed.faults.malformedList = true;
    expect((await failure(connect(malformed).poll(null))).code).toBe("bad_response");

    const notKiosk = new KioskClient(URL, "dev", {
      fetch: (async () => new Response("<html>router login</html>")) as unknown as typeof fetch,
    });
    const html = await failure(notKiosk.health());
    expect(html.code).toBe("bad_response");
    expect(html.message).toContain("Is this a Kiosk Satellite address?");
  });

  test("reports the device rate-limiting logins", async () => {
    const fake = createFakeKiosk();
    for (let i = 0; i < 5; i++) await failure(connect(fake, "wrong").poll(null));
    expect((await failure(connect(fake).poll(null))).code).toBe("rate_limited");
  });

  test("reads the device's state from health and settings", async () => {
    const state = await connect(createFakeKiosk({ name: "kitchen" })).readState();
    expect(state).toEqual({
      name: "kitchen",
      appVersion: "2026.11.23-fake",
      diagnosticsEnabled: true,
      engine: "vsWakeWord",
      wakeWords: ["alexa"],
      sensitivity: "Moderately sensitive",
      fineTune: 0,
      leader: false,
      follows: null,
    });
  });

  test("lists a wake word the device holds in both slots once", async () => {
    const fake = createFakeKiosk({ wakeWords: ["alexa", "alexa"] });
    expect((await connect(fake).readState()).wakeWords).toEqual(["alexa"]);
    fake.setSettings({ wakeWords: ["hey_jarvis", "alexa", "hey_jarvis"] });
    expect((await connect(fake).readState()).wakeWords).toEqual(["hey_jarvis", "alexa"]);
  });

  test("calls only the read surface", async () => {
    const fake = createFakeKiosk();
    const connection = connect(fake);
    await connection.readState();
    const poll = await connection.poll(null);
    const first = poll.entries[0];
    if (!first) throw new Error("no entries");
    await connection.fetchAudio(first);
    expect(new Set(fake.calls)).toEqual(
      new Set([
        "POST /api/login",
        "GET /api/health",
        "GET /api/settings",
        "POST /api/commands/getWakeWordActivations",
        "POST /api/commands/getWakeWordActivationAudio",
      ]),
    );
  });
});

describe("Kiosk Satellite source", () => {
  test("lists both kinds oldest first as clip entries", async () => {
    const poll = await connect(createFakeKiosk({ now: () => NOW })).poll(null);
    expect(poll.diagnosticsEnabled).toBe(true);
    expect(poll.gapDetected).toBe(false);
    const refs = poll.entries.map((e) => Number(e.ref));
    expect(refs).toEqual([...refs].sort((a, b) => a - b));
    expect(poll.entries.filter((e) => e.reason === "near_miss").length).toBe(2);
    expect(poll.entries[0]).toMatchObject({
      capturedAt: new Date(refs[0] ?? 0).toISOString(),
      wakeWord: "alexa",
      engine: "vsWakeWord",
      threshold: 10.5,
      durationMs: 3000,
    });
    expect(poll.entries[0]?.meta).toHaveProperty("decoded");
  });

  test("detects a gap only when a full buffer rolled past the cursor", async () => {
    let now = NOW;
    const fake = createFakeKiosk({ now: () => now, initialClips: 0 });
    const connection = connect(fake);
    const hear = (n: number) => {
      for (let i = 0; i < n; i++) {
        now += 1000;
        fake.hear();
      }
    };
    hear(3);
    let poll = await connection.poll(null);
    expect(poll.gapDetected).toBe(false);
    // Seven more fill the buffer: the oldest is still one already seen.
    hear(7);
    poll = await connection.poll(poll.cursor);
    expect(poll.gapDetected).toBe(false);
    expect(poll.entries.length).toBe(KIOSK_BUFFER_SIZE);
    // Eleven more before the next poll: everything seen has rolled off.
    hear(11);
    poll = await connection.poll(poll.cursor);
    expect(poll.gapDetected).toBe(true);
  });

  test("normalises what a user types as the address", () => {
    expect(normaliseBaseUrl("10.0.0.5")).toBe("http://10.0.0.5:2324");
    expect(normaliseBaseUrl(" portal.lan ")).toBe("http://portal.lan:2324");
    expect(normaliseBaseUrl("portal.lan:8080")).toBe("http://portal.lan:8080");
    expect(normaliseBaseUrl("https://kiosk.example.com/")).toBe("https://kiosk.example.com");
    expect(normaliseBaseUrl("http://10.0.0.5:2324")).toBe("http://10.0.0.5:2324");
    expect(() => normaliseBaseUrl("http://10.0.0.5:2324/api")).toThrow("no path");
    expect(() => normaliseBaseUrl("ftp://x")).toThrow("http://");
    expect(() => normaliseBaseUrl("http://user:pw@x")).toThrow();
  });
});
