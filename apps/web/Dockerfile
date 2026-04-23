FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
COPY packages/ packages/
COPY apps/web/ apps/web/

RUN npm install -g pnpm && pnpm install --frozen-lockfile
RUN pnpm --filter @radio/web build

FROM node:20-alpine

WORKDIR /app

RUN npm install -g pnpm serve

COPY --from=builder /app/apps/web/dist ./dist

EXPOSE 5173
CMD ["serve", "-s", "dist", "-l", "5173"]
