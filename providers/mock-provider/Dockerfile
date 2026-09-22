FROM node:24.15.0-bookworm-slim AS build
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json eslint.config.mjs ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/provider-sdk/package.json packages/provider-sdk/package.json
COPY providers/mock-provider/package.json providers/mock-provider/package.json
RUN pnpm install --lockfile=false --ignore-scripts --filter . --filter @repo/mock-provider...
COPY packages/contracts packages/contracts
COPY packages/provider-sdk packages/provider-sdk
COPY providers/mock-provider providers/mock-provider
RUN pnpm --filter @repo/contracts build \
 && pnpm --filter @repo/provider-sdk build \
 && pnpm --filter @repo/mock-provider build \
 && pnpm --filter @repo/mock-provider deploy --prod --legacy /runtime \
 && mkdir -p /runtime/node_modules/@repo/contracts/dist \
              /runtime/node_modules/@repo/provider-sdk/dist \
 && cp -R packages/contracts/dist/. /runtime/node_modules/@repo/contracts/dist/ \
 && cp -R packages/provider-sdk/dist/. /runtime/node_modules/@repo/provider-sdk/dist/

FROM node:24.15.0-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3002
WORKDIR /app
RUN groupadd --system --gid 10001 mockprovider \
 && useradd --system --uid 10001 --gid mockprovider --home-dir /app mockprovider
COPY --from=build --chown=mockprovider:mockprovider /runtime /app
USER 10001:10001
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||'3002')+'/health/live').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/src/main.js"]
