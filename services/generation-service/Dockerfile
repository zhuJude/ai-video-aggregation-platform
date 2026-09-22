FROM node:24.15.0-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.mjs ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY services/generation-service/package.json services/generation-service/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --filter . --filter @repo/generation-service...
COPY packages/contracts packages/contracts
COPY services/generation-service services/generation-service
RUN pnpm --filter @repo/contracts build \
 && pnpm --filter @repo/generation-service build \
 && pnpm --filter @repo/generation-service deploy --prod --legacy /runtime \
 && mkdir -p /runtime/node_modules/@repo/contracts/dist \
 && cp -R packages/contracts/dist/. /runtime/node_modules/@repo/contracts/dist/

FROM node:24.15.0-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
RUN groupadd --system --gid 10001 generation \
 && useradd --system --uid 10001 --gid generation --home-dir /app generation
COPY --from=build --chown=generation:generation /runtime /app
USER 10001:10001
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3000')+'/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/src/runtime/main.js"]
