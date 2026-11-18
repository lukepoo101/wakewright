// A fake Wakewright worker for development and tests: it speaks the worker
// protocol (docs/workers.md) like a real worker, but its "judges" are not
// models. Each verdict is chosen from a hash of the clip's audio, so the
// same clip always gets the same verdicts, and the fake device's synthetic
// clips cover every agreement state: all yes, all no, a disagreement, one
// judge abstaining, and a judge that fails on the clip.

export const PROTOCOL = 1;

export interface FakeJudge {
  name: string;
  version: string;
  wakeWords: string[] | null;
}

/** The judges the fake offers. openWakeWord has no "okay_nabu", as a real one might not. */
export const FAKE_JUDGES: FakeJudge[] = [
  { name: "openwakeword", version: "fake-1", wakeWords: ["alexa"] },
  { name: "microwakeword", version: "fake-1", wakeWords: ["alexa", "okay_nabu"] },
  { name: "stt", version: "fake-1", wakeWords: null },
];

export type FakeCase = "agree_yes" | "agree_no" | "disagree" | "abstain" | "failure";
/** By the audio hash's first byte, modulo the length. */
const CASES: FakeCase[] = ["agree_yes", "agree_no", "disagree", "agree_yes", "abstain", "failure"];

export interface Result {
  judge: string;
  version: string;
  verdict: "yes" | "no" | "abstain";
  score: number | null;
  threshold: number | null;
  transcript: string | null;
  detail: string | null;
  durationMs: number;
}

/** Which case a clip's audio falls in. */
export async function fakeCase(audio: Uint8Array<ArrayBuffer>): Promise<FakeCase> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", audio));
  return CASES[(hash[0] ?? 0) % CASES.length] as FakeCase;
}

/** The fake verdicts for one clip, for the judges a job asks for. */
export async function fakeVerdicts(
  audio: Uint8Array<ArrayBuffer>,
  wakeWord: string,
  judges: string[],
): Promise<Result[]> {
  const which = await fakeCase(audio);
  const spoken = wakeWord.replace(/_/g, " ");
  // [openWakeWord score, microWakeWord score or "abstain", transcript or "fail"]
  const plan: Record<FakeCase, [number, number | "abstain", string | "fail"]> = {
    agree_yes: [0.91, 0.98, `${spoken} turn on the lights`],
    agree_no: [0.08, 0.12, "a lexicon"],
    disagree: [0.64, 0.41, spoken],
    abstain: [0.87, "abstain", spoken],
    failure: [0.71, "abstain", "fail"],
  };
  const [oww, mww, said] = plan[which];
  const results: Result[] = [];
  const base = { score: null, threshold: null, transcript: null, detail: null, durationMs: 40 };
  for (const name of judges) {
    const version = FAKE_JUDGES.find((j) => j.name === name)?.version ?? "fake-1";
    if (name === "openwakeword") {
      results.push({
        ...base,
        judge: name,
        version,
        verdict: oww >= 0.5 ? "yes" : "no",
        score: oww,
        threshold: 0.5,
      });
    } else if (name === "microwakeword") {
      results.push(
        mww === "abstain"
          ? {
              ...base,
              judge: name,
              version,
              verdict: "abstain",
              detail: "No microWakeWord model for this clip (fake).",
            }
          : {
              ...base,
              judge: name,
              version,
              verdict: mww >= 0.9 ? "yes" : "no",
              score: mww,
              threshold: 0.9,
            },
      );
    } else if (name === "stt") {
      results.push(
        said === "fail"
          ? {
              ...base,
              judge: name,
              version,
              verdict: "abstain",
              detail: "The speech-to-text model failed on this clip (fake).",
            }
          : {
              ...base,
              judge: name,
              version,
              verdict: said.includes(spoken) ? "yes" : "no",
              transcript: said,
              durationMs: 180,
            },
      );
    }
  }
  return results;
}

export interface FakeWorkerOptions {
  /** The parent's address, e.g. http://127.0.0.1:8080. */
  parentUrl: string;
  /** This worker's token, from the parent's Workers tab or its configuration. */
  token: string;
  /** What it reports itself as; the parent shows it beside the worker's own name. */
  name?: string;
  /** Pretend each clip takes this long to judge. */
  delayMs?: number;
  waitSeconds?: number;
  signal?: AbortSignal;
  log?: (message: string) => void;
}

/** Claims and judges clips until `signal` aborts. Never throws for a parent that is away. */
export async function runFakeWorker(options: FakeWorkerOptions): Promise<void> {
  const base = `${options.parentUrl.replace(/\/$/, "")}/api/worker/v1`;
  const headers = { Authorization: `Bearer ${options.token}`, "Content-Type": "application/json" };
  const log = options.log ?? (() => {});
  const signal = options.signal;
  let lastProblem = "";
  const problem = (message: string) => {
    if (message !== lastProblem) log(message);
    lastProblem = message;
  };

  while (!signal?.aborted) {
    try {
      const res = await fetch(`${base}/jobs/claim`, {
        method: "POST",
        headers,
        signal,
        body: JSON.stringify({
          protocol: PROTOCOL,
          worker: { name: options.name ?? "fake-worker", version: "fake" },
          judges: FAKE_JUDGES,
          max: 8,
          waitSeconds: options.waitSeconds ?? 25,
        }),
      });
      if (!res.ok) {
        problem(
          res.status === 401
            ? "the parent refused this worker's token: it was replaced, the worker was deleted, or it is mistyped; retrying"
            : `the parent answered ${res.status} to a claim; retrying`,
        );
        await res.body?.cancel();
        await sleep(res.status === 401 ? 5000 : 2000, signal);
        continue;
      }
      if (lastProblem) log("connected to the parent");
      lastProblem = "";
      const { jobs } = (await res.json()) as {
        jobs: { id: string; clipId: string; wakeWord: string; judges: string[] }[];
      };
      for (const job of jobs) {
        const audio = await fetch(`${base}/clips/${encodeURIComponent(job.clipId)}/audio`, {
          headers,
          signal,
        });
        if (!audio.ok) {
          await audio.body?.cancel();
          continue;
        }
        const bytes = new Uint8Array(await audio.arrayBuffer());
        const results = await fakeVerdicts(bytes, job.wakeWord, job.judges);
        if (options.delayMs) await sleep(options.delayMs, signal);
        const sent = await fetch(`${base}/jobs/${encodeURIComponent(job.id)}/results`, {
          method: "POST",
          headers,
          signal,
          body: JSON.stringify({ results }),
        });
        await sent.body?.cancel();
        if (sent.status !== 204) log(`the parent answered ${sent.status} to results`);
      }
      if (jobs.length > 0) log(`judged ${jobs.length} clip${jobs.length === 1 ? "" : "s"}`);
    } catch (error) {
      if (signal?.aborted) break;
      problem(`cannot reach the parent: ${(error as Error).message}; retrying`);
      await sleep(2000, signal);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
