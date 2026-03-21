FROM node:20-slim AS base
RUN corepack enable

FROM base AS deps
WORKDIR /app
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
COPY client/package.json ./client/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build
# Produce a self-contained server deploy directory with workspace deps inlined
RUN pnpm --filter @wordfetti/server deploy --prod /app/deploy

FROM node:20-slim AS runtime
WORKDIR /app
COPY --from=build /app/deploy ./server
COPY --from=build /app/client/dist ./public
ENV NODE_ENV=production
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s \
  CMD node -e "require('http').get('http://localhost:3000/health',r=>process.exit(r.statusCode===200?0:1))"
CMD ["node", "server/dist/index.js"]
