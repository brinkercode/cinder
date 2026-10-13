# The slim image WorkerLite and WorkerBasic run on Cloudflare Containers (lite's disk is 2,000 MB); worker/src/workers.js
# sets CINDER_URL and CINDER_RUNNER_TOKEN. Node and git only: jobs that need another stack's toolchain go to the
# standard pool, which runs runner/Dockerfile.full. cinder-verify claims and hands the agent kinds to cinder-agent.
FROM golang:1.27 AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -o /out/ ./cmd/cinder-agent ./cmd/cinder-verify

FROM node:22.20.0-bookworm-slim
ENV CINDER_BAKED="node=22.20.0"
RUN apt-get update && apt-get install -y --no-install-recommends git make ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# claude is the develop and resolve harness's default CLI (internal/harness); without it develop fails at once.
RUN npm install -g @anthropic-ai/claude-code@2.0.14 && npm cache clean --force
# opencode runs agents on OpenAI-compatible models, Workers AI among them (internal/harness/opencode.go).
RUN npm install -g opencode-ai@1.18.32 && npm cache clean --force
# Smoke test: the build fails unless every tool answers its version command.
RUN node --version && npm --version && git --version && make --version && claude --version && opencode --version
COPY --from=build /out/ /usr/local/bin/
ENTRYPOINT ["cinder-verify"]
