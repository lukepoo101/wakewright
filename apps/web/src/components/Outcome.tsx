import type { ClipJudging, Outcome } from "../judging.ts";
import { outcomeLong, outcomeShort } from "../judging.ts";
import { Icon, type IconName } from "./Icon.tsx";
import styles from "./Outcome.module.css";

// The judges' weighted outcome for a clip, compactly: "Yes · 100%",
// "Uncertain · 62% yes", "Waiting · yes so far". Icon and border style as
// well as colour tell the outcomes apart; a clip whose outcome is against
// the device gets a warning icon and the alert colour. The full sentence is
// in the tooltip and is what screen readers hear.

const ICONS: Record<Outcome, IconName> = {
  waiting: "clock",
  not_enough: "minus",
  yes: "check",
  no: "cross",
  uncertain: "notEqual",
};

export function OutcomeChip({ judging }: { judging: ClipJudging }) {
  const long = outcomeLong(judging);
  const tone = judging.mismatch ? styles.mismatch : styles[judging.outcome];
  return (
    <span className={`${styles.chip} ${tone}`} title={long}>
      <Icon name={judging.mismatch ? "warning" : ICONS[judging.outcome]} size={14} />
      <span aria-hidden="true">{outcomeShort(judging)}</span>
      <span className={styles.visuallyHidden}>Judges: {long}</span>
    </span>
  );
}
