import type { Clip } from "../clips.ts";
import { ago, plural, useNow } from "../format.ts";
import { judgeName, type JudgingStatus, useJudgingStatus } from "../judging.ts";
import { AgreementChip } from "./Agreement.tsx";
import { ScoreBar } from "./ClipBits.tsx";
import styles from "./JudgesCard.module.css";
import { Alert, Card } from "./ui.tsx";

// The clip page's "What the judges said": the agreement in a sentence, a
// warning when the judges agree against the device, then each judge's
// latest verdict with its score against its threshold, what it heard, why
// it abstained and its version, and the judges that have not answered.

type Judges = {
  results: {
    judge: string;
    version: string;
    verdict: "yes" | "no" | "abstain";
    score: number | null;
    threshold: number | null;
    transcript: string | null;
    detail: string | null;
    durationMs: number;
    worker: string;
    judgedAt: string;
  }[];
  pending: { judge: string; reason: "waiting" | "no_model" }[];
};

export function JudgesCard({ clip, judges }: { clip: Clip; judges: Judges }) {
  const status = useJudgingStatus();
  const now = useNow();
  const j = clip.judging;
  const nothing = judges.results.length === 0;

  return (
    <Card className={styles.card}>
      <div className={styles.head}>
        <h2>What the judges said</h2>
        {!nothing && <AgreementChip judging={j} />}
      </div>

      {nothing ? (
        <p className={styles.summary}>{emptyText(status.data, judges)}</p>
      ) : (
        <p className={styles.summary}>{summary(clip)}</p>
      )}

      {j.mismatch === "false_wake" && (
        <Alert tone="error" title="Likely false wake">
          The device woke up, but the judges agree this clip is not its wake word.
        </Alert>
      )}
      {j.mismatch === "missed_wake" && (
        <Alert tone="error" title="Likely missed wake word">
          The device only nearly woke up, but the judges agree this clip is its wake word.
        </Alert>
      )}

      {(judges.results.length > 0 || judges.pending.length > 0) && (
        <ul className={styles.judges}>
          {sortJudges(judges.results).map((r) => (
            <li key={r.judge} className={styles.judge} style={{ order: judgeOrder(r.judge) }}>
              <div className={styles.judgeHead}>
                <h3>{judgeName(r.judge)}</h3>
                <Verdict verdict={r.verdict} />
              </div>
              {r.score !== null && (
                <div className={styles.line}>
                  <ScoreBar score={r.score} threshold={r.threshold} />
                  {r.threshold !== null && (
                    <span className={styles.muted}>
                      {r.score >= r.threshold ? "at or over its threshold" : "under its threshold"}
                    </span>
                  )}
                </div>
              )}
              {r.transcript !== null && (
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
              <p className={styles.meta}>
                Version <code>{r.version}</code> · {r.worker} · {ago(r.judgedAt, now)} ·{" "}
                {r.durationMs.toLocaleString("en-GB")} ms
              </p>
            </li>
          ))}
          {judges.pending.map((p) => (
            <li key={p.judge} className={styles.judge} style={{ order: judgeOrder(p.judge) }}>
              <div className={styles.judgeHead}>
                <h3>{judgeName(p.judge)}</h3>
                <span className={`${styles.verdict} ${styles.none}`}>
                  {p.reason === "waiting" ? "Not judged yet" : "Not judged"}
                </span>
              </div>
              {p.reason === "no_model" && (
                <p className={styles.line}>
                  <span className={styles.muted}>
                    No model for “{clip.wakeWord}” on any worker.
                  </span>
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// The wake word judges first, then speech to text, then any others.
const ORDER = ["openwakeword", "microwakeword", "stt"];
function judgeOrder(name: string): number {
  const i = ORDER.indexOf(name);
  return i === -1 ? ORDER.length : i;
}
function sortJudges<T extends { judge: string }>(list: T[]): T[] {
  return [...list].sort((a, b) => judgeOrder(a.judge) - judgeOrder(b.judge));
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

function summary(clip: Clip): string {
  const j = clip.judging;
  const votes = j.yes + j.no;
  const said = (n: number) => (n === 1 ? "1 judge says" : `${n} judges say`);
  const abstained =
    j.abstain > 0
      ? ` ${plural(j.abstain, "judge")} could not tell, so ${j.abstain === 1 ? "its" : "their"} answer does not count.`
      : "";
  const all = votes === 2 ? "Both judges" : `All ${votes} judges`;
  switch (j.agreement) {
    case "agree_yes":
      return `${all} that answered say this is the wake word, “${clip.wakeWord}”.${abstained}`;
    case "agree_no":
      return `${all} that answered say this is not the wake word, “${clip.wakeWord}”.${abstained}`;
    case "disagree":
      return `The judges disagree: ${said(j.yes)} it is the wake word, ${said(j.no)} it is not.${abstained}`;
    case "inconclusive":
      return `Too few votes to tell: ${votes === 0 ? "no judge could" : "only one judge could"} say whether this is the wake word.${abstained}`;
    case "waiting":
      return "No judge has answered yet.";
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
    return "No connected worker can judge this wake word.";
  }
  return "Waiting for the judges. A connected worker judges new clips within seconds, and older ones as it works through them, newest first.";
}
