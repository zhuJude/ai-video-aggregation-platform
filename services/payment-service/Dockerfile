FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/service-kit/package.json packages/service-kit/package.json
COPY services/payment-service/package.json services/payment-service/package.json
RUN corepack pnpm install --frozen-lockfile --ignore-scripts --filter @repo/payment-service...
COPY . .
RUN corepack pnpm --filter @repo/payment-service build

FROM node:24-alpine
RUN corepack enable
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/services/payment-service
USER node
EXPOSE 3013
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:3013/live || exit 1
CMD ["node", "dist/src/main.js"]
