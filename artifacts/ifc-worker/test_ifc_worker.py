#!/usr/bin/env python3
"""
IFC-authoring worker test — parcel-mesh/IFC Layer 2.

Authors an IFC from a tiny synthetic mesh via run.run(), then re-reads the
emitted IFC text with ifcopenshell and asserts the correctness core:

  - schema is IFC4,
  - exactly one IfcTriangulatedFaceSet with the right vertex + triangle
    counts,
  - the georef Pset exists (and carries the origin lat/lng),
  - the confidence Pset exists,
  - units are metre (IfcSIUnit LENGTHUNIT = METRE),
  - IfcProjectedCRS is present and there is NO IfcMapConversion (the
    review-mandated georef fix: no active off-planet coordinate transform),
  - the emitted file passes ifcopenshell.validate with ZERO errors,
  - an out-of-range triangle index is rejected as a structured error.

Runs in CI / the Docker image where ifcopenshell is installed. If
ifcopenshell is NOT installed the test is skipped (pytest) / exits 0 with a
notice (direct run), and the CALLER must report that it did not execute.

Run: `python -m pytest test_ifc_worker.py` or `python test_ifc_worker.py`.
"""
from __future__ import annotations

import io
import sys

try:
    import ifcopenshell  # noqa: F401
    import ifcopenshell.validate
    _HAVE_IFC = True
except ImportError:  # pragma: no cover
    _HAVE_IFC = False

import run as ifc_worker


# A tiny 2x2-grid-derived mesh: 4 vertices, 2 triangles (one quad). Local
# ENU metres; zero-based indices, exactly as the GLB path emits.
SYNTHETIC_REQUEST = {
    "positions": [
        0.0, 0.0, 450.0,     # vertex 0
        10.0, 0.0, 451.0,    # vertex 1
        0.0, 10.0, 452.0,    # vertex 2
        10.0, 10.0, 453.0,   # vertex 3
    ],
    "indices": [0, 1, 2, 1, 3, 2],  # two triangles
    "georefOrigin": {
        "originLng": -97.31,
        "originLat": 30.1,
        "originHeightMeters": 0.0,
    },
    "crsConvention": "local-enu-meters:origin-bbox-sw:equirectangular-coslat",
    "provenance": {
        "sourceCitation": "USGS 3DEP (https://example/exportImage)",
        "coverageFraction": 0.98,
        "demResolutionMeters": 10,
        "demResolutionMeasured": False,
        "collectionProxyDate": "2026-07-15T00:00:00Z",
        "hasHoles": False,
    },
    "confidence": {
        "estimate": 0.72,
        "provenance": "asserted",
        "n": 0,
        "intervalWidth": 1,
    },
}

EXPECTED_VERTEX_COUNT = 4
EXPECTED_TRIANGLE_COUNT = 2


def _author_and_reread():
    result = ifc_worker.run(SYNTHETIC_REQUEST)
    assert result["status"] == "ok", result
    assert result["schemaVersion"] == "IFC4"
    assert result["geometryPrimitive"] == "IfcTriangulatedFaceSet"
    assert result["vertexCount"] == EXPECTED_VERTEX_COUNT
    assert result["triangleCount"] == EXPECTED_TRIANGLE_COUNT
    ifc_text = result["ifcText"]
    assert ifc_text.startswith("ISO-10303-21"), ifc_text[:40]

    # Re-read the emitted text with ifcopenshell.
    model = ifcopenshell.file.from_string(ifc_text)
    return model


def test_schema_is_ifc4():
    model = _author_and_reread()
    assert model.schema == "IFC4", model.schema


def test_single_triangulated_face_set_with_right_counts():
    model = _author_and_reread()
    face_sets = model.by_type("IfcTriangulatedFaceSet")
    assert len(face_sets) == 1, len(face_sets)
    fs = face_sets[0]
    # Coordinates round-trip to the vertex count; CoordIndex to the triangles.
    assert len(fs.Coordinates.CoordList) == EXPECTED_VERTEX_COUNT
    assert len(fs.CoordIndex) == EXPECTED_TRIANGLE_COUNT
    # Every CoordIndex triple is one-based and in-range.
    for tri in fs.CoordIndex:
        assert len(tri) == 3
        for idx in tri:
            assert 1 <= idx <= EXPECTED_VERTEX_COUNT, idx


def _pset_props(model, pset_name: str) -> dict:
    """Return {propName: nominalValue} for a named IfcPropertySet."""
    for pset in model.by_type("IfcPropertySet"):
        if pset.Name != pset_name:
            continue
        out = {}
        for prop in pset.HasProperties:
            nominal = getattr(prop, "NominalValue", None)
            out[prop.Name] = (
                nominal.wrappedValue if nominal is not None else None
            )
        return out
    return {}


def test_georef_and_confidence_psets_present():
    model = _author_and_reread()
    pset_names = {p.Name for p in model.by_type("IfcPropertySet")}
    assert "Pset_HauskaTerrainProvenance" in pset_names, pset_names
    assert "Pset_HauskaTerrainConfidence" in pset_names, pset_names


def test_units_are_metre():
    model = _author_and_reread()
    length_units = [
        u
        for u in model.by_type("IfcSIUnit")
        if u.UnitType == "LENGTHUNIT"
    ]
    assert len(length_units) == 1, length_units
    assert length_units[0].Name == "METRE", length_units[0].Name


def test_georef_crs_named_and_no_active_map_conversion():
    """MAJOR review fix: IfcProjectedCRS is NAMED (EPSG:4326) but there is
    NO IfcMapConversion, so no georef-aware consumer can derive an
    off-planet coordinate by trusting a machine-readable transform. The
    origin lat/lng lives in the provenance Pset as human-readable metadata.
    """
    model = _author_and_reread()
    # The CRS is named.
    crss = model.by_type("IfcProjectedCRS")
    assert len(crss) == 1
    assert crss[0].Name == "EPSG:4326", crss[0].Name
    # There is NO active map conversion — this is the anti-off-planet guard.
    assert len(model.by_type("IfcMapConversion")) == 0, (
        "an IfcMapConversion would let a consumer place terrain off-planet"
    )
    # The origin lat/lng is carried in the provenance Pset instead.
    props = _pset_props(model, "Pset_HauskaTerrainProvenance")
    assert "georefOriginLat" in props, props
    assert "georefOriginLng" in props, props
    assert abs(float(props["georefOriginLat"]) - 30.1) < 1e-6, props
    assert abs(float(props["georefOriginLng"]) - (-97.31)) < 1e-6, props


def test_terrain_is_geographic_element():
    model = _author_and_reread()
    terrains = model.by_type("IfcGeographicElement")
    assert len(terrains) == 1
    assert terrains[0].PredefinedType == "TERRAIN"


def test_authored_file_passes_ifc4_schema_validation_with_zero_errors():
    """BLOCKER 2 regression: the emitted IFC must pass ifcopenshell.validate
    with ZERO errors. It failed before the IfcOwnerHistory.CreationDate fix
    ("Attribute not optional | IfcOwnerHistory.CreationDate")."""
    model = _author_and_reread()
    logger = ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(model, logger)
    errors = logger.statements
    assert len(errors) == 0, (
        f"expected 0 schema errors, got {len(errors)}: {errors}"
    )


def test_out_of_range_index_is_rejected_as_structured_error():
    """BLOCKER 1 regression: an index past the vertex list must NOT author a
    corrupt face set with status:ok; it must return code:index-out-of-range."""
    bad = dict(SYNTHETIC_REQUEST)
    bad["positions"] = [0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 1.0, 1.0]  # 3 verts
    bad["indices"] = [0, 1, 99]  # 99 is out of range for a 3-vertex mesh
    raised = None
    try:
        ifc_worker.run(bad)
    except ifc_worker.IndexOutOfRangeError as exc:
        raised = exc
    assert raised is not None, "expected IndexOutOfRangeError, none raised"
    assert "out of range" in str(raised)


def test_negative_index_is_rejected():
    """The bounds check also rejects a negative index."""
    bad = dict(SYNTHETIC_REQUEST)
    bad["positions"] = [0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 0.0, 1.0, 1.0]
    bad["indices"] = [0, 1, -1]
    raised = None
    try:
        ifc_worker.run(bad)
    except ifc_worker.IndexOutOfRangeError as exc:
        raised = exc
    assert raised is not None, "expected IndexOutOfRangeError for negative idx"


def _main() -> int:
    if not _HAVE_IFC:
        sys.stderr.write(
            "SKIP: ifcopenshell not installed; IFC worker test not executed.\n"
        )
        return 0
    tests = [
        test_schema_is_ifc4,
        test_single_triangulated_face_set_with_right_counts,
        test_georef_and_confidence_psets_present,
        test_units_are_metre,
        test_georef_crs_named_and_no_active_map_conversion,
        test_terrain_is_geographic_element,
        test_authored_file_passes_ifc4_schema_validation_with_zero_errors,
        test_out_of_range_index_is_rejected_as_structured_error,
        test_negative_index_is_rejected,
    ]
    failures = 0
    for t in tests:
        try:
            t()
            sys.stdout.write(f"PASS {t.__name__}\n")
        except Exception as exc:  # AssertionError or an unexpected raise
            failures += 1
            sys.stdout.write(f"FAIL {t.__name__}: {type(exc).__name__}: {exc}\n")
    sys.stdout.write(
        f"\n{len(tests) - failures}/{len(tests)} passed\n"
    )
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(_main())
