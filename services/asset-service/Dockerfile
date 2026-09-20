FROM node:24.8.0-alpine AS dependencies
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY services/asset-service/package.json services/asset-service/package.json
RUN corepack pnpm install --lockfile=false --ignore-scripts

FROM dependencies AS build
COPY tsconfig.base.json ./
COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.json
COPY packages/contracts/src packages/contracts/src
COPY services/asset-service/tsconfig.json services/asset-service/tsconfig.json
COPY services/asset-service/prisma.config.ts services/asset-service/prisma.config.ts
COPY services/asset-service/prisma services/asset-service/prisma
COPY services/asset-service/scripts/prisma-generate.mjs services/asset-service/scripts/prisma-generate.mjs
COPY services/asset-service/src services/asset-service/src
RUN corepack pnpm --filter @repo/contracts build
RUN corepack pnpm --filter @repo/asset-service build
RUN corepack pnpm config set --location=project --json allowBuilds '{"@prisma/client":true,"@prisma/engines":true,"argon2":true,"esbuild":true,"prisma":true,"@alicloud/openapi-core":true,"protobufjs":true}'
RUN corepack pnpm --filter @repo/asset-service deploy --legacy --prod /opt/service

FROM node:24.8.0-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /opt/service
COPY --from=build --chown=10001:10001 /opt/service ./
COPY --from=build --chown=10001:10001 /workspace/services/asset-service/dist ./dist
USER 10001
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:3000/health/ready || exit 1
CMD ["node", "dist/src/main.js"]
