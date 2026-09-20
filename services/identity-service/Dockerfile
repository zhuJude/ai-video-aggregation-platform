FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /workspace
COPY tsconfig.base.json ./
WORKDIR /workspace/services/identity-service
COPY services/identity-service/package.json services/identity-service/pnpm-lock.yaml services/identity-service/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts --config.strict-dep-builds=false
COPY services/identity-service ./
RUN pnpm rebuild @prisma/engines esbuild prisma && pnpm build && pnpm prune --prod

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /workspace/services/identity-service
COPY --from=build /workspace/services/identity-service/node_modules ./node_modules
COPY --from=build /workspace/services/identity-service/package.json ./package.json
COPY --from=build /workspace/services/identity-service/dist ./dist
USER node
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.IDENTITY_PORT||3001)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/src/main.js"]
