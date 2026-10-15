# The slim image WorkerLite and WorkerBasic run on Cloudflare Containers (lite's disk is 2,000 MB); worker/src/workers.js
# sets CINDER_URL and CINDER_RUNNER_TOKEN. Node and git only: jobs that need another stack's toolchain go to the
# standard pool, which runs runner/Dockerfile.full. cinder-verify claims and hands the agent kinds to cinder-agent.
# Base images are pinned by digest, which wins over the tag: bump both together.
FROM golang:1.27@sha256:820153096fda4de6ac1b7194d12e416b7dd8f4e9a33d17e0345b111b945162d8 AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -o /out/ ./cmd/cinder-agent ./cmd/cinder-verify

FROM node:22.20.0-bookworm-slim@sha256:b21fe589dfbe5cc39365d0544b9be3f1f33f55f3c86c87a76ff65a02f8f5848e
ENV CINDER_BAKED="node=22.20.0"
RUN apt-get update && apt-get install -y --no-install-recommends git make ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# claude is the develop and resolve harness's default CLI (internal/harness); without it develop fails at once.
RUN npm install -g @anthropic-ai/claude-code@2.0.14 && npm cache clean --force
# opencode runs agents on OpenAI-compatible models, Workers AI among them (internal/harness/opencode.go).
RUN npm install -g opencode-ai@1.18.32 && npm cache clean --force
# Smoke test: the build fails unless every tool answers its version command.
RUN node --version && npm --version && git --version && make --version && claude --version && opencode --version
# cinder-verify stays root; checks and flow steps run as cinder-job (internal/verify/job.go), so they can't read its
# environment or write /usr/local/bin, root's HOME or the tool cache, which lives where only root writes.
RUN useradd --uid 10001 --user-group --no-create-home --shell /usr/sbin/nologin cinder-job
ENV TOOL_CACHE=/var/cache/cinder-toolcache
COPY --from=build /out/ /usr/local/bin/
ENTRYPOINT ["cinder-verify"]
