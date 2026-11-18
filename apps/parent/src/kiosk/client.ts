import { z } from "zod";
import { SourceError } from "../source.ts";
import {
  type ActivationAudioData,
  ActivationAudioData as ActivationAudioDataShape,
  type ActivationsData,
  ActivationsData as ActivationsDataShape,
  commandResult,
  ErrorResponse,
  type Health,
  Health as HealthShape,
  LoginResponse,
  type SettingsResponse,
  SettingsResponse as SettingsShape,
} from "./shapes.ts";

// A small client for the Kiosk Satellite REST API (port 2324). It calls
// only the read surface: login, health, settings and the two wake word
// diagnostics commands. It logs in with the device's admin password, keeps
// the token (asked for with a one-day lifetime) and logs in again once when
// the device answers 401.

/** Commands this client may call. Anything that changes a device is absent. */
const READ_COMMANDS = ["getWakeWordActivations", "getWakeWordActivationAudio"] as const;
type ReadCommand = (typeof READ_COMMANDS)[number];

// The command envelope; its data is checked against each command's shape.
const CommandEnvelope = commandResult(z.unknown());

/** Larger answers are refused: a clip is about 130 kB of base64. */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export interface KioskClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class KioskClient {
  private token: string | undefined;
  private readonly fetch: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    readonly baseUrl: string,
    private readonly password: string,
    options: KioskClientOptions = {},
  ) {
    this.fetch = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** `GET /api/health`; needs no login. */
  async health(): Promise<Health> {
    return this.parse(await this.send("GET", "/api/health"), HealthShape, "health");
  }

  async settings(): Promise<SettingsResponse> {
    const res = await this.authed("GET", "/api/settings");
    return this.parse(res, SettingsShape, "settings");
  }

  async activations(): Promise<ActivationsData> {
    return this.command("getWakeWordActivations", undefined, ActivationsDataShape);
  }

  async activationAudio(id: string): Promise<ActivationAudioData> {
    return this.command("getWakeWordActivationAudio", { id }, ActivationAudioDataShape);
  }

  private async command<T extends z.ZodType>(
    name: ReadCommand,
    body: unknown,
    data: T,
  ): Promise<z.infer<T>> {
    const res = await this.authed("POST", `/api/commands/${name}`, body ?? {});
    const result = await this.parse(res, CommandEnvelope, name, true);
    if (!result.ok) {
      throw new SourceError("device_error", `The device could not run ${name}: ${result.error}`);
    }
    const parsed = data.safeParse(result.data);
    if (!parsed.success) {
      throw new SourceError(
        "bad_response",
        `The device's ${name} answer does not have the expected shape: ${parsed.error.issues[0]?.message ?? "invalid"}.`,
      );
    }
    return parsed.data;
  }

  // Sends with the cached token, logging in first if there is none, and
  // once more if the device says the token is no longer valid.
  private async authed(method: string, path: string, body?: unknown): Promise<Response> {
    if (!this.token) await this.login();
    let res = await this.send(method, path, body, this.token);
    if (res.status === 401) {
      await res.body?.cancel();
      this.token = undefined;
      await this.login();
      res = await this.send(method, path, body, this.token);
    }
    if (res.status === 401) {
      throw new SourceError("auth_failed", "The device rejected a fresh login token.");
    }
    return res;
  }

  private async login(): Promise<void> {
    const res = await this.send("POST", "/api/login", { password: this.password, ttl_days: 1 });
    if (res.status === 401) {
      await res.body?.cancel();
      throw new SourceError("auth_failed", "The device rejected the password.");
    }
    if (res.status === 429) {
      await res.body?.cancel();
      throw new SourceError(
        "rate_limited",
        "The device is refusing logins after too many failed attempts. Wait a few minutes.",
      );
    }
    this.token = (await this.parse(res, LoginResponse, "login")).token;
  }

  private async send(method: string, path: string, body?: unknown, token?: string) {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;
    try {
      return await this.fetch(new URL(path, this.baseUrl), {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const name = (error as Error).name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new SourceError(
          "timeout",
          `The device did not answer within ${this.timeoutMs / 1000} s.`,
        );
      }
      throw new SourceError(
        "unreachable",
        `Cannot connect to ${this.baseUrl}: ${(error as Error).message}`,
      );
    }
  }

  // Reads and validates a JSON answer. Command failures come back as 400
  // inside the command envelope, so commands accept that status too.
  private async parse<T extends z.ZodType>(
    res: Response,
    shape: T,
    what: string,
    commandEnvelope = false,
  ): Promise<z.infer<T>> {
    const length = Number(res.headers.get("Content-Length") ?? 0);
    if (length > MAX_RESPONSE_BYTES) {
      await res.body?.cancel();
      throw new SourceError("bad_response", `The device's ${what} answer is too large.`);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (error) {
      throw new SourceError(
        "unreachable",
        `The connection broke while reading ${what}: ${(error as Error).message}`,
      );
    }
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new SourceError("bad_response", `The device's ${what} answer is too large.`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new SourceError(
        "bad_response",
        `The device's ${what} answer (HTTP ${res.status}) is not JSON. Is this a Kiosk Satellite address?`,
      );
    }
    if (!res.ok && !(commandEnvelope && res.status === 400)) {
      const error = ErrorResponse.safeParse(json);
      throw new SourceError(
        "device_error",
        `The device answered ${what} with HTTP ${res.status}${error.success ? `: ${error.data.error}` : ""}.`,
      );
    }
    const parsed = shape.safeParse(json);
    if (!parsed.success) {
      throw new SourceError(
        "bad_response",
        `The device's ${what} answer does not have the expected shape: ${parsed.error.issues[0]?.message ?? "invalid"}.`,
      );
    }
    return parsed.data;
  }
}
