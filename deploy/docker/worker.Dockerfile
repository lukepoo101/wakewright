# syntax=docker/dockerfile:1
# The worker image: the wakewright-worker package and its locked
# dependencies in a virtual environment on Python's slim Debian base. CPU
# only. Build from the repository root:
#   docker build -f deploy/docker/worker.Dockerfile .
# The build context is limited by worker.Dockerfile.dockerignore. Both bases
# are pinned by digest; scripts/check-versions.ts keeps their Python and uv
# versions equal to mise.toml's.
#
# No model is in the image: the judges download theirs into /cache on first
# use (pinned and checksummed; see docs/models.md). Mount a volume there so
# they are downloaded once.

FROM ghcr.io/astral-sh/uv:0.13.7@sha256:96f40d3904aad8d0bd010539001d36c8e2188b981e1334471a90c4a1d93bb490 AS uv

FROM python:3.13.18-slim-trixie@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90 AS build
# Include this stage in the image's SBOM, as the parent image does.
ARG BUILDKIT_SBOM_SCAN_STAGE=true
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    UV_PROJECT_ENVIRONMENT=/app/.venv
WORKDIR /src
# Dependencies first, so their layer is reused until uv.lock changes.
COPY apps/worker/pyproject.toml apps/worker/uv.lock ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project
COPY apps/worker/src ./src
# pymicro-wakeword's wheel carries a few models of its own; the worker uses
# the pinned downloads instead, so keep every model out of the image.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-editable \
    && rm -r /app/.venv/lib/python3.13/site-packages/pymicro_wakeword/models \
    && mkdir -p /out-cache

FROM python:3.13.18-slim-trixie@sha256:e48f59cdba69a3cbd9ed2cf0f348d90d45a8d350d98134cf1070bc106ee9ed90
LABEL org.opencontainers.image.title="wakewright-worker" \
      org.opencontainers.image.description="Wakewright worker: judges wake word clips for the Wakewright parent" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/lukepoo101/wakewright"
COPY LICENSE NOTICE /usr/share/licenses/wakewright/
COPY --from=build /app/.venv /app/.venv
COPY --from=build --chown=10001:10001 /out-cache /cache
USER 10001:10001
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    WAKEWRIGHT_WORKER__CACHE_DIR=/cache
VOLUME /cache
# The worker serves nothing; this checks that its job loop is still turning.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10m \
  CMD ["wakewright-worker", "healthcheck"]
ENTRYPOINT ["wakewright-worker"]
CMD ["run"]
