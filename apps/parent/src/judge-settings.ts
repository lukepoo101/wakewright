// Judge type settings: the declarative schema a worker advertises for each
// judge type (docs/judges.md), checking a judge's settings against it, and
// the fingerprint of the settings that can change a verdict. The parent has
// no code per type: any type's form, validation and re-judging follow from
// its schema.

/** "long_text" is text shown as several lines (a prompt). */
export const SETTING_TYPES = [
  "text",
  "long_text",
  "secret",
  "number",
  "select",
  "boolean",
] as const;
export type SettingType = (typeof SETTING_TYPES)[number];
export type SettingValue = string | number | boolean | null;

export interface SettingField {
  key: string;
  label: string;
  type: SettingType;
  help: string;
  default: SettingValue;
  required: boolean;
  options: { value: string; label: string }[];
  minimum: number | null;
  maximum: number | null;
  placeholder: string;
  /** Changing it can change a verdict: the judge judges every clip again. Never true for a secret. */
  affectsVerdict: boolean;
}

export const TEXT_MAX = 2000;
export const LONG_TEXT_MAX = 8000;
export const SECRET_MAX = 4000;

/** A judge's settings, split: plain values, and secret ones (never shown again). */
export interface CheckedSettings {
  values: Record<string, SettingValue>;
  /** Every secret setting's value after the change: a string, or null when unset. */
  secrets: Record<string, string | null>;
}

export type SettingsCheck =
  ({ ok: true } & CheckedSettings) | { ok: false; errors: Record<string, string> };

/**
 * Checks `input` against `schema`. For an edit, `current` is what is
 * stored: a plain value left out keeps its current value, a secret left out
 * is kept, and a secret sent as null or "" is removed. A new judge starts
 * from each field's default.
 */
export function checkSettings(
  schema: readonly SettingField[],
  input: Record<string, unknown>,
  current?: CheckedSettings,
): SettingsCheck {
  const errors: Record<string, string> = {};
  const values: Record<string, SettingValue> = {};
  const secrets: Record<string, string | null> = {};
  const known = new Set(schema.map((f) => f.key));
  for (const key of Object.keys(input)) {
    if (!known.has(key)) errors[key] = "This judge type has no such setting.";
  }
  for (const f of schema) {
    const given = Object.hasOwn(input, f.key) ? input[f.key] : undefined;
    if (f.type === "secret") {
      const kept = current?.secrets[f.key] ?? null;
      let value: string | null = kept;
      if (given === null || given === "") value = null;
      else if (typeof given === "string") value = given.trim();
      else if (given !== undefined) errors[f.key] = "Enter text.";
      if (value !== null && value.length > SECRET_MAX) {
        errors[f.key] = `At most ${SECRET_MAX} characters.`;
      }
      if (f.required && !value && !errors[f.key]) errors[f.key] = `Enter the ${lower(f.label)}.`;
      secrets[f.key] = value || null;
      continue;
    }
    const fallback = current ? (current.values[f.key] ?? f.default) : f.default;
    const raw = given === undefined ? fallback : given === null ? f.default : given;
    const checked = checkValue(f, raw);
    if ("error" in checked) errors[f.key] = checked.error;
    else values[f.key] = checked.value;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, values, secrets };
}

function checkValue(f: SettingField, raw: unknown): { value: SettingValue } | { error: string } {
  const empty = raw === null || raw === undefined || raw === "";
  switch (f.type) {
    case "text":
    case "long_text": {
      if (!empty && typeof raw !== "string") return { error: "Enter text." };
      const value = empty ? "" : (raw as string).trim();
      const max = f.type === "long_text" ? LONG_TEXT_MAX : TEXT_MAX;
      if (value.length > max) return { error: `At most ${max} characters.` };
      if (f.required && !value) return { error: `Enter the ${lower(f.label)}.` };
      return { value };
    }
    case "number": {
      if (empty) return f.required ? { error: "Enter a number." } : { value: null };
      const n = typeof raw === "string" ? Number(raw) : raw;
      if (typeof n !== "number" || !Number.isFinite(n)) return { error: "Enter a number." };
      if (f.minimum !== null && n < f.minimum) return { error: `At least ${f.minimum}.` };
      if (f.maximum !== null && n > f.maximum) return { error: `At most ${f.maximum}.` };
      return { value: n };
    }
    case "select": {
      if (empty) return f.required ? { error: "Choose one." } : { value: null };
      if (typeof raw !== "string" || !f.options.some((o) => o.value === raw)) {
        return { error: "Choose one of the options." };
      }
      return { value: raw };
    }
    case "boolean": {
      if (empty) return { value: false };
      if (typeof raw !== "boolean") return { error: "Choose yes or no." };
      return { value: raw };
    }
    case "secret":
      return { error: "unreachable" };
  }
}

/**
 * The fingerprint of the settings that can change a verdict: the SHA-256 of
 * their canonical JSON (keys sorted). A judge with none has sha256("{}").
 * Weight, name, limits, secrets and fields marked not to affect the verdict
 * are left out, so changing them judges nothing again.
 */
export function fingerprint(
  schema: readonly SettingField[],
  values: Record<string, SettingValue>,
): string {
  const affecting = schema
    .filter((f) => f.type !== "secret" && f.affectsVerdict)
    .map((f) => f.key)
    .sort();
  const canonical: Record<string, SettingValue> = {};
  for (const key of affecting) canonical[key] = values[key] ?? null;
  return new Bun.CryptoHasher("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/** sha256("{}"): the fingerprint of a judge whose settings change nothing. */
export const EMPTY_FINGERPRINT = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

function lower(label: string): string {
  return label.length > 1 && label[1] === label[1]?.toUpperCase()
    ? label
    : label.charAt(0).toLowerCase() + label.slice(1);
}
