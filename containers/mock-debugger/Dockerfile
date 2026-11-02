# syntax=docker/dockerfile:1
FROM node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6

ENV HOME=/nonexistent
WORKDIR /opt/arkimux

COPY --chown=65532:65532 broker.mjs /opt/arkimux/broker.mjs
COPY --chown=65532:65532 retained-attempt-worker.mjs /opt/arkimux/retained-attempt-worker.mjs
COPY --chown=65532:65532 isolation-probe.mjs /opt/arkimux/isolation-probe.mjs

USER 65532:65532

ENTRYPOINT ["node", "--permission", "--allow-child-process", "--allow-fs-read=/opt/arkimux", "--allow-fs-read=/work/input", "--allow-fs-read=/work/scratch", "--allow-fs-write=/work/scratch", "/opt/arkimux/broker.mjs"]
