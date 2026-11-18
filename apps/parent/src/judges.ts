import type { Database } from "bun:sqlite";
import { KEY_VERSION, type SecretBox, SecretUnreadable } from "./crypto.ts";
import { getSecret, insertSecret } from "./db/devices.ts";
import {
  type AdvertisedType,
  deleteUnusedJudgeSecrets,
  getInstance,
  getRule,
  getType,
  type InstanceChanges,
  type InstanceRow,
  insertInstance,
  instanceByName,
  type JudgeKind,
  type JudgeTypeRow,
  listInstances,
  listTypes,
  markDeleted,
  recordFailure,
  setRule,
  updateInstance,
} from "./db/judges.ts";
import {
  type CheckedSettings,
  checkSettings,
  fingerprint,
  type SettingField,
  type SettingValue,
} from "./judge-settings.ts";
import type { Logger } from "./log.ts";
import { DEFAULT_WEIGHT, MAX_WEIGHT, type OutcomeRule } from "./outcome.ts";

// Judges as the owner configures them (ADR 0019): instances of the judge
// types workers advertise, each with settings, a weight, a daily limit and
// an on/off switch. The parent has no code per type: the form and checks
// come from the type's settings schema (judge-settings.ts).
//
// Secret settings (API keys) are sealed together as one JSON object with
// the instance key (crypto.ts), as device passwords are. They never leave
// this module except inside a job for a worker that may run the judge
// (settingsFor), are never returned by the API (the UI sees only which are
// set) and are never logged.

export const NAME_MAX = 64;
export const DAILY_LIMIT_MAX = 1_000_000;

export interface InstanceInput {
  name: string;
  type: string;
  settings?: Record<string, unknown>;
  weight?: number;
  enabled?: boolean;
  dailyLimit?: number | null;
}

export interface InstanceUpdate {
  name?: string;
  settings?: Record<string, unknown>;
  weight?: number;
  enabled?: boolean;
  dailyLimit?: number | null;
}

export type JudgeFailure =
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "unknown_type" }
  | { ok: false; reason: "name_taken" }
  | { ok: false; reason: "invalid"; errors: Record<string, string> };

export type JudgeOutcome<T> = ({ ok: true } & T) | JudgeFailure;

export interface JudgesOptions {
  db: Database;
  box: SecretBox;
  log: Logger;
  now?: () => number;
  /** A judge changed: waiting worker claims look again. */
  onChange?: () => void;
}

/** A judge type, parsed. */
export interface JudgeTypeInfo {
  id: string;
  name: string;
  kind: JudgeKind;
  description: string;
  external: boolean;
  version: string;
  wakeWords: string[] | null;
  settings: SettingField[];
  /** False: known only from earlier results; no worker has advertised it. */
  advertised: boolean;
  lastSeenAt: string | null;
}

export function toTypeInfo(row: JudgeTypeRow): JudgeTypeInfo {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    description: row.description,
    external: row.external === 1,
    version: row.version,
    wakeWords: row.wake_words_json === null ? null : (JSON.parse(row.wake_words_json) as string[]),
    settings: JSON.parse(row.settings_json) as SettingField[],
    advertised: row.last_seen_at !== null,
    lastSeenAt: row.last_seen_at,
  };
}

export class Judges {
  private readonly db: Database;
  private readonly box: SecretBox;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly onChange: () => void;

  constructor(options: JudgesOptions) {
    this.db = options.db;
    this.box = options.box;
    this.log = options.log.child({ component: "judges" });
    this.now = options.now ?? Date.now;
    this.onChange = options.onChange ?? (() => {});
  }

  types(): JudgeTypeInfo[] {
    return listTypes(this.db).map(toTypeInfo);
  }

  type(id: string): JudgeTypeInfo | null {
    const row = getType(this.db, id);
    return row ? toTypeInfo(row) : null;
  }

  list(): InstanceRow[] {
    return listInstances(this.db);
  }

  get(id: string): InstanceRow | null {
    const row = getInstance(this.db, id);
    return row && row.deleted_at === null ? row : null;
  }

  /** Which secret settings a judge has set, for the UI: never their values. */
  async secretsSet(row: InstanceRow): Promise<Record<string, boolean>> {
    const type = this.type(row.type);
    const secrets = await this.openSecrets(row).catch(() => ({}) as Record<string, string | null>);
    const out: Record<string, boolean> = {};
    for (const f of type?.settings ?? []) {
      if (f.type === "secret") out[f.key] = Boolean(secrets[f.key]);
    }
    return out;
  }

  async create(input: InstanceInput): Promise<JudgeOutcome<{ judge: InstanceRow }>> {
    const type = this.type(input.type);
    if (!type) return { ok: false, reason: "unknown_type" };
    if (instanceByName(this.db, input.name)) return { ok: false, reason: "name_taken" };
    const checked = checkSettings(type.settings, input.settings ?? {});
    if (!checked.ok) return { ok: false, reason: "invalid", errors: checked.errors };
    const id = Bun.randomUUIDv7();
    const at = this.iso();
    const secretId = await this.sealSecrets(checked.secrets, at);
    insertInstance(this.db, {
      id,
      name: input.name,
      type: type.id,
      settingsJson: JSON.stringify(checked.values),
      secretId,
      fingerprint: fingerprint(type.settings, checked.values),
      weight: input.weight ?? DEFAULT_WEIGHT[type.kind],
      enabled: input.enabled ?? true,
      dailyLimit: input.dailyLimit ?? null,
      at,
    });
    this.log.info("added a judge", { judge: input.name, type: type.id });
    this.onChange();
    return { ok: true, judge: getInstance(this.db, id) as InstanceRow };
  }

  async update(id: string, changes: InstanceUpdate): Promise<JudgeOutcome<{ judge: InstanceRow }>> {
    const row = this.get(id);
    if (!row) return { ok: false, reason: "not_found" };
    if (changes.name !== undefined) {
      const other = instanceByName(this.db, changes.name);
      if (other && other.id !== id) return { ok: false, reason: "name_taken" };
    }
    const at = this.iso();
    const out: InstanceChanges = {
      name: changes.name,
      weight: changes.weight,
      enabled: changes.enabled,
      dailyLimit: changes.dailyLimit,
    };
    let reset = changes.enabled === true && row.enabled === 0;
    if (changes.settings !== undefined) {
      const type = this.type(row.type);
      if (!type) return { ok: false, reason: "unknown_type" };
      let current: CheckedSettings;
      try {
        current = {
          values: JSON.parse(row.settings_json) as Record<string, SettingValue>,
          secrets: await this.openSecrets(row),
        };
      } catch (error) {
        if (!(error instanceof SecretUnreadable)) throw error;
        // The key changed since the secret was stored: the owner must enter it again.
        current = { values: JSON.parse(row.settings_json), secrets: {} };
      }
      const checked = checkSettings(type.settings, changes.settings, current);
      if (!checked.ok) return { ok: false, reason: "invalid", errors: checked.errors };
      out.settingsJson = JSON.stringify(checked.values);
      out.fingerprint = fingerprint(type.settings, checked.values);
      if (JSON.stringify(checked.secrets) !== JSON.stringify(current.secrets)) {
        out.secretId = await this.sealSecrets(checked.secrets, at);
      }
      // New settings may fix what failed: try again at once.
      reset = true;
    }
    out.resetHealth = reset;
    this.db.transaction(() => {
      updateInstance(this.db, id, out, at);
      deleteUnusedJudgeSecrets(this.db);
    })();
    this.log.info("changed a judge", {
      judge: changes.name ?? row.name,
      settings: changes.settings !== undefined,
    });
    this.onChange();
    return { ok: true, judge: getInstance(this.db, id) as InstanceRow };
  }

  /** Not run or counted any more; its verdicts stay, its secrets go. */
  delete(id: string): JudgeOutcome<object> {
    const row = this.get(id);
    if (!row) return { ok: false, reason: "not_found" };
    this.db.transaction(() => {
      markDeleted(this.db, id, this.iso());
      deleteUnusedJudgeSecrets(this.db);
    })();
    this.log.info("deleted a judge", { judge: row.name });
    this.onChange();
    return { ok: true };
  }

  rule(): OutcomeRule {
    return getRule(this.db);
  }

  setRule(rule: OutcomeRule): void {
    setRule(this.db, rule, this.iso());
    this.log.info("changed how the outcome is decided", { ...rule });
  }

  /**
   * Every setting of the judge, secrets included, for a job sent to a worker
   * that may run it. Never log or return the result. Null when its secrets
   * cannot be read with the current key (the judge is marked failing).
   */
  async settingsFor(row: InstanceRow): Promise<Record<string, SettingValue> | null> {
    const values = JSON.parse(row.settings_json) as Record<string, SettingValue>;
    try {
      const secrets = await this.openSecrets(row);
      return { ...values, ...secrets };
    } catch (error) {
      if (!(error instanceof SecretUnreadable)) throw error;
      const at = this.iso();
      recordFailure(this.db, row.id, {
        message:
          "its secret settings cannot be decrypted with the current secret key: enter them again",
        reason: "auth",
        at,
        retryAt: new Date(this.now() + 3_600_000).toISOString(),
      });
      this.log.warn("a judge's secret settings cannot be decrypted", { judge: row.name });
      return null;
    }
  }

  private async openSecrets(row: InstanceRow): Promise<Record<string, string | null>> {
    if (!row.secret_id) return {};
    const sealed = getSecret(this.db, row.secret_id);
    if (!sealed) return {};
    return JSON.parse(await this.box.open(sealed, secretContext(row.secret_id)));
  }

  private async sealSecrets(secrets: Record<string, string | null>, at: string) {
    const set = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v));
    if (Object.keys(set).length === 0) return null;
    const id = Bun.randomUUIDv7();
    insertSecret(this.db, {
      id,
      kind: "judge_settings",
      ciphertext: await this.box.seal(JSON.stringify(set), secretContext(id)),
      keyVersion: KEY_VERSION,
      at,
    });
    return id;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }
}

function secretContext(secretId: string): string {
  return `wakewright/secret/${secretId}/judge_settings`;
}

/** Whether a weight is one a judge may have. */
export function validWeight(w: number): boolean {
  return Number.isFinite(w) && w >= 0 && w <= MAX_WEIGHT;
}

export type { AdvertisedType };
