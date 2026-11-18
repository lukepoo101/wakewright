import { type Clip, kindLabel } from "../clips.ts";
import { shortDateTime } from "../format.ts";
import { usePlayer } from "../player.tsx";
import { scoreBar, scoreNumbers } from "../score.ts";
import styles from "./ClipBits.module.css";
import { Icon } from "./Icon.tsx";

// Small pieces every clip view shares: the kind chip, the clipped chip, the
// engine, the score bar and the play button.

export function KindChip({ kind }: { kind: Clip["kind"] }) {
  return (
    <span className={`${styles.chip} ${kind === "fired" ? styles.fired : styles.near}`}>
      <span className={styles.chipMark} aria-hidden="true" />
      {kindLabel(kind)}
    </span>
  );
}

/**
 * Shown when a clip has a run of full-scale samples (the parent's rule, in
 * clipping.ts); a few isolated full-scale samples are not flagged.
 * `labelClassName` lets a narrow layout hide the word and keep the icon.
 */
export function ClippedChip({
  clip,
  labelClassName = "",
}: {
  clip: Clip;
  labelClassName?: string;
}) {
  if (!clip.clipped) return null;
  return (
    <span className={`${styles.chip} ${styles.clipped}`} title={clippingText(clip)}>
      <Icon name="warning" size={14} />
      <span className={labelClassName}>Clipped</span>
    </span>
  );
}

/** The device's count of full-scale samples and the longest run, in words. */
export function clippingText(clip: Clip): string {
  const n = clip.clippedSamples;
  const count = `${n.toLocaleString("en-GB")} ${n === 1 ? "sample" : "samples"} at full scale`;
  const run = clip.clippedLongestRun;
  if (n <= 1 || run === null) return count;
  return run === 1 ? `${count}, none next to each other` : `${count}, up to ${run} in a row`;
}

/** The engine that scored the clip: scores of different engines use different scales. */
export function EngineName({ engine, className = "" }: { engine: string; className?: string }) {
  return <span className={`${styles.engine} ${className}`}>{engine}</span>;
}

/**
 * The score against the clip's own threshold: a bar with the threshold
 * marked in the middle, and the numbers on the engine's own scale. See
 * score.ts.
 */
export function ScoreBar({ score, threshold }: { score: number | null; threshold: number | null }) {
  if (score === null) return <span className={styles.muted}>no score</span>;
  const bar = scoreBar(score, threshold);
  const over = threshold !== null && score >= threshold;
  const numbers = scoreNumbers(score, threshold);
  return (
    <span className={styles.score}>
      {bar && (
        <span className={styles.track} aria-hidden="true">
          <span
            className={`${styles.fill} ${over ? styles.over : ""}`}
            style={{ width: `${bar.fill * 100}%` }}
          />
          <span className={styles.marker} />
        </span>
      )}
      <span className={styles.numbers}>
        {numbers.score}
        {numbers.threshold !== null && <span className={styles.muted}> / {numbers.threshold}</span>}
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
