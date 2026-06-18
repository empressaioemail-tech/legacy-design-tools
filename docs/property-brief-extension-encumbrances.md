# Property Brief extension — encumbrance upload (R4)

Contract for `hauska-brief-extension` consuming cortex-api PB-301 encumbrance paths.

## CTA field on `POST /api/brokerage/v1/brief`

**Operator / dev tier** — multipart upload:

```json
{
  "meta": {
    "encumbranceUploadCta": {
      "label": "Upload CC&Rs",
      "workspaceDid": "did:hauska:property-workspace:<listingKey>",
      "uploadPath": "/api/brokerage/v1/workspaces/encumbrances/upload",
      "listPath": "/api/brokerage/v1/workspaces/encumbrances"
    }
  }
}
```

**Chrome Web Store (`extension_public`)** — presigned GCS upload (PB-301):

```json
{
  "meta": {
    "clientTier": "extension_public",
    "encumbranceUploadCta": {
      "label": "Upload CC&Rs",
      "workspaceDid": "did:hauska:property-workspace:<listingKey>",
      "requestPath": "/api/brokerage/v1/workspaces/encumbrances/request-upload-url",
      "completePath": "/api/brokerage/v1/workspaces/encumbrances/complete-upload",
      "maxBytes": 26214400,
      "contentType": "application/pdf"
    }
  }
}
```

**Extension wiring:** Use `meta.encumbranceUploadCta.label` for the button copy ("Upload CC&Rs"). Pass `workspaceDid` from `atoms.workspaceDid`.

## Presigned upload (extension_public — PB-301)

### 1. Request presign

`POST /api/brokerage/v1/workspaces/encumbrances/request-upload-url`

- Auth: `Authorization: Bearer <BROKERAGE_EXTENSION_PUBLIC_KEY>` + `X-Hauska-Install-Id`
- JSON body:

```json
{
  "workspaceDid": "did:hauska:property-workspace:<listingKey>",
  "name": "ccr-sample.pdf",
  "size": 12345,
  "contentType": "application/pdf"
}
```

- Limits: `contentType` must be `application/pdf`; `size` ≤ **26,214,400** bytes (25 MiB).
- Response `200`:

```json
{
  "uploadURL": "https://storage.googleapis.com/...",
  "objectPath": "/objects/uploads/<uuid>",
  "workspaceDid": "did:hauska:property-workspace:<listingKey>",
  "metadata": { "name": "ccr-sample.pdf", "size": 12345, "contentType": "application/pdf" }
}
```

### 2. PUT bytes to GCS

`PUT <uploadURL>` with body = PDF bytes, `Content-Type: application/pdf`.

### 3. Complete ingest

`POST /api/brokerage/v1/workspaces/encumbrances/complete-upload`

- Same auth headers as presign.
- JSON body:

```json
{
  "workspaceDid": "did:hauska:property-workspace:<listingKey>",
  "objectPath": "/objects/uploads/<uuid>",
  "name": "ccr-sample.pdf",
  "size": 12345,
  "contentType": "application/pdf"
}
```

- Response `201`: `{ workspaceDid, listingKey, instruments[], clauses[] }`
- Uploaded docs are **tenant-private** (`accessPolicy: tenant-private`); scoped by `installId` + `listingKey` — never pooled.

## Multipart upload (operator / dev tier)

`POST /api/brokerage/v1/workspaces/encumbrances/upload`

- Auth: `X-Hauska-Install-Id` + brokerage API key (same as `/brief`)
- `Content-Type: multipart/form-data`
- Fields:
  - `file` (required) — PDF
  - `workspaceDid` (required) — from brief `atoms.workspaceDid`
- Response `201`: `{ workspaceDid, listingKey, instruments[], clauses[] }`

## List

`GET /api/brokerage/v1/workspaces/encumbrances?workspaceDid=did:hauska:property-workspace:...`

## LLM surfaces

After upload, `POST /brief` and `POST /research/chat` include uploaded clause excerpts in the Grok context (private restrictions block). `privateRestrictions` on the brief payload mirrors engagement briefing shape.

## Architect engagement path (unchanged)

Design Accelerator engagements continue to use:

- `POST /api/engagements/:id/encumbrances/upload`
- `GET /api/engagements/:id/encumbrances`
