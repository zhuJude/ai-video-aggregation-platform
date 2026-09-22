FROM node:24.15.0-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml turbo.json tsconfig.base.json ./
COPY packages ./packages
COPY services/catalog-service ./services/catalog-service
RUN corepack pnpm install --lockfile=false
RUN corepack pnpm --filter @repo/catalog-service build

FROM node:24.15.0-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /workspace
RUN groupadd --system --gid 10001 app && useradd --system --uid 10001 --gid app app
COPY --from=build --chown=app:app /workspace/node_modules ./node_modules
COPY --from=build --chown=app:app /workspace/packages ./packages
COPY --from=build --chown=app:app /workspace/services/catalog-service ./services/catalog-service
USER 10001:10001
EXPOSE 3001
CMD ["node", "services/catalog-service/dist/src/main.js"]
