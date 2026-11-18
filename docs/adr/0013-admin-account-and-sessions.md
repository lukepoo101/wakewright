# 0013 One local admin account with server-side sessions

- Status: accepted
- Date: 2026-11-18

## Context

v0.0.1 needs a login in front of household audio and device passwords:
one local admin account, a first-run setup for plain Docker users, and a
way for GitOps deployments to set the password from a secret. The design
asked for a signed session cookie, a CSRF check on every change and a
throttled login.

## Decision

- **Passwords**: `Bun.password` with its argon2id defaults; at least 12
  characters. Unknown usernames are checked against a dummy hash so timing
  does not reveal them.
- **Sessions**: the cookie `wakewright_session` holds a random 256-bit
  token; the `sessions` table stores only its SHA-256. This replaces the
  "signed cookie" in the design: a stored session can be revoked at sign-out
  or on a password change, which a stateless signed cookie cannot, and a
  database copy still cannot sign anyone in. Sessions last 30 days and slide
  forward (at most one write a day). The cookie is `HttpOnly`,
  `SameSite=Lax`, `Path=/`, and `Secure` on HTTPS requests or when
  `WAKEWRIGHT__SERVER__PUBLIC_URL` is `https://`.
- **CSRF**: every request body must be JSON (`415` otherwise), and this
  server grants no CORS, so a cross-site page cannot send one without a
  preflight that fails. Requests a plain HTML form could send are also
  checked with `hono/csrf`: `Sec-Fetch-Site: same-origin`, or an `Origin`
  equal to the request's origin, the public URL or the `Host` header. No
  token is needed on top of these, which is the approach of Go 1.25's
  `CrossOriginProtection` and Hono's own middleware.
- **Throttling**: per client address, five free failures, then a lock that
  doubles from 1 s to 15 minutes, answered `429` with `Retry-After`. Kept in
  memory, so a restart forgets it. Behind a reverse proxy all clients share
  the proxy's address and therefore one limit.
- **First-run setup**: while no account exists, the UI asks for one. The
  first browser to reach a new instance claims it; deployments that cannot
  accept that set the password by configuration.
- **Password by configuration**: `WAKEWRIGHT__ADMIN__PASSWORD` or
  `WAKEWRIGHT__ADMIN__PASSWORD_FILE` makes configuration the source of
  truth. On every start the account is created, or updated (ending all
  sessions) when the password or `WAKEWRIGHT__ADMIN__USERNAME` changed, and
  setup is disabled. The design's `INITIAL_PASSWORD_FILE` would have applied
  only once, so a rotated secret would silently not take effect.

## Consequences

There is no password change in the UI yet; a deployment without a
configured password changes it only by setting one in configuration. OIDC,
more accounts and API tokens come later and will reuse the sessions table.
