FROM node:24.15.0-alpine AS dependencies
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml ./
COPY pnpm-lock.yaml ./
COPY apps/user-web/package.json ./apps/user-web/package.json
COPY packages ./packages
RUN corepack pnpm install --frozen-lockfile --filter @repo/user-web...

FROM node:24.15.0-alpine AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/apps/user-web/node_modules ./apps/user-web/node_modules
COPY --from=dependencies /app/packages ./packages
COPY . .
RUN corepack pnpm --filter @repo/user-web build

FROM node:24.15.0-alpine AS runner
WORKDIR /app
ENV HOSTNAME=0.0.0.0
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /app/apps/user-web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/user-web/.next/static ./apps/user-web/.next/static
COPY --from=builder --chown=nextjs:nodejs /app/apps/user-web/public ./apps/user-web/public
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -qO- http://127.0.0.1:3000/health || exit 1
CMD ["node", "apps/user-web/server.js"]
