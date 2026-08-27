# Smart Site MCP — Cloud Run
FROM node:20-bookworm-slim

WORKDIR /app

# Build from monorepo root:
# docker build -f artifacts/smartsite-mcp/Dockerfile .

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY artifacts/smartsite-mcp/package.json ./artifacts/smartsite-mcp/
COPY lib/db/package.json ./lib/db/
COPY lib/db/src ./lib/db/src
COPY lib/db/drizzle.config.ts ./lib/db/

RUN corepack enable && pnpm install --filter @workspace/smartsite-mcp... --frozen-lockfile || pnpm install --filter @workspace/smartsite-mcp...

COPY artifacts/smartsite-mcp ./artifacts/smartsite-mcp
COPY tsconfig.base.json ./

WORKDIR /app/artifacts/smartsite-mcp
RUN pnpm build

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "dist/index.js"]
