#!/usr/bin/env python3
"""Acquire and stage the P-26 utility who-serves territory set.

This is a Factory 1.5 staging writer only. It never writes atoms, rail
declarations, cells, or product configuration.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import time
import zipfile
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

import psycopg
import requests
import shapefile
from psycopg.types.json import Jsonb
from pyproj import CRS, Transformer
from shapely.geometry import mapping, shape
from shapely.ops import transform
from shapely.strtree import STRtree


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_WORK_DIR = Path("P:/tmp/l22_utility_staging")
MIGRATION = ROOT / "lib/db/drizzle/0075_tx_utility_territory_staging.sql"
FETCHED_AT = datetime.now(timezone.utc)
FETCHED_AT_ISO = FETCHED_AT.isoformat()
FETCH_DATE = FETCHED_AT.date().isoformat()

SOURCES = {
    "puct-water-ccn": {
        "service_kind": "water",
        "url": "https://ftp.puc.texas.gov/public/puct-info/industry/water/utilities/PUCT_CCN_WATER_TSMS.zip",
        "expected": 3925,
        "tier": "state-regulator-download",
        "citation": "Public Utility Commission of Texas Water CCN service areas",
    },
    "puct-sewer-ccn": {
        "service_kind": "sewer",
        "url": "https://ftp.puc.texas.gov/public/puct-info/industry/water/utilities/PUCT_CCN_SEWER_TSMS.zip",
        "expected": 1455,
        "tier": "state-regulator-download",
        "citation": "Public Utility Commission of Texas Sewer CCN service areas",
    },
    "hifld-electric-retail": {
        "service_kind": "electric",
        "url": "https://services2.arcgis.com/LYMgRMwHfrWWEg3s/arcgis/rest/services/HIFLD_Electric_Retail_Service_Territories/FeatureServer/0",
        "where": "STATE = 'TX'",
        "expected": 139,
        "tier": "federal-hifld-arcgis",
        "citation": "HIFLD Electric Retail Service Territories, Texas subset",
    },
    "twdb-pws": {
        "service_kind": "water",
        "url": "https://services.twdb.texas.gov/arcgis/rest/services/PWS/Public_Water_Service_Areas/FeatureServer/0",
        "where": "1=1",
        "expected": 4621,
        "tier": "state-agency-arcgis",
        "citation": "Texas Water Development Board Public Water Service Areas",
    },
    "tceq-water-districts": {
        "service_kind": "water-district",
        "url": "https://services2.arcgis.com/LYMgRMwHfrWWEg3s/arcgis/rest/services/TCEQ_Water_Districts/FeatureServer/0",
        "where": "1=1",
        "expected": 2125,
        "tier": "state-regulator-arcgis",
        "citation": "Texas Commission on Environmental Quality Water Districts",
    },
}


def log(message: str) -> None:
    print(f"[l22] {message}", flush=True)


def database_url() -> str:
    direct = os.environ.get("DEPLOYMENT_DATABASE_URL", "").strip()
    if direct:
        return direct
    gcloud = (
        "C:/Users/cente/AppData/Local/Google/Cloud SDK/"
        "google-cloud-sdk/bin/gcloud.cmd"
        if os.name == "nt"
        else "gcloud"
    )
    result = subprocess.run(
        [
            gcloud,
            "secrets",
            "versions",
            "access",
            "latest",
            "--secret=DEPLOYMENT_DATABASE_URL",
            "--project=legacy-design-tools-prod",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    value = result.stdout.strip()
    if not value:
        raise RuntimeError("DEPLOYMENT_DATABASE_URL resolved empty")
    return value


def session() -> requests.Session:
    s = requests.Session()
    adapter = requests.adapters.HTTPAdapter(max_retries=4)
    s.mount("https://", adapter)
    s.headers["User-Agent"] = "Empressa-L22-utility-staging/1.0"
    return s


def get_json(s: requests.Session, url: str, params: dict[str, Any]) -> dict[str, Any]:
    response = s.get(url, params=params, timeout=120)
    response.raise_for_status()
    payload = response.json()
    if "error" in payload:
        raise RuntimeError(f"ArcGIS error from {response.url}: {payload['error']}")
    return payload


def download_zip(s: requests.Session, url: str, destination: Path) -> dict[str, Any]:
    last_error: Exception | None = None
    for attempt in range(1, 5):
        try:
            with s.get(url, stream=True, timeout=180) as response:
                response.raise_for_status()
                with destination.open("wb") as output:
                    for chunk in response.iter_content(1024 * 1024):
                        if chunk:
                            output.write(chunk)
            if destination.stat().st_size == 0:
                raise RuntimeError("downloaded zero bytes")
            with zipfile.ZipFile(destination) as archive:
                bad_member = archive.testzip()
                members = archive.namelist()
            if bad_member is not None:
                raise RuntimeError(f"zip integrity failed at {bad_member}")
            return {
                "bytes": destination.stat().st_size,
                "zip_test": "PASS",
                "members": members,
                "attempts": attempt,
            }
        except Exception as exc:
            last_error = exc
            if attempt < 4:
                time.sleep(attempt * 2)
    raise RuntimeError(f"failed to download valid zip {url}: {last_error}")


def transform_geojson(geometry: dict[str, Any], transformer: Transformer) -> dict[str, Any]:
    transformed = transform(transformer.transform, shape(geometry))
    return mapping(transformed)


def bbox_for(geometry: dict[str, Any]) -> tuple[float, float, float, float]:
    west, south, east, north = shape(geometry).bounds
    if not (-107 <= west <= east <= -92 and 25 <= south <= north <= 37):
        raise RuntimeError(f"non-Texas EPSG:4326 bbox: {(west, south, east, north)}")
    return west, south, east, north


def normalize_district_id(value: Any) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(value or "").strip().upper())


def normalize_district_name(value: Any) -> str:
    return re.sub(r"[^A-Z0-9]", "", str(value or "").strip().upper())


def shapefile_rows(
    source_key: str, extracted: Path
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    cfg = SOURCES[source_key]
    token = "WATER" if "water" in source_key else "SEWER"
    candidates = [
        path
        for path in extracted.rglob(f"PUCT_CCN_{token}_TSMS.shp")
        if "CCNFAC" not in path.name
    ]
    if len(candidates) != 1:
        raise RuntimeError(f"{source_key}: expected one territory shp, got {candidates}")
    shp_path = candidates[0]
    prj_path = shp_path.with_suffix(".prj")
    reader = shapefile.Reader(str(shp_path))
    if len(reader) != cfg["expected"]:
        raise RuntimeError(
            f"{source_key}: shapefile count {len(reader)} != {cfg['expected']}"
        )
    field_names = [field[0] for field in reader.fields[1:]]
    transformer = Transformer.from_crs(
        CRS.from_wkt(prj_path.read_text(encoding="utf-8")),
        CRS.from_epsg(4326),
        always_xy=True,
    )
    rows: list[dict[str, Any]] = []
    county_groups: Counter[str] = Counter()
    for index, item in enumerate(reader.iterShapeRecords()):
        attrs = dict(zip(field_names, item.record))
        raw_county = str(attrs.get("COUNTY") or "").strip()
        if raw_county:
            county_groups[raw_county] += 1
        geometry = transform_geojson(item.shape.__geo_interface__, transformer)
        west, south, east, north = bbox_for(geometry)
        object_id = str(index + 1)
        territory_id = str(attrs.get("CCN_NO") or object_id).strip()
        rows.append(
            make_row(
                source_key=source_key,
                object_id=object_id,
                territory_id=territory_id,
                territory_name=str(
                    attrs.get("UTILITY") or attrs.get("DBA_NAME") or ""
                ).strip()
                or None,
                county_name=raw_county or None,
                county_fips=None,
                geometry=geometry,
                bbox=(west, south, east, north),
                attributes=attrs,
                source_layer_id=shp_path.stem,
                source_vintage=FETCH_DATE,
            )
        )
    return rows, {
        "parsed_count": len(rows),
        "fields": field_names,
        "crs_input": prj_path.read_text(encoding="utf-8"),
        "crs_output": "EPSG:4326",
        "county_group_count": len(county_groups),
        "county_group_rows": dict(sorted(county_groups.items())),
        "blank_county_rows": sum(1 for row in rows if not row["county_name"]),
    }


def arcgis_features(
    s: requests.Session, source_key: str, include_geometry: bool = True
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    cfg = SOURCES[source_key]
    url = str(cfg["url"])
    where = str(cfg["where"])
    metadata = get_json(s, url, {"f": "json"})
    oid_field = metadata["objectIdField"]
    count_payload = get_json(
        s, f"{url}/query", {"f": "json", "where": where, "returnCountOnly": "true"}
    )
    count = int(count_payload["count"])
    ids_payload = get_json(
        s,
        f"{url}/query",
        {"f": "json", "where": where, "returnIdsOnly": "true"},
    )
    ids = sorted(ids_payload.get("objectIds") or [])
    if count != len(ids):
        raise RuntimeError(f"{source_key}: returnCountOnly {count} != ids {len(ids)}")
    if count != cfg["expected"]:
        raise RuntimeError(f"{source_key}: live count {count} != expected {cfg['expected']}")
    features: list[dict[str, Any]] = []
    for start in range(0, len(ids), 200):
        chunk = ids[start : start + 200]
        params = {
            "f": "geojson" if include_geometry else "json",
            "objectIds": ",".join(str(value) for value in chunk),
            "outFields": "*",
            "returnGeometry": "true" if include_geometry else "false",
            "outSR": "4326",
        }
        payload = get_json(s, f"{url}/query", params)
        chunk_features = payload.get("features") or []
        features.extend(chunk_features)
    if len(features) != count:
        raise RuntimeError(f"{source_key}: fetched {len(features)} != count {count}")
    last_edit_ms = (
        metadata.get("editingInfo", {}).get("lastEditDate")
        or metadata.get("editingInfo", {}).get("dataLastEditDate")
    )
    vintage = (
        datetime.fromtimestamp(last_edit_ms / 1000, timezone.utc).date().isoformat()
        if last_edit_ms
        else FETCH_DATE
    )
    return features, {
        "return_count_only": count,
        "object_id_count": len(ids),
        "fetched_count": len(features),
        "object_id_field": oid_field,
        "fields": [field["name"] for field in metadata.get("fields", [])],
        "source_vintage": vintage,
        "geometry_type": metadata.get("geometryType"),
    }


def make_row(
    *,
    source_key: str,
    object_id: str,
    territory_id: str,
    territory_name: str | None,
    county_name: str | None,
    county_fips: str | None,
    geometry: dict[str, Any],
    bbox: tuple[float, float, float, float],
    attributes: dict[str, Any],
    source_layer_id: str,
    source_vintage: str,
) -> dict[str, Any]:
    cfg = SOURCES[source_key]
    west, south, east, north = bbox
    return {
        "staging_row_id": f"{source_key}:{object_id}",
        "source_key": source_key,
        "service_kind": cfg["service_kind"],
        "territory_id": territory_id,
        "territory_name": territory_name,
        "county_name": county_name,
        "county_fips": county_fips,
        "geometry": geometry,
        "geometry_crs": "EPSG:4326",
        "source_url": cfg["url"],
        "source_layer_id": source_layer_id,
        "fetched_at": FETCHED_AT_ISO,
        "source_tiers": [cfg["tier"]],
        "source_tier_satisfied": [cfg["tier"]],
        "source_vintage": source_vintage,
        "source_citation": cfg["citation"],
        "passthrough_attributes": attributes,
        "west_lng": west,
        "south_lat": south,
        "east_lng": east,
        "north_lat": north,
        "object_id": object_id,
    }


def arcgis_rows(
    source_key: str, features: Iterable[dict[str, Any]], vintage: str
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    rows: list[dict[str, Any]] = []
    excluded: list[dict[str, Any]] = []
    for feature in features:
        attrs = feature.get("properties") or feature.get("attributes") or {}
        geometry = feature.get("geometry")
        if not geometry or not geometry.get("coordinates"):
            excluded.append(
                {
                    "reason": "empty-source-geometry",
                    "attributes": attrs,
                }
            )
            continue
        west, south, east, north = bbox_for(geometry)
        if source_key == "hifld-electric-retail":
            object_id = str(attrs["OBJECTID_1"])
            territory_id = str(attrs.get("ID") or object_id)
            territory_name = str(attrs.get("NAME") or "").strip() or None
            county_name = None
        elif source_key == "twdb-pws":
            object_id = str(attrs.get("ObjectID") or attrs.get("ObjectId"))
            if object_id == "None":
                raise RuntimeError(f"{source_key}: feature has no object ID: {attrs}")
            territory_id = str(attrs.get("PWSId") or attrs.get("PWSCode") or object_id)
            territory_name = str(attrs.get("PWSName") or "").strip() or None
            county_name = None
        else:
            object_id = str(attrs["OBJECTID"])
            territory_id = str(attrs.get("DISTRICT_ID") or object_id)
            territory_name = str(attrs.get("NAME") or "").strip() or None
            county_name = str(attrs.get("COUNTY") or "").strip() or None
        rows.append(
            make_row(
                source_key=source_key,
                object_id=object_id,
                territory_id=territory_id,
                territory_name=territory_name,
                county_name=county_name,
                county_fips=None,
                geometry=geometry,
                bbox=(west, south, east, north),
                attributes=attrs,
                source_layer_id="0",
                source_vintage=vintage,
            )
        )
    return rows, excluded


def load_counties(connection: psycopg.Connection[Any]) -> tuple[list[Any], list[dict[str, str]], STRtree]:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT county_fips, county_name, geometry FROM tx_county_boundary ORDER BY county_fips"
        )
        records = cursor.fetchall()
    if len(records) != 254:
        raise RuntimeError(f"expected 254 county boundaries, got {len(records)}")
    geometries = [shape(record[2]) for record in records]
    metadata = [
        {"county_fips": record[0], "county_name": record[1]} for record in records
    ]
    return geometries, metadata, STRtree(geometries)


def county_coverage(
    rows: list[dict[str, Any]],
    county_geometries: list[Any],
    county_metadata: list[dict[str, str]],
    county_tree: STRtree,
) -> dict[str, Any]:
    counts: Counter[str] = Counter()
    names: dict[str, str] = {}
    for row in rows:
        territory = shape(row["geometry"])
        for index in county_tree.query(territory, predicate="intersects"):
            county = county_metadata[int(index)]
            counts[county["county_fips"]] += 1
            names[county["county_fips"]] = county["county_name"]
    return {
        "method": "local Shapely intersects against 254 tx_county_boundary GeoJSON rows; no PostGIS",
        "counting_rule": "distinct county_fips with at least one polygon intersection; per-county n is source features intersecting that county and a feature may count in multiple counties",
        "county_count": len(counts),
        "groups": [
            {"county_fips": fips, "county_name": names[fips], "features": counts[fips]}
            for fips in sorted(counts)
        ],
    }


INSERT_SQL = """
INSERT INTO tx_utility_territory_staging (
  staging_row_id, source_key, service_kind, territory_id, territory_name,
  county_name, county_fips, geometry, geometry_crs, source_url,
  source_layer_id, fetched_at, source_tiers, source_tier_satisfied,
  source_vintage, source_citation, passthrough_attributes,
  west_lng, south_lat, east_lng, north_lat, object_id
) VALUES (
  %(staging_row_id)s, %(source_key)s, %(service_kind)s, %(territory_id)s,
  %(territory_name)s, %(county_name)s, %(county_fips)s, %(geometry)s,
  %(geometry_crs)s, %(source_url)s, %(source_layer_id)s, %(fetched_at)s,
  %(source_tiers)s, %(source_tier_satisfied)s, %(source_vintage)s,
  %(source_citation)s, %(passthrough_attributes)s, %(west_lng)s,
  %(south_lat)s, %(east_lng)s, %(north_lat)s, %(object_id)s
)
ON CONFLICT (staging_row_id) DO UPDATE SET
  territory_id = EXCLUDED.territory_id,
  territory_name = EXCLUDED.territory_name,
  county_name = EXCLUDED.county_name,
  county_fips = EXCLUDED.county_fips,
  geometry = EXCLUDED.geometry,
  geometry_crs = EXCLUDED.geometry_crs,
  source_url = EXCLUDED.source_url,
  source_layer_id = EXCLUDED.source_layer_id,
  fetched_at = EXCLUDED.fetched_at,
  source_tiers = EXCLUDED.source_tiers,
  source_tier_satisfied = EXCLUDED.source_tier_satisfied,
  source_vintage = EXCLUDED.source_vintage,
  source_citation = EXCLUDED.source_citation,
  passthrough_attributes = EXCLUDED.passthrough_attributes,
  west_lng = EXCLUDED.west_lng,
  south_lat = EXCLUDED.south_lat,
  east_lng = EXCLUDED.east_lng,
  north_lat = EXCLUDED.north_lat,
  object_id = EXCLUDED.object_id,
  ingested_at = now()
"""


def insert_rows(connection: psycopg.Connection[Any], rows: list[dict[str, Any]]) -> int:
    prepared = []
    for row in rows:
        value = dict(row)
        value["geometry"] = Jsonb(value["geometry"])
        value["source_tiers"] = Jsonb(value["source_tiers"])
        value["source_tier_satisfied"] = Jsonb(value["source_tier_satisfied"])
        value["passthrough_attributes"] = Jsonb(value["passthrough_attributes"])
        prepared.append(value)
    written = 0
    for start in range(0, len(prepared), 250):
        batch = prepared[start : start + 250]
        with connection.transaction():
            with connection.cursor() as cursor:
                cursor.executemany(INSERT_SQL, batch)
        written += len(batch)
        log(f"wrote {written}/{len(prepared)} rows")
    return written


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--work-dir", type=Path, default=DEFAULT_WORK_DIR)
    parser.add_argument("--report", type=Path, required=True)
    args = parser.parse_args()
    args.work_dir.mkdir(parents=True, exist_ok=True)
    s = session()
    report: dict[str, Any] = {
        "artifact": "l22_utility_stage_run",
        "started_at": FETCHED_AT_ISO,
        "sources": {},
        "constraints": {
            "atoms_writes": "NONE",
            "slot": "NOT TAKEN",
            "lease": "NOT TAKEN",
            "rail_edits": "NONE",
            "cells": "NONE",
            "product_surface": "NONE",
            "postgis": "NONE",
            "heavy_scan": "NONE",
        },
    }

    with psycopg.connect(database_url()) as connection:
        host = connection.info.host
        if "ep-lucky-truth-apodo8hr" not in host:
            raise RuntimeError(f"unexpected deployment host: {host}")
        report["database"] = {
            "host_fingerprint": host,
            "database": connection.info.dbname,
        }
        with connection.transaction():
            with connection.cursor() as cursor:
                cursor.execute(MIGRATION.read_text(encoding="utf-8"))

        county_geometries, county_metadata, county_tree = load_counties(connection)

        for source_key in ("puct-water-ccn", "puct-sewer-ccn"):
            cfg = SOURCES[source_key]
            zip_path = args.work_dir / f"{source_key}.zip"
            extract_dir = args.work_dir / source_key
            zip_proof = download_zip(s, str(cfg["url"]), zip_path)
            extract_dir.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(zip_path) as archive:
                archive.extractall(extract_dir)
            rows, source_proof = shapefile_rows(source_key, extract_dir)
            before = existing_source_count(connection, source_key)
            written = insert_rows(connection, rows)
            after = existing_source_count(connection, source_key)
            report["sources"][source_key] = {
                "source_url": cfg["url"],
                "zip_integrity": zip_proof,
                **source_proof,
                "existing_before": before,
                "written_or_updated": written,
                "staged_after": after,
                "coverage": county_coverage(
                    rows, county_geometries, county_metadata, county_tree
                ),
            }

        for source_key in ("hifld-electric-retail", "twdb-pws"):
            cfg = SOURCES[source_key]
            features, source_proof = arcgis_features(s, source_key)
            rows, excluded = arcgis_rows(
                source_key, features, source_proof["source_vintage"]
            )
            before = existing_source_count(connection, source_key)
            written = insert_rows(connection, rows)
            after = existing_source_count(connection, source_key)
            report["sources"][source_key] = {
                "source_url": cfg["url"],
                **source_proof,
                "existing_before": before,
                "written_or_updated": written,
                "staged_after": after,
                "excluded_source_rows": excluded,
                "excluded_source_count": len(excluded),
                "coverage": county_coverage(
                    rows, county_geometries, county_metadata, county_tree
                ),
            }

        tceq_features, tceq_proof = arcgis_features(s, "tceq-water-districts")
        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT district_id, district_name
                FROM tx_special_district
                WHERE source = 'tceq-water-districts-v1'
                """
            )
            existing_records = cursor.fetchall()
            existing_ids = {
                normalize_district_id(district_id) for district_id, _ in existing_records
            }
            existing_names = {
                normalize_district_name(district_name)
                for _, district_name in existing_records
            }
        source_ids = {
            normalize_district_id(
                (feature.get("properties") or feature.get("attributes") or {}).get(
                    "DISTRICT_ID"
                )
            )
            for feature in tceq_features
        }
        source_ids.discard("")
        id_only_additive_ids = sorted(source_ids - existing_ids)
        name_overlap_ids = sorted(
            {
                normalize_district_id(
                    (feature.get("properties") or feature.get("attributes") or {}).get(
                        "DISTRICT_ID"
                    )
                )
                for feature in tceq_features
                if normalize_district_id(
                    (feature.get("properties") or feature.get("attributes") or {}).get(
                        "DISTRICT_ID"
                    )
                )
                in id_only_additive_ids
                and normalize_district_name(
                    (feature.get("properties") or feature.get("attributes") or {}).get(
                        "NAME"
                    )
                )
                in existing_names
            }
        )
        additive_ids = sorted(set(id_only_additive_ids) - set(name_overlap_ids))
        additive_features = [
            feature
            for feature in tceq_features
            if normalize_district_id(
                (feature.get("properties") or feature.get("attributes") or {}).get(
                    "DISTRICT_ID"
                )
            )
            in additive_ids
        ]
        additive_rows, additive_invalid = arcgis_rows(
            "tceq-water-districts",
            additive_features,
            tceq_proof["source_vintage"],
        )
        before = existing_source_count(connection, "tceq-water-districts")
        written = insert_rows(connection, additive_rows) if additive_rows else 0
        after = existing_source_count(connection, "tceq-water-districts")
        report["sources"]["tceq-water-districts"] = {
            "source_url": SOURCES["tceq-water-districts"]["url"],
            **tceq_proof,
            "reconciliation": {
                "normalization": "uppercase; trim; remove every non A-Z/0-9 character; blank IDs excluded",
                "source_distinct_ids": len(source_ids),
                "tx_special_district_distinct_normalized_ids": len(existing_ids),
                "tx_special_district_rows_for_source": len(existing_records),
                "represented_source_ids": len(source_ids & existing_ids),
                "id_absent_but_name_represented_ids": name_overlap_ids,
                "id_absent_but_name_represented_count": len(name_overlap_ids),
                "additive_ids": additive_ids,
                "additive_count": len(additive_ids),
                "additive_empty_geometry": additive_invalid,
                "counting_rule": "district subject is represented when normalized DISTRICT_ID OR normalized NAME already exists; only rows absent by both keys are additive",
            },
            "existing_before": before,
            "written_or_updated": written,
            "staged_after": after,
            "coverage": county_coverage(
                additive_rows if additive_rows else arcgis_rows(
                    "tceq-water-districts", tceq_features, tceq_proof["source_vintage"]
                )[0],
                county_geometries,
                county_metadata,
                county_tree,
            ),
            "coverage_scope": "live source rows; staging remains additive-only",
        }

        with connection.cursor() as cursor:
            cursor.execute(
                """
                SELECT source_key, COUNT(*)::int AS rows,
                       COUNT(DISTINCT territory_id)::int AS territories,
                       COUNT(*) FILTER (
                         WHERE jsonb_array_length(source_tier_satisfied) = 0
                       )::int AS bad_tier,
                       COUNT(*) FILTER (
                         WHERE geometry_crs <> 'EPSG:4326'
                       )::int AS bad_crs
                FROM tx_utility_territory_staging
                GROUP BY source_key
                ORDER BY source_key
                """
            )
            report["sql_verification"] = [
                {
                    "source_key": row[0],
                    "rows": row[1],
                    "territories": row[2],
                    "bad_tier": row[3],
                    "bad_crs": row[4],
                }
                for row in cursor.fetchall()
            ]

    report["completed_at"] = datetime.now(timezone.utc).isoformat()
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2), encoding="utf-8")
    log(f"report: {args.report}")


def existing_source_count(
    connection: psycopg.Connection[Any], source_key: str
) -> int:
    with connection.cursor() as cursor:
        cursor.execute(
            "SELECT COUNT(*)::int FROM tx_utility_territory_staging WHERE source_key = %s",
            (source_key,),
        )
        return int(cursor.fetchone()[0])


if __name__ == "__main__":
    main()
