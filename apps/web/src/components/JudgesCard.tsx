import { Link } from "@tanstack/react-router";
import type { Clip } from "../clips.ts";
import { ago, useNow } from "../format.ts";
import {
  type JudgingStatus,
  OUTCOME_LABELS,
  percent,
  signedScore,
  useJudgingStatus,
} from "../judging.ts";
import { ScoreBar } from "./ClipBits.tsx";
import styles from "./JudgesCard.module.css";
import { OutcomeChip } from "./Outcome.tsx";
import { Alert, Card } from "./ui.tsx";

// The clip page's "What the judges said": the weighted outcome in a
// sentence with its score, a warning when it is against the device, then
// each judge's latest verdict with its weight, score against its
// threshold, what it heard (a transcript, or a listening model's own
// note), why it abstained and its version, and the
// judges that have not answered, with why.

type Result = {
  judgeId: string;
  name: string;
  typeName: string;
  kind: "wake_word_model" | "speech_to_text" | "listening";
  weight: number;
  status: "counted" | "not_counted" | "off" | "deleted";
  current: boolean;
  version: string;
  verdict: "yes" | "no" | "abstain";
  score: number | null;
  threshold: number | null;
  transcript: string | null;
  detail: string | null;
  durationMs: number;
  worker: string;
  judgedAt: string;
};

type Pending = {
  judgeId: string;
  name: string;
  typeName: string;
  weight: number;
  reason:
    "waiting" | "rejudging" | "no_model" | "failing" | "limited" | "no_worker" | "not_counted";
};

type Judges = { results: Result[]; pending: Pending[] };

const PENDING_TEXT: Record<Pending["reason"], string> = {
  waiting: "Not judged yet.",
  rejudging: "Its settings or version changed: waiting to judge this clip again.",
  no_model: "Its type has no model for this wake word.",
  failing: "Paused after a failure; see Judges.",
  limited: "At its daily limit; it judges newer clips first.",
  no_worker: "No connected worker can run it.",
  not_counted: "Weight 0: not run for the outcome.",
};

export function JudgesCard({ clip, judges }: { clip: Clip; judges: Judges }) {
  const status = useJudgingStatus();
  const now = useNow();
  const j = clip.judging;
  const nothing = judges.results.length === 0;
  const rule = status.data?.rule;

  return (
    <Card className={styles.card}>
      <div className={styles.head}>
        <h2>What the judges said</h2>
        {!nothing && <OutcomeChip judging={j} />}
      </div>

      <p className={styles.summary}>
        {nothing ? emptyText(status.data, judges) : summary(clip, rule)}{" "}
        {!nothing && <Link to="/judges">How the outcome is decided</Link>}
      </p>

      {j.mismatch === "false_wake" && (
        <Alert tone="error" title="Likely false wake">
          The device woke up, but the judges' weighted outcome is that this clip is not its wake
          word.
        </Alert>
      )}
      {j.mismatch === "missed_wake" && (
        <Alert tone="error" title="Likely missed wake word">
          The device only nearly woke up, but the judges' weighted outcome is that this clip is its
          wake word.
        </Alert>
      )}

      {(judges.results.length > 0 || judges.pending.length > 0) && (
        <ul className={styles.judges}>
          {judges.results.map((r) => {
            const pending = judges.pending.find((p) => p.judgeId === r.judgeId);
            return (
              <li
                key={r.judgeId}
                className={`${styles.judge} ${r.status === "counted" ? "" : styles.uncounted}`}
              >
                <div className={styles.judgeHead}>
                  <div className={styles.judgeName}>
                    <h3>{r.name}</h3>
                    <span className={styles.muted}>{r.typeName}</span>
                  </div>
                  <Verdict verdict={r.verdict} />
                </div>
                <p className={styles.weight}>{weightText(r)}</p>
                {r.score !== null && (
                  <div className={styles.line}>
                    <ScoreBar score={r.score} threshold={r.threshold} />
                    {r.threshold !== null && (
                      <span className={styles.muted}>
                        {r.score >= r.threshold
                          ? "at or over its threshold"
                          : "under its threshold"}
                      </span>
                    )}
                  </div>
                )}
                {r.transcript !== null && r.kind === "listening" && (
                  <p className={styles.line}>
                    <span className={styles.muted}>Its note, not a transcript</span>{" "}
                    {r.transcript || <span className={styles.muted}>none</span>}
                  </p>
                )}
                {r.transcript !== null && r.kind !== "listening" && (
                  <p className={styles.line}>
                    <span className={styles.muted}>Heard</span>{" "}
                    {r.transcript ? (
                      <q className={styles.transcript}>{r.transcript}</q>
                    ) : (
                      <span className={styles.muted}>nothing</span>
                    )}
                  </p>
                )}
                {r.detail !== null && (
                  <p className={styles.line}>
                    <span className={styles.muted}>
                      {r.verdict === "abstain" ? "Why it abstained" : "Note"}
                    </span>{" "}
                    {r.detail}
                  </p>
                )}
                {(!r.current || pending) && r.status !== "deleted" && (
                  <p className={styles.line}>
                    <span className={styles.muted}>
                      {pending ? PENDING_TEXT[pending.reason] : "Judged with earlier settings."}
                    </span>
                  </p>
                )}
                <p className={styles.meta}>
                  Version <code>{r.version}</code> · {r.worker} · {ago(r.judgedAt, now)} ·{" "}
                  {r.durationMs.toLocaleString("en-GB")} ms
                </p>
              </li>
            );
          })}
          {judges.pending
            .filter((p) => !judges.results.some((r) => r.judgeId === p.judgeId))
            .map((p) => (
              <li key={p.judgeId} className={styles.judge}>
                <div className={styles.judgeHead}>
                  <div className={styles.judgeName}>
                    <h3>{p.name}</h3>
                    <span className={styles.muted}>{p.typeName}</span>
                  </div>
                  <span className={`${styles.verdict} ${styles.none}`}>
                    {p.reason === "waiting" ? "Not judged yet" : "Not judged"}
                  </span>
                </div>
                <p className={styles.weight}>Weight {p.weight.toFixed(1)}</p>
                <p className={styles.line}>
                  <span className={styles.muted}>
                    {p.reason === "no_model"
                      ? `No model for “${clip.wakeWord}”.`
                      : PENDING_TEXT[p.reason]}
                  </span>
                </p>
              </li>
            ))}
        </ul>
      )}
    </Card>
  );
}

function weightText(r: Result): string {
  switch (r.status) {
    case "counted":
      return `Weight ${r.weight.toFixed(1)} · counted`;
    case "not_counted":
      return "Weight 0 · shown, not counted";
    case "off":
      return "Turned off · not counted";
    case "deleted":
      return "Deleted judge · not counted";
  }
}

function Verdict({ verdict }: { verdict: "yes" | "no" | "abstain" }) {
  const text = { yes: "Yes", no: "No", abstain: "Abstained" }[verdict];
  return (
    <span className={`${styles.verdict} ${styles[verdict]}`}>
      <span className={styles.visuallyHidden}>Verdict: </span>
      {text}
    </span>
  );
}

function summary(clip: Clip, rule: { margin: number; minimum: number } | undefined): string {
  const j = clip.judging;
  const weight = j.yesWeight + j.noWeight;
  const score =
    j.score === null ? "" : ` Score ${signedScore(j.score)} from ${weight.toFixed(1)} of weight.`;
  const needs = rule
    ? ` It needs ${signedScore(rule.margin)} or more for yes, ${signedScore(-rule.margin)} or less for no, and at least ${rule.minimum.toFixed(1)} of weight.`
    : "";
  const share = j.confidence === null ? "" : percent(j.confidence);
  switch (j.outcome) {
    case "yes":
      return `Yes: ${share} of the voting weight says this is the wake word, “${clip.wakeWord}”.${score}`;
    case "no":
      return `No: ${share} of the voting weight says this is not the wake word, “${clip.wakeWord}”.${score}`;
    case "uncertain":
      return `Uncertain: the judges lean ${j.yesWeight >= j.noWeight ? "yes" : "no"} (${share}), but not by enough to call it.${score}${needs}`;
    case "not_enough":
      return `Not enough evidence: too little weight voted to decide.${score}${needs}`;
    case "waiting":
      return j.provisional === null
        ? "No judge that counts has answered yet."
        : `Waiting for judges. So far: ${OUTCOME_LABELS[j.provisional].toLowerCase()}.${score}`;
  }
}

function emptyText(status: JudgingStatus | undefined, judges: Judges): string {
  if (status && status.workers.length === 0) {
    return "No workers yet. Add one under Workers and start it, and every clip is judged automatically.";
  }
  if (status && !status.workers.some((w) => w.reported.lastSeenAt)) {
    return "No worker has connected yet. Start one with its token, from Workers, to have this clip judged.";
  }
  if (status && !status.workers.some((w) => w.connected && w.enabled)) {
    return "No worker is connected at the moment. This clip is judged when one connects.";
  }
  if (judges.pending.length > 0 && judges.pending.every((p) => p.reason === "no_model")) {
    return "No judge can judge this wake word.";
  }
  return "Waiting for the judges. A connected worker judges new clips within seconds, and older ones as it works through them, newest first.";
}
