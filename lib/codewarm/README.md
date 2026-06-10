# @workspace/codewarm — cold-warm batch harness

Warms national reference manifests into cortex-local **reasoning atoms** (citation/structure only — no verbatim code text, no findings).

## CLI

```powershell
pnpm --filter @workspace/codewarm codewarm -- `
  --manifest P:\doc_repo\_catalog\codes\manifest_irc_2021.yaml `
  --jurisdiction austin_tx `
  [--dry-run] [--budget-cap 5.0]
```

## Windows TLS (UpCodes / ICC fetch)

On some Windows workstations (TLS-intercepting proxy), Node fails HTTPS to UpCodes with `unable to verify the first certificate`. Set before running the harness or B1 warm pass:

```powershell
$env:NODE_OPTIONS = "--use-system-ca"
```

See also `docs/local-dev-windows.md`.

## Manifest parser

Supports catalog YAML inline rows in `_catalog/codes/manifest_*.yaml`:

- Unquoted sections: `{ section: R301.1, title: "...", ... }`
- Quoted sections: `{ section: "302.1", title: "...", ... }` (IBC/IMC/IFC)
- `groups:` blocks with per-group or per-row `edition` (accessibility + NFPA track)

## Driver profiles

URL builders live in `lib/codes/src/webCodeFetch/driverProfiles.ts`. Florida (Miami/FBC 2023) paths are unchanged; Texas/national 2021 I-Codes use UpCodes + ICC Digital Codes slugs. IECC and A117.1 use **municipality-scoped** UpCodes slugs (e.g. `austin/iecc-2021`, `austin/icc-a117.1-2017`) — there is no statewide `texas/iecc-2021`.

Add a new geography by extending `CODE_BOOK_SLUGS` and the jurisdiction → UpCodes slug map — not by forking `drivers.ts`.

## Tests

```powershell
# Fixture shape tests (CI)
pnpm --filter @workspace/codewarm test

# Full six-manifest counts (local, requires doc_repo catalog path)
$env:CODEWARM_CATALOG_DIR = "P:\doc_repo\_catalog\codes"
pnpm --filter @workspace/codewarm test
```
