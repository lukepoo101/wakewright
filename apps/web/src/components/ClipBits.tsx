import { type Clip, kindLabel } from "../clips.ts";
import { shortDateTime } from "../format.ts";
import { usePlayer } from "../player.tsx";
import styles from "./ClipBits.module.css";
import { Icon } from "./Icon.tsx";

// Small pieces every clip view shares: the kind chip, the score bar and the
// play button.

export function KindChip({ kind }: { kind: Clip["kind"] }) {
  return (
    <span className={`${styles.chip} ${kind === "fired" ? styles.fired : styles.near}`}>
      <span className={styles.chipMark} aria-hidden="true" />
      {kindLabel(kind)}
    </span>
  );
}

export function ClippedChip({ samples }: { samples: number }) {
  if (samples === 0) return null;
  return (
    <span
      className={`${styles.chip} ${styles.clipped}`}
      title={`${samples.toLocaleString("en-GB")} samples at full scale`}
    >
      <Icon name="warning" size={14} />
      Clipped
    </span>
  );
}

/** The score against the threshold: a bar with a marker, and the numbers. */
export function ScoreBar({ score, threshold }: { score: number | null; threshold: number | null }) {
  if (score === null) return <span className={styles.muted}>no score</span>;
  const pct = (x: number) => `${Math.max(0, Math.min(1, x)) * 100}%`;
  const over = threshold !== null && score >= threshold;
  return (
    <span className={styles.score}>
      <span className={styles.track} aria-hidden="true">
        <span
          className={`${styles.fill} ${over ? styles.over : ""}`}
          style={{ width: pct(score) }}
        />
        {threshold !== null && <span className={styles.marker} style={{ left: pct(threshold) }} />}
      </span>
      <span className={styles.numbers}>
        {score.toFixed(2)}
        {threshold !== null && <span className={styles.muted}> / {threshold.toFixed(2)}</span>}
      </span>
    </span>
  );
}

export function PlayButton({ clip, size = "normal" }: { clip: Clip; size?: "normal" | "large" }) {
  const player = usePlayer();
  const active = player.current === clip.id;
  const playing = active && player.playing;
  const what = `${kindLabel(clip.kind).toLowerCase()} from ${clip.deviceName}, ${shortDateTime(clip.capturedAt)}`;
  return (
    <button
      type="button"
      className={`${styles.play} ${active ? styles.active : ""} ${size === "large" ? styles.large : ""}`}
      aria-label={playing ? `Pause ${what}` : `Play ${what}`}
      onClick={() => player.toggle(clip.id)}
    >
      <Icon name={playing ? "pause" : "play"} size={size === "large" ? 22 : 18} />
    </button>
  );
}
