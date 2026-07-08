# syntax=docker/dockerfile:1
# ANSEM Miner keeper — always-on round runner + read-layer.
# Build context = REPO ROOT:  docker build -f keeper/Dockerfile -t ansem-keeper .
FROM node:22-slim
WORKDIR /repo
RUN corepack enable
# Workspace manifests first (layer cache), then sources.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/sdk/package.json packages/sdk/package.json
COPY keeper/package.json keeper/package.json
COPY app/package.json app/package.json
RUN pnpm install --frozen-lockfile --filter @ansem/sdk --filter @ansem/keeper
COPY packages/sdk packages/sdk
COPY keeper keeper
RUN pnpm --filter @ansem/sdk build && pnpm --filter @ansem/keeper build
# Entrypoint: materialize the admin keypair from the secret env, bind to the host's PORT.
RUN printf '#!/bin/sh\nset -e\n[ -n "$KEEPER_WALLET_JSON" ] || { echo "KEEPER_WALLET_JSON missing"; exit 1; }\nprintf "%%s" "$KEEPER_WALLET_JSON" > /repo/wallet.json\nexport DEVNET_WALLET=/repo/wallet.json\nexport KEEPER_HTTP_PORT="${PORT:-8787}"\nexec node keeper/dist/main.js\n' > /entrypoint.sh && chmod +x /entrypoint.sh
EXPOSE 8787
CMD ["/entrypoint.sh"]
