# Records Request worker — Playwright Cloud Run sidecar (P-85 item 5)
FROM mcr.microsoft.com/playwright:v1.59.1-noble

WORKDIR /app

# Build from monorepo root: docker build -f artifacts/records-request-worker/Dockerfile .
COPY artifacts/records-request-worker/package.json ./
RUN npm install --omit=dev

COPY artifacts/records-request-worker/src ./src
COPY artifacts/records-request-worker/tsconfig.json ./

RUN npm install --save-dev tsx typescript @types/node @types/pg

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_ENV=production

EXPOSE 8080

CMD ["npx", "tsx", "src/run.ts"]
