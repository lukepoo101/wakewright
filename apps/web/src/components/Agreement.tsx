import type { ClipJudging } from "../judging.ts";
import { agreementLong, agreementShort } from "../judging.ts";
import styles from "./Agreement.module.css";
import { Icon, type IconName } from "./Icon.tsx";

// What the judges said about a clip, compactly: "3 of 3 yes", "2 of 3 yes",
// "Not judged". Icon and border style as well as colour tell the states
// apart; a clip where the judges agree against the device gets a warning
// icon and the alert colour. The full count is in the tooltip and is what
// screen readers hear.

const ICONS: Record<ClipJudging["agreement"], IconName> = {
  waiting: "clock",
  inconclusive: "minus",
  agree_yes: "check",
  agree_no: "cross",
  disagree: "notEqual",
};

export function AgreementChip({ judging }: { judging: ClipJudging }) {
  const long = agreementLong(judging);
  const tone = judging.mismatch ? styles.mismatch : styles[judging.agreement];
  return (
    <span className={`${styles.chip} ${tone}`} title={long}>
      <Icon name={judging.mismatch ? "warning" : ICONS[judging.agreement]} size={14} />
      <span aria-hidden="true">{agreementShort(judging)}</span>
      <span className={styles.visuallyHidden}>Judges: {long}</span>
    </span>
  );
}
