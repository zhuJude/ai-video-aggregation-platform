FROM node:24.8.0-alpine AS dependencies
WORKDIR /workspace
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY services/notification-service/package.json services/notification-service/package.json
RUN corepack pnpm install --lockfile=false --ignore-scripts

FROM dependencies AS build
COPY tsconfig.base.json ./
COPY packages/contracts/tsconfig.json packages/contracts/tsconfig.json
COPY packages/contracts/src packages/contracts/src
COPY services/notification-service/tsconfig.json services/notification-service/tsconfig.json
COPY services/notification-service/prisma.config.ts services/notification-service/prisma.config.ts
COPY services/notification-service/prisma services/notification-service/prisma
COPY services/notification-service/scripts/prisma-generate.mjs services/notification-service/scripts/prisma-generate.mjs
COPY services/notification-service/src services/notification-service/src
RUN corepack pnpm --filter @repo/contracts build
RUN corepack pnpm --filter @repo/notification-service build
RUN corepack pnpm config set --location=project --json allowBuilds '{"@prisma/client":true,"@prisma/engines":true,"argon2":true,"esbuild":true,"prisma":true,"@alicloud/openapi-core":true,"protobufjs":true}'
RUN corepack pnpm --filter @repo/notification-service deploy --legacy --prod /opt/service

FROM node:24.8.0-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /opt/service
COPY --from=build --chown=10003:10003 /opt/service ./
COPY --from=build --chown=10003:10003 /workspace/services/notification-service/dist ./dist
USER 10003
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:3000/health/ready || exit 1
CMD ["node", "dist/src/main.js"]
