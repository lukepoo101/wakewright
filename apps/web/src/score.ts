// Scores as the devices report them. Each engine has its own scale:
// microWakeWord and openWakeWord report a probability (0 to 1), vsWakeWord
// a match score with thresholds around 10 and scores that can pass 20. So
// nothing here assumes a maximum; scores are read against the threshold.

/**
 * Score and threshold as text, with the same number of decimals for both:
 * two on a 0–1 scale ("0.82", "0.60"), fewer on larger ones ("15.6", "10.5").
 */
export function scoreNumbers(
  score: number,
  threshold: number | null = null,
): { score: string; threshold: string | null } {
  const size = Math.max(Math.abs(score), Math.abs(threshold ?? 0));
  const digits = size < 10 ? 2 : size < 100 ? 1 : 0;
  const format = new Intl.NumberFormat("en-GB", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  return {
    score: format.format(score),
    threshold: threshold === null ? null : format.format(threshold),
  };
}

/**
 * Where the score bar's fill ends and its threshold marker sits, as
 * fractions of the bar. A probability (score and threshold both within
 * 0–1) is drawn on 0–1. On any other scale the bar runs from 0 to twice the
 * threshold, so the marker sits in the middle and a score more than double
 * the threshold fills it. Null when there is no scale to draw on (a score
 * above 1 with no threshold).
 */
export function scoreBar(
  score: number,
  threshold: number | null,
): { fill: number; marker: number | null } | null {
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  if (threshold !== null && threshold > 0 && (threshold > 1 || score > 1)) {
    return { fill: clamp(score / (2 * threshold)), marker: 0.5 };
  }
  if (threshold === null && score > 1) return null;
  return { fill: clamp(score), marker: threshold === null ? null : clamp(threshold) };
}

/** One sentence on how the score compares with the threshold. */
export function scoreSummary(score: number, threshold: number | null): string {
  if (threshold === null || threshold <= 0) return "";
  // Rounded down, so a score never reads as more than it was (99.9% is not
  // 100%, and 1.99 times is not 2).
  if (score >= threshold) {
    const times = Math.floor((score / threshold) * 10) / 10;
    return times >= 2
      ? `${times.toFixed(1)} times the threshold: the wake word fired.`
      : "Over the threshold: the wake word fired.";
  }
  return `Reached ${Math.floor((score / threshold) * 100)}% of the threshold.`;
}
