# Property Brief extension — encumbrance upload (R4)

Contract for `hauska-brief-extension` consuming cortex-api PB-301 encumbrance paths.

## CTA field on `POST /api/brokerage/v1/brief`

Every brief response includes `meta.encumbranceUploadCta`:

```json
{
  "meta": {
    "encumbranceUploadCta": {
      "label": "Upload CC&Rs",
      "workspaceDid": "did:hauska:property-workspace:<listingKey>",
      "uploadPath": "/api/brokerage/v1/workspaces/encumbrances/upload",
      "listPath": "/api/brokerage/v1/workspaces/encumbrances"
    }
  },
  "atoms": {
    "workspaceDid": "did:hauska:property-workspace:<listingKey>"
  }
}
```

**Extension wiring:** Use `meta.encumbranceUploadCta.label` for the button copy ("Upload CC&Rs"). Pass `workspaceDid` from `atoms.workspaceDid` as a multipart form field on upload.

## Upload

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
