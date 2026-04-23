FROM node:20-alpine

WORKDIR /app

# Copy root package.json and lock file
COPY package.json pnpm-lock.yaml ./

# Copy workspace packages
COPY packages/ packages/
COPY apps/api/ apps/api/

# Install dependencies
RUN npm install -g pnpm && pnpm install --frozen-lockfile

# Build shared and api
WORKDIR /app
RUN pnpm -r build

# Run API
EXPOSE 3000
CMD ["node", "apps/api/dist/index.js"]
