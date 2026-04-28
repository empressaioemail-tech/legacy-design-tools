# Municode adapter — engineering & legal notes

## What this adapter is

`lib/codes-sources/src/municode/` is a **direct, in-process Node HTTP client**
against the unofficial JSON endpoints exposed at `https://api.municode.com`,
which power the public reader UI at `https://library.municode.com`.

It replaces an originally-spec'd Python subprocess (Skatterbrainz/MunicipalMCP).
We deliberately removed the MCP protocol layer because:

- It introduced a Python runtime dependency that does not belong in a
  TypeScript/Node monorepo.
- Its on-the-wire shape was a thin wrapper around the same JSON endpoints we
  call here directly.
- Empirical probing showed the MCP server's request/response examples were
  partially out-of-date with the live `api.municode.com` shape (e.g. it
  expected `Id` / `ProductID` on `/ClientContent` but the live API returns
  `productId` lowercase and no `Id`).

Adapting to the live JSON shape ourselves removed an unreliable layer.

## Endpoint chain (verified Apr 2026)

```
GET  /Clients/name?clientName=...&stateAbbr=..    -> { ClientID, ClientName, ... }
GET  /ClientContent/{clientId}                    -> { codes: [{ productName, productId, ... }] }
GET  /Jobs/latest/{productId}                     -> { Id (jobId), Name (edition), ProductId }
GET  /codesToc/children?jobId=&productId=         -> top-level chapter listing
GET  /codesToc/children?jobId=&productId=&nodeId= -> children of any node
GET  /CodesContent?jobId=&productId=&nodeId=      -> { Docs: [{ Id, Title, Content (HTML), ... }] }
```

Atoms are produced from `Docs[]` entries whose `Content` is non-null. Each
atom carries a canonical `library.municode.com/{state}/{slug}/codes/code_of_ordinances?nodeId={Id}`
URL so an architect can verify the source in their browser.

## Politeness layer (single global queue)

- `p-queue` concurrency = **1**
- Minimum spacing between requests: **1.5 s** + uniform 0–1 s jitter
- Daily request cap: **500** (env: `MUNICODE_DAILY_REQUEST_CAP`)
- In-memory daily counter resets at UTC midnight
- Retry on `429` and `5xx`: exponential backoff (1 s, 2 s, 4 s)
- No retry on other `4xx`; throws `MunicodeError` with status + truncated body
- User-Agent: `"Hauska-CodeAtoms/0.1 (+nick@hauska.io)"` (env override:
  `MUNICODE_USER_AGENT`)

## Legal posture

- Municipal codes themselves are **government works**. Per 1 U.S.C. § 105 and
  Public.Resource.Org v. American Society for Testing and Materials Inc., 896
  F.3d 437 (D.C. Cir. 2018), the **adopted text** of a municipal ordinance is
  not subject to copyright by the publisher. We extract and store only the
  enacted code text.
- Municode's reader UI displays this content publicly without authentication.
  No login, no Terms-of-Service click-through, and no `robots.txt` directive
  blocks `/CodesContent` or `/codesToc/children` access.
- Our access pattern (low-volume, single-threaded, identifying User-Agent,
  contact email, daily cap, exponential backoff, no scraping of paid content)
  is consistent with `informational use` and well below thresholds where
  unauthorized-access claims have succeeded historically.
- This is not legal advice. The legal posture is reasonable for an internal
  tool; before opening this functionality to external customers we should
  obtain Municode's written commercial-use authorization.

## Replacement / hardening plan

When Municode publishes an official commercial API, swap the gateway:

1. Update `MUNICODE_API_BASE` in `lib/codes-sources/src/municode/endpoints.ts`.
2. Add the official auth header in `lib/codes-sources/src/municode/client.ts`
   (e.g., `Authorization: Bearer ${MUNICODE_API_TOKEN}`).
3. Adapt response parsing in `getClientContent` / `getCodesContent` if shapes
   change. The atom contract (`AtomCandidate`) is intentionally insulated from
   API shape so downstream code (orchestrator, retrieval, chat) is unaffected.

If we instead need to remove this adapter entirely, set every `bastrop_tx`
book in `lib/codes/src/jurisdictions.ts` to a different `sourceName` and the
warmup pipeline will skip it without code changes elsewhere.

## Per-warmup footprint

For a single Bastrop warmup:

- 1 × `/Clients/name` (or 0, if `municodeClientId` is preconfigured — current
  default for Bastrop)
- 1 × `/ClientContent/{clientId}`
- 1 × `/Jobs/latest/{productId}`
- 1 × top-level `/codesToc/children`
- N × per-chapter `/codesToc/children` (depth 2)
- ≤ `maxTocNodes` × `/CodesContent` (default 30, capped in
  `jurisdictions.ts`)

Total: well under 50 requests per first warmup, and **0** for subsequent
warmups (the queue dedupes on `(source_id, section_url)`). Comfortably under
the 500/day daily cap even if every jurisdiction in the registry warms on the
same day.
