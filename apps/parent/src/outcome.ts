// The weighted outcome of a clip's judges (ADR 0019): the one rule, in one
// place. The SQL in db/judging.ts computes the same thing for lists and
// filters (a test checks they agree), and the web UI imports this module
// for the Judges page's live example.
//
// Every judge that answered yes or no and counts (enabled, weight above 0)
// votes +1 or -1 times its weight. score = sum / total weight that voted,
// from -1 (all no) to +1 (all yes). Then:
//
// - waiting: a judge that counts and can run has not answered yet (the
//   score so far is provisional), or no judge has answered at all;
// - not_enough: the weight that voted is below `minimum`;
// - yes when score >= margin, no when score <= -margin, otherwise uncertain.

export type Outcome = "yes" | "no" | "uncertain" | "not_enough" | "waiting";

export interface OutcomeRule {
  /** 0 to 1: how far the score must lean to call it. */
  margin: number;
  /** The weight that must have voted, so one weak judge cannot decide. */
  minimum: number;
}

/** Margin 0.5; minimum 1.0, the default weight of one speech-to-text judge. */
export const DEFAULT_RULE: OutcomeRule = { margin: 0.5, minimum: 1 };

/** Default weights of new judges, by kind. */
export const DEFAULT_WEIGHT = { speech_to_text: 1, wake_word_model: 0.3, listening: 0.5 } as const;
export const MAX_WEIGHT = 10;

/** Float sums such as 0.3 + 0.3 + 0.4 must still reach 1. */
export const EPSILON = 1e-9;

export interface Vote {
  verdict: "yes" | "no" | "abstain";
  weight: number;
}

export interface Weighed {
  outcome: Outcome;
  /** -1 to +1, or null when no weight voted. Provisional while waiting. */
  score: number | null;
  /** The weight behind yes and behind no. */
  yesWeight: number;
  noWeight: number;
  /** Counted judges that voted yes or no. */
  yes: number;
  no: number;
  /** What the outcome would be without the judges still to answer. */
  provisional: Exclude<Outcome, "waiting"> | null;
}

/**
 * The outcome of `votes` (counted judges' latest answers) under `rule`.
 * `waiting`: a counted judge that can run on this clip has not answered.
 */
export function weigh(votes: readonly Vote[], rule: OutcomeRule, waiting = false): Weighed {
  let yesWeight = 0;
  let noWeight = 0;
  let yes = 0;
  let no = 0;
  let answered = 0;
  for (const v of votes) {
    if (!(v.weight > 0)) continue;
    answered++;
    if (v.verdict === "yes") {
      yesWeight += v.weight;
      yes++;
    } else if (v.verdict === "no") {
      noWeight += v.weight;
      no++;
    }
  }
  const total = yesWeight + noWeight;
  const score = total > 0 ? clamp((yesWeight - noWeight) / total) : null;
  const settled: Exclude<Outcome, "waiting"> =
    score === null || total < rule.minimum - EPSILON
      ? "not_enough"
      : score >= rule.margin - EPSILON
        ? "yes"
        : score <= -rule.margin + EPSILON
          ? "no"
          : "uncertain";
  const isWaiting = waiting || answered === 0;
  return {
    outcome: isWaiting ? "waiting" : settled,
    score,
    yesWeight,
    noWeight,
    yes,
    no,
    provisional: answered === 0 ? null : settled,
  };
}

/**
 * How sure the outcome is, 0 to 1: the share of the voting weight that is on
 * the outcome's side (for uncertain, on the side the score leans to).
 */
export function confidence(w: Pick<Weighed, "yesWeight" | "noWeight">): number | null {
  const total = w.yesWeight + w.noWeight;
  if (total <= 0) return null;
  return Math.max(w.yesWeight, w.noWeight) / total;
}

/** Whether a counted judge voted against a yes or no outcome. */
export function dissent(w: Pick<Weighed, "outcome" | "provisional" | "yes" | "no">): boolean {
  const o = w.outcome === "waiting" ? w.provisional : w.outcome;
  return (o === "yes" && w.no > 0) || (o === "no" && w.yes > 0);
}

function clamp(x: number): number {
  return Math.max(-1, Math.min(1, x));
}
