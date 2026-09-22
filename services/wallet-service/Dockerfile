FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN corepack pnpm install --lockfile=false
RUN corepack pnpm --filter @repo/wallet-service build

FROM node:24-alpine
RUN corepack enable
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/services/wallet-service
USER node
EXPOSE 3012
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1:3012/live || exit 1
CMD ["node", "dist/src/main.js"]
