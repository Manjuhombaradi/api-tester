# API Tester command line runner - runs exported suites in CI pipelines or on any Docker host (no GUI).
#   docker build -t api-tester .
#   docker run --rm -v "$PWD:/work" api-tester run /work/suite.apisuite --env CI --reporter cli,junit --out /work/reports
# Linux hosts: add --user "$(id -u):$(id -g)" so report files belong to you.
# Local test API (sample suite):  docker run --rm -p 3999:3999 api-tester echo-server
FROM node:22-bookworm-slim

WORKDIR /app
# API_TESTER_ECHO_HOST: the echo server listens on all interfaces inside the container, so -p 3999:3999 works
ENV NODE_ENV=production \
    API_TESTER_ECHO_HOST=0.0.0.0

COPY package.json package-lock.json ./
# Electron and the packaging tools are dev dependencies and are not installed here.
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

COPY src/cli.js ./src/cli.js
COPY src/core ./src/core
COPY src/main/commandLine.js src/main/workspace.js ./src/main/
COPY samples ./samples

# Suites and reports are read / written relative to /work (mount your folder there). Without a mount, reports
# go to the container (owned by the node user, so writing them does not fail).
RUN mkdir -p /work && chown node:node /work
WORKDIR /work
USER node
EXPOSE 3999

ENTRYPOINT ["node", "/app/src/cli.js"]
CMD ["--help"]
