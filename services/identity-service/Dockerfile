FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /workspace
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY services/identity-service/package.json services/identity-service/package.json
RUN pnpm install --frozen-lockfile --ignore-scripts --filter @repo/identity-service...
COPY services/identity-service services/identity-service
RUN pnpm rebuild @prisma/engines esbuild prisma \
 && pnpm --filter @repo/identity-service build \
 && pnpm --filter @repo/identity-service deploy --prod --legacy /opt/service

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /opt/service
COPY --from=build /opt/service ./
COPY --from=build /workspace/services/identity-service/dist ./dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.IDENTITY_PORT||3001)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/src/main.js"]
