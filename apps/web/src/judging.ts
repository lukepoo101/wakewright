import { useQuery } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { call, v1 } from "./api.ts";
import type { Clip } from "./clips.ts";

// What the judges said about clips, in words, and the judging status for
// Home. Each judge answers "does this clip contain its wake word?"; their
// yes and no votes, times their weights, decide the outcome (outcome.ts on
// the server; the Judges page explains it).

export type JudgingStatus = InferResponseType<typeof v1.judging.$get, 200>;
export type ClipJudging = Clip["judging"];
export type Outcome = ClipJudging["outcome"];
export type Mismatch = NonNullable<ClipJudging["mismatch"]>;

export function useJudgingStatus() {
  return useQuery({
    queryKey: ["judging"],
    queryFn: () => call(v1.judging.$get()),
    refetchInterval: 15_000,
  });
}

export const OUTCOME_LABELS: Record<Outcome, string> = {
  yes: "Yes",
  no: "No",
  uncertain: "Uncertain",
  not_enough: "Not enough evidence",
  waiting: "Waiting",
};

/** 0.83 → "83%". */
export function percent(x: number): string {
  return `${Math.round(x * 100)}%`;
}

/** A score from -1 to +1 as people read it: "+0.25", "−1.00". */
export function signedScore(score: number): string {
  const s = Math.abs(score).toFixed(2);
  return score > 0.004 ? `+${s}` : score < -0.004 ? `−${s}` : s;
}

/** The compact chip text: "Yes · 100%", "Uncertain · 62% yes", "Waiting · yes so far". */
export function outcomeShort(j: ClipJudging): string {
  const lean = j.yesWeight >= j.noWeight ? "yes" : "no";
  switch (j.outcome) {
    case "yes":
    case "no":
      return j.confidence === null
        ? OUTCOME_LABELS[j.outcome]
        : `${OUTCOME_LABELS[j.outcome]} · ${percent(j.confidence)}`;
    case "uncertain":
      return j.confidence === null ? "Uncertain" : `Uncertain · ${percent(j.confidence)} ${lean}`;
    case "not_enough":
      return "Not enough";
    case "waiting":
      return j.provisional === "yes" || j.provisional === "no"
        ? `Waiting · ${j.provisional} so far`
        : "Waiting";
  }
}

/** The outcome in a sentence, for a tooltip and screen readers. */
export function outcomeLong(j: ClipJudging): string {
  const votes = [
    j.yes > 0 && `${j.yes} ${j.yes === 1 ? "judge says" : "judges say"} yes`,
    j.no > 0 && `${j.no} ${j.no === 1 ? "says" : "say"} no`,
    j.abstain > 0 && `${j.abstain} could not tell`,
  ].filter(Boolean);
  const said = votes.length > 0 ? ` ${votes.join(", ")}.` : "";
  const weight = j.yesWeight + j.noWeight;
  const share =
    j.confidence !== null && weight > 0
      ? ` ${percent(j.confidence)} of the voting weight is on the ${j.yesWeight >= j.noWeight ? "yes" : "no"} side.`
      : "";
  const mismatch = j.mismatch ? ` ${mismatchLabel(j.mismatch)}.` : "";
  const head: Record<Outcome, string> = {
    yes: "Outcome: it is the wake word.",
    no: "Outcome: it is not the wake word.",
    uncertain: "Outcome: uncertain, the judges lean neither way strongly enough.",
    not_enough: "Outcome: not enough evidence, too little weight voted.",
    waiting:
      j.provisional === null
        ? "No judge has answered yet."
        : `Waiting for judges; so far: ${OUTCOME_LABELS[j.provisional].toLowerCase()}.`,
  };
  return `${head[j.outcome]}${said}${share}${mismatch}`;
}

export function mismatchLabel(m: Mismatch): string {
  return m === "false_wake" ? "Likely false wake" : "Likely missed wake word";
}

/** The Judges filter: one choice in the UI; an outcome, a mismatch or dissent in the API. */
export type JudgesFilter = Outcome | Mismatch | "dissent";

export const JUDGES_FILTERS: { value: JudgesFilter; label: string }[] = [
  { value: "uncertain", label: "Uncertain" },
  { value: "false_wake", label: "Likely false wakes" },
  { value: "missed_wake", label: "Likely missed wake words" },
  { value: "dissent", label: "A judge dissents" },
  { value: "yes", label: "Outcome yes" },
  { value: "no", label: "Outcome no" },
  { value: "not_enough", label: "Not enough evidence" },
  { value: "waiting", label: "Waiting for judges" },
];

/** The API query for a Judges filter. */
export function judgesQuery(value: JudgesFilter) {
  if (value === "false_wake" || value === "missed_wake") return { mismatch: value };
  if (value === "dissent") return { dissent: "1" as const };
  return { outcome: value };
}
