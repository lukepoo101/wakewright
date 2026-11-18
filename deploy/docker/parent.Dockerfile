# syntax=docker/dockerfile:1
# The parent image: the server bundle and the built SPA on Bun's distroless
# base (no shell, no package manager). Build from the repository root:
#   docker build -f deploy/docker/parent.Dockerfile .
# Both bases are pinned by digest; scripts/check-versions.ts keeps their Bun
# version equal to mise.toml's.

FROM oven/bun:1.4.4-slim@sha256:1846adf22496bd711036aae8be147e57bdebbaea2e5264e3e0b5af1db187d9a4 AS build
# Include this stage in the image's SBOM: the runtime image holds one
# bundled main.js, so the npm packages inside it are only visible here.
ARG BUILDKIT_SBOM_SCAN_STAGE=true
WORKDIR /src
# Manifests first, so the dependency layer is reused until they change.
COPY package.json bun.lock bunfig.toml ./
COPY apps/parent/package.json apps/parent/
COPY apps/web/package.json apps/web/
COPY devtools/fake-kiosk/package.json devtools/fake-kiosk/
RUN bun install --frozen-lockfile --production
COPY apps ./apps
RUN bun run build && mkdir -p /out-data

FROM oven/bun:1.4.4-distroless@sha256:153a951ae40106e125898103e6e990ee0f38e6aee7f561029e26cf9fbed23470
LABEL org.opencontainers.image.title="wakewright" \
      org.opencontainers.image.description="Wakewright parent: collects and stores wake word clips" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/lukepoo101/wakewright"
COPY LICENSE NOTICE /usr/share/licenses/wakewright/
COPY --from=build /src/dist /app
COPY --from=build --chown=10001:10001 /out-data /data
WORKDIR /app
USER 10001:10001
ENV NODE_ENV=production \
    WAKEWRIGHT__STORAGE__DATA_DIR=/data
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --start-interval=1s \
  CMD ["/usr/local/bin/bun", "/app/main.js", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/bun", "/app/main.js"]
CMD ["serve"]
