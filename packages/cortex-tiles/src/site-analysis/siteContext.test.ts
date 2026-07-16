// packages/cortex-tiles/src/site-analysis/siteContext.test.ts
//
// PROOF of Change 1 (brokerage address-keyed shape) AND Change 2 (fetch
// injection + React-free headless import):
//
//   - Imports fetchSiteContext + extractors THROUGH the "./site-analysis"
//     headless subpath entry (via the relative headless.ts module), NOT the
//     barrel — so a failure here means the headless surface is broken.
//   - Uses an INJECTED fetch (not global fetch) — proving the MV3 worker-proxy
//     seam. No vi.stubGlobal('fetch') needed; the seam is exercised directly.
//   - No React, no @testing-library/react, no render(), no CSS import.

import { describe, it, expect, vi } from 'vitest'
import {
  fetchSiteContext,
  getHydrologyLayer,
  getHazardLayer,
  getTopographyLayer,
  getParcelContext,
  SiteContextHttpError,
  type SiteContext,
} from './headless'

const BASE = 'https://cortex.example/api/brokerage/v1'

/** A realistic /map-data response envelope (verbatim shape). */
function mapDataResponse(): SiteContext {
  return {
    packageTier: 'max',
    reasoningOverlays: [],
    honesty: { confidence: { value: 0.72, kind: 'asserted' } },
    mapData: {
      parcelKey: 'clip-123',
      place: { latitude: 30.11, longitude: -97.31, formattedAddress: '123 Main St' },
      tenantScope: 'public',
      assembledAt: '2026-07-16T00:00:00.000Z',
      layers: [
        {
          layerKey: 'parcel-polygon',
          status: 'ok',
          adapterKey: 'cotality:parcels',
          envelope: {
            payload: { geojson: { type: 'FeatureCollection', features: [{ id: 'p1' }] } },
            confidence: { value: 0.72, kind: 'asserted' },
            dataVintage: '2026-06-01',
            coverage: { degraded: false },
            source: { adapter: 'cotality:parcels' },
          },
        },
        {
          layerKey: 'flood-zone',
          status: 'ok',
          adapterKey: 'national:fema-nfhl',
          envelope: {
            payload: { geojson: { type: 'FeatureCollection', features: [] }, floodZone: 'AE' },
            confidence: { value: 0.72, kind: 'asserted' },
            dataVintage: '2026-05-01',
            coverage: { degraded: false },
            source: { adapter: 'national:fema-nfhl' },
          },
        },
        {
          layerKey: 'dem',
          status: 'ok',
          adapterKey: 'national:usgs-dem',
          envelope: {
            payload: { flowLinesGeoJson: { type: 'FeatureCollection', features: [{}, {}] } },
            confidence: { value: 0.72, kind: 'asserted' },
            dataVintage: '2026-04-01',
            coverage: { degraded: false },
            source: { adapter: 'national:usgs-dem' },
          },
        },
        {
          layerKey: 'topography',
          status: 'ok',
          adapterKey: 'national:usgs-dem',
          envelope: {
            payload: { contoursGeoJson: { type: 'FeatureCollection', features: [{}, {}, {}] } },
            confidence: { value: 0.72, kind: 'asserted' },
            dataVintage: '2026-04-01',
            coverage: { degraded: false },
            source: { adapter: 'national:usgs-dem' },
          },
        },
      ],
    },
  }
}

describe('fetchSiteContext (brokerage, address-keyed, injected fetch)', () => {
  it('POSTs the address-keyed body to /map-data via the INJECTED fetch (no global fetch)', async () => {
    const injected = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify(mapDataResponse()), { status: 200 })),
    )
    // Guard: global fetch must NOT be called — the injected fetch is the seam.
    const globalFetch = vi.fn(() =>
      Promise.reject(new Error('global fetch must not be used when injected')),
    )
    vi.stubGlobal('fetch', globalFetch)

    const params = {
      latitude: 30.11,
      longitude: -97.31,
      address: '123 Main St',
      parcelKey: 'clip-123',
      jurisdictionCity: 'Bastrop',
      jurisdictionState: 'TX',
      layers: ['parcel-polygon', 'flood-zone', 'dem', 'topography'] as const,
      forceRefresh: false,
    }
    const ctx = await fetchSiteContext(BASE, { ...params, layers: [...params.layers] }, {
      fetch: injected,
    })

    // Injected fetch used; global fetch never touched.
    expect(injected).toHaveBeenCalledTimes(1)
    expect(globalFetch).not.toHaveBeenCalled()

    const [url, init] = injected.mock.calls[0]
    // baseUrl prefix is NOT hardcoded — the caller's brokerage base is honored,
    // /map-data is appended.
    expect(url).toBe(`${BASE}/map-data`)
    expect(init?.method).toBe('POST')
    // Address-keyed body — the exact MAP_DATA_BODY fields, not engagementId.
    const body = JSON.parse(String(init?.body))
    expect(body).toMatchObject({
      latitude: 30.11,
      longitude: -97.31,
      address: '123 Main St',
      parcelKey: 'clip-123',
      jurisdictionCity: 'Bastrop',
      jurisdictionState: 'TX',
    })
    expect(body).not.toHaveProperty('engagementId')

    // Returns + extracts the bundled response.
    expect(ctx.packageTier).toBe('max')
    expect(ctx.mapData.layers).toHaveLength(4)

    vi.unstubAllGlobals()
  })

  it('forwards the AbortSignal to the injected fetch', async () => {
    const injected = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve(new Response(JSON.stringify(mapDataResponse()), { status: 200 })),
    )
    const ac = new AbortController()
    await fetchSiteContext(BASE, { latitude: 1, longitude: 2 }, {
      fetch: injected,
      signal: ac.signal,
    })
    expect(injected.mock.calls[0][1]?.signal).toBe(ac.signal)
  })

  it('throws a SiteContextHttpError carrying status + code on tier_required (403)', async () => {
    const injected = vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({ error: 'tier_required', message: 'Max tier required', packageTier: 'free' }),
          { status: 403 },
        ),
      ),
    )
    await expect(
      fetchSiteContext(BASE, { latitude: 1, longitude: 2 }, { fetch: injected }),
    ).rejects.toMatchObject({
      name: 'SiteContextHttpError',
      status: 403,
      code: 'tier_required',
      packageTier: 'free',
    })
    // Sanity: it is the exported class.
    const err = await fetchSiteContext(BASE, { latitude: 1, longitude: 2 }, {
      fetch: injected,
    }).catch((e) => e)
    expect(err).toBeInstanceOf(SiteContextHttpError)
  })

  it('falls back to global fetch when no fetch is injected', async () => {
    const globalFetch = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify(mapDataResponse()), { status: 200 })),
    )
    vi.stubGlobal('fetch', globalFetch)
    const ctx = await fetchSiteContext(BASE, { latitude: 30.11, longitude: -97.31 })
    expect(globalFetch).toHaveBeenCalledTimes(1)
    expect(ctx.mapData.parcelKey).toBe('clip-123')
    vi.unstubAllGlobals()
  })
})

describe('extractors pull the right layer from a sample siteContext', () => {
  const ctx = mapDataResponse()

  it('getParcelContext -> parcel-polygon slot', () => {
    const slot = getParcelContext(ctx)
    expect(slot?.layerKey).toBe('parcel-polygon')
    expect(slot?.status).toBe('ok')
    expect((slot?.envelope?.payload as { geojson?: { features?: unknown[] } })?.geojson?.features).toHaveLength(1)
  })

  it('getHazardLayer -> flood-zone slot (fema/floodplain -> flood-zone)', () => {
    const slot = getHazardLayer(ctx)
    expect(slot?.layerKey).toBe('flood-zone')
    expect((slot?.envelope?.payload as { floodZone?: string })?.floodZone).toBe('AE')
  })

  it('getHydrologyLayer -> dem slot (flow), then topography fallback', () => {
    const slot = getHydrologyLayer(ctx)
    expect(slot?.layerKey).toBe('dem')
    expect((slot?.envelope?.payload as { flowLinesGeoJson?: { features?: unknown[] } })?.flowLinesGeoJson?.features).toHaveLength(2)
  })

  it('getTopographyLayer -> topography slot (contours)', () => {
    const slot = getTopographyLayer(ctx)
    expect(slot?.layerKey).toBe('topography')
    expect((slot?.envelope?.payload as { contoursGeoJson?: { features?: unknown[] } })?.contoursGeoJson?.features).toHaveLength(3)
  })

  it('returns null (never a fabricated slot) when a layer is absent', () => {
    const empty: SiteContext = {
      mapData: {
        parcelKey: 'x',
        place: { latitude: 0, longitude: 0 },
        tenantScope: 'public',
        assembledAt: '2026-07-16T00:00:00.000Z',
        layers: [],
      },
    }
    expect(getParcelContext(empty)).toBeNull()
    expect(getHazardLayer(empty)).toBeNull()
    expect(getHydrologyLayer(null)).toBeNull()
    expect(getTopographyLayer(undefined)).toBeNull()
  })

  it('hydrology falls back to topography when dem is absent', () => {
    const noDem: SiteContext = {
      mapData: {
        ...ctx.mapData,
        layers: ctx.mapData.layers.filter((l) => l.layerKey !== 'dem'),
      },
    }
    expect(getHydrologyLayer(noDem)?.layerKey).toBe('topography')
  })
})
