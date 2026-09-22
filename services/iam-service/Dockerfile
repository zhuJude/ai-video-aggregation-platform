FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY services/iam-service/package.json services/iam-service/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @repo/iam-service...
COPY services/iam-service services/iam-service
RUN pnpm rebuild @prisma/engines argon2 esbuild prisma \
 && pnpm --filter @repo/iam-service build \
 && pnpm --filter @repo/iam-service deploy --prod --legacy /opt/service

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /opt/service
COPY --from=build /opt/service ./
COPY --from=build /workspace/services/iam-service/dist ./dist
USER node
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.IAM_PORT||3002)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/src/main.js"]
