# Build from the repository root:
# docker build -f apps/admin-web/Dockerfile -t admin-web .
FROM node:24-alpine AS dependencies
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.24.0 --activate
WORKDIR /workspace/apps/admin-web
COPY apps/admin-web/package.json ./
RUN pnpm install --lockfile=false

FROM dependencies AS builder
COPY tsconfig.base.json /workspace/tsconfig.base.json
COPY apps/admin-web ./
RUN pnpm build

FROM node:24-alpine AS runner
ENV HOSTNAME=0.0.0.0
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder --chown=nextjs:nodejs /workspace/apps/admin-web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /workspace/apps/admin-web/.next/static ./.next/static
USER nextjs
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 CMD ["node", "-e", "fetch('http://127.0.0.1:3000/login').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]
CMD ["node", "server.js"]
