import type { Database } from "bun:sqlite";
import { KEY_VERSION, type SecretBox } from "./crypto.ts";
import {
  type DeviceRow,
  deleteUnusedSecrets,
  getSecret,
  insertDevice,
  insertSecret,
  removeDevice,
  updateDevice,
} from "./db/devices.ts";
import { kioskSource } from "./kiosk/source.ts";
import {
  type ConnectOptions,
  type ReportedState,
  type Source,
  type SourceConnection,
  SourceError,
} from "./source.ts";

// Device management shared by the API and the collector: the registered
// sources, encrypted passwords, and connecting to a device.

// biome-ignore lint/suspicious/noExplicitAny: each source has its own config type
export const sources: Record<string, Source<any>> = { [kioskSource.id]: kioskSource };

export interface ConnectionReport {
  state: ReportedState;
  /** Clips the device holds right now. */
  clips: number;
}

export class Devices {
  constructor(
    private readonly db: Database,
    private readonly box: SecretBox,
    readonly connectOptions: ConnectOptions,
  ) {}

  async create(d: { name: string; source: string; config: unknown; password: string }) {
    const id = Bun.randomUUIDv7();
    const at = new Date().toISOString();
    const secretId = await this.storePassword(d.password, at);
    insertDevice(this.db, {
      id,
      name: d.name,
      source: d.source,
      configJson: JSON.stringify(d.config),
      secretId,
      at,
    });
    return id;
  }

  async update(
    device: DeviceRow,
    d: { name: string; config: unknown; password: string | undefined },
  ): Promise<void> {
    const at = new Date().toISOString();
    const configJson = JSON.stringify(d.config);
    const secretId = d.password === undefined ? null : await this.storePassword(d.password, at);
    updateDevice(this.db, device.id, {
      name: d.name,
      configJson,
      secretId,
      at,
      reset: configJson !== device.config_json,
    });
    deleteUnusedSecrets(this.db);
  }

  remove(device: DeviceRow): void {
    removeDevice(this.db, device.id, new Date().toISOString());
    deleteUnusedSecrets(this.db);
  }

  /** The device's password; throws SecretUnreadable if the key changed. */
  async password(device: DeviceRow): Promise<string> {
    const sealed = device.secret_id ? getSecret(this.db, device.secret_id) : null;
    if (!device.secret_id || !sealed) throw new Error(`Device ${device.id} has no password`);
    return this.box.open(sealed, secretContext(device.secret_id));
  }

  connect(source: string, config: unknown, password: string): SourceConnection {
    const impl = sources[source];
    if (!impl) throw new Error(`Unknown source ${source}`);
    return impl.connect({ config, password }, this.connectOptions);
  }

  /** Logs in, reads the device's state and lists its clips. Writes nothing. */
  async test(source: string, config: unknown, password: string): Promise<ConnectionReport> {
    const connection = this.connect(source, config, password);
    const state = await connection.readState();
    const poll = await connection.poll(null);
    return {
      state: { ...state, diagnosticsEnabled: poll.diagnosticsEnabled },
      clips: poll.entries.length,
    };
  }

  private async storePassword(password: string, at: string): Promise<string> {
    const id = Bun.randomUUIDv7();
    insertSecret(this.db, {
      id,
      kind: "device_password",
      ciphertext: await this.box.seal(password, secretContext(id)),
      keyVersion: KEY_VERSION,
      at,
    });
    return id;
  }
}

function secretContext(secretId: string): string {
  return `wakewright/secret/${secretId}/device_password`;
}

export function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof SourceError) return { code: error.code, message: error.message };
  if (error instanceof Error && error.name === "SecretUnreadable") {
    return { code: "secret_unreadable", message: error.message };
  }
  return { code: "internal", message: (error as Error)?.message ?? String(error) };
}
