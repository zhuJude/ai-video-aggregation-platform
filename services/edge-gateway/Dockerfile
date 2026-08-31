FROM node:24.15.0-bookworm-slim AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/service-kit/package.json packages/service-kit/package.json
COPY services/edge-gateway/package.json services/edge-gateway/package.json
RUN pnpm install --lockfile=false --ignore-scripts --filter @repo/edge-gateway...
COPY packages/contracts packages/contracts
COPY packages/service-kit packages/service-kit
COPY services/edge-gateway services/edge-gateway
RUN pnpm --filter @repo/contracts build \
 && pnpm --filter @repo/service-kit build \
 && pnpm --filter @repo/edge-gateway build

FROM node:24.15.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN groupadd --system --gid 10001 gateway \
 && useradd --system --uid 10001 --gid gateway --home-dir /app gateway
COPY --from=build --chown=gateway:gateway /app /app
USER 10001:10001
EXPOSE 3000
CMD ["node", "services/edge-gateway/dist/src/main.js"]
