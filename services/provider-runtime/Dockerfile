FROM node:24.15.0-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json eslint.config.mjs ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/provider-sdk/package.json packages/provider-sdk/package.json
COPY providers/mock-provider/package.json providers/mock-provider/package.json
COPY services/provider-runtime/package.json services/provider-runtime/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --filter . --filter @repo/provider-runtime...
COPY packages/contracts packages/contracts
COPY packages/provider-sdk packages/provider-sdk
COPY providers/mock-provider providers/mock-provider
COPY services/provider-runtime services/provider-runtime
RUN pnpm --filter @repo/contracts build \
 && pnpm --filter @repo/provider-sdk build \
 && pnpm --filter @repo/mock-provider build \
 && pnpm --filter @repo/provider-runtime build \
 && pnpm --filter @repo/provider-runtime deploy --prod --legacy /runtime \
 && mkdir -p /runtime/node_modules/@repo/contracts/dist \
              /runtime/node_modules/@repo/provider-sdk/dist \
 && cp -R packages/contracts/dist/. /runtime/node_modules/@repo/contracts/dist/ \
 && cp -R packages/provider-sdk/dist/. /runtime/node_modules/@repo/provider-sdk/dist/

FROM node:24.15.0-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3001
WORKDIR /app
RUN groupadd --system --gid 10001 provider \
 && useradd --system --uid 10001 --gid provider --home-dir /app provider
COPY --from=build --chown=provider:provider /runtime /app
USER 10001:10001
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3001')+'/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/src/runtime/main.js"]
