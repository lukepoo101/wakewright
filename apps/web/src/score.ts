// Scores as the devices report them. Each engine has its own scale:
// microWakeWord and openWakeWord report a probability (0 to 1), vsWakeWord
// a match score with thresholds around 10 and scores that can pass 20. So
// nothing here assumes a maximum; scores are read against the clip's own
// threshold, and the engine is shown beside every score.

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
 * Where the score bar's fill ends, as a fraction of the bar. Engines score
 * on different scales, so the bar always shows the score against the
 * clip's own threshold: it runs from 0 to twice the threshold, the
 * threshold marker sits in the middle, and a score of twice the threshold
 * or more fills it. Bars of different engines compare fairly. Null when
 * there is no threshold to read the score against.
 */
export function scoreBar(score: number, threshold: number | null): { fill: number } | null {
  if (threshold === null || threshold <= 0) return null;
  return { fill: Math.max(0, Math.min(1, score / (2 * threshold))) };
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
