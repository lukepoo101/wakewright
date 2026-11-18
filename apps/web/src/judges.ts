import { useQuery } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { call, v1 } from "./api.ts";
import { ago } from "./format.ts";

// Judges: instances of the judge types workers offer, each with settings,
// a weight, a daily limit and an on/off switch, and the rule that turns
// their weighted votes into an outcome.

export type JudgeList = InferResponseType<typeof v1.judges.$get, 200>;
export type Judge = JudgeList["judges"][number];
export type JudgeType = JudgeList["types"][number];
export type SettingField = JudgeType["settings"][number];
export type SettingValue = string | number | boolean | null;

export const judgesKey = ["judges"] as const;

export function useJudges() {
  return useQuery({
    queryKey: judgesKey,
    queryFn: () => call(v1.judges.$get()),
    refetchInterval: 10_000,
  });
}

export type JudgeHealthMark = "ok" | "paused" | "waiting" | "failing" | "diagnosticsOff";

/** The status mark for a judge: shape and colour, beside its status in words. */
export function healthMark(j: Judge): JudgeHealthMark {
  switch (j.health) {
    case "ok":
      return "ok";
    case "failing":
      return "failing";
    case "limited":
      return "diagnosticsOff";
    case "off":
      return "paused";
    default:
      return "waiting";
  }
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/** The judge's state in words: "Judging", "Failing: invalid API key; next try 14:05". */
export function healthText(j: Judge, now: number): string {
  switch (j.health) {
    case "ok":
      return `Judging · last answer ${ago(j.lastResultAt, now)}`;
    case "idle":
      return "Ready · has not judged a clip yet";
    case "off":
      return "Off · not run or counted";
    case "limited":
      return `Daily limit reached · ${j.attempts24h} in the last 24 hours`;
    case "no_worker":
      return j.workers.length === 0
        ? "No connected worker offers its type and may run it"
        : "No worker can run it now";
    case "no_type":
      return "No worker has offered its type yet";
    case "failing": {
      const error = j.lastError;
      const next = j.retryAt ? clock(j.retryAt) : null;
      if (error?.reason === "quota") {
        return `Paused until the quota resets${next ? ` · next try ${next}` : ""}`;
      }
      if (error?.reason === "rate_limit") {
        return `Rate limited · next try ${next ?? "soon"}`;
      }
      return `Failing: ${error?.message ?? "unknown error"}${next ? ` · next try ${next}` : ""}`;
    }
  }
}

export const KIND_LABELS: Record<JudgeType["kind"], string> = {
  wake_word_model: "Wake word model",
  speech_to_text: "Speech to text",
};

/** A weight as the UI shows it: "1.0", "0.3", "2.25". */
export function weightText(w: number): string {
  return Number.isInteger(w * 10) ? w.toFixed(1) : String(w);
}
