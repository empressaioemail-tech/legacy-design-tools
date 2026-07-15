#!/usr/bin/env python3
"""
Site IFC-authoring worker — parcel-mesh/IFC Layer 2.

Reads ONE JSON request on stdin, writes ONE JSON result on stdout.
Sibling to the hydrology worker; SAME spawn-JSON-over-stdio contract, a
SEPARATE process and a separate concern (terrain-to-IFC authoring, not
hydrology). See README.md for the request/response contract.

Library: ifcopenshell. Authors an IFC4 file whose terrain surface is a
single IfcTriangulatedFaceSet (the IFC4 tessellated primitive for a
triangle mesh). The real-world CRS is NAMED via IfcProjectedCRS
(EPSG:4326) on the model context; the origin lat/lng is carried as
human-readable Pset metadata rather than as a numerically-active
IfcMapConversion (see the georeferencing note below). The terrain element
is stamped with two provenance/confidence property sets so the IFC carries
the SAME quality-gate signals as every other output (structural
commitment 1).

INPUT geometry note (load-bearing correctness): the worker does NOT
triangulate anything. It receives the exact compacted positions + indices
Layer 1 already built for the GLB (see siteTopographyMesh.
buildTerrainMeshGeometry) and writes those same vertices/triangles into
the IfcTriangulatedFaceSet. This is what guarantees the GLB mesh and the
IFC never diverge.
"""
from __future__ import annotations

import json
import sys
import time
import traceback
import uuid
from typing import Any

try:
    import numpy as np  # noqa: F401  (kept for parity / future numeric use)
    import ifcopenshell
    import ifcopenshell.guid
except ImportError as exc:  # pragma: no cover
    # Exit 0 with the structured JSON on stdout, matching every OTHER error
    # path in this worker. The Node client checks exit code first, so a
    # non-zero exit here would be reported as a bare `worker-exit` and the
    # `missing-deps` code would be lost. Exiting 0 lets the client parse the
    # structured result consistently.
    json.dump(
        {
            "status": "error",
            "code": "missing-deps",
            "message": f"ifcopenshell/numpy not installed: {exc}",
        },
        sys.stdout,
    )
    sys.stdout.write("\n")
    sys.stdout.flush()
    sys.exit(0)


# IfcTriangulatedFaceSet CoordIndex is ONE-BASED (IFC lists index from 1),
# whereas the incoming GLB indices are zero-based (glTF convention). The
# offset is applied exactly once, at face-set authoring time.
IFC_INDEX_BASE = 1


class IndexOutOfRangeError(ValueError):
    """A triangle index points outside [0, vertexCount). Mapped to the
    structured error code `index-out-of-range` in main()."""


def _error(code: str, message: str) -> None:
    json.dump({"status": "error", "code": code, "message": message}, sys.stdout)
    sys.stdout.write("\n")
    sys.stdout.flush()


def _guid() -> str:
    """A compressed IFC GlobalId (22-char base64), unique per entity."""
    return ifcopenshell.guid.compress(uuid.uuid4().hex)


def _positions_to_coord_list(positions: list[float]) -> list[tuple[float, float, float]]:
    """Flat [x,y,z, x,y,z, ...] -> list of (x, y, z) triples for IfcCartesianPointList3D."""
    if len(positions) % 3 != 0:
        raise ValueError(
            f"positions length {len(positions)} is not a multiple of 3"
        )
    coords: list[tuple[float, float, float]] = []
    for i in range(0, len(positions), 3):
        coords.append(
            (float(positions[i]), float(positions[i + 1]), float(positions[i + 2]))
        )
    return coords


def _indices_to_triangles(indices: list[int]) -> list[tuple[int, int, int]]:
    """Flat triangle index list -> list of (a, b, c) with IFC one-based offset applied."""
    if len(indices) % 3 != 0:
        raise ValueError(
            f"indices length {len(indices)} is not a multiple of 3 (not triangles)"
        )
    tris: list[tuple[int, int, int]] = []
    for i in range(0, len(indices), 3):
        tris.append(
            (
                int(indices[i]) + IFC_INDEX_BASE,
                int(indices[i + 1]) + IFC_INDEX_BASE,
                int(indices[i + 2]) + IFC_INDEX_BASE,
            )
        )
    return tris


def _add_owner_history(f: Any) -> Any:
    """Minimal IfcOwnerHistory (an authoring app stamp). Optional in IFC4 but
    convenient for downstream tooling that expects it on rooted entities."""
    app = f.create_entity(
        "IfcApplication",
        ApplicationDeveloper=f.create_entity(
            "IfcOrganization", Name="Empressa"
        ),
        Version="1",
        ApplicationFullName="Hauska terrain IFC worker",
        ApplicationIdentifier="hauska-ifc-worker",
    )
    person = f.create_entity("IfcPerson", FamilyName="worker")
    org = f.create_entity("IfcOrganization", Name="Empressa")
    person_org = f.create_entity(
        "IfcPersonAndOrganization",
        ThePerson=person,
        TheOrganization=org,
    )
    return f.create_entity(
        "IfcOwnerHistory",
        OwningUser=person_org,
        OwningApplication=app,
        ChangeAction="ADDED",
        # CreationDate is NOT optional on IfcOwnerHistory in IFC4; omitting it
        # makes ifcopenshell.validate fail every file with "Attribute not
        # optional | IfcOwnerHistory.CreationDate", and strict importers can
        # reject it. IfcTimeStamp is an INTEGER (seconds since the UNIX epoch).
        CreationDate=int(time.time()),
    )


def _make_property_single(f: Any, name: str, value: Any) -> Any:
    """One IfcPropertySingleValue. Text for str, Real for numbers, else Text."""
    if value is None:
        nominal = f.create_entity("IfcText", "")
    elif isinstance(value, bool):
        nominal = f.create_entity("IfcBoolean", value)
    elif isinstance(value, (int, float)):
        nominal = f.create_entity("IfcReal", float(value))
    else:
        nominal = f.create_entity("IfcText", str(value))
    return f.create_entity(
        "IfcPropertySingleValue", Name=name, NominalValue=nominal
    )


def _attach_pset(
    f: Any,
    owner_history: Any,
    element: Any,
    pset_name: str,
    props: dict[str, Any],
) -> Any:
    """Attach an IfcPropertySet to a rooted element via IfcRelDefinesByProperties."""
    property_values = [
        _make_property_single(f, name, value) for name, value in props.items()
    ]
    pset = f.create_entity(
        "IfcPropertySet",
        GlobalId=_guid(),
        OwnerHistory=owner_history,
        Name=pset_name,
        HasProperties=property_values,
    )
    f.create_entity(
        "IfcRelDefinesByProperties",
        GlobalId=_guid(),
        OwnerHistory=owner_history,
        RelatedObjects=[element],
        RelatingPropertyDefinition=pset,
    )
    return pset


def run(req: dict[str, Any]) -> dict[str, Any]:
    positions = req.get("positions")
    indices = req.get("indices")
    if not isinstance(positions, list) or not positions:
        raise ValueError("positions (flat [x,y,z,...] list) is required")
    if not isinstance(indices, list) or not indices:
        raise ValueError("indices (flat triangle-index list) is required")

    georef = req.get("georefOrigin") or {}
    origin_lng = float(georef.get("originLng", 0.0))
    origin_lat = float(georef.get("originLat", 0.0))
    # Height of the local origin above the datum. Local Z is real DEM
    # elevation, so this stays 0: local Z already equals real-world height.
    origin_height = float(georef.get("originHeightMeters", 0.0))
    crs_convention = str(req.get("crsConvention", ""))

    coords = _positions_to_coord_list(positions)

    # BLOCKER 1 fix: bounds-check the triangle indices BEFORE authoring. The
    # length / multiple-of-3 checks in `_indices_to_triangles` do NOT catch
    # an index that points past the vertex list (e.g. [0,1,99] on a 3-vertex
    # mesh), which would author an IfcTriangulatedFaceSet whose CoordIndex
    # references a nonexistent point — a corrupt face set that
    # ifcopenshell.geom decodes to zero verts, yet would still be uploaded
    # and stamped with provenance/confidence Psets (asserting quality on
    # garbage, a commitment-#1 violation). Reject it as a structured error
    # instead of emitting status:ok on corrupt geometry.
    vertex_count = len(coords)
    for idx in indices:
        idx_int = int(idx)
        if idx_int < 0 or idx_int >= vertex_count:
            raise IndexOutOfRangeError(
                f"triangle index {idx_int} out of range "
                f"[0, {vertex_count}) for a {vertex_count}-vertex mesh"
            )

    triangles = _indices_to_triangles(indices)
    triangle_count = len(triangles)

    f = ifcopenshell.file(schema="IFC4")
    owner_history = _add_owner_history(f)

    # ---- Units: SI metre. IfcUnitAssignment with LENGTHUNIT = metre. ----
    length_unit = f.create_entity(
        "IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE"
    )
    area_unit = f.create_entity(
        "IfcSIUnit", UnitType="AREAUNIT", Name="SQUARE_METRE"
    )
    volume_unit = f.create_entity(
        "IfcSIUnit", UnitType="VOLUMEUNIT", Name="CUBIC_METRE"
    )
    plane_angle_unit = f.create_entity(
        "IfcSIUnit", UnitType="PLANEANGLEUNIT", Name="RADIAN"
    )
    unit_assignment = f.create_entity(
        "IfcUnitAssignment",
        Units=[length_unit, area_unit, volume_unit, plane_angle_unit],
    )

    # ---- Geometric representation context (3D model). ----
    axis = f.create_entity(
        "IfcAxis2Placement3D",
        Location=f.create_entity(
            "IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0)
        ),
    )
    context = f.create_entity(
        "IfcGeometricRepresentationContext",
        ContextType="Model",
        CoordinateSpaceDimension=3,
        Precision=1.0e-5,
        WorldCoordinateSystem=axis,
    )
    body_subcontext = f.create_entity(
        "IfcGeometricRepresentationSubContext",
        ContextIdentifier="Body",
        ContextType="Model",
        ParentContext=context,
        TargetView="MODEL_VIEW",
    )

    # ---- GEOREFERENCING: IfcProjectedCRS name ONLY; NO active map conversion.
    #
    # MAJOR review finding, fixed here (option a — the genuinely honest one):
    #   We do NOT author a numerically-active IfcMapConversion. An earlier
    #   version put Eastings=origin_lng(deg), Northings=origin_lat(deg),
    #   Scale=1.0; a georef-aware consumer then computes
    #   E = origin_lng + local_x_metres, so a point at local (1000m, 1000m)
    #   lands ~111,320x off the planet (hundreds of degrees of "longitude").
    #   Naming the CRS honestly is not enough while the machine-readable
    #   placement is silently wrong.
    #
    #   Fix: keep IfcProjectedCRS named EPSG:4326 (in IFC4 this is the ONLY
    #   IfcCoordinateReferenceSystem subtype; IfcGeographicCRS doesn't exist
    #   until IFC4x3, so 4326-in-IfcProjectedCRS is the least-wrong name),
    #   but DO NOT relate it through an IfcMapConversion. There is therefore
    #   NO machine-readable transform a tool could trust to place the terrain
    #   off-planet. The origin lat/lng travels as human-readable metadata in
    #   Pset_HauskaTerrainProvenance (georefOriginLat / georefOriginLng)
    #   below. A consumer that needs real placement reprojects that named
    #   4326 origin itself. `origin_height` is likewise recorded there.
    #
    #   `MapUnit` is left null deliberately (there is no active conversion to
    #   attach a unit to); the CRS is a NAME, not a live coordinate op.
    projected_crs = f.create_entity(  # noqa: F841 (referenced for provenance)
        "IfcProjectedCRS",
        Name="EPSG:4326",
        Description=(
            "Geographic CRS (WGS84 lat/lng) that the terrain's origin is "
            "expressed in. NAME ONLY: no IfcMapConversion is authored, so "
            "the local-metre mesh coordinates are NOT machine-transformable "
            "to world coordinates from this file. Origin lat/lng is carried "
            "in Pset_HauskaTerrainProvenance (georefOriginLat/Lng). "
            f"Local mesh CRS convention: {crs_convention}"
        ),
        GeodeticDatum="WGS84",
    )

    # ---- Spatial hierarchy: IfcProject -> IfcSite. ----
    project = f.create_entity(
        "IfcProject",
        GlobalId=_guid(),
        OwnerHistory=owner_history,
        Name="Site terrain",
        RepresentationContexts=[context],
        UnitsInContext=unit_assignment,
    )
    site = f.create_entity(
        "IfcSite",
        GlobalId=_guid(),
        OwnerHistory=owner_history,
        Name="Parcel site",
        CompositionType="ELEMENT",
        # RefLatitude / RefLongitude in IFC compound-degrees would duplicate
        # the map-conversion origin; we keep the origin authoritative on the
        # map conversion and leave these null to avoid two-source drift.
    )
    f.create_entity(
        "IfcRelAggregates",
        GlobalId=_guid(),
        OwnerHistory=owner_history,
        RelatingObject=project,
        RelatedObjects=[site],
    )

    # ---- Terrain surface: IfcGeographicElement with an IfcTriangulatedFaceSet
    #      body. IfcTriangulatedFaceSet is the IFC4 tessellated primitive for
    #      a triangle mesh (NOT IfcFacetedBrep, which is IFC2x3-era/heavier).
    point_list = f.create_entity(
        "IfcCartesianPointList3D",
        CoordList=coords,
    )
    face_set = f.create_entity(
        "IfcTriangulatedFaceSet",
        Coordinates=point_list,
        CoordIndex=triangles,
        Closed=False,  # a terrain surface is an open shell, not a solid.
    )
    shape_rep = f.create_entity(
        "IfcShapeRepresentation",
        ContextOfItems=body_subcontext,
        RepresentationIdentifier="Body",
        RepresentationType="Tessellation",
        Items=[face_set],
    )
    product_shape = f.create_entity(
        "IfcProductDefinitionShape",
        Representations=[shape_rep],
    )
    site_placement = f.create_entity(
        "IfcLocalPlacement",
        RelativePlacement=f.create_entity(
            "IfcAxis2Placement3D",
            Location=f.create_entity(
                "IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0)
            ),
        ),
    )
    terrain = f.create_entity(
        "IfcGeographicElement",
        GlobalId=_guid(),
        OwnerHistory=owner_history,
        Name="Terrain surface",
        ObjectPlacement=site_placement,
        Representation=product_shape,
        PredefinedType="TERRAIN",
    )
    f.create_entity(
        "IfcRelContainedInSpatialStructure",
        GlobalId=_guid(),
        OwnerHistory=owner_history,
        RelatingStructure=site,
        RelatedElements=[terrain],
    )

    # ---- Provenance + confidence property sets (structural commitment 1).
    #      Two Psets on the terrain element: one for source/coverage
    #      provenance, one for the widthed-confidence estimate. Every
    #      confidence-carrying output names source + confidence.
    provenance = req.get("provenance") or {}
    confidence = req.get("confidence") or {}
    _attach_pset(
        f,
        owner_history,
        terrain,
        "Pset_HauskaTerrainProvenance",
        {
            "sourceCitation": provenance.get("sourceCitation"),
            "coverageFraction": provenance.get("coverageFraction"),
            "demResolutionMeters": provenance.get("demResolutionMeters"),
            "demResolutionMeasured": provenance.get("demResolutionMeasured"),
            "collectionProxyDate": provenance.get("collectionProxyDate"),
            "crsConvention": crs_convention,
            "georefCrs": "EPSG:4326",
            # Georef origin (WGS84 lat/lng of the local-frame SW corner) as
            # human-readable metadata. This is where the placement now lives
            # since there is NO active IfcMapConversion; a consumer reprojects
            # this named 4326 origin itself rather than trusting a (removed)
            # off-planet coordinate transform.
            "georefOriginLat": origin_lat,
            "georefOriginLng": origin_lng,
            "georefOriginHeightMeters": origin_height,
            "hasHoles": provenance.get("hasHoles"),
        },
    )
    _attach_pset(
        f,
        owner_history,
        terrain,
        "Pset_HauskaTerrainConfidence",
        {
            "confidenceEstimate": confidence.get("estimate"),
            "confidenceProvenance": confidence.get("provenance"),
            "confidenceN": confidence.get("n"),
            "confidenceIntervalWidth": confidence.get("intervalWidth"),
        },
    )

    ifc_text = f.wrapped_data.to_string()

    return {
        "status": "ok",
        "library": "ifcopenshell",
        "libraryVersion": getattr(ifcopenshell, "version", "unknown"),
        "schemaVersion": "IFC4",
        "geometryPrimitive": "IfcTriangulatedFaceSet",
        "georefCrs": "EPSG:4326",
        "vertexCount": vertex_count,
        "triangleCount": triangle_count,
        "byteCount": len(ifc_text.encode("utf-8")),
        # IFC is text (STEP/SPF). Return it inline; the Node client uploads
        # it to object storage. Small parcel-scale meshes keep this modest;
        # if a future wide-catchment profile grows it, switch to a temp-file
        # path handshake (same seam the hydrology worker uses for the DEM).
        "ifcText": ifc_text,
    }


def main() -> None:
    try:
        req = json.load(sys.stdin)
        result = run(req)
        json.dump(result, sys.stdout)
        sys.stdout.write("\n")
        sys.stdout.flush()
    except IndexOutOfRangeError as exc:
        # Corrupt geometry (an index past the vertex list). Distinct code so
        # the caller can tell a bad-input rejection from a worker crash, and
        # so we NEVER stamp provenance/confidence on a corrupt face set.
        _error("index-out-of-range", str(exc))
    except Exception as exc:  # pragma: no cover
        _error("worker-failed", f"{exc}\n{traceback.format_exc()}")


if __name__ == "__main__":
    main()
