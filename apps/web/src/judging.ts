import { useQuery } from "@tanstack/react-query";
import type { InferResponseType } from "hono/client";
import { call, v1 } from "./api.ts";
import type { Clip } from "./clips.ts";

// What the judges said about clips, in words, and the judging status for
// Home. Judges are run by workers; each answers "does this clip contain its
// wake word?" with yes, no or abstain. Agreement ignores abstentions.

export type JudgingStatus = InferResponseType<typeof v1.judging.$get, 200>;
export type ClipJudging = Clip["judging"];
export type Agreement = ClipJudging["agreement"];
export type Mismatch = NonNullable<ClipJudging["mismatch"]>;

export function useJudgingStatus() {
  return useQuery({
    queryKey: ["judging"],
    queryFn: () => call(v1.judging.$get()),
    refetchInterval: 15_000,
  });
}

const JUDGE_NAMES: Record<string, string> = {
  openwakeword: "openWakeWord",
  microwakeword: "microWakeWord",
  stt: "Speech to text",
};

/** A judge's name as people know it. */
export function judgeName(name: string): string {
  return JUDGE_NAMES[name] ?? name;
}

/** The compact count shown in lists: "3 of 3 yes", "2 of 3 yes", "Not judged". */
export function agreementShort(j: ClipJudging): string {
  const votes = j.yes + j.no;
  switch (j.agreement) {
    case "waiting":
      return "Not judged";
    case "inconclusive":
      return votes === 1 ? "1 vote" : "No votes";
    case "agree_no":
      return `${j.no} of ${votes} no`;
    default:
      return `${j.yes} of ${votes} yes`;
  }
}

/** Every vote in words, for a tooltip and screen readers. */
export function agreementLong(j: ClipJudging): string {
  if (j.agreement === "waiting") return "No judge has answered yet";
  const parts = [
    j.yes > 0 && `${j.yes} ${j.yes === 1 ? "judge says" : "judges say"} it is the wake word`,
    j.no > 0 && `${j.no} ${j.no === 1 ? "says" : "say"} it is not`,
    j.abstain > 0 && `${j.abstain} could not tell`,
  ].filter(Boolean);
  const text = parts.join(", ");
  const mismatch = j.mismatch ? `. ${mismatchLabel(j.mismatch)}` : "";
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}${mismatch}`;
}

export function mismatchLabel(m: Mismatch): string {
  return m === "false_wake" ? "Likely false wake" : "Likely missed wake word";
}

/** The Judges filter: one choice in the UI, an agreement or a mismatch in the API. */
export type JudgesFilter = Agreement | Mismatch;

export const JUDGES_FILTERS: { value: JudgesFilter; label: string }[] = [
  { value: "disagree", label: "Disagreements" },
  { value: "false_wake", label: "Likely false wakes" },
  { value: "missed_wake", label: "Likely missed wake words" },
  { value: "agree_yes", label: "All say yes" },
  { value: "agree_no", label: "All say no" },
  { value: "inconclusive", label: "Too few votes" },
  { value: "waiting", label: "Not judged yet" },
];

export function isMismatch(value: JudgesFilter): value is Mismatch {
  return value === "false_wake" || value === "missed_wake";
}
