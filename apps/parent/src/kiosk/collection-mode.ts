import type { CollectionEngine, CollectionOptions, SettingChange } from "../source.ts";
import type { Health, SettingEntry } from "./shapes.ts";
import { WakeSettingKeys } from "./shapes.ts";

// What a collection session changes on a Kiosk Satellite (ADR 0020): the
// wake word engine, its sensitivity preset and the fine-tune, each to its
// most sensitive value, keeping the wake words. Everything here is worked
// out from the device's own settings list (options, ranges, current
// values) and the app's documented behaviour, checked against its source
// (2026.11.23):
//
// - `voice.wake_word_engine`: vswakeword, microwakeword, openwakeword (and
//   pryon on the Echo images). One listens at a time; every model ships
//   with the app, so a switch needs no download or restart. Another engine
//   offers its own wake word ids: an id the new engine lacks falls back to
//   its first wake word, and the app tells Home Assistant so, which would
//   change the wake word. So an engine is offered only when it has every
//   wake word the device listens for now.
// - `voice.wake_word_sensitivity`: slightly, moderately, very. "very"
//   lowers every confidence gate of vsWakeWord and microWakeWord by 10%
//   and openWakeWord's cutoff by 0.1.
// - `voice.wake_word_fine_tune`: -10 to 10; each step lowers the gates by
//   another 2% (openWakeWord's cutoff by 0.01). Its maximum is read from
//   the setting's definition.
//
// The app applies a change at once: a settings change rebuilds the wake
// word configuration in the same moment.
//
// Fleets: a leader pushes its Voice Satellite settings (engine and
// sensitivity among them) to its followers, and overwrites a follower's
// own change of them. The fine-tune is never synced. So on a tablet that
// leads or follows a fleet only the fine-tune is raised.

/** The only keys a collection session may write. */
export const COLLECTION_KEYS = [
  WakeSettingKeys.engine,
  WakeSettingKeys.sensitivity,
  WakeSettingKeys.fineTune,
] as const;

/**
 * The engines in the order a session prefers them: microWakeWord first.
 * Kiosk Satellite does not rank its engines; at their most sensitive each
 * gate is lowered by the same share. microWakeWord is first because it is
 * the engine that has woken most often on the tablets this was built for,
 * and its probability cutoffs fall furthest (0.85–0.97 times 0.7).
 */
const PREFERENCE = ["microwakeword", "openwakeword", "vswakeword"];

/** The wake word models each engine ships with, by id. */
const BUNDLED: Record<string, readonly string[]> = {
  vswakeword: [
    "ok_nabu",
    "hey_jarvis",
    "alexa",
    "hey_mycroft",
    "hey_home_assistant",
    "hey_luna",
    "ok_computer",
    "ok_luna",
    "ok_nova",
    "ok_vesta",
    "hey_vesta",
    "hey_alfred",
  ],
  microwakeword: [
    "ok_nabu",
    "hey_jarvis",
    "alexa",
    "hey_mycroft",
    "hey_home_assistant",
    "hey_luna",
    "okay_computer",
    "hey_baby",
  ],
  openwakeword: [
    "ok_nabu",
    "hey_jarvis",
    "alexa",
    "hey_mycroft",
    "home_assistant",
    "hey_luna",
    "okay_computer",
    "hey_rhasspy",
  ],
};

const MOST_SENSITIVE = "very";
const FINE_TUNE_MAX = 10;

/** Works out what a session would change, for each engine the device offers. */
export function collectionOptions(settings: SettingEntry[], health: Health): CollectionOptions {
  const byKey = new Map(settings.map((s) => [s.key, s]));
  const engine = byKey.get(WakeSettingKeys.engine);
  const sensitivity = byKey.get(WakeSettingKeys.sensitivity);
  const fineTune = byKey.get(WakeSettingKeys.fineTune);
  const diagnostics = byKey.get(WakeSettingKeys.diagnostics)?.value;
  const words = wakeWordIds(byKey.get(WakeSettingKeys.wakeWords)?.value);
  const fleet = health.leader
    ? { role: "leader" as const, leader: null }
    : health.follows
      ? { role: "follower" as const, leader: health.follows }
      : null;

  const current = {
    engine: typeof engine?.value === "string" ? engine.value : null,
    engineLabel: labelOf(engine, engine?.value),
    sensitivity: typeof sensitivity?.value === "string" ? sensitivity.value : null,
    sensitivityLabel: labelOf(sensitivity, sensitivity?.value),
    fineTune: typeof fineTune?.value === "number" ? fineTune.value : null,
    wakeWords: words ?? [],
  };

  const problems: string[] = [];
  if (!engine || current.engine === null) problems.push("The device does not report its engine.");
  if (!sensitivity || current.sensitivity === null) {
    problems.push("The device does not report its wake word sensitivity.");
  }
  if (!fineTune || current.fineTune === null) {
    problems.push("The device does not report its fine-tune setting.");
  }
  if (words === null) problems.push("The device does not report its wake words.");
  if (diagnostics !== true) {
    problems.push(
      "Wake word diagnostics are off, so the device would save no clips. Turn them on first.",
    );
  }

  const targetSensitivity = sensitivity?.options?.includes(MOST_SENSITIVE)
    ? MOST_SENSITIVE
    : (sensitivity?.options?.at(-1) ?? MOST_SENSITIVE);
  const targetFineTune = typeof fineTune?.max === "number" ? fineTune.max : FINE_TUNE_MAX;
  const offered = (engine?.options ?? []).filter((o) => o in BUNDLED || o === current.engine);
  const ordered = [
    ...PREFERENCE.filter((o) => offered.includes(o)),
    ...offered.filter((o) => !PREFERENCE.includes(o)),
  ];

  const engines: CollectionEngine[] = ordered.map((value) => {
    const isCurrent = value === current.engine;
    let reason: string | null = null;
    if (!isCurrent && fleet) {
      reason =
        fleet.role === "leader"
          ? "This tablet leads a Kiosk Satellite fleet, which would pass a new engine on to the other tablets."
          : `This tablet follows ${fleet.leader} in a Kiosk Satellite fleet, which would put the engine back.`;
    } else if (!isCurrent) {
      const missing = (words ?? []).filter((w) => !BUNDLED[value]?.includes(w));
      if (missing.length > 0) {
        reason = `It has no ${missing.join(", ")} wake word, so the tablet would listen for another one.`;
      }
    }
    const changes: SettingChange[] = [];
    const change = (entry: SettingEntry | undefined, from: unknown, to: unknown) => {
      if (!entry || from === to) return;
      changes.push({
        key: entry.key,
        title: entry.title ?? entry.key,
        from,
        to,
        fromLabel: labelOf(entry, from),
        toLabel: labelOf(entry, to),
      });
    };
    change(engine, current.engine, value);
    // A fleet syncs the sensitivity preset too; leave it as it is there.
    if (!fleet) change(sensitivity, current.sensitivity, targetSensitivity);
    change(fineTune, current.fineTune, targetFineTune);
    return {
      value,
      label: labelOf(engine, value),
      current: isCurrent,
      available: reason === null,
      reason,
      recommended: false,
      changes,
    };
  });
  const recommended = engines.find((e) => e.available);
  if (recommended) recommended.recommended = true;

  return {
    ready: problems.length === 0 && recommended !== undefined,
    problems,
    current,
    fleet,
    engines,
    defaultEngine: recommended?.value ?? null,
  };
}

function labelOf(entry: SettingEntry | undefined, value: unknown): string {
  if (value === null || value === undefined) return "not set";
  if (typeof value === "string") return entry?.optionLabels?.[value] ?? value;
  if (typeof value === "number" && entry?.key === WakeSettingKeys.fineTune) {
    return value > 0 ? `+${value}` : String(value);
  }
  return String(value);
}

// `voice.wake_words` is a JSON list of model ids, slot 1 first.
function wakeWordIds(value: unknown): string[] | null {
  if (typeof value !== "string") return null;
  try {
    const list: unknown = JSON.parse(value);
    return Array.isArray(list) && list.every((x) => typeof x === "string")
      ? [...new Set(list as string[])]
      : null;
  } catch {
    return null;
  }
}

const TITLES: Record<string, string> = {
  [WakeSettingKeys.engine]: "Wake word engine",
  [WakeSettingKeys.sensitivity]: "Wake word sensitivity",
  [WakeSettingKeys.fineTune]: "Fine-tune sensitivity",
};
const VALUE_LABELS: Record<string, string> = {
  vswakeword: "vsWakeWord",
  microwakeword: "microWakeWord",
  openwakeword: "openWakeWord",
  pryon: "Amazon",
  slightly: "Slightly sensitive",
  moderately: "Moderately sensitive",
  very: "Very sensitive",
};

/** A collection setting's title and a value's label, without the device at hand. */
export function describeSetting(key: string, value: unknown): { title: string; label: string } {
  const title = TITLES[key] ?? key;
  if (typeof value === "string") return { title, label: VALUE_LABELS[value] ?? value };
  if (typeof value === "number" && key === WakeSettingKeys.fineTune) {
    return { title, label: value > 0 ? `+${value}` : String(value) };
  }
  return { title, label: value === null || value === undefined ? "not set" : String(value) };
}
