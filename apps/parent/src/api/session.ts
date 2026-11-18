import { createRoute, z } from "@hono/zod-openapi";
import type { Auth } from "../auth.ts";
import { MIN_PASSWORD_LENGTH } from "../config.ts";
import {
  type CookiePolicy,
  clearSessionCookie,
  clientAddress,
  errorContent,
  newApi,
  sessionToken,
  setSessionCookie,
} from "./common.ts";

// Sign-in, sign-out and first-run setup: /api/v1/session and /api/v1/setup.
// With sign-in off (auth mode "none") the session is always "open" and the
// rest answer 409.

const Username = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/, "Use 1–64 letters, digits, dots, dashes or underscores.");
// Bun.password hashes the whole string; the upper bound only stops abuse.
const NewPassword = z
  .string()
  .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`)
  .max(1024);

const SessionUser = z.object({ username: z.string() }).openapi("SessionUser");

const SessionState = z
  .object({
    /** "open": sign-in is off (WAKEWRIGHT__AUTH__MODE=none); the app is usable as is. */
    state: z.enum(["setup", "signed_out", "signed_in", "open"]),
    user: SessionUser.optional(),
    /** True when the admin password is set by configuration, not in the UI. */
    managed: z.boolean(),
  })
  .openapi("SessionState");

const Credentials = z
  .object({ username: z.string().max(64), password: z.string().max(1024) })
  .openapi("Credentials");

const SetupRequest = z.object({ username: Username, password: NewPassword }).openapi("Setup");

const getSession = createRoute({
  method: "get",
  path: "/session",
  tags: ["session"],
  summary: "Whether setup is needed and who is signed in",
  responses: {
    200: { description: "State", content: { "application/json": { schema: SessionState } } },
  },
});

const signIn = createRoute({
  method: "post",
  path: "/session",
  tags: ["session"],
  summary: "Sign in; sets the session cookie",
  request: { body: { required: true, content: { "application/json": { schema: Credentials } } } },
  responses: {
    200: { description: "Signed in", content: { "application/json": { schema: SessionUser } } },
    401: errorContent("Wrong username or password"),
    409: errorContent("Sign-in is off on this server"),
    429: errorContent("Too many failed attempts; see Retry-After"),
  },
});

const signOut = createRoute({
  method: "delete",
  path: "/session",
  tags: ["session"],
  summary: "Sign out; ends the session",
  responses: {
    204: { description: "Signed out" },
    409: errorContent("Sign-in is off on this server"),
  },
});

const setup = createRoute({
  method: "post",
  path: "/setup",
  tags: ["session"],
  summary: "First-run setup: create the admin account and sign in",
  request: { body: { required: true, content: { "application/json": { schema: SetupRequest } } } },
  responses: {
    201: { description: "Created", content: { "application/json": { schema: SessionUser } } },
    409: errorContent(
      "Setup is already done, the password is set by configuration, or sign-in is off",
    ),
  },
});

const authOff = {
  error: "auth_off",
  message: "Sign-in is off on this server (WAKEWRIGHT__AUTH__MODE is none).",
} as const;

export function sessionRoutes(auth: Auth, policy: CookiePolicy) {
  return newApi()
    .openapi(getSession, (c) => {
      const managed = auth.managed;
      if (auth.mode === "none") return c.json({ state: "open" as const, managed }, 200);
      if (auth.state() === "setup") return c.json({ state: "setup" as const, managed }, 200);
      const session = auth.authenticate(sessionToken(c));
      if (!session) return c.json({ state: "signed_out" as const, managed }, 200);
      return c.json(
        { state: "signed_in" as const, user: { username: session.user.username }, managed },
        200,
      );
    })
    .openapi(signIn, async (c) => {
      if (auth.mode === "none") return c.json(authOff, 409);
      const { username, password } = c.req.valid("json");
      const result = await auth.login(username, password, clientAddress(c));
      if (!result.ok) {
        if (result.reason === "throttled") {
          c.header("Retry-After", String(result.retryAfterS));
          return c.json(
            {
              error: "throttled",
              message: `Too many failed attempts. Try again in ${result.retryAfterS} s.`,
            },
            429,
          );
        }
        return c.json(
          { error: "invalid_credentials", message: "Wrong username or password." },
          401,
        );
      }
      setSessionCookie(c, policy, result.token, result.expiresAt);
      return c.json({ username: result.user.username }, 200);
    })
    .openapi(signOut, (c) => {
      if (auth.mode === "none") return c.json(authOff, 409);
      auth.logout(sessionToken(c));
      clearSessionCookie(c);
      return c.body(null, 204);
    })
    .openapi(setup, async (c) => {
      if (auth.mode === "none") return c.json(authOff, 409);
      const { username, password } = c.req.valid("json");
      const result = await auth.setup(username, password);
      if (!result.ok) {
        return c.json(
          { error: "already_set_up", message: "The admin account already exists. Sign in." },
          409,
        );
      }
      setSessionCookie(c, policy, result.token, result.expiresAt);
      return c.json({ username: result.user.username }, 201);
    });
}
