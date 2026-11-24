FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY apps/shared/package.json apps/shared/

# pnpm is pinned (same version as package.json's "packageManager"). Unpinned,
# this line installed whatever was newest on build day, and a newer pnpm
# refused the install outright (ERR_PNPM_IGNORED_BUILDS) — invisible on the
# server only while Docker kept reusing an old cached copy of this step.
RUN npm install -g pnpm@10.33.2 --quiet && pnpm install --frozen-lockfile

COPY apps/shared apps/shared
COPY apps/web apps/web

RUN pnpm --filter @soono/shared build && pnpm --filter @soono/web build

FROM nginx:alpine

COPY --from=builder /app/apps/web/dist /usr/share/nginx/html
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
