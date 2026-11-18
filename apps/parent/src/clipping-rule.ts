// Clipping: samples at 16-bit full scale (32767 or -32768).
//
// A single full-scale sample is a peak that touched the top of the range
// for 62.5 µs; it adds no audible distortion and does not change what a
// model hears. Distortion comes from the waveform being flattened against
// the limit, which takes consecutive full-scale samples. So a clip is
// flagged as clipped when it has a run of at least CLIPPED_RUN consecutive
// full-scale samples: the default start threshold of Audacity's Find
// Clipping (https://manual.audacityteam.org/man/find_clipping.html). The
// device's count of full-scale samples is always shown on the clip page.

/** Consecutive full-scale samples that make a clip count as clipped. */
export const CLIPPED_RUN = 3;

export function isClipped(longestRun: number | null): boolean {
  return longestRun !== null && longestRun >= CLIPPED_RUN;
}
