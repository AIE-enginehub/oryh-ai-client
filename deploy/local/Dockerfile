FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git python3 make g++ ca-certificates dbus gnome-keyring libsecret-1-0 && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.19.0
ENV CI=1
WORKDIR /opt/deepseek-harness
COPY deepseek-harness/ ./
# The external-plugin Remote fix is not upstream (patches/deepseek-harness-external-remote.json), and the
# generator runs from its build output, so it must be applied before Harness is built. A checkout that
# already carries it — a developer's own tree — is accepted as is.
COPY oryh-ai-client/patches/deepseek-harness-external-remote.patch ./external-remote.patch
RUN if git apply --check external-remote.patch 2>/dev/null; then git apply external-remote.patch; \
    else git apply --check --reverse external-remote.patch; fi && rm -f external-remote.patch
RUN pnpm install --frozen-lockfile
ARG DSH_CLIENT_COMMIT_HASH=c291e7961a
RUN find packages vendor -type d -empty -delete
RUN rm -f tsconfig.host.tsbuildinfo tsconfig.client.tsbuildinfo && pnpm run build:native-system && node --max-old-space-size=4096 node_modules/typescript/bin/tsc -b tsconfig.host.json
RUN NODE_OPTIONS=--max-old-space-size=4096 DSH_CLIENT_COMMIT_HASH=$DSH_CLIENT_COMMIT_HASH pnpm build
RUN apt-get update && apt-get install -y --no-install-recommends musl-tools ripgrep && rm -rf /var/lib/apt/lists/*
RUN pnpm exec tsx native/system/scripts/build.ts
WORKDIR /opt/oryh-ai-client
COPY oryh-ai-client/ ./
RUN pnpm install --frozen-lockfile && pnpm build
ENV HOME=/home/node DSH_HOME=/home/node/.dsh XDG_DATA_HOME=/home/node/.local/share
RUN mkdir -p /home/node/.dsh /home/node/.local/share && chown -R node:node /home/node
USER node
EXPOSE 4173
ENTRYPOINT ["dbus-run-session", "--", "sh", "/opt/oryh-ai-client/deploy/local/entrypoint.sh"]
