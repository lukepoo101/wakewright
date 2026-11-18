# Getting started with Docker

Wakewright runs as one container. It needs a persistent volume for its
data and must be able to reach your Kiosk Satellite devices on your
network (port 2324 by default). Everything it collects stays in that
volume; see [privacy.md](privacy.md).

The image is `ghcr.io/lukepoo101/wakewright`, for amd64 and arm64. Use a
release tag: `0.0.1` (also `0.0` and `latest`). `edge` is built from every
merge to `main` and is for testing. To pin the exact image, and check who
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
  ghcr.io/lukepoo101/wakewright:0.0.1
```

Open `http://<host>:8080`. The first browser to open a new instance is
asked to create the admin account, so do this straight away. The key that
encrypts device passwords is generated into the volume on first start.

## Docker Compose

[`deploy/compose/docker-compose.yml`](../deploy/compose/docker-compose.yml)
sets the admin password and the secret key from files instead, so nothing
is decided by whoever opens the page first:

```sh
mkdir wakewright && cd wakewright
curl -fsSLO https://raw.githubusercontent.com/lukepoo101/wakewright/main/deploy/compose/docker-compose.yml
mkdir -p secrets
openssl rand -base64 32 > secrets/key
printf '%s' 'a long admin password' > secrets/admin_password
chmod 644 secrets/*   # the container runs as uid 10001 and must read them
docker compose up -d
```

Sign in as `admin` with that password. Edit `WAKEWRIGHT__SERVER__PUBLIC_URL`
to the address you use. Keep `secrets/key` with your backups: without it,
stored device passwords cannot be read (clips are unaffected).

## Kubernetes and GitOps

Run one replica with a `Recreate` strategy and a ReadWriteOnce volume at
`/data`. Put the admin password and the secret key in a Secret and pass
them as `WAKEWRIGHT__ADMIN__PASSWORD_FILE` and `WAKEWRIGHT__SECRET_KEY_FILE`.
Configuration then owns the account: it is created on first start and
updated, signing everyone out, whenever the secret changes. Use `/healthz`
for liveness and `/readyz` for readiness. Set
`WAKEWRIGHT__SERVER__PUBLIC_URL` to the ingress address. Every variable is
in [configuration.md](configuration.md).

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
