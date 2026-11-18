import { expect, test } from "bun:test";
import { createFakeKiosk } from "@wakewright/fake-kiosk";
import { testApi } from "../../../apps/parent/test/helpers.ts";
import { fakeCase, fakeVerdicts, runFakeWorker } from "../src/worker.ts";

const TOKEN = "fake-worker-test-token";

test("verdicts follow the clip's case and the judges asked for", async () => {
  const audio = new Uint8Array([1, 2, 3]);
  const results = await fakeVerdicts(audio, "alexa", ["stt", "openwakeword"]);
  expect(results.map((r) => r.judge)).toEqual(["stt", "openwakeword"]);
  expect(await fakeVerdicts(audio, "alexa", ["stt"])).toEqual(results.slice(0, 1));
  expect(await fakeCase(audio)).toBe(await fakeCase(audio.slice()));
});

test("judges every clip of a served parent through the worker protocol", async () => {
  const kiosk = createFakeKiosk({ name: "kitchen", initialClips: 10, seed: 1 });
  const t = await testApi({ fetch: kiosk.fetch, workerToken: TOKEN });
  await t.setUp();
  await t.request("/api/v1/devices", {
    json: { name: "kitchen", baseUrl: "http://kitchen.test:2324", password: "dev" },
  });
  await t.collector.pollAll();
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: t.api.fetch });
  const controller = new AbortController();
  const running = runFakeWorker({
    parentUrl: server.url.href,
    token: TOKEN,
    waitSeconds: 1,
    signal: controller.signal,
  });
  try {
    for (let i = 0; i < 100; i++) {
      const status = await (await t.request("/api/v1/judging")).json();
      if (status.judged === 10 && status.waiting === 0) break;
      await Bun.sleep(50);
    }
    const { clips } = await (await t.request("/api/v1/clips?pageSize=100")).json();
    const states = new Set(
      clips.map((c: { judging: { agreement: string } }) => c.judging.agreement),
    );
    expect(states.has("waiting")).toBe(false);
    for (const state of ["agree_yes", "agree_no", "disagree", "inconclusive"]) {
      expect(states.has(state)).toBe(true);
    }
  } finally {
    controller.abort();
    t.judging.close();
    await running;
    await server.stop(true);
  }
});
