// packages/cortex-tiles/src/map/gisLayerBody.contract.test.ts
//
// Contract test capturing the REAL cause of the black-map 400 storm and proving
// the strict-clean body fix.
//
// The server route (legacy-design-tools artifacts/api-server/src/routes/
// brokerageMapData.ts) validates POST /map-data/gis-layer against a `.strict()`
// GIS_LAYER_BODY whose `bbox` is a UNION of three strict shapes. Because it is
// strict, ANY extra key (a `zoom` carried alongside the bounds, a stray corner
// alias) is rejected with a 400 `invalid_request`. That is the request the old
// pre-library client's `bboxSupported` latch feature-detected and worked around,
// and the one the storm re-fired thousands of times.
//
// This test reconstructs that exact server schema (kept in lockstep with the
// route) so the rejected field is named in CI, and asserts that the body
// `normalizeBbox` produces — exactly {west,south,east,north} — is accepted.

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { normalizeBbox } from './liveGis'

// -- EXACT mirror of brokerageMapData.ts GIS_LAYER_BODY (the accepted shapes) --
const GIS_BBOX_BODY = z
  .object({
    westLng: z.number().finite(),
    southLat: z.number().finite(),
    eastLng: z.number().finite(),
    northLat: z.number().finite(),
  })
  .strict()
const GIS_BBOX_CARDINAL_BODY = z
  .object({
    west: z.number().finite(),
    south: z.number().finite(),
    east: z.number().finite(),
    north: z.number().finite(),
  })
  .strict()
const GIS_BBOX_ESRI_BODY = z
  .object({
    xmin: z.number().finite(),
    ymin: z.number().finite(),
    xmax: z.number().finite(),
    ymax: z.number().finite(),
  })
  .strict()
const GIS_LAYER_KEYS = [
  'fema',
  'parcels',
  'ssurgo-soils',
  'groundwater',
  'mud-pid',
  'edwards-aquifer',
  'texas-rrc',
] as const
const GIS_LAYER_BODY = z
  .object({
    layer: z.enum(GIS_LAYER_KEYS),
    latitude: z.number().finite().optional(),
    longitude: z.number().finite().optional(),
    fixture: z.boolean().optional(),
    forceRefresh: z.boolean().optional(),
    bbox: z
      .union([GIS_BBOX_BODY, GIS_BBOX_CARDINAL_BODY, GIS_BBOX_ESRI_BODY])
      .optional(),
  })
  .strict()

const BBOX = { west: -97.934, south: 29.865, east: -97.92, north: 29.876 }

describe('GIS_LAYER_BODY server contract (why the 400 stormed, and the fix)', () => {
  it('ACCEPTS the strict-clean body the fix sends: {layer, bbox:{west,south,east,north}}', () => {
    const body = { layer: 'parcels', bbox: normalizeBbox(BBOX) }
    const r = GIS_LAYER_BODY.safeParse(body)
    expect(r.success).toBe(true)
  })

  it('REJECTS a top-level zoom (the old home-grown client variant) — 400 Unrecognized key', () => {
    const r = GIS_LAYER_BODY.safeParse({ layer: 'parcels', bbox: BBOX, zoom: 15.2 })
    expect(r.success).toBe(false)
    if (!r.success) {
      expect(r.error.flatten().formErrors.join('; ')).toMatch(/Unrecognized key.*zoom/i)
    }
  })

  it('REJECTS zoom carried INSIDE bbox (a raw viewport-object spread) — 400 on bbox', () => {
    // This is the most likely real cause: ViewportState is {bbox, zoom}; spreading
    // the viewport (or merging zoom into bbox) drags `zoom` into the strict bbox.
    const r = GIS_LAYER_BODY.safeParse({ layer: 'parcels', bbox: { ...BBOX, zoom: 15.2 } })
    expect(r.success).toBe(false)
    if (!r.success) {
      const bboxErrs = r.error.flatten().fieldErrors.bbox?.join('; ') ?? ''
      expect(bboxErrs).toMatch(/Unrecognized key.*zoom/i)
    }
  })

  it('REJECTS mixed corner aliases inside bbox (westLng beside cardinal) — 400 on bbox', () => {
    const r = GIS_LAYER_BODY.safeParse({ layer: 'parcels', bbox: { ...BBOX, westLng: -97.9 } })
    expect(r.success).toBe(false)
  })

  it('normalizeBbox strips ALL of the above so the produced bbox always validates', () => {
    const dirty = { ...BBOX, zoom: 15.2, westLng: -97.9, pitch: 0 } as unknown as typeof BBOX
    const clean = normalizeBbox(dirty)
    expect(GIS_BBOX_CARDINAL_BODY.safeParse(clean).success).toBe(true)
    expect(GIS_LAYER_BODY.safeParse({ layer: 'fema', bbox: clean }).success).toBe(true)
  })
})
