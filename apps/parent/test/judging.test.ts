import { describe, expect, test } from "bun:test";
import { createFakeKiosk } from "@wakewright/fake-kiosk";
import { workerOpenApiDocument } from "../src/api/worker.ts";
import { WORKER_OPENAPI_PATH } from "../../../scripts/worker-openapi.ts";
import { LEASE_MS } from "../src/judging.ts";
import { testApi } from "./helpers.ts";

/** Each test worker's token, declared as if by configuration. */
const tokenOf = (name: string) => `test-token-for-${name}-0123456789`;
const TOKEN = tokenOf("w1");
const DECLARED = ["w1", "w2", "w3"].map((name) => ({
  name,
  token: tokenOf(name),
  notes: "",
  enabled: true,
  judges: null,
}));
const START = Date.parse("2026-11-18T12:00:00Z");

const offer = (id: string, version: string, wakeWords: string[] | null, extra = {}) => ({
  id,
  version,
  name: id,
  kind: wakeWords === null ? "speech_to_text" : "wake_word_model",
  wakeWords,
  ...extra,
});
const OWW = offer("openwakeword", "alexa_v0.1+1", ["alexa"]);
const MWW = offer("microwakeword", "v2+1", ["alexa", "okay_nabu"]);
const STT = offer("stt", "tiny+1", null);
const ALL = [OWW, MWW, STT];

type Job = {
  id: string;
  clipId: string;
  wakeWord: string;
  judges: { instance: string; type: string; settings: Record<string, unknown> }[];
};
/** The judge (instance) ids a job asks for. */
const judgeIds = (job: Job | undefined) => job?.judges.map((j) => j.instance);

// A parent with three declared workers (w1, w2, w3) and two fake devices
// collected: the kitchen
// (vsWakeWord, "alexa") and the lounge (microWakeWord, "okay_nabu"), four
// clips each. `clock` moves the parent's time.
async function judged(options: { declared?: typeof DECLARED; realTime?: boolean } = {}) {
  const clock = { now: START };
  const kitchen = createFakeKiosk({ name: "kitchen", initialClips: 4, now: () => START });
  const lounge = createFakeKiosk({
    name: "lounge",
    initialClips: 4,
    seed: 2,
    engine: "microWakeWord",
    now: () => START + 30_000,
  });
  const fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    return (url.hostname === "kitchen.test" ? kitchen : lounge).fetch(input, init);
  }) as typeof globalThis.fetch;
  const t = await testApi({
    fetch,
    now: options.realTime ? undefined : () => clock.now,
    declared: options.declared ?? DECLARED,
  });
  await t.setUp();
  for (const name of ["kitchen", "lounge"]) {
    await t.request("/api/v1/devices", {
      json: { name, baseUrl: `http://${name}.test:2324`, password: "dev" },
    });
  }
  await t.collector.pollAll();

  async function worker(
    path: string,
    init: { json?: unknown; token?: string | null; method?: string } = {},
  ) {
    const headers = new Headers();
    const token = init.token === undefined ? TOKEN : init.token;
    if (token !== null) headers.set("Authorization", `Bearer ${token}`);
    if (init.json !== undefined) headers.set("Content-Type", "application/json");
    return t.api.request(`http://localhost/api/worker/v1${path}`, {
      method: init.method ?? (init.json === undefined ? "GET" : "POST"),
      headers,
      body: init.json === undefined ? undefined : JSON.stringify(init.json),
    });
  }

  async function claim(
    judges: object[] = ALL,
    extra: { max?: number; waitSeconds?: number; name?: string } = {},
  ): Promise<Job[]> {
    const res = await worker("/jobs/claim", {
      token: tokenOf(extra.name ?? "w1"),
      json: {
        protocol: 2,
        worker: { name: `host-of-${extra.name ?? "w1"}`, version: "0.0.3" },
        types: judges,
        max: extra.max ?? 8,
        waitSeconds: extra.waitSeconds ?? 0,
      },
    });
    expect(res.status).toBe(200);
    return (await res.json()).jobs;
  }

  function result(
    judge: { id: string; version: string },
    verdict: string,
    extra: Record<string, unknown> = {},
  ) {
    return {
      instance: (extra.instance as string | undefined) ?? judge.id,
      type: judge.id,
      version: judge.version,
      verdict,
      failure: null,
      score: null,
      threshold: null,
      transcript: null,
      detail: null,
      durationMs: 12,
      ...extra,
    };
  }

  async function answer(job: Job, results: object[], name = "w1") {
    return worker(`/jobs/${job.id}/results`, { json: { results }, token: tokenOf(name) });
  }

  /** A worker's identity, as the worker API's token check gives it. */
  function identity(name: string) {
    const id = t.workers.authenticate(tokenOf(name));
    if (!id) throw new Error(`no worker ${name}`);
    return id;
  }

  async function clips(query = "") {
    return (await (await t.request(`/api/v1/clips?pageSize=100${query}`)).json()) as {
      total: number;
      clips: { id: string; kind: string; judging: Record<string, unknown> }[];
    };
  }

  return { ...t, clock, kitchen, lounge, worker, claim, result, answer, clips, identity };
}

describe("worker API: access", () => {
  test("with no workers, every token is refused", async () => {
    const t = await judged({ declared: [] });
    const res = await t.worker("/jobs/claim", { json: { protocol: 2 } });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "unauthenticated" });
    const status = await (await t.request("/api/v1/judging")).json();
    expect(status).toMatchObject({ workers: [] });
  });

  test("needs the token, and a user session is not enough", async () => {
    const t = await judged();
    const body = { protocol: 2, worker: { name: "w", version: "1" }, types: [STT] };
    for (const token of [null, "wrong-token-of-some-length", `${TOKEN}x`, TOKEN.slice(0, -1)]) {
      const res = await t.worker("/jobs/claim", { json: body, token });
      expect(res.status).toBe(401);
      expect(res.headers.get("WWW-Authenticate")).toContain("Bearer");
    }
    // The browser's session cookie does not open the worker API.
    const res = await t.request("/api/worker/v1/jobs/claim", { json: body });
    expect(res.status).toBe(401);
    expect((await t.worker("/jobs/claim", { json: { ...body, waitSeconds: 0 } })).status).toBe(200);
  });

  test("still needs the token with sign-in turned off", async () => {
    const t = await testApi({ mode: "none", declared: DECLARED });
    const res = await t.api.request("http://localhost/api/worker/v1/jobs/claim", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protocol: 2, worker: { name: "w", version: "1" }, types: [STT] }),
    });
    expect(res.status).toBe(401);
  });

  test("the worker token does not open the user API", async () => {
    const t = await judged();
    const res = await t.api.request("http://localhost/api/v1/clips", {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(401);
  });

  test("an unsupported protocol answers 426 with the supported range", async () => {
    const t = await judged();
    for (const json of [
      // A 0.2 worker: protocol 1, with judges rather than types.
      {
        protocol: 1,
        worker: { name: "w", version: "0.2.0" },
        judges: [{ name: "stt", version: "x", wakeWords: null }],
      },
      { protocol: 0 },
      { protocol: 99, whatever: "a newer shape" },
    ]) {
      const res = await t.worker("/jobs/claim", { json });
      expect(res.status).toBe(426);
      const body = await res.json();
      expect(body).toMatchObject({ error: "unsupported_protocol", supported: { min: 2, max: 2 } });
      expect(body.message).toContain("same release");
    }
    expect((await t.worker("/jobs/claim", { json: { judges: [] } })).status).toBe(400);
  });

  test("rejects a judge offered twice", async () => {
    const t = await judged();
    const res = await t.worker("/jobs/claim", {
      json: { protocol: 2, worker: { name: "w", version: "1" }, types: [STT, STT] },
    });
    expect(res.status).toBe(400);
  });
});

describe("worker API: claims and leases", () => {
  test("hands out clips newest first, with the judges each needs", async () => {
    const t = await judged();
    const jobs = await t.claim(ALL, { max: 32 });
    expect(jobs).toHaveLength(8);
    const { clips } = await t.clips();
    expect(jobs.map((j) => j.clipId)).toEqual(clips.map((c) => c.id));
    for (const job of jobs) {
      // openWakeWord has no model for okay_nabu, so it is not asked.
      expect(judgeIds(job)?.sort()).toEqual(
        job.wakeWord === "alexa"
          ? ["microwakeword", "openwakeword", "stt"]
          : ["microwakeword", "stt"],
      );
      for (const j of job.judges) expect(j.settings).toEqual({});
    }
    const audio = await t.worker(`/clips/${jobs[0]?.clipId}/audio`);
    expect(audio.status).toBe(200);
    expect(audio.headers.get("Content-Type")).toBe("audio/wav");
    expect((await audio.arrayBuffer()).byteLength).toBe(44 + 3 * 16_000 * 2);
    expect((await t.worker("/clips/nope/audio")).status).toBe(404);
  });

  test("a leased clip goes to nobody else until its lease expires", async () => {
    const t = await judged();
    const first = await t.claim(ALL, { max: 3, name: "w1" });
    expect(first).toHaveLength(3);
    const second = await t.claim(ALL, { max: 32, name: "w2" });
    expect(second).toHaveLength(5);
    expect(second.some((j) => first.some((f) => f.clipId === j.clipId))).toBe(false);
    expect(await t.claim(ALL, { name: "w3" })).toEqual([]);

    t.clock.now += LEASE_MS + 1;
    const again = await t.claim(ALL, { max: 32, name: "w3" });
    expect(again).toHaveLength(8);
    // The first worker's results now come too late.
    const late = await t.answer(first[0] as Job, [t.result(STT, "yes")]);
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ error: "lease_expired" });
  });

  test("results end the lease and the clip is not offered again", async () => {
    const t = await judged();
    // The newest clip is the lounge's "okay_nabu"; the second, the kitchen's "alexa".
    const [, job] = (await t.claim(ALL, { max: 2 })) as [Job, Job];
    expect(job.wakeWord).toBe("alexa");
    const ok = await t.answer(job, [
      t.result(OWW, "yes", { score: 0.92, threshold: 0.5 }),
      t.result(MWW, "abstain", { detail: "the model failed to load" }),
      t.result(STT, "yes", { transcript: "alexa" }),
    ]);
    expect(ok.status).toBe(204);
    // A second answer to the same job is stale.
    expect((await t.answer(job, [t.result(STT, "yes")])).status).toBe(409);
    const rest = await t.claim(ALL, { max: 32 });
    expect(rest).toHaveLength(6);
    expect(rest.some((j) => j.clipId === job.clipId)).toBe(false);

    // A new version of one judge needs the clip again, for that judge only.
    t.clock.now += LEASE_MS + 1;
    const newer = await t.claim([OWW, MWW, { ...STT, version: "tiny+2" }], { max: 32 });
    expect(judgeIds(newer.find((j) => j.clipId === job.clipId))).toEqual(["stt"]);
  });

  test("refuses results for a judge the job did not ask for", async () => {
    const t = await judged();
    const [job] = (await t.claim([STT], { max: 1 })) as [Job];
    expect((await t.answer(job, [t.result(OWW, "yes")])).status).toBe(400);
    expect((await t.answer(job, [t.result({ ...STT, version: "other" }, "yes")])).status).toBe(400);
    expect((await t.answer(job, [t.result(STT, "yes"), t.result(STT, "no")])).status).toBe(400);
    expect((await t.answer(job, [t.result(STT, "maybe")])).status).toBe(400);
    // A failure needs its reason, and only a failure may have one.
    expect((await t.answer(job, [t.result(STT, "failed")])).status).toBe(400);
    expect(
      (
        await t.answer(job, [
          t.result(STT, "yes", { failure: { reason: "auth", retryAfterSeconds: null } }),
        ])
      ).status,
    ).toBe(400);
    expect(
      (await t.worker("/jobs/nope/results", { json: { results: [t.result(STT, "yes")] } })).status,
    ).toBe(409);
    expect((await t.answer(job, [t.result(STT, "no")])).status).toBe(204);
  });
});

describe("worker API: long poll", () => {
  test("waits, then answers an empty list", async () => {
    const t = await judged({ realTime: true });
    await t.claim([STT], { max: 32 });
    const started = performance.now();
    expect(await t.claim([STT], { waitSeconds: 0.3, name: "w2" })).toEqual([]);
    expect(performance.now() - started).toBeGreaterThanOrEqual(280);
  });

  test("wakes when a new clip is stored", async () => {
    const t = await judged({ realTime: true });
    await t.claim(ALL, { max: 32 });
    const started = performance.now();
    const waiting = t.claim(ALL, { waitSeconds: 10, name: "w2" });
    await Bun.sleep(50);
    t.kitchen.hear();
    await t.collector.pollAll();
    const jobs = await waiting;
    expect(jobs).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("wakes when a lease expires", async () => {
    const t = await judged({ realTime: true });
    // A short lease: the clip comes back to the second worker.
    const { Judging } = await import("../src/judging.ts");
    const judging = new Judging({
      db: t.db,
      log: (await import("./helpers.ts")).quietLog,
      judges: t.judges,
      leaseMs: 200,
    });
    const request = {
      worker: { name: "host", version: "1" },
      types: [
        { ...STT, kind: "speech_to_text" as const, description: "", external: false, settings: [] },
      ],
      max: 32,
      waitSeconds: 0,
    };
    expect(await judging.claim(t.identity("w1"), request)).toHaveLength(8);
    const started = performance.now();
    const jobs = await judging.claim(t.identity("w2"), { ...request, waitSeconds: 5 });
    expect(jobs).toHaveLength(8);
    expect(performance.now() - started).toBeLessThan(1500);
  });

  test("ends at once when the server stops or the worker goes away", async () => {
    const t = await judged({ realTime: true });
    await t.claim([STT], { max: 32 });
    const controller = new AbortController();
    const request = {
      worker: { name: "host", version: "1" },
      types: [
        { ...STT, kind: "speech_to_text" as const, description: "", external: false, settings: [] },
      ],
      max: 8,
      waitSeconds: 30,
    };
    const w2 = t.identity("w2");
    const started = performance.now();
    const gone = t.judging.claim(w2, request, controller.signal);
    const stopped = t.judging.claim(w2, request);
    await Bun.sleep(20);
    expect(t.judging.status().workers.find((w) => w.name === "w2")?.connected).toBe(true);
    controller.abort();
    expect(await gone).toEqual([]);
    t.judging.close();
    expect(await stopped).toEqual([]);
    expect(performance.now() - started).toBeLessThan(500);
    // After stopping, claims answer at once.
    expect(await t.judging.claim(w2, request)).toEqual([]);
  });
});

describe("weighted outcome", () => {
  // Answers every alexa clip with the verdicts given for openWakeWord,
  // microWakeWord and speech to text, newest clip first (undefined: no result).
  async function answerAll(
    t: Awaited<ReturnType<typeof judged>>,
    plan: (string | undefined)[][],
  ): Promise<[string, string, string, string, ...string[]]> {
    const jobs = await t.claim(ALL, { max: 32 });
    const alexa = jobs.filter((j) => j.wakeWord === "alexa");
    for (const [i, verdicts] of plan.entries()) {
      const job = alexa[i] as Job;
      const results = [OWW, MWW, STT]
        .map((j, k) => (verdicts[k] ? t.result(j, verdicts[k] as string) : undefined))
        .filter(Boolean) as object[];
      expect((await t.answer(job, results)).status).toBe(204);
    }
    return alexa.map((j) => j.clipId) as [string, string, string, string, ...string[]];
  }

  test("weighs each judge's latest vote: speech to text 1.0, the wake word models 0.3", async () => {
    const t = await judged();
    const ids = await answerAll(t, [
      ["yes", "yes", "yes"],
      ["no", "no", "abstain"],
      ["yes", "no", "yes"],
      ["no", "no", "yes"],
    ]);
    const byId = new Map((await t.clips()).clips.map((c) => [c.id, c]));
    const judging = ids.map((id) => byId.get(id)?.judging);
    expect(judging[0]).toMatchObject({ outcome: "yes", score: 1, confidence: 1, yes: 3 });
    // 0.6 of weight voted: less than the minimum of 1.
    expect(judging[1]).toMatchObject({ outcome: "not_enough", yes: 0, no: 2, abstain: 1 });
    // (1.3 - 0.3) / 1.6 = 0.625: yes, with one judge dissenting.
    expect(judging[2]).toMatchObject({ outcome: "yes", dissent: true });
    expect(judging[2]?.score).toBeCloseTo(0.625);
    // (1 - 0.6) / 1.6 = 0.25: under the margin of 0.5.
    expect(judging[3]).toMatchObject({ outcome: "uncertain", dissent: false });
    expect(judging[3]?.score).toBeCloseTo(0.25);
    expect(judging[3]?.confidence).toBeCloseTo(0.625);
    // The lounge's clips have no results yet.
    const lounge = (await t.clips()).clips.filter((c) => !ids.includes(c.id));
    for (const c of lounge) {
      expect(c.judging).toMatchObject({ outcome: "waiting", mismatch: null, score: null });
    }
  });

  test("filters by outcome, dissent and disagreement with the device", async () => {
    const t = await judged();
    const { clips } = await t.clips();
    const kinds = new Map(clips.map((c) => [c.id, c.kind]));
    const ids = await answerAll(t, [
      ["yes", "yes", "yes"],
      ["no", "no", "no"],
      ["yes", "no", "yes"],
      ["no", "no", "yes"],
    ]);
    expect((await t.clips("&outcome=uncertain")).clips.map((c) => c.id)).toEqual([ids[3]]);
    expect((await t.clips("&dissent=1")).clips.map((c) => c.id)).toEqual([ids[2]]);
    expect((await t.clips("&outcome=waiting")).total).toBe(4);

    const falseWake = (await t.clips("&mismatch=false_wake")).clips.map((c) => c.id);
    const missed = (await t.clips("&mismatch=missed_wake")).clips.map((c) => c.id);
    expect(falseWake).toEqual(kinds.get(ids[1]) === "fired" ? [ids[1]] : []);
    expect(missed.sort()).toEqual(
      [ids[0], ids[2]].filter((id) => kinds.get(id) === "near_miss").sort(),
    );

    // A filtered clip steps only through clips under the same filter.
    const one = await (await t.request(`/api/v1/clips/${ids[0]}?outcome=yes`)).json();
    expect([one.newerId, one.olderId]).toContain(ids[2]);
    expect((await t.request("/api/v1/clips?outcome=maybe")).status).toBe(400);

    const status = await (await t.request("/api/v1/judging")).json();
    expect(status).toMatchObject({
      judged: 4,
      yes: 2,
      no: 1,
      uncertain: 1,
      notEnough: 0,
      pending: 4,
      dissent: 1,
      falseWake: falseWake.length,
      missedWake: missed.length,
      waiting: 4,
      rule: { margin: 0.5, minimum: 1 },
    });
    expect(
      status.workers.map((w: { name: string; connected: boolean }) => [w.name, w.connected]),
    ).toEqual([
      ["w1", true],
      ["w2", false],
      ["w3", false],
    ]);
  });

  test("a weight or the rule changes outcomes at once, with nothing judged again", async () => {
    const t = await judged();
    const [id] = await answerAll(t, [["yes", "yes", "no"]]);
    const outcome = async () =>
      (await (await t.request(`/api/v1/clips/${id}`)).json()).clip.judging;
    // (0.6 - 1) / 1.6 = -0.25: uncertain.
    expect((await outcome()).outcome).toBe("uncertain");
    const patch = (json: object) => t.request("/api/v1/judges/stt", { method: "PATCH", json });
    expect((await patch({ weight: 0.2 })).status).toBe(200);
    // 0.8 of weight voted: below the minimum of 1.
    expect((await outcome()).outcome).toBe("not_enough");
    const rule = await t.request("/api/v1/judging/rule", {
      method: "PUT",
      json: { margin: 0.5, minimum: 0.5 },
    });
    expect(rule.status).toBe(200);
    // (0.6 - 0.2) / 0.8 = 0.5: yes, at the margin, with one judge dissenting.
    expect(await outcome()).toMatchObject({ outcome: "yes", dissent: true });
    // Weight 0: shown, not counted.
    expect((await patch({ weight: 0 })).status).toBe(200);
    expect(await outcome()).toMatchObject({ outcome: "yes", dissent: false, score: 1 });
    // Nothing was handed out again for that clip.
    t.clock.now += LEASE_MS + 1;
    const again = await t.claim(ALL, { max: 32 });
    expect(again.some((j) => j.clipId === id)).toBe(false);
    // Turned off, a judge does not count either.
    await t.request("/api/v1/judges/openwakeword", { method: "PATCH", json: { enabled: false } });
    // Only microWakeWord (0.3) is left: below the minimum of 0.5.
    expect(await outcome()).toMatchObject({ outcome: "not_enough", yes: 1 });
  });

  test("a newer version's result replaces the older one in the vote", async () => {
    const t = await judged();
    const [id] = await answerAll(t, [["yes", "yes", "no"]]);
    expect((await t.clips("&outcome=uncertain")).clips.map((c) => c.id)).toEqual([id]);
    t.clock.now += LEASE_MS + 1;
    const stt2 = { ...STT, version: "tiny+2" };
    const job = (await t.claim([OWW, MWW, stt2], { max: 32 })).find((j) => j.clipId === id) as Job;
    // While it waits for the new version, the old vote still counts, provisionally.
    const waiting = await (await t.request(`/api/v1/clips/${id}`)).json();
    expect(waiting.clip.judging).toMatchObject({ outcome: "waiting", provisional: "uncertain" });
    expect(waiting.judges.pending).toMatchObject([{ judgeId: "stt", reason: "rejudging" }]);
    expect((await t.answer(job, [t.result(stt2, "yes", { transcript: "alexa" })])).status).toBe(
      204,
    );
    const clip = await (await t.request(`/api/v1/clips/${id}`)).json();
    expect(clip.clip.judging).toMatchObject({ outcome: "yes", yes: 3, confidence: 1 });
    expect(clip.judges.results.find((r: { judgeId: string }) => r.judgeId === "stt")).toMatchObject(
      {
        name: "Speech to text",
        weight: 1,
        status: "counted",
        current: true,
        version: "tiny+2",
        verdict: "yes",
        transcript: "alexa",
        worker: "w1",
      },
    );
  });

  test("the clip page lists judges that have not answered, and why", async () => {
    const t = await judged();
    await t.claim(ALL, { max: 32 });
    const { clips } = await t.clips();
    const lounge = clips.find((c) => c.judging.outcome === "waiting") as { id: string };
    const detail = await (await t.request(`/api/v1/clips/${lounge.id}`)).json();
    expect(detail.judges.results).toEqual([]);
    const pending = Object.fromEntries(
      detail.judges.pending.map((p: { judgeId: string; reason: string }) => [p.judgeId, p.reason]),
    );
    expect(detail.clip.wakeWord).toBe("okay_nabu");
    expect(pending).toEqual({ microwakeword: "waiting", openwakeword: "no_model", stt: "waiting" });
  });

  test("Home counts clips waiting for the judges recent workers offer", async () => {
    const t = await judged();
    // No worker has connected yet: every unjudged clip waits.
    const before = await (await t.request("/api/v1/judging")).json();
    expect(before.waiting).toBe(8);
    expect(before.workers.some((w: { connected: boolean }) => w.connected)).toBe(false);
    await t.claim([OWW], { max: 1 });
    // openWakeWord covers only the kitchen's four "alexa" clips.
    expect((await (await t.request("/api/v1/judging")).json()).waiting).toBe(4);
    t.clock.now += 3 * 60_000;
    expect((await (await t.request("/api/v1/judging")).json()).workers[0]).toMatchObject({
      name: "w1",
      connected: false,
      reported: {
        name: "host-of-w1",
        version: "0.0.3",
        types: [{ id: OWW.id, version: OWW.version, wakeWords: OWW.wakeWords }],
      },
    });
  });
});

test("the committed worker OpenAPI document is up to date (mise run openapi)", async () => {
  const committed = await Bun.file(WORKER_OPENAPI_PATH).json();
  expect(committed).toEqual(JSON.parse(JSON.stringify(workerOpenApiDocument())));
});
