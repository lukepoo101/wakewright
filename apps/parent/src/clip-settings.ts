import type { ClipEntry, ReportedState } from "./source.ts";

// The device settings a clip was recorded under ("device settings then").
//
// A device reports its settings now, not the settings an older clip was
// recorded with, and a newly added device hands over clips from days ago.
// So a clip gets the settings Wakewright read from the device only when
// they were read within SETTINGS_WINDOW_MS of the moment the clip was
// recorded, and only when they name the engine the clip itself reports.
// Otherwise the clip's settings are unknown (NULL). The clip's own engine,
// wake word, score and threshold come from the device's entry and are
// always authoritative. See ADR 0014.

/** How far apart a clip and a settings read may be for the read to describe the clip. */
export const SETTINGS_WINDOW_MS = 5 * 60_000;

export interface SettingsSnapshot {
  engine: string | null;
  wakeWords: string[] | null;
  sensitivity: string | null;
  fineTune: number | null;
}

/** The settings to store with a clip, or null when they are not known. */
export function settingsForClip(
  entry: Pick<ClipEntry, "capturedAt" | "engine">,
  reported: ReportedState,
  readAt: number,
): SettingsSnapshot | null {
  if (Math.abs(readAt - Date.parse(entry.capturedAt)) > SETTINGS_WINDOW_MS) return null;
  if (reported.engine !== null && reported.engine.toLowerCase() !== entry.engine.toLowerCase()) {
    return null;
  }
  return {
    engine: reported.engine,
    wakeWords: reported.wakeWords,
    sensitivity: reported.sensitivity,
    fineTune: reported.fineTune,
  };
}
