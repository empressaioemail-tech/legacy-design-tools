/**
 * P-152 (lane 2 of 2, "cortex consumes the reader"): server-to-server
 * client for the Hauska retrieval service's `/property-nodes/:id/record`
 * route — the one reader over the Factory's parcel_record store. Same
 * base-URL / key resolution convention as the existing
 * `fetchPropertyAtomChain.ts` client (`HAUSKA_RETRIEVAL_API_URL` /
 * `RETRIEVAL_API_URL`, `HAUSKA_RETRIEVAL_API_KEY` / `RETRIEVAL_API_KEY`).
 *
 * One parcel's `/record` response covers all 65 rails in a single call.
 * `parcelRecordCellRead.ts`'s `loadParcelRecordCell` is called once per
 * rail per request (18+ call sites across the *FromParcelRecord.ts
 * modules) — without de-duplication, a single facets request would issue
 * up to 65 redundant HTTP round-trips for the SAME parcel. `fetchParcelRecord`
 * coalesces concurrent calls for the same parcelNodeId into one in-flight
 * request and caches the settled result for a short TTL, so one facets
 * request costs exactly one upstream call. Failures are never cached (a
 * transient network blip should not force every rail to refuse for the
 * full TTL window) and resolve to `null`, matching the fail-closed
 * contract `parcelRecordCellRead.ts` already had for "store not configured".
 */

const DEFAULT_RETRIEVAL = "https://hauska-retrieval-api-h7gvu7rgcq-uc.a.run.app";

/** Coalescing/cache window. Generous enough to cover one facets request's rail fan-out, short enough that staleness is negligible against a read-replica of already-committed values. */
const CACHE_TTL_MS = 3000;

export type ParcelRecordServeState = "record" | "refused" | "legacy-transitional";

export interface ParcelRecordRailWire {
  cell: Record<string, unknown> | null;
  gate: { verdict: "pass" | "refuse" | "excluded" | null; evaluatedAt: string | null };
  serve: ParcelRecordServeState;
  atom: { did: string; entityType: string; body: unknown } | null;
  atomBacked: boolean;
  rendering: { text: string; atomVersion: string; vocabVersion: string } | null;
  companions: unknown[];
}

export interface ParcelRecordWire {
  parcelNodeId: string;
  placeKey: string | null;
  countyFips: string;
  railRegistrySha: string;
  readAt: string;
  rails: Record<string, ParcelRecordRailWire>;
  refused: { reason: string } | null;
}

type CacheEntry = { expiresAt: number; promise: Promise<ParcelRecordWire | null> };

const cache = new Map<string, CacheEntry>();

let injectedFetcher: ((placeKey: string) => Promise<ParcelRecordWire | null>) | null | undefined;

/** Test seam. `null` disables the network path entirely (returns null for every call). `undefined` (reset) restores the real env-resolved fetch. */
export function setParcelRecordFetcherForTests(
  fetcher: ((placeKey: string) => Promise<ParcelRecordWire | null>) | null,
): void {
  injectedFetcher = fetcher;
  cache.clear();
}

export function resetParcelRecordFetcherForTests(): void {
  injectedFetcher = undefined;
  cache.clear();
}

/**
 * LIVE FINDING (P-152, 2026-09-11): cortex's own `.github/workflows/
 * cloud-run-deploy.yml` mounts the retrieval-api URL/key as
 * `BRIEF_RETRIEVAL_API_URL`/`BRIEF_RETRIEVAL_API_KEY` -- confirmed via
 * `gcloud run services describe cortex-api` against the actually-serving
 * revision. Neither `HAUSKA_RETRIEVAL_API_URL`/`RETRIEVAL_API_URL` nor
 * `HAUSKA_RETRIEVAL_API_KEY`/`RETRIEVAL_API_KEY` (the names
 * `fetchPropertyAtomChain.ts` checks, and this module originally copied)
 * are ever set in production. Caught by diffing this lane's own canary
 * deploy against a pre-capture baseline before any traffic shift: every
 * gate-verdict lookup silently failed, cascading through resolveAllowlist's
 * fail-closed default into a mass "legacy"/"not-cut-over" regression on
 * the live facets response. This means fetchPropertyAtomChain.ts's own
 * existing calls have likely NEVER reached the retrieval service in
 * production either (same dead code path, same missing names) -- flagged
 * for the operator/overseer, out of this dispatch's scope to fix there.
 */
function resolveBaseUrl(): string {
  return (
    process.env.HAUSKA_RETRIEVAL_API_URL?.trim() ||
    process.env.RETRIEVAL_API_URL?.trim() ||
    process.env.BRIEF_RETRIEVAL_API_URL?.trim() ||
    DEFAULT_RETRIEVAL
  ).replace(/\/$/, "");
}

function resolveApiKey(): string | undefined {
  return (
    process.env.HAUSKA_RETRIEVAL_API_KEY?.trim() ||
    process.env.RETRIEVAL_API_KEY?.trim() ||
    process.env.BRIEF_RETRIEVAL_API_KEY?.trim()
  );
}

async function fetchFromRetrievalApi(placeKey: string): Promise<ParcelRecordWire | null> {
  const key = resolveApiKey();
  if (!key) return null;
  try {
    const res = await fetch(
      `${resolveBaseUrl()}/property-nodes/${encodeURIComponent(placeKey)}/record`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      },
    );
    if (!res.ok) return null;
    return (await res.json()) as ParcelRecordWire;
  } catch {
    return null;
  }
}

/**
 * `placeKey` here is the `{countyFips}:{propId}` form callers already
 * build (matching the retrieval service's own `parcelNodeId` path param).
 */
export async function fetchParcelRecord(placeKey: string): Promise<ParcelRecordWire | null> {
  if (injectedFetcher !== undefined) {
    return injectedFetcher ? injectedFetcher(placeKey) : null;
  }
  const now = Date.now();
  const cached = cache.get(placeKey);
  if (cached && cached.expiresAt > now) return cached.promise;

  const promise = fetchFromRetrievalApi(placeKey);
  cache.set(placeKey, { expiresAt: now + CACHE_TTL_MS, promise });
  const result = await promise;
  if (result === null) {
    // Never cache a failure -- let the next call retry immediately.
    cache.delete(placeKey);
  }
  return result;
}

export type ParcelGateVerdictWire = {
  verdict: "pass" | "refuse" | "excluded";
  evaluatedAt: string;
} | null;

let injectedVerdictFetcher:
  | ((countyFips: string, railKey: string) => Promise<ParcelGateVerdictWire | undefined>)
  | null
  | undefined;

/** Test seam for the (county, rail) gate-verdict lookup. `undefined` return from the fetcher means "query failed" (caller should throw/fail closed); `null` means "no usable verdict" (a real, valid answer). */
export function setGateVerdictFetcherForTests(
  fetcher: ((countyFips: string, railKey: string) => Promise<ParcelGateVerdictWire | undefined>) | null,
): void {
  injectedVerdictFetcher = fetcher;
}

export function resetGateVerdictFetcherForTests(): void {
  injectedVerdictFetcher = undefined;
}

/**
 * `parcel_gate_verdict` is keyed by (county, rail) alone -- no parcel is in
 * scope at `resolveAllowlist`'s call sites. Returns `undefined` (not
 * `null`) when the fetch itself failed (network error, non-200, missing
 * key), so callers can distinguish "the read failed" from "a real, valid
 * null verdict" -- the same distinction `parcelGateVerdictRead.ts`'s own
 * try/catch already collapses to "no usable verdict" either way, but kept
 * here so a genuine connectivity failure can still be surfaced as an error
 * by a caller that wants to (mirroring a live Postgres connection failure
 * throwing today, not silently returning an empty result).
 */
export async function fetchGateVerdict(
  countyFips: string,
  railKey: string,
): Promise<ParcelGateVerdictWire | undefined> {
  if (injectedVerdictFetcher !== undefined) {
    return injectedVerdictFetcher ? injectedVerdictFetcher(countyFips, railKey) : undefined;
  }
  const key = resolveApiKey();
  if (!key) return undefined;
  try {
    const res = await fetch(
      `${resolveBaseUrl()}/parcel-record-gate-verdict/${encodeURIComponent(countyFips)}/${encodeURIComponent(railKey)}`,
      { method: "GET", headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } },
    );
    if (!res.ok) return undefined;
    const body = (await res.json()) as { verdict: ParcelGateVerdictWire };
    return body.verdict;
  } catch {
    return undefined;
  }
}
