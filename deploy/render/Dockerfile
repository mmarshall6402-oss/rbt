# syntax=docker/dockerfile:1
# One-service test deploy (Render free tier): the API also serves the web app, behind a shared site password.
# Production on AWS uses apps/api/Dockerfile + CloudFront + Cognito instead. Build from the repo root.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/rules/package.json packages/rules/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile --filter "@fieldtrack/api..." --filter "@fieldtrack/web..."
COPY packages/rules packages/rules
COPY apps/api apps/api
COPY apps/web apps/web
RUN pnpm --filter @fieldtrack/web build \
 && pnpm --filter @fieldtrack/api build && pnpm --filter @fieldtrack/api forms && pnpm --filter @fieldtrack/api deploy --prod --legacy /out

FROM node:22-slim
# Same hardening as the AWS image: patched OS packages, no npm/corepack at runtime.
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/* \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
WORKDIR /app
ENV NODE_ENV=production PORT=3000 MIGRATIONS_DIR=/app/db/migrations AUTH_MODE=site WEB_DIR=/app/web
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/forms ./forms
COPY --from=build /repo/apps/web/dist ./web
COPY apps/web/security-headers.json ./web/security-headers.json
COPY db/migrations ./db/migrations
USER node
EXPOSE 3000
# Free plans have no pre-deploy step, so migrate on start (the runner holds an advisory lock and is a no-op when up to date).
CMD ["sh", "-c", "node dist/migrate.js && exec node dist/server.js"]
