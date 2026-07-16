// packages/cortex-tiles/src/site-analysis/siteReports.test.ts
//
// THE PROOF that RAW-FUNCTION mode is vanilla-consumable: this file imports the
// pure report functions ONLY (no React, no @testing-library/react, no
// CortexProvider, no render()) and calls each one directly with a MOCKED global
// fetch. If these functions carried any React/hook/context dependency they
// could not be imported and invoked here. Peer of map/liveGis.test.ts, which
// proves the same for fetchGisLayer.

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  fetchHydrology,
  fetchDrainage,
  fetchTopography,
  fetchSubsurface,
  fetchHazardProfile,
  fetchSetbacks,
  ReportHttpError,
} from './siteReports'

const BASE = '/api/spine/cortex/api'
const EID = 'eng-42'

afterEach(() => {
  vi.unstubAllGlobals()
})

/**
 * Stub fetch for the run+get report pattern:
 *   POST .../reports/:type/run   -> 200 (or a supplied run status)
 *   GET  .../reports/:type       -> the given envelope
 * Returns the mock so callers can assert on URLs/methods.
 */
function stubReport(envelope: unknown, runStatus = 200) {
  const m = vi.fn((url: string, init?: RequestInit) => {
    if (typeof url === 'string' && url.includes('/run')) {
      return Promise.resolve(new Response('{}', { status: runStatus }))
    }
    return Promise.resolve(new Response(JSON.stringify(envelope), { status: 200 }))
  })
  vi.stubGlobal('fetch', m)
  return m
}

describe('fetchHydrology (pure, no React) — run+get -> honest state', () => {
  it('POSTs the run then GETs the report and returns ok with the typed body', async () => {
    const m = stubReport({
      status: 'ok',
      result: {
        flowLinesGeoJson: { type: 'FeatureCollection', features: [{}] },
        hydrologyLibrary: 'pysheds',
      },
    })

    const state = await fetchHydrology(BASE, { engagementId: EID })

    // Two calls: run POST, then result GET — at the exact plan-review paths.
    expect(m).toHaveBeenCalledTimes(2)
    const [runUrl, runInit] = m.mock.calls[0]
    expect(runUrl).toBe(`${BASE}/plan-review/engagements/${EID}/reports/hydrology/run`)
    expect(runInit?.method).toBe('POST')
    const [getUrl] = m.mock.calls[1]
    expect(getUrl).toBe(`${BASE}/plan-review/engagements/${EID}/reports/hydrology`)

    expect(state.status).toBe('ok')
    if (state.status === 'ok') {
      expect(state.result.hydrologyLibrary).toBe('pysheds')
      expect(state.result.flowLinesGeoJson?.features).toHaveLength(1)
    }
  })

  it('maps a body-level hydrologyDegraded flag to a degraded state + reason', async () => {
    stubReport({
      status: 'ok',
      result: {
        hydrologyDegraded: true,
        hydrologyDegradedReason: 'pysheds unavailable; native D8 fallback',
      },
    })
    const state = await fetchHydrology(BASE, { engagementId: EID })
    expect(state.status).toBe('degraded')
    if (state.status === 'degraded') {
      expect(state.reason).toBe('pysheds unavailable; native D8 fallback')
    }
  })

  it('maps an error envelope to a named error state', async () => {
    stubReport({ status: 'error', error: 'DEM fetch failed upstream' })
    const state = await fetchHydrology(BASE, { engagementId: EID })
    expect(state).toEqual({ status: 'error', message: 'DEM fetch failed upstream' })
  })

  it('throws a ReportHttpError carrying the status when the run POST fails', async () => {
    stubReport({ status: 'ok' }, 500)
    await expect(fetchHydrology(BASE, { engagementId: EID })).rejects.toBeInstanceOf(
      ReportHttpError,
    )
  })
})

describe('fetchDrainage (pure, no React)', () => {
  it('returns ok with flow lines + drainage zones', async () => {
    stubReport({
      status: 'ok',
      result: {
        flowLinesGeoJson: { type: 'FeatureCollection', features: [{}, {}] },
        drainageZonesGeoJson: { type: 'FeatureCollection', features: [{}] },
      },
    })
    const state = await fetchDrainage(BASE, { engagementId: EID })
    expect(state.status).toBe('ok')
    if (state.status === 'ok') {
      expect(state.result.flowLinesGeoJson?.features).toHaveLength(2)
      expect(state.result.drainageZonesGeoJson?.features).toHaveLength(1)
    }
  })

  it('maps a not-run envelope to an honest not-run state', async () => {
    stubReport({ status: 'not-run' })
    const state = await fetchDrainage(BASE, { engagementId: EID })
    expect(state.status).toBe('not-run')
  })
})

describe('fetchTopography (pure, no React) — map-data contour function', () => {
  it('returns ok with contour GeoJSON at the topography path', async () => {
    const m = stubReport({
      status: 'ok',
      result: { contoursGeoJson: { type: 'FeatureCollection', features: [{}, {}, {}] } },
    })
    const state = await fetchTopography(BASE, { engagementId: EID })
    expect(m.mock.calls[1]?.[0]).toBe(
      `${BASE}/plan-review/engagements/${EID}/reports/topography`,
    )
    expect(state.status).toBe('ok')
    if (state.status === 'ok') {
      expect(state.result.contoursGeoJson?.features).toHaveLength(3)
    }
  })
})

describe('fetchSubsurface (pure, no React)', () => {
  it('returns ok with the opaque SSURGO body', async () => {
    stubReport({ status: 'ok', result: { component: 'clay loam', drainageClass: 'poor' } })
    const state = await fetchSubsurface(BASE, { engagementId: EID })
    expect(state.status).toBe('ok')
    if (state.status === 'ok') {
      expect(state.result.drainageClass).toBe('poor')
    }
  })

  it('surfaces the USDA-unavailable reason on an unavailable status', async () => {
    stubReport({ status: 'unavailable', result: { reason: 'USDA SDA endpoint unreachable' } })
    const state = await fetchSubsurface(BASE, { engagementId: EID })
    expect(state).toEqual({ status: 'unavailable', detail: 'USDA SDA endpoint unreachable' })
  })
})

describe('fetchHazardProfile (pure, no React) — FEMA flood zone', () => {
  it('returns ok with the hazard layers body', async () => {
    stubReport({
      status: 'ok',
      result: {
        layers: [
          { layerKind: 'fema-flood', provider: 'FEMA NFHL', payload: { floodZone: 'AE' } },
        ],
      },
    })
    const state = await fetchHazardProfile(BASE, { engagementId: EID })
    expect(state.status).toBe('ok')
    if (state.status === 'ok') {
      expect(state.result.layers?.[0].payload).toEqual({ floodZone: 'AE' })
    }
  })

  it('maps a quota-exhausted body to a degraded state', async () => {
    stubReport({ status: 'ok', result: { layers: [], quotaExhausted: true } })
    const state = await fetchHazardProfile(BASE, { engagementId: EID })
    expect(state.status).toBe('degraded')
  })
})

describe('fetchSetbacks (pure, no React) — single GET, no run', () => {
  it('GETs the jurisdiction table and returns ok', async () => {
    const table = {
      jurisdictionKey: 'bastrop',
      jurisdictionDisplayName: 'Bastrop, TX',
      districts: [{ district_name: 'R-1', front_ft: 25, rear_ft: 10 }],
    }
    const m = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify(table), { status: 200 })),
    )
    vi.stubGlobal('fetch', m)

    const state = await fetchSetbacks(BASE, 'bastrop')

    expect(m).toHaveBeenCalledTimes(1)
    expect(m.mock.calls[0]?.[0]).toBe(`${BASE}/local/setbacks/bastrop`)
    expect(state.status).toBe('ok')
    if (state.status === 'ok') {
      expect(state.table.districts?.[0].district_name).toBe('R-1')
    }
  })

  it('maps 404 to an honest not-found (no codified table, not an error)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('{}', { status: 404 }))),
    )
    const state = await fetchSetbacks(BASE, 'nowhere')
    expect(state).toEqual({ status: 'not-found' })
  })

  it('maps other failures to a named error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ message: 'adapter boom' }), { status: 500 }),
        ),
      ),
    )
    const state = await fetchSetbacks(BASE, 'boom')
    expect(state.status).toBe('error')
    if (state.status === 'error') {
      expect(state.message).toContain('adapter boom')
    }
  })
})

describe('AbortSignal is honored (peer of fetchGisLayer abort support)', () => {
  it('passes the signal through to fetch', async () => {
    const m = stubReport({ status: 'ok', result: {} })
    const ac = new AbortController()
    await fetchTopography(BASE, { engagementId: EID }, ac.signal)
    // Every fetch call carries the same signal.
    for (const call of m.mock.calls) {
      expect(call[1]?.signal).toBe(ac.signal)
    }
  })
})

describe('fetch-injection seam (MV3 worker-proxy) — uses injected fetch', () => {
  it('routes report calls through auth.fetch instead of global fetch', async () => {
    // Injected fetch answers run+get; global fetch must never be touched.
    const injected = vi.fn((url: string) =>
      Promise.resolve(
        url.includes('/run')
          ? new Response('{}', { status: 200 })
          : new Response(JSON.stringify({ status: 'ok', result: { contoursGeoJson: { type: 'FeatureCollection', features: [] } } }), { status: 200 }),
      ),
    )
    const globalFetch = vi.fn(() => Promise.reject(new Error('global fetch must not be used')))
    vi.stubGlobal('fetch', globalFetch)

    const state = await fetchTopography(BASE, { engagementId: EID }, undefined, {
      fetch: injected,
    })

    expect(injected).toHaveBeenCalledTimes(2) // run + get
    expect(globalFetch).not.toHaveBeenCalled()
    expect(state.status).toBe('ok')
  })

  it('fetchSetbacks also honors the injected fetch', async () => {
    const injected = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ jurisdictionKey: 'bastrop', districts: [] }), { status: 200 })),
    )
    const globalFetch = vi.fn(() => Promise.reject(new Error('global fetch must not be used')))
    vi.stubGlobal('fetch', globalFetch)

    const state = await fetchSetbacks(BASE, 'bastrop', undefined, { fetch: injected })

    expect(injected).toHaveBeenCalledTimes(1)
    expect(globalFetch).not.toHaveBeenCalled()
    expect(state.status).toBe('ok')
  })
})
