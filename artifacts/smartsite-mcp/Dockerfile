# Smart Site MCP — Cloud Run (Node 22 for pnpm 10 via corepack)
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

WORKDIR /app/artifacts/smartsite-mcp
RUN pnpm add -D esbuild && pnpm exec esbuild src/index.ts --bundle --platform=node --target=node22 --format=esm --outfile=dist/server.mjs --external:dotenv --external:express --external:jose --external:drizzle-orm --external:pg --external:zod --external:"@modelcontextprotocol/*"

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "dist/server.mjs"]
