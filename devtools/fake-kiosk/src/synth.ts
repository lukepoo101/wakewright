// Synthetic test clips, generated in code: tones, chirps and noise only.
// They have the format a Kiosk Satellite clip has (3.00 s, 16 kHz, mono,
// PCM16 WAV) but no speech, and nothing here is copied from any device or
// app. Real household audio never enters this repository.

export const SAMPLE_RATE = 16_000;
export const CLIP_SECONDS = 3;

export type Signal =
  | { kind: "tone"; hz: number }
  | { kind: "chirp"; fromHz: number; toHz: number }
  | { kind: "noise"; seed: number };

/** Mono PCM16 samples for one clip; amplitude is a fraction of full scale. */
export function synthesize(signal: Signal, amplitude = 0.3): Int16Array {
  const n = SAMPLE_RATE * CLIP_SECONDS;
  const out = new Int16Array(n);
  const random = mulberry32(signal.kind === "noise" ? signal.seed : 0);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    let x: number;
    if (signal.kind === "noise") {
      x = random() * 2 - 1;
    } else {
      const hz =
        signal.kind === "tone" ? signal.hz : signal.fromHz + (signal.toHz - signal.fromHz) * t;
      phase += (2 * Math.PI * hz) / SAMPLE_RATE;
      x = Math.sin(phase);
    }
    // 50 ms fades at each end avoid clicks.
    const fade = Math.min(1, i / 800, (n - 1 - i) / 800);
    out[i] = Math.round(x * amplitude * fade * 32767);
  }
  return out;
}

/** A canonical 44-byte-header RIFF/WAVE file for mono PCM16 samples. */
export function encodeWav(samples: Int16Array, sampleRate = SAMPLE_RATE): Uint8Array {
  const dataBytes = samples.length * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const ascii = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  ascii(0, "RIFF");
  v.setUint32(4, 36 + dataBytes, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // channels
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  v.setUint32(40, dataBytes, true);
  new Int16Array(buf, 44).set(samples);
  return new Uint8Array(buf);
}

/** Peak and RMS level in dBFS, and the number of full-scale samples. */
export function levels(samples: Int16Array): {
  peakDb: number | null;
  rmsDb: number | null;
  clipped: number;
} {
  let peak = 0;
  let sumSquares = 0;
  let clipped = 0;
  for (const s of samples) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
    if (a >= 32767) clipped++;
    sumSquares += s * s;
  }
  const db = (x: number) => (x > 0 ? Math.round(20 * Math.log10(x / 32767) * 10) / 10 : null);
  return { peakDb: db(peak), rmsDb: db(Math.sqrt(sumSquares / samples.length)), clipped };
}

// Small seeded PRNG so noise clips are identical on every run.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
