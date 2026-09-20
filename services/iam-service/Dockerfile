FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /workspace
COPY tsconfig.base.json ./
WORKDIR /workspace/services/iam-service
COPY services/iam-service/package.json services/iam-service/pnpm-lock.yaml services/iam-service/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts --config.strict-dep-builds=false
COPY services/iam-service ./
RUN pnpm rebuild @prisma/engines argon2 esbuild prisma && pnpm build && pnpm prune --prod

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /workspace/services/iam-service
COPY --from=build /workspace/services/iam-service/node_modules ./node_modules
COPY --from=build /workspace/services/iam-service/package.json ./package.json
COPY --from=build /workspace/services/iam-service/dist ./dist
USER node
EXPOSE 3002
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.IAM_PORT||3002)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/src/main.js"]
