import { describe, expect, test } from "bun:test";
import { createFakeKiosk } from "@wakewright/fake-kiosk";
import type { DeclaredWorker } from "../src/config.ts";
import { decodePairing, encodePairing } from "../src/pairing.ts";
import {
  generateToken,
  routedTypes,
  sameDigest,
  TOKEN_PREFIX,
  tokenSha256,
} from "../src/workers.ts";
import { testApi } from "./helpers.ts";

// Workers as records the parent owns (ADR 0018): their tokens, declared
// workers applied from configuration, routing at claim time, and what
// pausing, deleting and new tokens do at once.

const OWW = {
  id: "openwakeword",
  version: "alexa_v0.1+1",
  name: "openWakeWord",
  kind: "wake_word_model",
  wakeWords: ["alexa"],
};
const STT = {
  id: "stt",
  version: "tiny+1",
  name: "Speech",
  kind: "speech_to_text",
  wakeWords: null,
};

type Job = { id: string; judges: { instance: string }[] };
const ids = (job: Job) => job.judges.map((j) => j.instance);

function declared(name: string, extra: Partial<DeclaredWorker> = {}): DeclaredWorker {
  return {
    name,
    token: `declared-token-of-${name}-0123456789`,
    notes: "",
    enabled: true,
    judges: null,
    ...extra,
  };
}

// A signed-in parent with one fake device's four "alexa" clips collected.
async function parent(declaredWorkers: DeclaredWorker[] = [], mode?: "none") {
  const kiosk = createFakeKiosk({ name: "kitchen", initialClips: 4 });
  const t = await testApi({ fetch: kiosk.fetch, declared: declaredWorkers, mode });
  if (!mode) await t.setUp();
  await t.request("/api/v1/devices", {
    json: { name: "kitchen", baseUrl: "http://kitchen.test:2324", password: "dev" },
  });
  await t.collector.pollAll();

  function worker(token: string | null, path: string, json?: unknown) {
    const headers = new Headers();
    if (token !== null) headers.set("Authorization", `Bearer ${token}`);
    if (json !== undefined) headers.set("Content-Type", "application/json");
    return t.api.request(`http://localhost/api/worker/v1${path}`, {
      method: json === undefined ? "GET" : "POST",
      headers,
      body: json === undefined ? undefined : JSON.stringify(json),
    });
  }

  async function claim(token: string, judges: object[] = [OWW, STT], waitSeconds = 0) {
    const res = await worker(token, "/jobs/claim", {
      protocol: 2,
      worker: { name: "a-host", version: "0.2.0" },
      types: judges,
      max: 32,
      waitSeconds,
    });
    return {
      status: res.status,
      jobs: res.ok ? ((await res.json()).jobs as Job[]) : [],
    };
  }

  function stt(job: { id: string }, token: string) {
    return worker(token, `/jobs/${job.id}/results`, {
      results: [
        {
          instance: "stt",
          type: "stt",
          version: STT.version,
          verdict: "yes",
          score: null,
          threshold: null,
          transcript: "alexa",
          detail: null,
          failure: null,
          durationMs: 5,
        },
      ],
    });
  }

  async function create(body: object) {
    const res = await t.request("/api/v1/workers", { json: body });
    return { status: res.status, body: await res.json() };
  }

  async function list() {
    return (await (await t.request("/api/v1/workers")).json()) as {
      workers: {
        id: string;
        name: string;
        source: string;
        enabled: boolean;
        notes: string;
        allowedJudges: string[] | null;
        connected: boolean;
        token: { hint: string | null };
        reported: { name: string | null; types: object[] };
      }[];
      judges: string[];
      publicUrl: string | null;
    };
  }

  return { ...t, worker, claim, stt, create, list };
}

describe("tokens", () => {
  test("a generated token is prefixed, 256 bits of letters and digits, and new every time", () => {
    const tokens = new Set(Array.from({ length: 200 }, generateToken));
    expect(tokens.size).toBe(200);
    for (const token of tokens) {
      expect(token).toMatch(new RegExp(`^${TOKEN_PREFIX}[0-9A-Za-z]{43}$`));
    }
  });

  test("is stored only as its SHA-256, and compared without an early exit", async () => {
    expect(tokenSha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    const a = tokenSha256("one token");
    expect(sameDigest(a, a)).toBe(true);
    expect(sameDigest(a, tokenSha256("another token"))).toBe(false);
    expect(sameDigest(a, a.slice(0, -1))).toBe(false);
    expect(sameDigest(a, `${a}0`)).toBe(false);
    expect(sameDigest("", "")).toBe(true);

    const t = await parent();
    const { body } = await t.create({ name: "laptop" });
    const dump = JSON.stringify(t.db.query("SELECT * FROM workers").all());
    expect(dump).not.toContain(body.token);
    expect(dump).toContain(tokenSha256(body.token));
  });

  test("the pairing string carries the address and token, and says what is wrong", () => {
    const token = generateToken();
    const pairing = encodePairing({ url: "https://wakewright.example.lan/", token });
    expect(pairing).toMatch(/^wakewright-pair:1:[A-Za-z0-9_-]+$/);
    expect(decodePairing(` ${pairing}\n`)).toEqual({
      url: "https://wakewright.example.lan",
      token,
    });
    // The example in docs/workers.md and apps/worker/tests/test_config.py.
    expect(encodePairing({ url: "http://wakewright:8080", token: "wwk_example" })).toBe(
      "wakewright-pair:1:eyJ1cmwiOiJodHRwOi8vd2FrZXdyaWdodDo4MDgwIiwidG9rZW4iOiJ3d2tfZXhhbXBsZSJ9",
    );
    expect(() => decodePairing("wwk_abc")).toThrow(/starts with "wakewright-pair:"/);
    expect(() => decodePairing("wakewright-pair:2:abc")).toThrow(/format 2/);
    expect(() => decodePairing("wakewright-pair:1:!!")).toThrow(/damaged/);
    const noUrl = encodePairing({ url: "ftp://x", token: "t" });
    expect(() => decodePairing(noUrl)).toThrow(/address/);
  });
});

describe("workers created in the UI", () => {
  test("creating shows the token once; it then authenticates a claim", async () => {
    const t = await parent();
    expect((await t.list()).workers).toEqual([]);
    const created = await t.create({ name: "Laptop", notes: "under the desk" });
    expect(created.status).toBe(201);
    expect(created.body.token).toStartWith(TOKEN_PREFIX);
    expect(created.body.worker).toMatchObject({
      name: "Laptop",
      notes: "under the desk",
      enabled: true,
      source: "ui",
      allowedJudges: null,
      connected: false,
      token: { hint: created.body.token.slice(0, 8) },
    });
    // The list never holds the token again.
    expect(JSON.stringify(await t.list())).not.toContain(created.body.token);

    const claimed = await t.claim(created.body.token);
    expect(claimed.status).toBe(200);
    expect(claimed.jobs).toHaveLength(4);
    const [w] = (await t.list()).workers;
    expect(w).toMatchObject({ connected: true, reported: { name: "a-host" } });
  });

  test("names are unique, ignoring case, and validated", async () => {
    const t = await parent([declared("cluster-worker")]);
    expect((await t.create({ name: "Laptop" })).status).toBe(201);
    const again = await t.create({ name: "laptop" });
    expect(again).toMatchObject({ status: 409, body: { error: "name_taken" } });
    const configured = await t.create({ name: "Cluster-Worker" });
    expect(configured.status).toBe(409);
    expect(configured.body.message).toContain("set by configuration");
    expect((await t.create({ name: "" })).status).toBe(400);
    expect((await t.create({ name: "a/b" })).status).toBe(400);
    expect((await t.create({ name: "x", allowedJudges: [] })).status).toBe(400);
  });

  test("edits: rename, notes and the judges it may run", async () => {
    const t = await parent();
    const { body } = await t.create({ name: "Laptop" });
    const res = await t.request(`/api/v1/workers/${body.worker.id}`, {
      method: "PATCH",
      json: { name: "Study laptop", notes: "new notes", allowedJudges: ["stt", "stt"] },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).worker).toMatchObject({
      name: "Study laptop",
      notes: "new notes",
      allowedJudges: ["stt"],
    });
    const missing = await t.request("/api/v1/workers/nope", { method: "PATCH", json: {} });
    expect(missing.status).toBe(404);
  });

  test("need a signed-in user; a worker token does not open them", async () => {
    const t = await parent();
    const { body } = await t.create({ name: "Laptop" });
    const res = await t.api.request("http://localhost/api/v1/workers", {
      headers: { Authorization: `Bearer ${body.token}` },
    });
    expect(res.status).toBe(401);
    t.signOutLocally();
    expect((await t.request("/api/v1/workers")).status).toBe(401);
  });

  test("work with sign-in turned off", async () => {
    const t = await parent([], "none");
    const created = await t.create({ name: "Laptop" });
    expect(created.status).toBe(201);
    expect((await t.claim(created.body.token)).status).toBe(200);
  });
});

describe("routing", () => {
  test("a worker gets only the judges it offers and is allowed to run", () => {
    expect(routedTypes([OWW, STT], { enabled: true, allowedJudges: null })).toEqual([OWW, STT]);
    expect(routedTypes([OWW, STT], { enabled: true, allowedJudges: ["stt", "mww"] })).toEqual([
      STT,
    ]);
    expect(routedTypes([OWW, STT], { enabled: false, allowedJudges: null })).toEqual([]);
  });

  test("at claim time, and the waiting count follows what workers may run", async () => {
    const t = await parent();
    const { body } = await t.create({ name: "Laptop", allowedJudges: ["openwakeword"] });
    const { jobs } = await t.claim(body.token);
    expect(jobs).toHaveLength(4);
    for (const job of jobs) expect(ids(job)).toEqual(["openwakeword"]);
    // Only openWakeWord may run; the speech-to-text the worker offers waits for nobody.
    expect((await (await t.request("/api/v1/judging")).json()).waiting).toBe(4);
  });

  test("a paused worker waits with no jobs and its leases are released", async () => {
    const t = await parent();
    const { body } = await t.create({ name: "Laptop" });
    const id = body.worker.id;
    const [job] = (await t.claim(body.token, [STT])).jobs as [Job];

    const pause = await t.request(`/api/v1/workers/${id}`, {
      method: "PATCH",
      json: { enabled: false },
    });
    expect((await pause.json()).worker.enabled).toBe(false);
    expect(await t.claim(body.token)).toEqual({ status: 200, jobs: [] });
    // Its lease went: the result is refused, and another worker may take the clip.
    expect((await t.stt(job, body.token)).status).toBe(409);
    const other = await t.create({ name: "Other" });
    expect((await t.claim(other.body.token, [STT])).jobs).toHaveLength(4);

    // Deleting the other worker releases its leases; resumed, the first gets the clips again.
    await t.request(`/api/v1/workers/${other.body.worker.id}`, { method: "DELETE" });
    await t.request(`/api/v1/workers/${id}`, { method: "PATCH", json: { enabled: true } });
    expect((await t.claim(body.token, [OWW])).jobs).toHaveLength(4);
  });

  test("resuming a paused worker wakes its waiting claim", async () => {
    const t = await parent();
    const { body } = await t.create({ name: "Laptop", enabled: false });
    const started = performance.now();
    const waiting = t.claim(body.token, [STT], 10);
    await Bun.sleep(50);
    await t.request(`/api/v1/workers/${body.worker.id}`, {
      method: "PATCH",
      json: { enabled: true },
    });
    expect((await waiting).jobs).toHaveLength(4);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});

describe("revocation", () => {
  test("deleting refuses the token, releases its leases and keeps its verdicts", async () => {
    const t = await parent();
    const { body } = await t.create({ name: "Laptop" });
    const [first, second] = (await t.claim(body.token, [STT])).jobs as [Job, Job];
    expect((await t.stt(first, body.token)).status).toBe(204);

    const del = await t.request(`/api/v1/workers/${body.worker.id}`, { method: "DELETE" });
    expect(del.status).toBe(204);
    expect((await t.claim(body.token)).status).toBe(401);
    expect((await t.stt(second, body.token)).status).toBe(401);
    expect(t.db.query("SELECT count(*) AS n FROM judge_leases").get()).toEqual({ n: 0 });
    // The verdict it sent stays, under its name.
    const { clips } = await (await t.request("/api/v1/clips?pageSize=10")).json();
    const results = await Promise.all(
      clips.map(
        async (c: { id: string }) =>
          (await (await t.request(`/api/v1/clips/${c.id}`)).json()).judges.results,
      ),
    );
    expect(results.flat()).toEqual([expect.objectContaining({ judgeId: "stt", worker: "Laptop" })]);
    expect(
      (await t.request(`/api/v1/workers/${body.worker.id}`, { method: "DELETE" })).status,
    ).toBe(404);
  });

  test("a new token refuses the old one at once and ends its waiting claim", async () => {
    const t = await parent();
    const { body } = await t.create({ name: "Laptop" });
    await t.claim(body.token, [STT]);
    const started = performance.now();
    const waiting = t.claim(body.token, [STT], 10);
    await Bun.sleep(50);
    const res = await t.request(`/api/v1/workers/${body.worker.id}/token`, { json: {} });
    expect(res.status).toBe(200);
    const { token } = await res.json();
    expect(token).not.toBe(body.token);
    expect(await waiting).toEqual({ status: 200, jobs: [] });
    expect(performance.now() - started).toBeLessThan(2000);
    expect((await t.claim(body.token)).status).toBe(401);
    // The released leases go to the new token.
    expect((await t.claim(token, [STT])).jobs).toHaveLength(4);
  });

  test("a worker's lease is its own: another worker cannot answer it", async () => {
    const t = await parent();
    const a = (await t.create({ name: "A" })).body;
    const b = (await t.create({ name: "B" })).body;
    const [job] = (await t.claim(a.token, [STT])).jobs as [Job];
    expect((await t.stt(job, b.token)).status).toBe(409);
    expect((await t.stt(job, a.token)).status).toBe(204);
  });
});

describe("declared workers", () => {
  test("appear read-only, marked as set by configuration", async () => {
    const t = await parent([
      declared("cluster-worker", { notes: "in the cluster", judges: ["stt"] }),
    ]);
    const { workers } = await t.list();
    expect(workers).toEqual([
      expect.objectContaining({
        name: "cluster-worker",
        source: "config",
        notes: "in the cluster",
        allowedJudges: ["stt"],
        token: expect.objectContaining({ hint: null }),
      }),
    ]);
    const id = workers[0]?.id;
    for (const [path, method, json] of [
      [`/api/v1/workers/${id}`, "PATCH", { enabled: false }],
      [`/api/v1/workers/${id}/token`, "POST", {}],
      [`/api/v1/workers/${id}`, "DELETE", undefined],
    ] as const) {
      const res = await t.request(path, { method, json });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "managed_by_configuration" });
    }
    // The configured token is accepted as given, with no prefix.
    const { jobs } = await t.claim(declared("cluster-worker").token);
    for (const job of jobs) expect(ids(job)).toEqual(["stt"]);
  });

  test("configuration is applied on every start", async () => {
    const t = await parent([declared("one"), declared("two")]);
    const [job] = (await t.claim(declared("one").token, [STT])).jobs as [Job];
    const ids = new Map((await t.list()).workers.map((w) => [w.name, w.id]));

    // Unchanged: nothing happens, and the lease stays.
    const changes: string[] = [];
    const { Workers } = await import("../src/workers.ts");
    const { quietLog } = await import("./helpers.ts");
    const restart = new Workers({ db: t.db, log: quietLog, onChange: (id) => changes.push(id) });
    restart.applyDeclared([declared("one"), declared("two")]);
    expect(changes).toEqual([]);

    // "one" gets a new token and notes, "two" goes, "three" comes.
    restart.applyDeclared([
      declared("one", { token: "a-rotated-token-0123456789", notes: "rotated" }),
      declared("three", { enabled: false }),
    ]);
    const after = (await t.list()).workers;
    expect(after.map((w) => [w.name, w.notes, w.enabled])).toEqual([
      ["one", "rotated", true],
      ["three", "", false],
    ]);
    expect(after[0]?.id).toBe(ids.get("one") as string);
    expect(changes.sort()).toEqual([ids.get("one") as string, ids.get("two") as string].sort());
    expect((await t.claim(declared("one").token)).status).toBe(401);
    expect((await t.claim(declared("two").token)).status).toBe(401);
    expect((await t.stt(job, "a-rotated-token-0123456789")).status).toBe(409);
    expect((await t.claim("a-rotated-token-0123456789", [STT])).jobs).toHaveLength(4);
  });

  test("a UI worker with a declared worker's name is renamed and keeps working", async () => {
    const t = await parent();
    const { body } = await t.create({ name: "Cluster-Worker" });
    const { Workers } = await import("../src/workers.ts");
    const { quietLog } = await import("./helpers.ts");
    new Workers({ db: t.db, log: quietLog }).applyDeclared([declared("cluster-worker")]);
    const names = (await t.list()).workers.map((w) => [w.name, w.source]);
    expect(names).toEqual([
      ["cluster-worker", "config"],
      ["Cluster-Worker-created-here", "ui"],
    ]);
    expect((await t.claim(body.token)).status).toBe(200);
  });

  test("a declared token that is already another worker's is refused", async () => {
    const t = await parent();
    const { body } = await t.create({ name: "Laptop" });
    const { Workers } = await import("../src/workers.ts");
    const { quietLog } = await import("./helpers.ts");
    expect(() =>
      new Workers({ db: t.db, log: quietLog }).applyDeclared([
        declared("cluster-worker", { token: body.token }),
      ]),
    ).toThrow(/already another worker's token/);
  });
});
