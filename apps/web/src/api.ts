import type { AppType } from "@wakewright/parent";
import { type ClientResponse, hc } from "hono/client";
import type { SuccessStatusCode } from "hono/utils/http-status";

// Typed client for the parent's API, built from the server's route types:
// no code generation. Same origin as the SPA, so the session cookie goes
// with every request.
export const api = hc<AppType>("/");
export const v1 = api.api.v1;

/** A non-2xx answer, with the server's error code and message. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

// The body type of a call's 2xx answers.
type Ok<R> =
  R extends ClientResponse<infer T, infer S> ? (S extends SuccessStatusCode ? T : never) : never;

/**
 * Awaits a client call and returns its 2xx JSON body, or throws ApiError
 * with the server's message. A network failure becomes ApiError status 0.
 */
export async function call<R extends ClientResponse<unknown, number>>(
  request: Promise<R>,
): Promise<Ok<R>> {
  let res: R;
  try {
    res = await request;
  } catch {
    throw new ApiError(0, "network", "Cannot reach the Wakewright server. Check your connection.");
  }
  if (res.ok) return (res.status === 204 ? undefined : await res.json()) as Ok<R>;
  let code = "http_error";
  let message = `The server answered ${res.status}.`;
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    code = body.error ?? code;
    message = body.message ?? message;
  } catch {
    // Not JSON: keep the generic message.
  }
  const retry = Number(res.headers.get("Retry-After"));
  throw new ApiError(res.status, code, message, Number.isFinite(retry) ? retry : undefined);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}
