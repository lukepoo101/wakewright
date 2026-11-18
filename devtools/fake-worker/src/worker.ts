// A fake Wakewright worker for development and tests: it speaks the worker
// protocol (docs/workers.md) like a real worker, but its judge types are not
// models. Each verdict is chosen from a hash of the clip's audio, so the
// same clip always gets the same verdicts, and the fake device's synthetic
// clips cover every outcome with the default weights: yes, no, uncertain,
// a yes with a dissenting judge, and not enough evidence.

export const PROTOCOL = 2;

export interface FakeSetting {
  key: string;
  label: string;
  type: "text" | "secret" | "number" | "select" | "boolean";
  help?: string;
  default?: string | number | boolean | null;
  required?: boolean;
  minimum?: number | null;
  maximum?: number | null;
  placeholder?: string;
  affectsVerdict?: boolean;
}

export interface FakeType {
  id: string;
  version: string;
  name: string;
  kind: "wake_word_model" | "speech_to_text";
  description: string;
  external: boolean;
  wakeWords: string[] | null;
  settings: FakeSetting[];
}

/**
 * The judge types the fake offers: the built-in ones, with the settings
 * forms the real worker advertises (apps/worker), so the Judges page shows
 * the same forms. openWakeWord has no "okay_nabu", as a real one might not.
 * The OpenAI-compatible type never calls anything: an API key starting with
 * "bad" fails as a refused key, a base URL containing "unreachable" as a
 * network failure, "quota" in the model as a used-up quota.
 */
export const FAKE_TYPES: FakeType[] = [
  {
    id: "openwakeword",
    version: "fake-1",
    name: "openWakeWord (fake)",
    kind: "wake_word_model",
    description: "The fake worker's stand-in for openWakeWord.",
    external: false,
    wakeWords: ["alexa"],
    settings: [],
  },
  {
    id: "microwakeword",
    version: "fake-1",
    name: "microWakeWord (fake)",
    kind: "wake_word_model",
    description: "The fake worker's stand-in for microWakeWord.",
    external: false,
    wakeWords: ["alexa", "okay_nabu"],
    settings: [],
  },
  {
    id: "stt",
    version: "fake-1",
    name: "Parakeet speech to text (fake)",
    kind: "speech_to_text",
    description: "The fake worker's stand-in for local speech to text.",
    external: false,
    wakeWords: null,
    settings: [],
  },
  {
    id: "openai-compatible",
    version: "fake-1",
    name: "OpenAI-compatible transcription (fake)",
    kind: "speech_to_text",
    description:
      "Sends each clip to a speech-to-text service with an OpenAI-compatible /audio/transcriptions endpoint. This fake calls nothing.",
    external: true,
    wakeWords: null,
    settings: [
      {
        key: "base_url",
        label: "API base URL",
        type: "text",
        help: "The address up to /v1, without /audio/transcriptions.",
        required: true,
        placeholder: "https://api.openai.com/v1",
      },
      {
        key: "api_key",
        label: "API key",
        type: "secret",
        help: "Sent as a bearer token. Leave empty for a server that needs none.",
      },
      {
        key: "model",
        label: "Model",
        type: "text",
        help: "The service's model name.",
        required: true,
        placeholder: "whisper-1",
      },
      {
        key: "timeout",
        label: "Timeout (seconds)",
        type: "number",
        default: 30,
        minimum: 1,
        maximum: 120,
        affectsVerdict: false,
      },
    ],
  },
];

export type FakeCase = "agree_yes" | "agree_no" | "disagree" | "abstain" | "failure";
/** By the audio hash's first byte, modulo the length. */
const CASES: FakeCase[] = ["agree_yes", "agree_no", "disagree", "agree_yes", "abstain", "failure"];

export interface JobJudge {
  instance: string;
  type: string;
  settings: Record<string, unknown>;
}

export interface Result {
  instance: string;
  type: string;
  version: string;
  verdict: "yes" | "no" | "abstain" | "failed";
  score: number | null;
  threshold: number | null;
  transcript: string | null;
  detail: string | null;
  failure: { reason: string; retryAfterSeconds: number | null } | null;
  durationMs: number;
}

/** Which case a clip's audio falls in. */
export async function fakeCase(audio: Uint8Array<ArrayBuffer>): Promise<FakeCase> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", audio));
  return CASES[(hash[0] ?? 0) % CASES.length] as FakeCase;
}

/** The fake results for one clip, for the judges a job asks for. */
export async function fakeVerdicts(
  audio: Uint8Array<ArrayBuffer>,
  wakeWord: string,
  judges: JobJudge[],
): Promise<Result[]> {
  const which = await fakeCase(audio);
  const spoken = wakeWord.replace(/_/g, " ");
  // [openWakeWord score, microWakeWord score or "abstain", transcript or "fail"]
  const plan: Record<FakeCase, [number, number | "abstain", string | "fail"]> = {
    agree_yes: [0.91, 0.98, `${spoken} turn on the lights`],
    agree_no: [0.08, 0.12, "a lexicon"],
    // The wake word models say yes, speech to text no: uncertain.
    disagree: [0.64, 0.95, "a lexicon"],
    // openWakeWord dissents from a yes.
    abstain: [0.31, "abstain", spoken],
    failure: [0.71, "abstain", "fail"],
  };
  const [oww, mww, said] = plan[which];
  const results: Result[] = [];
  for (const j of judges) {
    const version = FAKE_TYPES.find((t) => t.id === j.type)?.version ?? "fake-1";
    const base = {
      instance: j.instance,
      type: j.type,
      version,
      score: null,
      threshold: null,
      transcript: null,
      detail: null,
      failure: null,
      durationMs: 40,
    };
    if (j.type === "openwakeword") {
      results.push({ ...base, verdict: oww >= 0.5 ? "yes" : "no", score: oww, threshold: 0.5 });
    } else if (j.type === "microwakeword") {
      results.push(
        mww === "abstain"
          ? { ...base, verdict: "abstain", detail: "No microWakeWord model for this clip (fake)." }
          : { ...base, verdict: mww >= 0.9 ? "yes" : "no", score: mww, threshold: 0.9 },
      );
    } else if (j.type === "stt") {
      results.push(
        said === "fail"
          ? {
              ...base,
              verdict: "abstain",
              detail: "The speech-to-text model failed on this clip (fake).",
            }
          : {
              ...base,
              verdict: said.includes(spoken) ? "yes" : "no",
              transcript: said,
              durationMs: 180,
            },
      );
    } else if (j.type === "openai-compatible") {
      results.push(cloud(base, j.settings, said === "fail" ? spoken : said, spoken));
    }
  }
  return results;
}

function cloud(
  base: Omit<Result, "verdict">,
  settings: Record<string, unknown>,
  said: string,
  spoken: string,
): Result {
  const text = (k: string) => (typeof settings[k] === "string" ? (settings[k] as string) : "");
  const failed = (reason: string, detail: string, retryAfterSeconds: number | null = null) => ({
    ...base,
    verdict: "failed" as const,
    detail,
    failure: { reason, retryAfterSeconds },
  });
  if (text("api_key").startsWith("bad")) return failed("auth", "invalid API key (HTTP 401)");
  if (text("base_url").includes("unreachable")) {
    return failed("network", "cannot reach the service: ConnectError");
  }
  if (text("model").includes("quota")) {
    return failed("quota", "quota used up (HTTP 429)", 3600);
  }
  // A different model hears a little differently.
  const heard = text("model").includes("tiny") ? said.replace(spoken, "a lexer") : said;
  return {
    ...base,
    verdict: heard.includes(spoken) ? "yes" : "no",
    transcript: heard,
    durationMs: 350,
  };
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
          types: FAKE_TYPES,
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
        jobs: { id: string; clipId: string; wakeWord: string; judges: JobJudge[] }[];
      };
      const failing = new Set<string>();
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
        // As the real worker does, a judge that failed is not tried again
        // within the same claim.
        const todo = job.judges.filter((j) => !failing.has(j.instance));
        const results = await fakeVerdicts(bytes, job.wakeWord, todo);
        for (const r of results) if (r.verdict === "failed") failing.add(r.instance);
        if (results.length === 0) continue;
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
