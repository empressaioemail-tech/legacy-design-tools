# Placid collateral export (api-server)

Headless **PDF** export for Deliver → **Client materials** via [Placid REST API 2.0](https://placid.app/docs/2.0/rest). Replaces Canva Enterprise autofill as the primary path.

## Environment

```env
# Required for live Placid calls (omit for dev stub PDF job)
PLACID_API_TOKEN=

# Watermarked previews, no production credits (recommended for local QA)
PLACID_TEST_MODE=true

# Template UUIDs from Placid dashboard (required for production QA)
PLACID_TEMPLATE_COVER=
PLACID_TEMPLATE_PLAN=
PLACID_TEMPLATE_CLOSING=

# HMAC for signed asset URLs (Placid fetches images from your api-server)
COLLATERAL_SIGNING_SECRET=

# GCS — same as renders (optional PDF persist after Placid finishes)
GOOGLE_APPLICATION_CREDENTIALS=
PRIVATE_OBJECT_DIR=
```

When `PLACID_API_TOKEN` is unset, export jobs complete with a **dev stub** `downloadUrl` (no Placid HTTP).

## Local QA

Use **`pnpm run dev:local`** or `scripts/dev-local-windows.ps1` — **not** `pnpm run dev` (Cloud Run proxy → missing routes).

1. Apply migration `lib/db/drizzle/0025_add_collateral.sql` (or `pnpm db:push` in your env).
2. Set `DATABASE_URL`, `COLLATERAL_SIGNING_SECRET`, and optional `PLACID_*` in `.env.local`.
3. Engagement → **Deliver → Client materials** → **Generate PDF**.

Spike script (Placid + signed URL smoke):

```powershell
$env:COLLATERAL_SIGNING_SECRET = "your-secret"
$env:PLACID_API_TOKEN = "..."
$env:PLACID_TEST_MODE = "true"
node scripts/spike-placid.mjs
```

## API routes

| Method | Path |
|--------|------|
| GET | `/api/collateral/templates` |
| GET | `/api/collateral/fetch/:token/:assetKey` (public, signed) |
| GET | `/api/engagements/:engagementId/collateral/assets` |
| POST | `/api/engagements/:engagementId/collateral/export` → `202 { jobId }` |
| GET | `/api/collateral/export-jobs/:jobId` |
| GET | `/api/engagements/:engagementId/collateral/exports` |

## Placid layer mapping (client-presentation)

| Placid layer | Slot / source |
|--------------|----------------|
| `headline` | `textFields.headline` or package `clientHeadline` |
| `address` | `textFields.address` |
| `project_name` | `textFields.project_name` / engagement name |
| `hero_image` | `slotMapping.hero_image` (signed URL) |
| `floor_plan` | plan page — selected sheet asset (signed URL) |
| `sheet_label` | sheet id label text |
| `talking_points` | `textFields.talking_points` / package talking points |

**PDF assembly:** cover → up to 12 plan pages (`PLACID_TEMPLATE_PLAN`) → closing.

**Credits:** 2 per page (`credits_estimated` on create, `credits_actual` on complete). Metering row in `collateral_metering_events`.

## Tests

```powershell
pnpm --filter @workspace/api-server run test -- src/__tests__/exportSignedUrl.test.ts src/__tests__/collateral-route.test.ts
```

Requires `DATABASE_URL` and test Postgres.
