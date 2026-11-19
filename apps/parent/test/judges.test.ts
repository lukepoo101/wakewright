import { describe, expect, test } from "bun:test";
import { createFakeKiosk } from "@wakewright/fake-kiosk";
import { listClips } from "../src/db/clips.ts";
import { checkSettings, fingerprint, type SettingField } from "../src/judge-settings.ts";
import { LEASE_MS, retryDelayMs } from "../src/judging.ts";
import { createLogger } from "../src/log.ts";
import { confidence, DEFAULT_RULE, dissent, type Vote, weigh } from "../src/outcome.ts";
import { testApi } from "./helpers.ts";

// Judges as configured instances of advertised types (ADR 0019): the
// weighted outcome, settings checked against a type's schema, what judges
// a clip again and what does not, secrets, daily limits, failures and
// backoff, test runs and deleting.

const START = Date.parse("2026-11-18T12:00:00Z");
const tokenOf = (name: string) => `judges-test-token-of-${name}-0123456789`;
const field = (f: Partial<SettingField> & Pick<SettingField, "key" | "type">): SettingField => ({
  label: f.key,
  help: "",
  default: null,
  required: false,
  options: [],
  minimum: null,
  maximum: null,
  placeholder: "",
  affectsVerdict: f.type !== "secret",
  ...f,
});
const CLOUD_SETTINGS = [
  field({ key: "base_url", type: "text", required: true }),
  field({ key: "api_key", type: "secret", label: "API key" }),
  field({ key: "model", type: "text", required: true, label: "Model" }),
  field({
    key: "timeout",
    type: "number",
    default: 30,
    minimum: 1,
    maximum: 120,
    affectsVerdict: false,
  }),
];
const STT = {
  id: "stt",
  version: "parakeet+1",
  name: "Parakeet",
  kind: "speech_to_text",
  wakeWords: null,
};
const CLOUD = {
  id: "openai-compatible",
  version: "openai-compatible+1",
  name: "OpenAI-compatible transcription",
  kind: "speech_to_text",
  external: true,
  wakeWords: null,
  settings: CLOUD_SETTINGS,
};
const LISTENING = {
  id: "audio-question",
  version: "audio-question+1.abcd1234",
  name: "Audio question",
  kind: "listening",
  external: true,
  wakeWords: null,
  settings: [
    field({ key: "base_url", type: "text", required: true }),
    field({ key: "model", type: "text", required: true, label: "Model" }),
    field({ key: "prompt", type: "long_text", placeholder: `Does it say "{wake_word}"?\n...` }),
  ],
};
const SECRET = "sk-a-real-looking-secret-0123456789";

type Job = {
  id: string;
  clipId: string;
  judges: { instance: string; type: string; settings: Record<string, unknown> }[];
};

describe("the weighted outcome", () => {
  const v = (verdict: Vote["verdict"], weight: number): Vote => ({ verdict, weight });

  test("score, margin and minimum", () => {
    expect(weigh([v("yes", 1), v("yes", 0.3), v("yes", 0.3)], DEFAULT_RULE)).toMatchObject({
      outcome: "yes",
      score: 1,
    });
    expect(weigh([v("yes", 1), v("no", 0.3), v("no", 0.3)], DEFAULT_RULE).outcome).toBe(
      "uncertain",
    );
    expect(weigh([v("no", 1), v("yes", 0.3)], DEFAULT_RULE).outcome).toBe("no");
    // Two wake word models alone are not enough evidence.
    expect(weigh([v("yes", 0.3), v("yes", 0.3)], DEFAULT_RULE).outcome).toBe("not_enough");
    // Float sums reach the minimum: 0.3 + 0.3 + 0.4 = 0.9999999999999999.
    expect(weigh([v("yes", 0.3), v("yes", 0.3), v("yes", 0.4)], DEFAULT_RULE).outcome).toBe("yes");
    // Exactly at the margin is called.
    expect(weigh([v("yes", 3), v("no", 1)], DEFAULT_RULE).outcome).toBe("yes");
  });

  test("abstentions and zero weights do not vote", () => {
    expect(weigh([v("abstain", 1), v("yes", 0.3)], DEFAULT_RULE)).toMatchObject({
      outcome: "not_enough",
      score: 1,
    });
    // Only weight-0 judges answered: as if nobody had.
    expect(weigh([v("yes", 0), v("no", 0)], DEFAULT_RULE)).toMatchObject({
      outcome: "waiting",
      score: null,
      provisional: null,
    });
    expect(weigh([], DEFAULT_RULE).outcome).toBe("waiting");
    expect(weigh([v("abstain", 1)], DEFAULT_RULE)).toMatchObject({
      outcome: "not_enough",
      score: null,
    });
    // A minimum of 0 still needs a vote.
    expect(weigh([v("abstain", 1)], { margin: 0.5, minimum: 0 }).outcome).toBe("not_enough");
  });

  test("waiting keeps a provisional outcome, confidence and dissent", () => {
    const w = weigh([v("yes", 1), v("no", 0.3)], DEFAULT_RULE, true);
    expect(w).toMatchObject({ outcome: "waiting", provisional: "yes" });
    expect(dissent(w)).toBe(true);
    expect(confidence(w)).toBeCloseTo(1 / 1.3);
    expect(confidence(weigh([v("abstain", 1)], DEFAULT_RULE))).toBeNull();
    // margin 0: any lean is called; margin 1: only unanimity.
    expect(weigh([v("yes", 1), v("no", 0.9)], { margin: 0, minimum: 0 }).outcome).toBe("yes");
    expect(weigh([v("yes", 1), v("no", 0.01)], { margin: 1, minimum: 0 }).outcome).toBe(
      "uncertain",
    );
  });
});

describe("settings against a type's schema", () => {
  test("defaults, required fields, types, ranges and unknown keys", () => {
    const ok = checkSettings(CLOUD_SETTINGS, {
      base_url: " https://x/v1 ",
      model: "m",
      api_key: "k",
    });
    expect(ok).toEqual({
      ok: true,
      values: { base_url: "https://x/v1", model: "m", timeout: 30 },
      secrets: { api_key: "k" },
    });
    const bad = checkSettings(CLOUD_SETTINGS, { model: 3, timeout: 500, colour: "red" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(Object.keys(bad.errors).sort()).toEqual(["base_url", "colour", "model", "timeout"]);
      expect(bad.errors.timeout).toBe("At most 120.");
    }
    const select = [
      field({ key: "size", type: "select", options: [{ value: "s", label: "Small" }] }),
      field({ key: "fast", type: "boolean" }),
    ];
    expect(checkSettings(select, { size: "s", fast: true }).ok).toBe(true);
    expect(checkSettings(select, { size: "xl" }).ok).toBe(false);
    expect(checkSettings(select, { fast: "yes" }).ok).toBe(false);
  });

  test("long text keeps its lines, up to a longer limit than text", () => {
    const schema = [field({ key: "prompt", type: "long_text" }), field({ key: "t", type: "text" })];
    expect(checkSettings(schema, { prompt: "  one\n\ntwo  " })).toMatchObject({
      ok: true,
      values: { prompt: "one\n\ntwo", t: "" },
    });
    expect(checkSettings(schema, { prompt: "x".repeat(5000) }).ok).toBe(true);
    expect(checkSettings(schema, { t: "x".repeat(5000) }).ok).toBe(false);
    expect(checkSettings(schema, { prompt: "x".repeat(8001) }).ok).toBe(false);
  });

  test("an edit keeps what it leaves out; a secret is removed only when cleared", () => {
    const current = {
      values: { base_url: "https://x/v1", model: "m", timeout: 30 },
      secrets: { api_key: "old" },
    };
    expect(checkSettings(CLOUD_SETTINGS, { model: "n" }, current)).toMatchObject({
      values: { base_url: "https://x/v1", model: "n" },
      secrets: { api_key: "old" },
    });
    expect(checkSettings(CLOUD_SETTINGS, { api_key: "" }, current)).toMatchObject({
      secrets: { api_key: null },
    });
    const required = [field({ key: "key", type: "secret", required: true, label: "API key" })];
    const missing = checkSettings(required, {});
    expect(missing.ok ? null : missing.errors.key).toBe("Enter the API key.");
  });

  test("the fingerprint covers only what can change a verdict", () => {
    const base = { base_url: "https://x/v1", model: "m", timeout: 30 };
    const f = fingerprint(CLOUD_SETTINGS, base);
    expect(fingerprint(CLOUD_SETTINGS, { ...base, timeout: 99 })).toBe(f);
    expect(fingerprint(CLOUD_SETTINGS, { ...base, model: "other" })).not.toBe(f);
    expect(f).toMatch(/^[0-9a-f]{64}$/);
  });
});

test("backoff: as the service asks, else doubling to a cap per reason", () => {
  expect(retryDelayMs("rate_limit", 1, 7)).toBe(7_000);
  expect(retryDelayMs("rate_limit", 1, 0)).toBe(5_000);
  expect(retryDelayMs("network", 1, null)).toBe(30_000);
  expect(retryDelayMs("network", 2, null)).toBe(60_000);
  expect(retryDelayMs("network", 20, null)).toBe(30 * 60_000);
  expect(retryDelayMs("auth", 1, null)).toBe(15 * 60_000);
  expect(retryDelayMs("quota", 1, 10 * 86_400)).toBe(86_400_000);
});

// A parent with four "alexa" clips, the default judges, and two declared
// workers: w1 runs everything, w2 only Parakeet.
async function parent() {
  const clock = { now: START };
  const lines: string[] = [];
  const kiosk = createFakeKiosk({ name: "kitchen", initialClips: 4, now: () => START });
  const t = await testApi({
    fetch: kiosk.fetch,
    now: () => clock.now,
    log: createLogger("debug", {}, (line) => lines.push(line)),
    declared: [
      { name: "w1", token: tokenOf("w1"), notes: "", enabled: true, judges: null },
      { name: "w2", token: tokenOf("w2"), notes: "", enabled: true, judges: ["stt"] },
    ],
  });
  await t.setUp();
  await t.request("/api/v1/devices", {
    json: { name: "kitchen", baseUrl: "http://kitchen.test:2324", password: "dev" },
  });
  await t.collector.pollAll();

  async function claim(
    name = "w1",
    types: object[] = [STT, CLOUD],
    max = 32,
    protocol = 2,
  ): Promise<Job[]> {
    const res = await t.api.request("http://localhost/api/worker/v1/jobs/claim", {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenOf(name)}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        protocol,
        worker: { name: `host-${name}`, version: "0.3.0" },
        types,
        max,
        waitSeconds: 0,
      }),
    });
    expect(res.status).toBe(200);
    return (await res.json()).jobs;
  }

  async function answer(job: Job, results: object[], name = "w1") {
    const res = await t.api.request(`http://localhost/api/worker/v1/jobs/${job.id}/results`, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokenOf(name)}`, "Content-Type": "application/json" },
      body: JSON.stringify({ results }),
    });
    return res.status;
  }

  const result = (
    instance: string,
    type: { id: string; version: string },
    verdict: string,
    extra = {},
  ) => ({
    instance,
    type: type.id,
    version: type.version,
    verdict,
    score: null,
    threshold: null,
    transcript: verdict === "yes" ? "alexa" : null,
    detail: null,
    failure: null,
    durationMs: 9,
    ...extra,
  });

  // Judges every clip with Parakeet, yes.
  async function judgeAllWithStt() {
    for (const job of await claim("w1", [STT])) {
      expect(await answer(job, [result("stt", STT, "yes")])).toBe(204);
    }
  }

  async function list() {
    return (await (await t.request("/api/v1/judges")).json()) as {
      judges: Record<string, unknown>[];
      types: Record<string, unknown>[];
      rule: { margin: number; minimum: number };
    };
  }

  async function addCloud(extra: object = {}) {
    // A worker must have offered the type first.
    await claim("w1", [STT, CLOUD], 1);
    clock.now += LEASE_MS + 1;
    const res = await t.request("/api/v1/judges", {
      json: {
        name: "Cloud",
        type: CLOUD.id,
        settings: { base_url: "https://api.example.test/v1", model: "big", api_key: SECRET },
        ...extra,
      },
    });
    expect(res.status).toBe(201);
    return (await res.json()).judge as { id: string } & Record<string, unknown>;
  }

  return { ...t, clock, lines, claim, answer, result, judgeAllWithStt, list, addCloud };
}

describe("judges in the API", () => {
  test("the migrated three, with their weights, and the types workers offered", async () => {
    const t = await parent();
    await t.claim("w1", [STT, CLOUD], 1);
    const { judges, types, rule } = await t.list();
    expect(judges.map((j) => [j.id, j.name, j.weight, j.enabled])).toEqual([
      ["stt", "Speech to text", 1, true],
      ["microwakeword", "microWakeWord", 0.3, true],
      ["openwakeword", "openWakeWord", 0.3, true],
    ]);
    expect(rule).toEqual({ margin: 0.5, minimum: 1 });
    const cloud = types.find((x) => x.id === CLOUD.id);
    expect(cloud).toMatchObject({ external: true, workers: ["w1"], advertised: true });
    expect(types.find((x) => x.id === "stt")).toMatchObject({ workers: ["w1"] });
    // w2 may run only Parakeet.
    await t.claim("w2", [STT, CLOUD], 1);
    const after = (await t.list()).types;
    expect(after.find((x) => x.id === "stt")).toMatchObject({ workers: ["w1", "w2"] });
    expect(after.find((x) => x.id === CLOUD.id)).toMatchObject({ workers: ["w1"] });
  });

  test("adding: a type no worker offers, a bad setting and a taken name are refused", async () => {
    const t = await parent();
    const unknown = await t.request("/api/v1/judges", { json: { name: "X", type: "nope" } });
    expect(unknown.status).toBe(400);
    await t.claim("w1", [STT, CLOUD], 1);
    const bad = await t.request("/api/v1/judges", {
      json: { name: "X", type: CLOUD.id, settings: { base_url: "", timeout: 0 } },
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).fields).toMatchObject({
      base_url: expect.any(String),
      model: "Enter the model.",
    });
    const taken = await t.request("/api/v1/judges", {
      json: { name: "speech TO text", type: "stt" },
    });
    expect(taken.status).toBe(409);
    const weight = await t.request("/api/v1/judges", {
      json: { name: "Y", type: "stt", weight: 11 },
    });
    expect(weight.status).toBe(400);
  });

  test("a secret is stored sealed, never returned or logged, and sent only in a job", async () => {
    const t = await parent();
    const judge = await t.addCloud();
    expect(judge).toMatchObject({
      type: CLOUD.id,
      weight: 1,
      external: true,
      settings: { base_url: "https://api.example.test/v1", model: "big", timeout: 30 },
      secrets: { api_key: true },
    });
    const everything = [
      JSON.stringify(judge),
      await (await t.request("/api/v1/judges")).text(),
      await (await t.request("/api/openapi.json")).text(),
      t.lines.join("\n"),
    ].join("\n");
    expect(everything).not.toContain(SECRET);
    const stored = t.db
      .query<{ ciphertext: Uint8Array }, []>(
        "SELECT ciphertext FROM secrets WHERE kind = 'judge_settings'",
      )
      .all();
    expect(stored).toHaveLength(1);
    expect(Buffer.from(stored[0]?.ciphertext ?? []).toString("latin1")).not.toContain(SECRET);

    const w1 = await t.claim("w1", [STT, CLOUD], 2);
    expect(w1).toHaveLength(2);
    const cloud = w1.flatMap((j) => j.judges).find((x) => x.instance === judge.id);
    expect(cloud?.settings).toEqual({
      base_url: "https://api.example.test/v1",
      model: "big",
      timeout: 30,
      api_key: SECRET,
    });
    // w2 may not run the cloud type: its jobs never carry the key.
    const w2 = await t.claim("w2", [STT, CLOUD]);
    expect(w2).toHaveLength(2);
    expect(JSON.stringify(w2)).not.toContain(SECRET);
    expect(w2.every((j) => j.judges.every((x) => x.instance === "stt"))).toBe(true);
    expect(t.lines.join("\n")).not.toContain(SECRET);

    // Replacing and removing the key; leaving it out keeps it.
    const patch = (settings: object) =>
      t.request(`/api/v1/judges/${judge.id}`, { method: "PATCH", json: { settings } });
    expect((await (await patch({ model: "big" })).json()).judge.secrets).toEqual({ api_key: true });
    expect((await (await patch({ api_key: null })).json()).judge.secrets).toEqual({
      api_key: false,
    });
    expect(
      t.db.query("SELECT count(*) AS n FROM secrets WHERE kind = 'judge_settings'").get(),
    ).toEqual({
      n: 0,
    });
  });

  test("a new model judges again; a new name, weight, timeout or key does not", async () => {
    const t = await parent();
    const judge = await t.addCloud();
    const cloudJobs = async () =>
      (await t.claim("w1", [STT, CLOUD])).filter((j) =>
        j.judges.some((x) => x.instance === judge.id),
      );
    const first = await cloudJobs();
    expect(first).toHaveLength(4);
    for (const job of first) {
      expect(
        await t.answer(
          job,
          job.judges.map((x) => t.result(x.instance, x.type === "stt" ? STT : CLOUD, "yes")),
        ),
      ).toBe(204);
    }
    const patch = (json: object) =>
      t.request(`/api/v1/judges/${judge.id}`, { method: "PATCH", json });
    for (const change of [
      { name: "Cloud judge" },
      { weight: 2.5 },
      { settings: { timeout: 60 } },
      { settings: { api_key: "sk-another-one-0123456789" } },
      { dailyLimit: 100 },
    ]) {
      expect((await patch(change)).status).toBe(200);
      expect(await cloudJobs()).toEqual([]);
    }
    expect((await patch({ settings: { model: "small" } })).status).toBe(200);
    const again = await cloudJobs();
    expect(again).toHaveLength(4);
    // Only the cloud judge, not Parakeet.
    for (const job of again) expect(job.judges.map((x) => x.instance)).toEqual([judge.id]);
  });

  test("the daily limit judges the newest clips first and stops", async () => {
    const t = await parent();
    const judge = await t.addCloud({ dailyLimit: 2 });
    const jobs = (await t.claim("w1", [CLOUD])).filter((j) => j.judges.length > 0);
    expect(jobs).toHaveLength(2);
    const { rows } = listClips(t.db, {}, { limit: 10, offset: 0 }, t.judging.context());
    expect(jobs.map((j) => j.clipId)).toEqual(rows.slice(0, 2).map((r) => r.id));
    for (const job of jobs)
      expect(await t.answer(job, [t.result(judge.id, CLOUD, "no")])).toBe(204);
    expect(await t.claim("w1", [CLOUD])).toEqual([]);
    const view = (await t.list()).judges.find((j) => j.id === judge.id);
    expect(view).toMatchObject({ health: "limited", judged24h: 2, attempts24h: 2 });
    // A day later it carries on.
    t.clock.now += 24 * 3_600_000 + 1;
    expect(await t.claim("w1", [CLOUD])).toHaveLength(2);
  });

  test("a failing judge is paused with its error, others carry on, and outcomes do not wait", async () => {
    const t = await parent();
    await t.judgeAllWithStt();
    const judge = await t.addCloud();
    const [job] = await t.claim("w1", [STT, CLOUD], 1);
    expect(job).toBeDefined();
    const failure = { reason: "auth", retryAfterSeconds: null };
    expect(
      await t.answer(job as Job, [
        t.result(judge.id, CLOUD, "failed", { detail: "invalid API key (HTTP 401)", failure }),
      ]),
    ).toBe(204);
    const view = (await t.list()).judges.find((j) => j.id === judge.id);
    expect(view).toMatchObject({
      health: "failing",
      lastError: { message: "invalid API key (HTTP 401)", reason: "auth" },
      retryAt: new Date(t.clock.now + 15 * 60_000).toISOString(),
    });
    // Nothing was recorded for the clip, and the paused judge gets no jobs.
    expect(
      t.db.query("SELECT count(*) AS n FROM judge_results WHERE instance_id = ?").get(judge.id),
    ).toEqual({ n: 0 });
    expect(await t.claim("w1", [STT, CLOUD])).toEqual([]);
    // The clips keep Parakeet's outcome rather than waiting for it.
    const { clips } = await (await t.request("/api/v1/clips")).json();
    for (const c of clips) expect(c.judging.outcome).toBe("yes");
    // After the pause it is tried again; a verdict makes it healthy.
    t.clock.now += 15 * 60_000 + 1;
    const [retry] = await t.claim("w1", [STT, CLOUD], 1);
    expect(await t.answer(retry as Job, [t.result(judge.id, CLOUD, "yes")])).toBe(204);
    expect((await t.list()).judges.find((j) => j.id === judge.id)).toMatchObject({
      health: "ok",
      lastError: null,
    });
  });

  test("a clip that keeps failing on its own is given up on", async () => {
    const t = await parent();
    const judge = await t.addCloud();
    let clip = "";
    for (let i = 0; i < 5; i++) {
      const [job] = await t.claim("w1", [CLOUD], 1);
      clip ||= (job as Job).clipId;
      expect((job as Job).clipId).toBe(clip);
      const failure = { reason: "server", retryAfterSeconds: 0 };
      await t.answer(job as Job, [
        t.result(judge.id, CLOUD, "failed", { detail: "HTTP 500", failure }),
      ]);
      t.clock.now += 6_000;
    }
    const detail = await (await t.request(`/api/v1/clips/${clip}`)).json();
    expect(
      detail.judges.results.find((r: { judgeId: string }) => r.judgeId === judge.id),
    ).toMatchObject({
      verdict: "abstain",
      detail: "gave up after 5 failed attempts: HTTP 500",
    });
  });

  test("a test runs on one clip through a worker, even while the judge is off", async () => {
    const t = await parent();
    const judge = await t.addCloud({ enabled: false });
    expect(await t.claim("w1", [CLOUD])).toEqual([]);
    const started = await t.request(`/api/v1/judges/${judge.id}/test`, { json: {} });
    expect(started.status).toBe(202);
    const { test: pending } = await started.json();
    expect(pending.state).toBe("waiting");
    // A worker that may not run the type does not take it.
    expect(await t.claim("w2", [STT, CLOUD])).toHaveLength(4);
    const [job] = await t.claim("w1", [CLOUD]);
    expect(job).toMatchObject({ clipId: pending.clipId, judges: [{ instance: judge.id }] });
    const running = await (await t.request(`/api/v1/judge-tests/${pending.id}`)).json();
    expect(running.test.state).toBe("running");
    expect(
      await t.answer(job as Job, [t.result(judge.id, CLOUD, "yes", { transcript: "Alexa, hi" })]),
    ).toBe(204);
    const done = await (await t.request(`/api/v1/judge-tests/${pending.id}`)).json();
    expect(done.test).toMatchObject({
      state: "done",
      result: { verdict: "yes", transcript: "Alexa, hi", worker: "w1" },
    });
    // Unanswered, a test expires.
    const again = await (await t.request(`/api/v1/judges/${judge.id}/test`, { json: {} })).json();
    t.clock.now += 3 * 60_000 + 1;
    expect(
      (await (await t.request(`/api/v1/judge-tests/${again.test.id}`)).json()).test.state,
    ).toBe("expired");
  });

  test("a listening judge: offered over protocol 3, weight 0.5, its note on the clip page", async () => {
    const t = await parent();
    await t.claim("w1", [STT, LISTENING], 1, 3);
    const { types } = await t.list();
    expect(types.find((x) => x.id === LISTENING.id)).toMatchObject({
      kind: "listening",
      settings: [{}, {}, { key: "prompt", type: "long_text" }],
    });
    t.clock.now += LEASE_MS + 1;
    const res = await t.request("/api/v1/judges", {
      json: {
        name: "Listener",
        type: LISTENING.id,
        settings: { base_url: "https://llm.example.test/v1", model: "audio" },
        enabled: true,
      },
    });
    expect(res.status).toBe(201);
    const judge = (await res.json()).judge;
    expect(judge).toMatchObject({ kind: "listening", weight: 0.5, settings: { prompt: "" } });
    const [job] = await t.claim("w1", [LISTENING], 1, 3);
    const note = "someone says the wake word";
    expect(
      await t.answer(job as Job, [t.result(judge.id, LISTENING, "yes", { transcript: note })]),
    ).toBe(204);
    const clip = await (await t.request(`/api/v1/clips/${(job as Job).clipId}`)).json();
    expect(clip.judges.results).toContainEqual(
      expect.objectContaining({ judgeId: judge.id, kind: "listening", transcript: note }),
    );
  });

  test("deleting stops it running and counting but keeps its verdicts on the clip page", async () => {
    const t = await parent();
    const judge = await t.addCloud();
    const jobs = await t.claim("w1", [CLOUD]);
    for (const job of jobs) await t.answer(job, [t.result(judge.id, CLOUD, "no")]);
    const clipId = (jobs[0] as Job).clipId;
    const before = await (await t.request(`/api/v1/clips/${clipId}`)).json();
    expect(before.clip.judging).toMatchObject({ outcome: "no", no: 1 });
    expect((await t.request(`/api/v1/judges/${judge.id}`, { method: "DELETE" })).status).toBe(204);
    expect((await t.list()).judges.some((j) => j.id === judge.id)).toBe(false);
    const after = await (await t.request(`/api/v1/clips/${clipId}`)).json();
    expect(after.clip.judging.outcome).toBe("waiting");
    expect(after.clip.judging.no).toBe(0);
    expect(after.judges.results).toEqual([
      expect.objectContaining({
        judgeId: judge.id,
        name: "Cloud",
        status: "deleted",
        verdict: "no",
      }),
    ]);
    // Its name is free again.
    expect(
      (await t.request("/api/v1/judges", { json: { name: "Cloud", type: "stt" } })).status,
    ).toBe(201);
    expect((await t.request(`/api/v1/judges/${judge.id}`, { method: "DELETE" })).status).toBe(404);
  });

  test("the SQL outcome matches outcome.ts for every clip", async () => {
    const t = await parent();
    await t.request("/api/v1/judges/openwakeword", { method: "PATCH", json: { weight: 0.7 } });
    const jobs = await t.claim("w1", [
      STT,
      {
        id: "openwakeword",
        version: "o1",
        name: "o",
        kind: "wake_word_model",
        wakeWords: ["alexa"],
      },
      {
        id: "microwakeword",
        version: "m1",
        name: "m",
        kind: "wake_word_model",
        wakeWords: ["alexa"],
      },
    ]);
    const plans = [
      ["yes", "no", "no"],
      ["no", "yes", "abstain"],
      ["abstain", "yes", "yes"],
      ["no", "no", "yes"],
    ];
    const weights: Record<string, number> = { stt: 1, openwakeword: 0.7, microwakeword: 0.3 };
    const types: Record<string, { id: string; version: string }> = {
      stt: STT,
      openwakeword: { id: "openwakeword", version: "o1" },
      microwakeword: { id: "microwakeword", version: "m1" },
    };
    const expected = new Map<string, ReturnType<typeof weigh>>();
    for (const [i, job] of jobs.entries()) {
      const plan = plans[i] as string[];
      const ids = ["stt", "openwakeword", "microwakeword"];
      await t.answer(
        job,
        ids.map((id, k) =>
          t.result(id, types[id] as { id: string; version: string }, plan[k] as string),
        ),
      );
      expected.set(
        job.clipId,
        weigh(
          ids.map((id, k) => ({
            verdict: plan[k] as Vote["verdict"],
            weight: weights[id] as number,
          })),
          DEFAULT_RULE,
        ),
      );
    }
    const { clips } = await (await t.request("/api/v1/clips")).json();
    for (const c of clips) {
      const w = expected.get(c.id);
      expect(c.judging.outcome).toBe(w?.outcome);
      if (w?.score === null) expect(c.judging.score).toBeNull();
      else expect(c.judging.score).toBeCloseTo(w?.score ?? NaN);
    }
  });
});
