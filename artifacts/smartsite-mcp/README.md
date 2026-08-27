# Smart Site MCP (`artifacts/smartsite-mcp`)

Product MCP for Smart Site (OPS-16 P-87). Public hostname: `https://mcp.smartsite.cloud`.

Streamable HTTP MCP at `POST /mcp` with OAuth 2.1 bearer (WorkOS AuthKit). No public catalog: unauthenticated calls receive **401**.

## Endpoints

| Route | Purpose |
|---|---|
| `POST /mcp` | Streamable HTTP MCP (OAuth bearer required) |
| `GET /health` | Liveness JSON (`status`, `service`, `authConfigured`, `cortexConfigured`) |
| `GET /llms.txt` | Agent discovery — lists exactly eight Smart Site tools |
| `GET /.well-known/oauth-protected-resource` | MCP OAuth resource metadata |
| `GET /.well-known/oauth-authorization-server` | Proxies AuthKit authorization-server metadata |

## Tools (eight)

| Tool | Status | Backend |
|---|---|---|
| `find_parcel` | live | `GET /api/brokerage/v1/place/situs-search` |
| `get_smart_site` | live | `POST /api/property-explorer/v1/research/brief` |
| `list_my_properties` | live | Summary list only (no snapshot/chat); sourced from saved-properties |
| `run_report` | live | `POST /api/property-explorer/v1/research/brief` (sync R1; flattened + `reportReadMode`) |
| `request_records` | **not_ready** | P-85 blocked |
| `check_request` | **not_ready** | P-85 blocked |
| `export_instrument` | **not_ready** | P-87 blocked — no parcel export endpoint |
| `ask_the_map` | live | `POST /api/brokerage/v1/research/chat` |

Core tools call **cortex-api** with `SERVICE_API_KEY` only (A-039: no engine-api, no hauska-mcp-server).

## Local dev

```bash
pnpm install
export SMARTSITE_MCP_DEV_MODE=true
export SMARTSITE_MCP_DEV_TOKEN="google:dev-subject-1:dev@example.com"
export DATABASE_URL="..."
export CORTEX_API_BASE_URL="https://cortex-api-tds7av26va-uc.a.run.app"
export SERVICE_API_KEY="..."
pnpm --filter @workspace/smartsite-mcp dev
```

Probe:

```bash
curl -s http://localhost:8080/health | jq .
curl -s http://localhost:8080/.well-known/oauth-protected-resource | jq .
curl -s http://localhost:8080/llms.txt
curl -s -X POST http://localhost:8080/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0"}}}'
# Expect HTTP 401 missing_bearer
```

## Tests

```bash
pnpm --filter @workspace/smartsite-mcp test
```

## Production env (Cloud Run)

| Variable / secret | Purpose |
|---|---|
| `WORKOS_CLIENT_ID` (secret) | AuthKit OAuth client id; JWT audience verification uses `SMARTSITE_MCP_RESOURCE` |
| `WORKOS_ISSUER` | `https://happy-asteroid-26.authkit.app` |
| `WORKOS_JWKS_URI` | `https://happy-asteroid-26.authkit.app/oauth2/jwks` |
| `SMARTSITE_MCP_RESOURCE` | `https://mcp.smartsite.cloud/mcp` (JWT audience) |
| `SMARTSITE_MCP_PUBLIC_URL` | `https://mcp.smartsite.cloud` (llms.txt + OAuth metadata) |
| `DATABASE_URL` (secret) | Neon cortex-prod for `pe_user_identities` join |
| `CORTEX_API_BASE_URL` | Workbench backend URL (cortex-api Cloud Run) |
| `SERVICE_API_KEY` (secret) | Service bearer for cortex property-explorer / brokerage routes |
| `PORT` | `8080` (Cloud Run default) |

Operator-owed before live Connect: WorkOS AuthKit project with CIMD, Google + Microsoft on AS, DNS `mcp.smartsite.cloud` → Cloud Run.

## Deploy

Separate Cloud Run service **`smartsite-mcp`** (not cortex-api).

Workflow: `.github/workflows/cloud-run-deploy-smartsite-mcp.yml`

1. **Push to `main`** (paths under `artifacts/smartsite-mcp/`) — builds and pushes image to Artifact Registry (`apps/smartsite-mcp`).
2. **`workflow_dispatch` → `deploy-canary`** — deploys a 0%-traffic canary revision tagged `canary`.
3. **`workflow_dispatch` → `shift-traffic`** — routes 100% to canary and smoke-probes `GET /health`.

Docker build from monorepo root:

```bash
docker build -f artifacts/smartsite-mcp/Dockerfile .
```

WDLL: `_inbox/2026-08-26_smartsite_ai_connector_WDLL.md` items 9–17.
