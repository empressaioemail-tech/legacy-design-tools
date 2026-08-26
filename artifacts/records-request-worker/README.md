# Records Request worker (P-85 item 5)

Playwright Cloud Run worker for clerk portal records search. Scaffold only:
Williamson TylerHost disclaimer reachability is verified; login and search are
placeholders.

## Job contract

Reads `jobId` from:

- `RECORDS_REQUEST_JOB_ID` env (Cloud Run Job)
- `--job-id=<uuid>` CLI flag
- HTTP `POST /run` with `{ "jobId": "..." }` when `PORT` is set (Cloud Run Service)

Requires `DATABASE_URL`. Transitions `records_request_jobs` status
`queued → running → complete|failed` with honest errors when the portal is
unreachable.

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

| portalId              | county | status   |
| --------------------- | ------ | -------- |
| williamson-tylerhost  | 48491  | scaffold |

Other P-85 counties fail closed with `portal-unresolved` until recipes land.
