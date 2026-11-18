# Getting started with Docker

Wakewright runs as one container. It needs a persistent volume for its
data and must be able to reach your Kiosk Satellite devices on your
network (port 2324 by default). Everything it collects stays in that
volume; see [privacy.md](privacy.md).

The image is `ghcr.io/lukepoo101/wakewright`, for amd64 and arm64. Use a
release tag: the version (for example `0.1.0`), its minor version (`0.1`,
which follows its patch releases) or `latest`; the examples below use the
newest release. `edge` is built from every merge to `main` and is for
testing. To pin the exact image, and check who
built it, see [verify an image](RELEASING.md#verify-an-image).

| What         | Value                                                                                                    |
| ------------ | -------------------------------------------------------------------------------------------------------- |
| Port         | `8080` (HTTP; put a reverse proxy in front for HTTPS)                                                    |
| Volume       | `/data`: database, audio, backups, the generated secret key. Local or block storage, never NFS or CephFS |
| Liveness     | `GET /healthz`                                                                                           |
| Readiness    | `GET /readyz` (the database is migrated and writable)                                                    |
| Health check | built into the image (`main.js healthcheck`)                                                             |
| User         | uid 10001; works with a read-only root filesystem and `/tmp` as tmpfs                                    |
| Replicas     | exactly one                                                                                              |

## Quick start: docker run

```sh
docker volume create wakewright-data
docker run -d --name wakewright --restart unless-stopped \
  -p 8080:8080 -v wakewright-data:/data \
  --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges \
  ghcr.io/lukepoo101/wakewright:0.2.0
```

Open `http://<host>:8080`. The first browser to open a new instance is
asked to create the admin account, so do this straight away. The key that
encrypts device passwords is generated into the volume on first start.

## Docker Compose

[`deploy/compose/docker-compose.yml`](../deploy/compose/docker-compose.yml)
sets the admin password and the secret key from files instead, so nothing
is decided by whoever opens the page first, and runs the
[worker](worker.md) beside the parent to judge clips, declared in the
parent's configuration with a token from a file:

```sh
mkdir wakewright && cd wakewright
curl -fsSLO https://raw.githubusercontent.com/lukepoo101/wakewright/main/deploy/compose/docker-compose.yml
mkdir -p secrets
openssl rand -base64 32 > secrets/key
printf '%s' 'a long admin password' > secrets/admin_password
openssl rand -base64 32 > secrets/worker_token   # the declared worker's token
chmod 644 secrets/*   # the containers run as uid 10001 and must read them
docker compose up -d
```

Sign in as `admin` with that password. Edit `WAKEWRIGHT__SERVER__PUBLIC_URL`
to the address you use. Keep `secrets/key` with your backups: without it,
stored device passwords cannot be read (clips are unaffected). The worker
downloads its models (about 2.5 GB) into its `worker-cache` volume on first
start; delete the `worker` service to collect clips without judging them.
To run a worker on another machine, add it on the Workers page, which gives
it its own token and a pairing string ([worker.md](worker.md)).

## Kubernetes and GitOps

Run one replica with a `Recreate` strategy and a ReadWriteOnce volume at
`/data`. Put the admin password and the secret key in a Secret and pass
them as `WAKEWRIGHT__ADMIN__PASSWORD_FILE` and `WAKEWRIGHT__SECRET_KEY_FILE`.
Configuration then owns the account: it is created on first start and
updated, signing everyone out, whenever the secret changes. Use `/healthz`
for liveness and `/readyz` for readiness. Set
`WAKEWRIGHT__SERVER__PUBLIC_URL` to the ingress address. Declare workers
the same way, each with its token in a Secret
(`WAKEWRIGHT__WORKERS__<NAME>__TOKEN_FILE`,
[configuration.md](configuration.md#workers)); they show on the Workers page
as set by configuration. Every variable is
in [configuration.md](configuration.md).

If your ingress already signs people in (an OIDC or forward-auth
middleware), you can turn Wakewright's own sign-in off with
`WAKEWRIGHT__AUTH__MODE=none` and leave out the admin password. Then only
the ingress may reach the Service: restrict it with a network policy
([configuration.md](configuration.md#sign-in-off-behind-an-authenticating-proxy)).

## Add your first device

1. Turn on wake word diagnostics on the device:
   [kiosk-satellite.md](kiosk-satellite.md).
2. In Wakewright, open **Devices**, then **Add device**. Enter a name, the
   device's address (for example `192.168.1.40`; port 2324 is added) and
   its remote administration password. **Test connection** shows what the
   device reports; **Add device** saves it.
3. Say the wake word. The clip appears under **Clips** within seconds.

## Backups

Every night at 03:30 Wakewright writes a copy of its database to
`/data/backups/` and keeps 14. Audio files under `/data/blobs/` never
change once written, so any file-level backup tool copies them
incrementally. Back up the whole volume, and keep the secret key apart from
it if you supplied one.
