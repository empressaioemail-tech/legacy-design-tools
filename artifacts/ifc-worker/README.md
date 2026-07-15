# IFC-authoring worker (parcel-mesh/IFC Layer 2)

Python sidecar invoked from api-server via JSON over stdio. Sibling to the
hydrology worker; same spawn-JSON contract, separate process, separate
concern (terrain-to-IFC authoring).

## Library

**ifcopenshell**. Authors an IFC4 file whose terrain surface is a single
`IfcTriangulatedFaceSet` (the IFC4 tessellated primitive for a triangle
mesh; NOT `IfcFacetedBrep`, which is the heavier IFC2x3-era shape).

## Geometry source (why the IFC and the GLB never diverge)

The worker does NOT triangulate. It receives the exact compacted
`positions` + `indices` that Layer 1 already built for the GLB
(`siteTopographyMesh.buildTerrainMeshGeometry`) and writes those same
vertices/triangles into the face set. glTF indices are zero-based; IFC
`CoordIndex` is one-based, so the worker adds exactly one to each index at
face-set authoring time (`IFC_INDEX_BASE`).

## Request (stdin JSON)

```json
{
  "positions": [0.0, 0.0, 450.0, 10.0, 0.0, 451.0, 0.0, 10.0, 452.0],
  "indices": [0, 1, 2],
  "georefOrigin": {
    "originLng": -97.31,
    "originLat": 30.1,
    "originHeightMeters": 0.0
  },
  "crsConvention": "local-enu-meters:origin-bbox-sw:equirectangular-coslat",
  "provenance": {
    "sourceCitation": "USGS 3DEP (https://.../exportImage)",
    "coverageFraction": 0.98,
    "demResolutionMeters": 10,
    "demResolutionMeasured": false,
    "collectionProxyDate": "2026-07-15T00:00:00Z",
    "hasHoles": false
  },
  "confidence": {
    "estimate": 0.72,
    "provenance": "asserted",
    "n": 0,
    "intervalWidth": 1
  }
}
```

## Response (stdout JSON)

```json
{
  "status": "ok",
  "library": "ifcopenshell",
  "schemaVersion": "IFC4",
  "geometryPrimitive": "IfcTriangulatedFaceSet",
  "georefCrs": "EPSG:4326",
  "vertexCount": 3,
  "triangleCount": 1,
  "byteCount": 1234,
  "ifcText": "ISO-10303-21; ... END-ISO-10303-21;"
}
```

On failure: `{ "status": "error", "code": "...", "message": "..." }`.
Error codes: `index-out-of-range` (a triangle index points past the vertex
list, or is negative), `missing-deps` (ifcopenshell/numpy not installed),
`worker-failed` (any other authoring error). Every error path exits 0 with
the JSON on stdout so the Node client parses it consistently.

## IFC entities authored

- `IfcProject` -> `IfcSite` (spatial hierarchy via `IfcRelAggregates`).
- `IfcGeographicElement` (PredefinedType `TERRAIN`) contained in the site
  via `IfcRelContainedInSpatialStructure`.
- Body: `IfcTriangulatedFaceSet` over an `IfcCartesianPointList3D`, inside
  an `IfcShapeRepresentation` (RepresentationType `Tessellation`).
- Units: `IfcUnitAssignment` with `IfcSIUnit` LENGTHUNIT = METRE (+ area,
  volume, plane-angle).
- `IfcOwnerHistory` with `CreationDate` set (required in IFC4; a null one
  fails schema validation).
- Georeferencing: `IfcProjectedCRS` (name only). NO `IfcMapConversion`.
- Provenance/confidence: `Pset_HauskaTerrainProvenance` (carries
  `georefOriginLat` / `georefOriginLng` / `georefOriginHeightMeters`) and
  `Pset_HauskaTerrainConfidence` on the terrain element via
  `IfcRelDefinesByProperties`.

## Georeferencing: named CRS, no active map conversion (honesty)

The worker records the real-world CRS as `IfcProjectedCRS` named
`EPSG:4326` and carries the local-frame origin lat/lng in
`Pset_HauskaTerrainProvenance`. It does NOT author an `IfcMapConversion`.

Why no map conversion: an active `IfcMapConversion` with `Eastings` =
origin longitude (deg), `Northings` = origin latitude (deg), `Scale` = 1.0
would make a georef-aware consumer compute `E = origin_lng +
local_x_metres`, so a point at local (1000 m, 1000 m) lands hundreds of
degrees away — roughly 111,320x off the planet. Naming the CRS honestly is
not enough while the machine-readable transform is silently wrong. So there
is deliberately NO machine-readable transform in the file: a consumer that
needs true placement reprojects the named 4326 origin (read from the Pset)
itself. In IFC4 `IfcProjectedCRS` is the only `IfcCoordinateReferenceSystem`
subtype (`IfcGeographicCRS` arrives in IFC4x3), so 4326-in-IfcProjectedCRS
is the least-wrong name. The mesh coordinates stay local metres relative to
that origin. This is the review-mandated fix: the file cannot be used to
place the terrain 11,000 km off by trusting its own georef.

## Schema validity

The emitted IFC passes `ifcopenshell.validate` with zero errors (verified
against ifcopenshell 0.8.5). The test suite asserts this so a regression
(e.g. a re-introduced null `IfcOwnerHistory.CreationDate`) fails CI.

## Local setup

```bash
cd artifacts/ifc-worker
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt   # Windows
# .venv/bin/pip install -r requirements.txt      # POSIX
```

Set `IFC_PYTHON=artifacts/ifc-worker/.venv/Scripts/python.exe` (or rely on
`python3` on PATH). The api-server integration is best-effort: if Python /
ifcopenshell is unavailable, IFC authoring is skipped and the mesh /
contour / confidence output still lands (no fallback IFC is authored — the
`ifc` payload block simply stays absent).

## Test

`test_ifc_worker.py` authors an IFC from a tiny synthetic mesh and re-reads
it with ifcopenshell to assert schema IFC4, exactly one
IfcTriangulatedFaceSet with the right vertex/triangle counts, both Psets
present (incl. the georef origin lat/lng), metre units, `IfcProjectedCRS`
named with NO `IfcMapConversion`, zero `ifcopenshell.validate` errors, and
that an out-of-range or negative triangle index is rejected as
`index-out-of-range`. Run with `python -m pytest` (or `python
test_ifc_worker.py`) inside the venv / Docker image.
