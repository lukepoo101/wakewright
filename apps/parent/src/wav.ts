// A RIFF/WAVE header reader: enough to check that a clip is what a Kiosk
// Satellite saves (16 kHz, mono, 16-bit PCM) and how long it is. It walks
// the chunk list, so files with extra chunks (LIST, fact) are accepted, and
// it never reads past the buffer. No audio decoding happens on the server.

export interface WavInfo {
  format: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  dataOffset: number;
  dataBytes: number;
  durationMs: number;
}

export class WavError extends Error {
  override name = "WavError";
}

export function readWav(bytes: Uint8Array): WavInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) =>
    String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new WavError("not a RIFF/WAVE file");
  }

  let fmt: Pick<WavInfo, "format" | "channels" | "sampleRate" | "bitsPerSample"> | undefined;
  let at = 12;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === "fmt ") {
      if (size < 16 || body + 16 > bytes.length) throw new WavError("fmt chunk is truncated");
      fmt = {
        format: view.getUint16(body, true),
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        bitsPerSample: view.getUint16(body + 14, true),
      };
    } else if (id === "data") {
      if (!fmt) throw new WavError("data chunk comes before the fmt chunk");
      if (body + size > bytes.length) throw new WavError("data chunk is truncated");
      const bytesPerSecond = fmt.sampleRate * fmt.channels * (fmt.bitsPerSample / 8);
      return {
        ...fmt,
        dataOffset: body,
        dataBytes: size,
        durationMs: bytesPerSecond > 0 ? Math.round((size / bytesPerSecond) * 1000) : 0,
      };
    }
    // Chunks are padded to an even length.
    at = body + size + (size % 2);
  }
  throw new WavError(fmt ? "no data chunk" : "no fmt chunk");
}

export const CLIP_FORMAT = { sampleRate: 16_000, channels: 1, bitsPerSample: 16 } as const;
const MAX_CLIP_MS = 30_000;

/** Throws WavError unless the bytes are a 16 kHz mono 16-bit PCM clip of 30 s or less. */
export function checkClipWav(bytes: Uint8Array): WavInfo {
  const info = readWav(bytes);
  if (info.format !== 1) throw new WavError(`format ${info.format} is not PCM`);
  if (info.channels !== CLIP_FORMAT.channels)
    throw new WavError(`${info.channels} channels, not mono`);
  if (info.sampleRate !== CLIP_FORMAT.sampleRate) {
    throw new WavError(`${info.sampleRate} Hz, not ${CLIP_FORMAT.sampleRate} Hz`);
  }
  if (info.bitsPerSample !== CLIP_FORMAT.bitsPerSample) {
    throw new WavError(`${info.bitsPerSample}-bit, not 16-bit`);
  }
  if (info.dataBytes === 0 || info.dataBytes % 2 !== 0) throw new WavError("no whole samples");
  if (info.durationMs > MAX_CLIP_MS) throw new WavError(`${info.durationMs} ms is too long`);
  return info;
}
