# syntax=docker/dockerfile:1
# Build from the repo root: docker build -f apps/api/Dockerfile .
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/rules/package.json packages/rules/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@fieldtrack/api..."
COPY packages/rules packages/rules
COPY apps/api apps/api
RUN pnpm --filter @fieldtrack/api build && pnpm --filter @fieldtrack/api forms && pnpm --filter @fieldtrack/api deploy --prod --legacy /out

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=3000 MIGRATIONS_DIR=/app/db/migrations DB_SSLROOTCERT=/app/rds-ca.pem
# TLS to RDS is verified against Amazon's CA bundle, not just encrypted.
ADD --chmod=644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/rds-ca.pem
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/forms ./forms
COPY db/migrations ./db/migrations
USER node
EXPOSE 3000
# Same image runs migrations as a one-off task: command ["node", "dist/migrate.js"]
CMD ["node", "dist/server.js"]
