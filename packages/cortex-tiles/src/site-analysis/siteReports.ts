// packages/cortex-tiles/src/site-analysis/siteReports.ts
//
// RAW-FUNCTION mode for the site-analysis + property-intel report tiles.
//
// Pure logic for the report-backed library tiles: each function takes a
// `baseUrl` (the spine / plan-review-BFF proxy URL) plus params, POSTs the
// report run and GETs the result, and maps HTTP/report outcomes onto honest,
// discriminated states. Kept free of React/hooks/context so the fetch + shape
// rules are unit-testable AND callable directly from a plain vanilla-JS or Node
// context — no React provider tree, no CortexClient object required.
//
// This is the EXACT peer of the map's `fetchGisLayer` (see ../map/liveGis.ts):
//   fetchGisLayer(baseUrl, layer, bbox, signal?) -> Promise<LiveLayerState>
// take a baseUrl + params, return a Promise of an honest state, AbortSignal
// support, no silent fixture fallback. The tile COMPONENTS call these same
// functions internally, so there is one source of truth: the component renders,
// the function fetches.
//
// Data plane (matches CortexClient's plan-review methods verbatim —
// packages/cortex-client/src/client.ts):
//   POST {baseUrl}/plan-review/engagements/:id/reports/:type/run   (body "{}")
//   GET  {baseUrl}/plan-review/engagements/:id/reports/:type
//   GET  {baseUrl}/local/setbacks/:jurisdictionKey                 (setbacks)
// The report GET envelope is ReportResult<T>:
//   { status: 'ok'|'running'|'not-run'|'error'|'unavailable'|'degraded',
//     result?, error?, degradedReason?, generationId? }

// ─── Auth seam ─────────────────────────────────────────────────────
// Optional token accessor. Mirrors CortexClient.doFetch's auth rule: send a
// Bearer header ONLY when a non-empty token is produced; otherwise fall through
// to the same-origin session cookie (credentials: 'include'). A vanilla caller
// with no auth simply omits this — the function is still callable.
export interface SiteReportAuth {
  /** Returns a bearer token, or an empty string / undefined for cookie-session. */
  getToken?: () => string | Promise<string>
}

/** Raw report result envelope, mirrored from cortex-client ReportResult<T>. */
export type ReportStatusWire =
  | 'ok'
  | 'degraded'
  | 'error'
  | 'running'
  | 'not-run'
  | 'unavailable'

export interface ReportResultWire<T = unknown> {
  status: ReportStatusWire
  result?: T
  error?: string
  degradedReason?: string
  generationId?: string
}

/** Params identifying which engagement a report run targets. */
export interface ReportParams {
  engagementId: string
}

// ─── Honest state unions (peer of map's LiveLayerState) ─────────────
// Each report function returns a discriminated union so consumers render an
// honest state, never a silent fixture. `ok` carries the typed result body;
// `degraded` additionally carries the report's own degrade reason.

/** A GeoJSON FeatureCollection as it appears in report payloads. */
export interface GeoJsonFC {
  type: string
  features: unknown[]
}

export interface HydrologyData {
  flowLinesGeoJson?: GeoJsonFC
  hydrologyLibrary?: string | null
  hydrologyDegraded?: boolean
  hydrologyDegradedReason?: string | null
}

export interface DrainageData {
  flowLinesGeoJson?: GeoJsonFC
  drainageZonesGeoJson?: GeoJsonFC
  hydrologyDegraded?: boolean
  hydrologyDegradedReason?: string | null
}

export interface TopographyData {
  contoursGeoJson?: GeoJsonFC
}

/** Subsurface (SSURGO) payload is adapter-shaped; kept opaque. */
export type SubsurfaceData = Record<string, unknown>

export interface HazardLayer {
  layerKind?: string
  provider?: string | null
  snapshotDate?: string | null
  sourceKind?: string | null
  payload?: unknown
}

export interface HazardData {
  layers?: HazardLayer[]
  quotaExhausted?: boolean
}

/**
 * Honest report state. `ok` carries the typed body; `degraded` carries the
 * run-reported reason alongside the (partial) body; `not-run`/`unavailable`
 * are honest empties; `error` is a named message (never a silent fixture).
 */
export type ReportState<T> =
  | { status: 'ok'; result: T }
  | { status: 'degraded'; result: T; reason: string }
  | { status: 'not-run'; detail?: string }
  | { status: 'unavailable'; detail?: string }
  | { status: 'error'; message: string }

// ─── Shared low-level fetch (raw, React-free) ──────────────────────
function trimBase(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '')
}

async function authHeaders(
  auth?: SiteReportAuth,
): Promise<Record<string, string>> {
  if (!auth?.getToken) return {}
  const token = await auth.getToken()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** POST the report run, then GET the report result envelope. Raw fetch. */
async function runAndGetReport<T>(
  baseUrl: string,
  type: string,
  params: ReportParams,
  signal?: AbortSignal,
  auth?: SiteReportAuth,
): Promise<ReportResultWire<T>> {
  const base = trimBase(baseUrl)
  const headers = {
    'Content-Type': 'application/json',
    ...(await authHeaders(auth)),
  }
  const eid = encodeURIComponent(params.engagementId)

  // Run (POST). A run failure surfaces as a non-ok HTTP status here.
  const runRes = await fetch(
    `${base}/plan-review/engagements/${eid}/reports/${type}/run`,
    { method: 'POST', body: '{}', credentials: 'include', headers, signal },
  )
  if (!runRes.ok) {
    const detail = await safeErrorText(runRes)
    throw new ReportHttpError(runRes.status, `${type} run: ${detail}`)
  }

  // Get (GET) the persisted result envelope.
  const getRes = await fetch(
    `${base}/plan-review/engagements/${eid}/reports/${type}`,
    { method: 'GET', credentials: 'include', headers, signal },
  )
  if (!getRes.ok) {
    const detail = await safeErrorText(getRes)
    throw new ReportHttpError(getRes.status, `${type}: ${detail}`)
  }
  return (await getRes.json()) as ReportResultWire<T>
}

async function safeErrorText(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json()
    if (body && typeof body === 'object') {
      const rec = body as Record<string, unknown>
      if (typeof rec.message === 'string' && rec.message) return rec.message
      if (typeof rec.error === 'string' && rec.error) return rec.error
    }
  } catch {
    /* non-JSON body */
  }
  return `HTTP ${res.status}`
}

/** Error carrying the upstream HTTP status, so callers can branch (e.g. 429). */
export class ReportHttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
    this.name = 'ReportHttpError'
  }
}

/**
 * Map a report GET envelope onto the honest ReportState union. Shared by every
 * report-backed pure function so the state rules live in one place.
 * `degradeReasonFrom` lets a report surface its own per-run degrade reason
 * (hydrology/drainage carry `hydrologyDegraded` on the body, not the envelope).
 */
function toReportState<T>(
  wire: ReportResultWire<T>,
  degradeReasonFrom?: (result: T | undefined) => string | null,
): ReportState<T> {
  if (wire.status === 'error') {
    return { status: 'error', message: wire.error ?? 'report run failed' }
  }
  if (wire.status === 'not-run') {
    return { status: 'not-run', detail: wire.error }
  }
  if (wire.status === 'unavailable') {
    return { status: 'unavailable', detail: wire.error }
  }
  const result = (wire.result ?? {}) as T
  const bodyReason = degradeReasonFrom?.(wire.result)
  const reason = bodyReason ?? wire.degradedReason ?? null
  if (wire.status === 'degraded' || bodyReason) {
    return {
      status: 'degraded',
      result,
      reason: reason ?? 'degraded',
    }
  }
  return { status: 'ok', result }
}

// ─── Pure report functions (peers of fetchGisLayer) ────────────────

/** Hydrology ("will it flood" flow data). */
export function fetchHydrology(
  baseUrl: string,
  params: ReportParams,
  signal?: AbortSignal,
  auth?: SiteReportAuth,
): Promise<ReportState<HydrologyData>> {
  return runAndGetReport<HydrologyData>(baseUrl, 'hydrology', params, signal, auth).then(
    (wire) =>
      toReportState(wire, (r) =>
        r?.hydrologyDegraded
          ? (r.hydrologyDegradedReason ?? 'pysheds unavailable; native D8 fallback')
          : null,
      ),
  )
}

/** Drainage (flow lines + drainage zones). */
export function fetchDrainage(
  baseUrl: string,
  params: ReportParams,
  signal?: AbortSignal,
  auth?: SiteReportAuth,
): Promise<ReportState<DrainageData>> {
  return runAndGetReport<DrainageData>(baseUrl, 'drainage', params, signal, auth).then(
    (wire) =>
      toReportState(wire, (r) =>
        r?.hydrologyDegraded
          ? (r.hydrologyDegradedReason ?? 'pysheds unavailable; native D8 fallback')
          : null,
      ),
  )
}

/**
 * Topography (contour lines). Operator: "topography is a map function" — like
 * fetchGisLayer, this returns map-ready contour GeoJSON for the overlay stack.
 */
export function fetchTopography(
  baseUrl: string,
  params: ReportParams,
  signal?: AbortSignal,
  auth?: SiteReportAuth,
): Promise<ReportState<TopographyData>> {
  return runAndGetReport<TopographyData>(baseUrl, 'topography', params, signal, auth).then(
    (wire) => toReportState(wire),
  )
}

/** Subsurface (SSURGO soil suitability). */
export function fetchSubsurface(
  baseUrl: string,
  params: ReportParams,
  signal?: AbortSignal,
  auth?: SiteReportAuth,
): Promise<ReportState<SubsurfaceData>> {
  return runAndGetReport<SubsurfaceData>(baseUrl, 'subsurface', params, signal, auth).then(
    (wire) => {
      // The subsurface report surfaces an unreachable USDA endpoint as an
      // `unavailable` status with a `{ reason }` body; carry that reason.
      if (wire.status === 'unavailable') {
        const reason = (wire.result as { reason?: string } | undefined)?.reason
        return { status: 'unavailable', detail: reason }
      }
      return toReportState(wire)
    },
  )
}

/** FEMA flood-zone + peril hazard profile. */
export function fetchHazardProfile(
  baseUrl: string,
  params: ReportParams,
  signal?: AbortSignal,
  auth?: SiteReportAuth,
): Promise<ReportState<HazardData>> {
  return runAndGetReport<HazardData>(baseUrl, 'hazard', params, signal, auth).then(
    (wire) => {
      const state = toReportState(wire)
      // Quota exhaustion is carried on the body; surface it as degraded so the
      // consumer can render the honest quota banner (never a silent empty).
      if (
        state.status === 'ok' &&
        (state.result as HazardData | undefined)?.quotaExhausted
      ) {
        return {
          status: 'degraded',
          result: state.result,
          reason: 'hazard data quota exhausted',
        }
      }
      return state
    },
  )
}

// ─── Setbacks (single GET, no run) ─────────────────────────────────

export interface SetbackDistrict {
  district_name?: string | null
  front_ft?: number | null
  rear_ft?: number | null
  side_ft?: number | null
  side_corner_ft?: number | null
  max_height_ft?: number | null
  max_lot_coverage_pct?: number | null
  max_impervious_pct?: number | null
  citation_url?: string | null
}

export interface SetbackTable {
  jurisdictionKey?: string
  jurisdictionDisplayName?: string
  note?: string | null
  districts?: SetbackDistrict[]
}

/** Honest setbacks state: ok (table) / not-found (no codified table) / error. */
export type SetbacksState =
  | { status: 'ok'; table: SetbackTable }
  | { status: 'not-found' }
  | { status: 'error'; message: string }

/**
 * Local setbacks ("what can be built") for a jurisdiction. A single GET against
 * the adapter-owned setback table; 404 -> honest not-found (no codified table),
 * never a fixture.
 */
export async function fetchSetbacks(
  baseUrl: string,
  jurisdiction: string,
  signal?: AbortSignal,
  auth?: SiteReportAuth,
): Promise<SetbacksState> {
  const base = trimBase(baseUrl)
  const headers = {
    'Content-Type': 'application/json',
    ...(await authHeaders(auth)),
  }
  const res = await fetch(
    `${base}/local/setbacks/${encodeURIComponent(jurisdiction)}`,
    { method: 'GET', credentials: 'include', headers, signal },
  )
  if (res.status === 404) return { status: 'not-found' }
  if (!res.ok) {
    return { status: 'error', message: `setbacks: ${await safeErrorText(res)}` }
  }
  const table = (await res.json()) as SetbackTable
  return { status: 'ok', table }
}
