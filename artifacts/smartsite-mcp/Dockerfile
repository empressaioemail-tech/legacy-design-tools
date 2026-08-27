# Smart Site MCP — Cloud Run (Node 22 for pnpm 11 via corepack)
FROM node:22-bookworm-slim

WORKDIR /app

# Build from monorepo root:
# docker build -f artifacts/smartsite-mcp/Dockerfile .

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY artifacts/smartsite-mcp/package.json ./artifacts/smartsite-mcp/
COPY lib/db/package.json ./lib/db/
COPY lib/db/tsconfig.json ./lib/db/
COPY lib/db/src ./lib/db/src
COPY lib/db/drizzle.config.ts ./lib/db/

RUN corepack enable && corepack prepare pnpm@10.28.0 --activate && pnpm install --filter @workspace/smartsite-mcp... --frozen-lockfile || pnpm install --filter @workspace/smartsite-mcp...

COPY artifacts/smartsite-mcp ./artifacts/smartsite-mcp
COPY tsconfig.base.json ./

RUN cd /app/lib/db && pnpm exec tsc -p tsconfig.json

WORKDIR /app/artifacts/smartsite-mcp
RUN pnpm build

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "dist/index.js"]
