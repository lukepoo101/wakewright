import { OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { Auth, User } from "../auth.ts";

// Shared pieces of the API: the context type, error bodies, the session
// cookie and the sign-in guard.

export interface ApiEnv {
  Variables: { user: User };
}

export const ErrorBody = z
  .object({
    error: z.string().openapi({ example: "invalid_request" }),
    message: z.string(),
  })
  .openapi("Error");

export function errorContent(description: string) {
  return { description, content: { "application/json": { schema: ErrorBody } } };
}

/** An OpenAPIHono whose validation failures answer 400 with an Error body. */
export function newApi<E extends ApiEnv = ApiEnv>() {
  return new OpenAPIHono<E>({
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json({ error: "invalid_request", message: z.prettifyError(result.error) }, 400);
      }
    },
  });
}

export const SESSION_COOKIE = "wakewright_session";

export interface CookiePolicy {
  /** Mark cookies Secure even when the request arrived over plain HTTP. */
  forceSecure: boolean;
}

export function setSessionCookie(c: Context, policy: CookiePolicy, token: string, expires: Date) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "Lax",
    secure: policy.forceSecure || new URL(c.req.url).protocol === "https:",
    path: "/",
    expires,
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

export function sessionToken(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

/** Answers 401 unless the request carries a valid session; sets `user`. */
export function requireUser(auth: Auth, policy: CookiePolicy): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    const token = sessionToken(c);
    const session = auth.authenticate(token);
    if (!session || !token) {
      return c.json({ error: "unauthenticated", message: "Sign in first." }, 401);
    }
    if (session.renewed) setSessionCookie(c, policy, token, session.renewed);
    c.set("user", session.user);
    await next();
  };
}

/** The client's address, for throttling; "unknown" when Bun does not say. */
export function clientAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    return "unknown";
  }
}
