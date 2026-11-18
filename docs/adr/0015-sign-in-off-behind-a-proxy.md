# 0015 Sign-in can be turned off for an authenticating proxy

- Status: accepted
- Date: 2026-11-18

## Context

Many self-hosters already put every web app behind one sign-in at a
reverse proxy (OAuth2 Proxy, Authelia, Authentik, a Traefik or Caddy
forward-auth middleware). For them Wakewright's own login
([ADR 0013](0013-admin-account-and-sessions.md)) is a second password
in front of the same people, and a secret to manage for nothing.

Well-regarded apps handle this in two ways. Sonarr, Radarr and the other
\*arr apps have an authentication method "External" that turns their own
login off and leaves it to the proxy. Grafana's auth proxy and
Paperless-ngx's remote-user setting instead trust a header the proxy sets
to name the user, which is only safe when nothing but the proxy can reach
the app, and maps that name to an account.

## Decision

- `WAKEWRIGHT__AUTH__MODE` is `local` (the default: the admin account and
  sessions of ADR 0013) or `none`. `none` says plainly what Wakewright
  does, nothing, rather than what the operator hopes something else does;
  a name like "external" or "proxy" would suggest the app checks the proxy.
- With `none`: no first-run setup, no sign-in, no session needed. The
  session endpoint answers `{ "state": "open" }`; setup, sign-in and
  sign-out answer `409` (`auth_off`). The UI goes from its loading screen
  straight to the app and hides sign-out, so no login screen ever flashes.
- An admin password in configuration together with `none` is a start-up
  error: it would protect nothing, and refusing it stops anyone believing
  it does. The username alone is ignored.
- Every start in `none` logs a warning that anyone who can reach the port
  has full access.
- The same-origin checks of ADR 0013 stay on in both modes. They guard the
  browser of a signed-in user, and a proxy's sign-in cookie is exactly such
  an ambient credential.
- `/healthz` and `/readyz` are open in both modes, as before.
- No trusted user header. Wakewright has one account and no per-user
  data; the only user it records is who paused collection, which is left
  empty in `none` mode. A header mapping would add a spoofing risk for no
  feature. It can come later if accounts do.
- The mode covers the UI's API (`/api/v1`) only. Machine APIs, such as a
  worker API with its own tokens, authenticate independently of it.

## Consequences

With `none`, the network is the only protection: the operator must make
sure only the proxy can reach the port (a private bind, a firewall or a
network policy). An existing admin account is kept in the database, so
switching back to `local` restores it.
