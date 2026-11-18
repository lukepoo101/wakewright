# Configuration reference

Wakewright is configured only with environment variables named
`WAKEWRIGHT__SECTION__KEY`. They are validated at start-up, and the server
refuses to start with a message naming any variable it cannot use.
Everything you change while it runs (the admin account, devices, pausing)
lives in the database instead.

A secret can be given directly, or as a path to a file in the matching
`_FILE` variable, which is what Docker and Kubernetes secrets provide. Set
one or the other, not both. One trailing newline in a file is ignored.

| Variable                                  | Default                       | Meaning                                                                                                                                                                                                                                           |
| ----------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WAKEWRIGHT__SERVER__HOST`                | `0.0.0.0`                     | Address to listen on.                                                                                                                                                                                                                             |
| `WAKEWRIGHT__SERVER__PORT`                | `8080`                        | Port to listen on.                                                                                                                                                                                                                                |
| `WAKEWRIGHT__SERVER__PUBLIC_URL`          | none                          | The address people open, such as `https://wakewright.example.lan`. When it is `https://`, session cookies are marked `Secure` even if TLS ends at a reverse proxy, and its origin is accepted for changes. Set it whenever a proxy sits in front. |
| `WAKEWRIGHT__SERVER__STATIC_DIR`          | `public/` next to `main.js`   | The built web UI. Only needed when running from an unusual layout.                                                                                                                                                                                |
| `WAKEWRIGHT__STORAGE__DATA_DIR`           | `data` (`/data` in the image) | Database, audio, backups and the generated secret key. Must be local or block storage, never NFS or CephFS.                                                                                                                                       |
| `WAKEWRIGHT__LOG__LEVEL`                  | `info`                        | `debug`, `info`, `warn` or `error`. Logs are JSON lines on standard output.                                                                                                                                                                       |
| `WAKEWRIGHT__ADMIN__USERNAME`             | `admin`                       | The admin account's name when the password is set by configuration.                                                                                                                                                                               |
| `WAKEWRIGHT__ADMIN__PASSWORD`             | none                          | The admin password, at least 12 characters. When set (here or in `_FILE`), configuration owns the account: it is created or updated on every start, a changed password signs everyone out, and first-run setup is skipped.                        |
| `WAKEWRIGHT__ADMIN__PASSWORD_FILE`        | none                          | A file holding the admin password.                                                                                                                                                                                                                |
| `WAKEWRIGHT__SECRET_KEY`                  | generated                     | The key that encrypts stored device passwords: 32 random bytes in base64 (`openssl rand -base64 32`). Without it, Wakewright creates `secret.key` in the data directory on first start.                                                           |
| `WAKEWRIGHT__SECRET_KEY_FILE`             | none                          | A file holding the secret key.                                                                                                                                                                                                                    |
| `WAKEWRIGHT__COLLECTOR__INTERVAL_SECONDS` | `10`                          | How often each device is asked for new clips (1–3600). A device keeps only its last 10 wake words and 10 near misses, so keep this well under the time it takes to hear 10.                                                                       |
| `WAKEWRIGHT__COLLECTOR__TIMEOUT_SECONDS`  | `10`                          | How long one call to a device may take before it counts as failed (1–120).                                                                                                                                                                        |

## First-run setup or a configured password

Without `WAKEWRIGHT__ADMIN__PASSWORD`, the first browser to open a new
instance is asked to create the admin account. That suits a single Docker
host on a home network. For GitOps, or any instance reachable before you
can open it, set the password by configuration instead.

To reset a forgotten password, set `WAKEWRIGHT__ADMIN__PASSWORD` (and
`WAKEWRIGHT__ADMIN__USERNAME` if you chose another name) and restart.

## The secret key

Device passwords are stored encrypted with AES-256-GCM. The key never goes
into the database, so a copy of the database or one of its backups does not
reveal them.

- Without `WAKEWRIGHT__SECRET_KEY(_FILE)`, the key is generated once into
  `<data dir>/secret.key` (mode 0600). That protects database copies, but
  not a copy of the whole data directory.
- For GitOps, generate a key with `openssl rand -base64 32`, keep it in your
  secret store and pass it as `WAKEWRIGHT__SECRET_KEY_FILE`.
- If the key changes, stored passwords can no longer be read: each device
  shows "The stored password cannot be read" until you enter its password
  again. Clips are not affected.
