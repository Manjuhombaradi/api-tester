# API Tester command line runner - runs exported suites in CI pipelines or on any Docker host (no GUI).
#   docker build -t api-tester .
#   docker run --rm -v "$PWD:/work" api-tester run /work/suite.apisuite --env CI --reporter cli,junit --out /work/reports
# Linux hosts: add --user "$(id -u):$(id -g)" so report files belong to you.
# Local test API (sample suite):  docker run --rm -p 127.0.0.1:3999:3999 api-tester echo-server
#   (127.0.0.1: reachable from this computer only; plain -p 3999:3999 publishes it on every network interface)
#
# Base image: node:22-bookworm-slim, pinned by digest so every build of a commit uses the same image
# (digest of 2026-10-21; Dependabot proposes updates). Rebuild the image when Node.js publishes a security release.

# --- production dependencies, exactly as locked, without install scripts (Electron and the packaging tools are
#     dev dependencies and are not installed)
FROM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

# --- runtime image: Node.js and the command line version only
FROM node:25-bookworm-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370
LABEL org.opencontainers.image.authors="Manjunagouda Hombaradi <manjuhombaradi@gmail.com>"
# npm, npx, corepack and yarn are not needed to run suites: removed (less to attack, fewer scanner findings)
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
        /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
        /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-v*

WORKDIR /app
# API_TESTER_ECHO_HOST: the echo server listens on all interfaces inside the container, so -p 127.0.0.1:3999:3999 works
ENV NODE_ENV=production \
    API_TESTER_ECHO_HOST=0.0.0.0

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src/cli.js ./src/cli.js
COPY src/core ./src/core
COPY src/main/commandLine.js src/main/workspace.js ./src/main/
COPY samples ./samples

# Suites and reports are read / written relative to /work (mount your folder there). Without a mount, reports
# go to the container (owned by the node user, so writing them does not fail).
RUN mkdir -p /work && chown node:node /work
WORKDIR /work
# unprivileged user (uid 1000) of the base image
USER node
EXPOSE 3999

ENTRYPOINT ["node", "/app/src/cli.js"]
CMD ["--help"]
