#!/usr/bin/env python3
"""
TxGIO bare-earth DTM acquire CLI — terrain tile pipeline T-008.

Downloads StratMap/TxGIO DEM GeoTIFFs via the public api.tnris.org REST API,
extracts, mosaics to a single staged GeoTIFF, and writes a metadata sidecar
(CRS, vertical datum, vertical unit) required for Phase 3 flood depth.

ADDITIVE ONLY — output is for 3D map viz tiles; do NOT wire into engine
flood/site-topography/contour adapters.

Usage (from legacy-design-tools repo root):
  python artifacts/tile-pipeline/terrain_dem_acquire.py \\
    --aoi=bastrop-city-2mi \\
    --out-dir=./.terrain-bake

Requires: Python 3.10+, curl or urllib, unzip. Mosaic step requires GDAL
(native gdalbuildvrt/gdalwarp on PATH, or Docker via GDAL_DOCKER_IMAGE).
"""

from __future__ import annotations

import argparse
import fnmatch
import hashlib
import json
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path

# Default: 2017 StratMap Central Texas — covers Bastrop (matches Contour1Ft2017 lineage)
DEFAULT_COLLECTION_ID = "0549d3ba-3f72-4710-b26c-28c65df9c70d"
DEFAULT_COLLECTION_URL = (
    "https://data.tnris.org/collection/?c=0549d3ba-3f72-4710-b26c-28c65df9c70d"
)
TNris_API = "https://api.tnris.org/api/v1"
GDAL_DOCKER_IMAGE = "ghcr.io/osgeo/gdal:alpine-small-latest"

SCRIPT_DIR = Path(__file__).resolve().parent
AOI_PRESETS_PATH = SCRIPT_DIR / "aoi_presets.json"

# Collection-level defaults (verified from api.tnris.org collection record 2026-07-31).
# gdalinfo on extracted tiles should confirm; supplemental report is authoritative.
COLLECTION_DEFAULTS = {
    "horizontal_crs": "EPSG:6343",
    "horizontal_crs_name": "NAD83(2011) / Texas Central (ftUS)",
    "vertical_datum": "NAVD88",
    "vertical_unit": "US survey foot",
    "source": "TxGIO DataHub / StratMap 2017 Central Texas Lidar",
    "source_url": DEFAULT_COLLECTION_URL,
    "s_three_key": "stratmap-2017-50cm-central-texas",
    "resolution": "50cm",
}


def log(msg: str) -> None:
    print(f"[terrain-dem-acquire] {msg}", flush=True)


def fail(msg: str) -> None:
    log(f"ERROR: {msg}")
    sys.exit(1)


DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def http_headers() -> dict[str, str]:
    return {"User-Agent": DEFAULT_USER_AGENT, "Accept": "*/*"}


def http_json(url: str) -> dict:
    req = urllib.request.Request(url, headers=http_headers())
    with urllib.request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def load_aoi_preset(name: str) -> dict:
    if not AOI_PRESETS_PATH.exists():
        fail(f"AOI presets file missing: {AOI_PRESETS_PATH}")
    presets = json.loads(AOI_PRESETS_PATH.read_text(encoding="utf-8"))
    if name not in presets:
        fail(f"Unknown --aoi={name!r}. Known: {', '.join(sorted(presets))}")
    return presets[name]


def fetch_collection(collection_id: str) -> dict:
    url = f"{TNris_API}/collections/{collection_id}/"
    try:
        return http_json(url)
    except urllib.error.HTTPError:
        # List endpoint fallback
        data = http_json(f"{TNris_API}/collections/?limit=200")
        for row in data.get("results", []):
            if row.get("collection_id") == collection_id:
                return row
        fail(f"collection {collection_id} not found")


def fetch_dem_resources(collection_id: str) -> list[dict]:
    resources: list[dict] = []
    offset = 0
    limit = 200
    while True:
        qs = urllib.parse.urlencode(
            {
                "collection_id": collection_id,
                "resource_type_abbreviation": "DEM",
                "limit": limit,
                "offset": offset,
            }
        )
        data = http_json(f"{TNris_API}/resources/?{qs}")
        batch = data.get("results", [])
        if not batch:
            break
        resources.extend(batch)
        if not data.get("next"):
            break
        offset += limit
    return resources


def select_resources_for_aoi(resources: list[dict], preset: dict) -> list[dict]:
    patterns = preset.get("tile_name_patterns") or []
    if not patterns:
        fail("AOI preset has no tile_name_patterns")
    selected: list[dict] = []
    for row in resources:
        name = row.get("area_type_name") or ""
        if any(fnmatch.fnmatch(name, pat) for pat in patterns):
            selected.append(row)
    # Stable order for reproducible downloads
    selected.sort(key=lambda r: r.get("area_type_name") or "")
    return selected


def download_file(url: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_size > 0:
        log(f"skip existing {dest.name}")
        return
    log(f"download {dest.name} ({url})")
    req = urllib.request.Request(url, headers=http_headers())
    with urllib.request.urlopen(req, timeout=600) as resp, dest.open("wb") as out:
        shutil.copyfileobj(resp, out)


def extract_raster_tiles(zip_path: Path, extract_dir: Path) -> list[Path]:
    """Extract raster tiles from TxGIO DEM zip (often Erdas .img, sometimes GeoTIFF)."""
    extract_dir.mkdir(parents=True, exist_ok=True)
    rasters: list[Path] = []
    with zipfile.ZipFile(zip_path, "r") as zf:
        for info in zf.infolist():
            lower = info.filename.lower()
            if lower.endswith((".tif", ".tiff", ".img")):
                zf.extract(info, extract_dir)
                rasters.append(extract_dir / info.filename)
    return rasters


def gdal_on_path() -> bool:
    return shutil.which("gdalbuildvrt") is not None and shutil.which("gdalwarp") is not None


def to_docker_path(p: Path) -> str:
    """Windows path -> Docker Desktop mount form."""
    s = str(p.resolve())
    win = re.match(r"^([A-Za-z]):[\\/](.*)$", s)
    if win:
        return f"/{win.group(1).lower()}/{win.group(2).replace(chr(92), '/')}"
    return s.replace(chr(92), "/")


def run_gdal(args: list[str], work_dir: Path) -> None:
    if gdal_on_path():
        log(f"gdal {' '.join(args[:4])}{'...' if len(args) > 4 else ''}")
        subprocess.run(args, cwd=work_dir, check=True)
        return
    docker = shutil.which("docker")
    if not docker:
        fail(
            "GDAL not on PATH and Docker unavailable. Install GDAL or Docker to mosaic tiles."
        )
    mount = f"{to_docker_path(work_dir)}:/data"
    docker_args = []
    for a in args:
        p = Path(a)
        if p.is_absolute():
            try:
                rel = p.resolve().relative_to(work_dir.resolve())
                docker_args.append("/data/" + rel.as_posix())
            except ValueError:
                docker_args.append(a)
        else:
            docker_args.append(a)
    cmd = [docker, "run", "--rm", "-v", mount, GDAL_DOCKER_IMAGE, *docker_args]
    log(f"docker gdal {docker_args[0]} ... ({len(docker_args)} args)")
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as exc:
        fail(f"GDAL docker command failed (exit {exc.returncode}): {' '.join(cmd)}")


def gdalinfo_json(tif_path: Path, work_dir: Path) -> dict:
    """Best-effort gdalinfo -json via native or docker."""
    if gdal_on_path():
        result = subprocess.run(
            ["gdalinfo", "-json", str(tif_path)],
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(result.stdout)
    rel = tif_path.relative_to(work_dir).as_posix()
    result = subprocess.run(
        [
            "docker",
            "run",
            "--rm",
            "-v",
            f"{to_docker_path(work_dir)}:/data",
            GDAL_DOCKER_IMAGE,
            "gdalinfo",
            "-json",
            f"/data/{rel}",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def parse_vertical_from_gdalinfo(info: dict) -> tuple[str | None, str | None]:
    """Extract vertical CRS/datum hints from gdalinfo JSON."""
    vdatum = None
    vunit = None
    for ci in info.get("coordinateSystem", {}).get("coordinateSystem", {}).get(
        "axis", []
    ):
        # Often empty for compound CRS — fall through
        pass
    # GTiff tags
    meta = info.get("metadata", {}) or {}
    for domain in ("IMAGE_STRUCTURE", "DERIVED_SUBDATASETS", ""):
        block = meta.get(domain) if isinstance(meta.get(domain), dict) else {}
        if isinstance(block, dict):
            for k, v in block.items():
                if "VERT" in k.upper() or "DATUM" in k.upper():
                    vdatum = vdatum or str(v)
    # EPSG 6343 is 2D projected; vertical is collection metadata (NAVD88 ftUS)
    return vdatum, vunit


def content_hash12(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.digest().hex()[:12]


def mosaic_input_lines(raster_paths: list[Path], work_dir: Path) -> list[str]:
    """Paths for gdalbuildvrt -input_file_list (container paths when using Docker)."""
    unique = sorted({p.resolve() for p in raster_paths})
    if gdal_on_path():
        return [str(p) for p in unique]
    lines: list[str] = []
    for p in unique:
        rel = p.relative_to(work_dir.resolve())
        lines.append("/data/" + rel.as_posix())
    return lines


def mosaic_tifs(raster_paths: list[Path], work_dir: Path, out_tif: Path) -> None:
    if not raster_paths:
        fail("no raster tiles extracted from DEM zips")
    list_file = work_dir / "mosaic_inputs.txt"
    list_file.write_text(
        "\n".join(mosaic_input_lines(raster_paths, work_dir)) + "\n", encoding="utf-8"
    )
    vrt = work_dir / "mosaic.vrt"
    run_gdal(
        ["gdalbuildvrt", "-input_file_list", str(list_file), str(vrt)],
        work_dir,
    )
    run_gdal(
        [
            "gdalwarp",
            "-co",
            "COMPRESS=DEFLATE",
            "-co",
            "TILED=YES",
            str(vrt),
            str(out_tif),
        ],
        work_dir,
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Acquire TxGIO bare-earth DTM for an AOI")
    parser.add_argument(
        "--aoi",
        default="bastrop-city-2mi",
        help="AOI preset name (see aoi_presets.json)",
    )
    parser.add_argument(
        "--out-dir",
        default="./.terrain-bake",
        help="Output directory for staged GeoTIFF + metadata",
    )
    parser.add_argument(
        "--collection-id",
        default=DEFAULT_COLLECTION_ID,
        help="TxGIO collection UUID",
    )
    parser.add_argument(
        "--download-only",
        action="store_true",
        help="Download + extract only; skip mosaic (for debugging)",
    )
    parser.add_argument(
        "--force-extract",
        action="store_true",
        help="Re-extract DEM zips even when tile subdirs already exist",
    )
    args = parser.parse_args()

    work_dir = Path(args.out_dir).resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    preset = load_aoi_preset(args.aoi)

    log(f"AOI {args.aoi}: {preset.get('description', '')}")
    collection = fetch_collection(args.collection_id)
    log(
        f"collection: {collection.get('name')} ({args.collection_id}) "
        f"s3={collection.get('s_three_key')}"
    )

    all_resources = fetch_dem_resources(args.collection_id)
    log(f"collection DEM resource count: {len(all_resources)}")
    selected = select_resources_for_aoi(all_resources, preset)
    if not selected:
        fail(f"no DEM tiles matched AOI patterns {preset.get('tile_name_patterns')}")
    log(f"selected {len(selected)} DEM tiles for AOI")

    manifest_path = work_dir / "download_manifest.json"
    manifest_path.write_text(
        json.dumps(
            {
                "aoi": args.aoi,
                "collection_id": args.collection_id,
                "tiles": [
                    {
                        "area_type_name": r["area_type_name"],
                        "url": r["resource"],
                        "filesize": r.get("filesize"),
                    }
                    for r in selected
                ],
            },
            indent=2,
        ),
        encoding="utf-8",
    )

    zip_dir = work_dir / "zips"
    tif_dir = work_dir / "tiles"
    all_rasters: list[Path] = []
    for row in selected:
        url = row["resource"]
        fname = url.rsplit("/", 1)[-1]
        zip_path = zip_dir / fname
        extract_subdir = tif_dir / fname.replace(".zip", "")
        download_file(url, zip_path)
        if extract_subdir.exists() and not args.force_extract:
            existing = sorted(
                p
                for p in extract_subdir.rglob("*")
                if p.is_file() and p.suffix.lower() in (".img", ".tif", ".tiff")
            )
            if existing:
                log(f"skip extract {extract_subdir.name} ({len(existing)} rasters)")
                all_rasters.extend(existing)
                continue
        if extract_subdir.exists():
            shutil.rmtree(extract_subdir)
        all_rasters.extend(extract_raster_tiles(zip_path, extract_subdir))

    log(f"extracted {len(all_rasters)} raster tiles (.img/.tif)")

    if args.download_only:
        log("--download-only: skipping mosaic")
        return

    tmp_mosaic = work_dir / "terrain-dem.mosaic.tif"
    mosaic_tifs(all_rasters, work_dir, tmp_mosaic)

    dem_hash = content_hash12(tmp_mosaic)
    final_tif = work_dir / f"terrain-dem.{dem_hash}.tif"
    tmp_mosaic.rename(final_tif)

    gi = gdalinfo_json(final_tif, work_dir)
    crs_wkt = (gi.get("coordinateSystem") or {}).get("wkt") or ""
    epsg_match = re.search(r'AUTHORITY\["EPSG","(\d+)"\]', crs_wkt)
    horizontal_crs = f"EPSG:{epsg_match.group(1)}" if epsg_match else COLLECTION_DEFAULTS["horizontal_crs"]
    vdatum_tag, vunit_tag = parse_vertical_from_gdalinfo(gi)

    metadata = {
        **COLLECTION_DEFAULTS,
        "horizontal_crs": horizontal_crs,
        "horizontal_crs_reprojected": "EPSG:3857",
        "vertical_datum": vdatum_tag or COLLECTION_DEFAULTS["vertical_datum"],
        "vertical_unit": vunit_tag or COLLECTION_DEFAULTS["vertical_unit"],
        "vertical_datum_source": "collection_metadata+supplemental_report",
        "acquired_at": datetime.now(timezone.utc).isoformat(),
        "aoi": args.aoi,
        "aoi_bbox_wgs84": preset.get("bbox_wgs84"),
        "collection_id": args.collection_id,
        "collection_name": collection.get("name"),
        "content_hash": dem_hash,
        "tile_count": len(selected),
        "output_geotiff": final_tif.name,
        "gdalinfo_size": gi.get("size"),
        "gdalinfo_geoTransform": gi.get("geoTransform"),
    }

    meta_path = work_dir / f"terrain-dem.{dem_hash}.metadata.json"
    meta_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    log("---- acquire summary ----")
    log(f"geotiff:  {final_tif} ({final_tif.stat().st_size / 1_048_576:.1f} MB)")
    log(f"metadata: {meta_path}")
    log(f"horizontal_crs: {metadata['horizontal_crs']}")
    log(f"vertical_datum: {metadata['vertical_datum']}")
    log(f"vertical_unit: {metadata['vertical_unit']}")


if __name__ == "__main__":
    main()
