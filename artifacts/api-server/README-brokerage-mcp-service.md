/**
 * MCP service-path contract for brokerage Layer 2 routes.
 *
 * cc-agent-M (`hauska-mcp-server/src/legacy-client.ts`) wires against this
 * document. Env pairing:
 *   - cortex-api: `SERVICE_API_KEY`
 *   - hauska-mcp-server: `LEGACY_BACKEND_API_KEY` (same secret)
 */

# Brokerage MCP service path

## Auth

| Header | Value | Required |
|---|---|---|
| `Authorization` | `Bearer <SERVICE_API_KEY>` | yes (service path) |
| `X-Hauska-Jurisdiction-Tenant` | tenant slug from gate `#29` (e.g. `bastrop_tx`) | recommended on service path |
| `X-Hauska-Platform-Internal` | `true` when Hauska operator bypass applies | optional |
| `X-Hauska-Install-Id` | — | **no** on service path |
| `X-Hauska-Key` | same bearer value accepted | optional alias |

Wrong or missing credentials:

```json
{ "error": "unauthorized", "message": "Valid Authorization Bearer (service token or brokerage key) or X-Hauska-Key required" }
```

HTTP **401**.

The service token is the same secret used for L-surface routes (`requireServiceToken`).

## Property brief

### `POST /api/brokerage/v1/brief`

Request body (unchanged from extension):

```json
{
  "address": "251 Cool Water Dr, Bastrop, TX 78602",
  "mls_id": "optional",
  "source": "optional",
  "page_url": "optional",
  "presentationMode": "consumer"
}
```

Success: **200** with `runId`, `reasoningSummary`, `laySummary`, `citations`, `atoms`, `siteContext`, etc.

Service-path differences vs extension:

- No wallet **402** (`insufficient_balance`) — MCP gate meters Layer 2 calls.
- No `X-Hauska-Install-Id` required.
- Billable signal on success:
  - Response header: `X-Hauska-Billable: property-brief-v1`
  - Response body: `meta.metering: { "billable": true, "sku": "property-brief-v1" }`

Validation error (**400**):

```json
{
  "errorClass": "validation_error",
  "error": "invalid_request",
  "message": "Invalid brief body"
}
```

### `GET /api/brokerage/v1/brief/{runId}`

Read companion for a persisted brief run. `{runId}` is the UUID returned by POST.

Success: **200** — stored brief payload (site-context layer payloads stripped).

Not found (**404**):

```json
{ "error": "not_found", "message": "Brief run not found" }
```

Invalid UUID (**400**):

```json
{ "error": "invalid_request", "message": "Invalid brief runId" }
```

GET is not billable (no `X-Hauska-Billable` header).

## Place-scoped hydrology (address without engagement)

All routes use the same service auth as brief. Internally materializes a
deterministic engagement `mcp-place:{placeKey}` and reuses engagement-scoped
workers.

### Site topography

| Method | Path | Body / params |
|---|---|---|
| POST | `/api/brokerage/v1/place/site-topography/refresh` | `{ "address": "..." }` or `{ "lat", "lng" }` |
| POST | `/api/brokerage/v1/place/{placeKey}/site-topography/refresh` | optional refresh params |
| GET | `/api/brokerage/v1/place/{placeKey}/site-topography` | — |

Refresh success envelope includes `placeKey`, `engagementId`, `mcpPlaceEngagementCreated`, plus worker fields (`status`, `materializableElementId`, `propertySet` on GET).

### Site drainage

| Method | Path | Body / params |
|---|---|---|
| POST | `/api/brokerage/v1/place/site-drainage/refresh` | `{ "address": "..." }` or `{ "lat", "lng" }` |
| POST | `/api/brokerage/v1/place/{placeKey}/site-drainage/refresh` | optional rainfall params |
| GET | `/api/brokerage/v1/place/{placeKey}/site-drainage` | — |

`{placeKey}` is URL-encoded (e.g. `coord%3A30.11000%3A-97.32000`).

## cc-agent-M wiring checklist

1. Send `Authorization: Bearer ${LEGACY_BACKEND_API_KEY}` on brief POST/GET and place hydrology routes.
2. Do **not** send `X-Hauska-Install-Id`.
3. On brief POST success, read `X-Hauska-Billable` and/or `meta.metering` for gate accounting (SDK sprint wires charging).
4. Use `GET .../brief/{runId}` for async poll / re-fetch after POST returns `runId`.
