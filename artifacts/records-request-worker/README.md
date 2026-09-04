# Records Request worker (P-85 item 5)

Playwright Cloud Run worker for clerk portal records search.

- **Williamson default:** `williamson-publicsearch` (TylerHost returns HTTP 403 to headless bots).
- **Tyler counties (Hays, Williamson TylerHost, McLennan):** disclaimer → owner-name search → results capture with SHA-256. McLennan is the same Tyler self-service DOCSEARCH product as Hays (verified live 2026-09-03, reachable headless unlike Williamson TylerHost) but its combined name field id (`field_BothNamesID`) differs from Hays' (`field_GrantorGrantee`) — see `TYLER_MCLENNAN_SEARCH_INPUT_SELECTORS`.
- **Aumentum counties (Bastrop, Travis tccsearch):** SearchTerms → grantor / legal / subdivision queries → per-query results capture with SHA-256.
- **Caldwell (CountyGovernmentRecords.com):** a different Tyler Technologies product than the ERSS/self-service counties, verified live 2026-09-03. The splash page's only action routes straight to a login page — "Users of this site must register to conduct document searches," with no anonymous search path. The recipe reaches the real portal, acknowledges the splash, and fails closed to `needs-human`/`login-required` (same tri-state contract as every other county); it does not register or hold a login credential (NO PRIVILEGED DATA).

## Job contract

Reads `jobId` from:

- `RECORDS_REQUEST_JOB_ID` env (Cloud Run Job)
- `--job-id=<uuid>` CLI flag
- HTTP `POST /run` with `{ "jobId": "..." }` when `PORT` is set (Cloud Run Service)

Requires `DATABASE_URL`. Transitions `records_request_jobs` status
`queued → running → complete|failed|needs-human` with honest errors when the portal is
unreachable, login is required, or the daily canary marks the portal `lookup-failed`.

## Run cost (item 14)

Every terminal transition writes `run_cost` jsonb with `imageFeesCents`, `computeCents`,
`humanMinutes`, `instrumentCount`, `totalCents`, and `derivedAt`. Values derive from
`scope_searched.acquisition` metadata and worker wall time.

## Portal canary (item 14)

Daily selector drift check via `scripts/p85/run-records-portal-canary.mjs` (Cloud Scheduler
stub). Failing versioned recipe selectors set `clerk_portal_terms.canary_status=lookup-failed`,
blocking new enqueues and worker runs until the next passing canary.

## api-server integration

When `RECORDS_REQUEST_WORKER_URL` is set, `enqueueRecordsRequestJob` POSTs
`{ jobId }` to that URL (fire-and-forget). When unset, launch is a no-op.

## Local setup

```bash
cd artifacts/records-request-worker
pnpm install
pnpm test
RECORDS_REQUEST_JOB_ID=<uuid> DATABASE_URL=... pnpm start
```

HTTP mode (matches `RECORDS_REQUEST_WORKER_URL` deployment):

```bash
PORT=8080 DATABASE_URL=... pnpm start
curl -X POST localhost:8080/run -H 'Content-Type: application/json' -d '{"jobId":"<uuid>"}'
```

## Docker

```bash
docker build -t records-request-worker -f artifacts/records-request-worker/Dockerfile .
```

Cloud Run Job example:

```bash
gcloud run jobs execute records-request-worker \
  --update-env-vars RECORDS_REQUEST_JOB_ID=<uuid>,DATABASE_URL=<secret>
```

## Recipes

| portalId              | county | status        |
| --------------------- | ------ | ------------- |
| bastrop-aumentum      | 48021  | index-search  |
| travis-tccsearch      | 48453  | index-search  |
| williamson-tylerhost  | 48491  | index-search  |
| williamson-publicsearch | 48491 | index-search (default) |
| hays-erss             | 48209  | index-search  |
| caldwell-clerk-web    | 48055  | index-search (fails closed to needs-human/login-required — real portal has no anonymous search path, verified live 2026-09-03) |
| mclennan-online-records | 48309 | index-search (P-113, verified live 2026-09-03) |

Index-search recipes require `searchTerms.ownerName` on the job payload (cortex enriches at enqueue from TxGIO). Login walls route to `needs-human`.

## Williamson publicsearch grading (P-85 W1 item 5)

Default portal for county `48491`. Grading fixture parcel: `apn:48491:R062578` with owner `PURVIS MICHAEL`.

Unit fixture and expected `scopeSearched` shape: `src/recipes/publicsearchSearch.test.ts`.

Operator live run (production portal — manual only):

```bash
cd artifacts/records-request-worker
pnpm install
pnpm exec playwright install chromium
pnpm exec vitest run src/recipes/publicsearchSearch.live.test.ts
```

Pass criteria on job `scope_searched`:

- `mode` is `index-search`
- `portalId` is `williamson-publicsearch`
- `recipeVersion` is `p85-publicsearch-v1`
- `stepsReached` includes `open-entry`, `open-portal`, `fill-owner-query`, `submit-search`
- `captures[0].sha256` is a 64-char hex digest
- `queries[0].kind` is `owner-name` matching CAD owner
- Terminal status is `complete`, `needs-human`, or `awaiting-purchase-approval`
