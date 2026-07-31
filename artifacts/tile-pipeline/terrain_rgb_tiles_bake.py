#!/usr/bin/env python3
"""
Terrain-RGB tile bake CLI — terrain tile pipeline T-009.

Reprojects staged TxGIO DTM to EPSG:3857, converts vertical units to meters
during rgbify, encodes Mapbox terrain-RGB, and tiles to {z}/{x}/{y}.png for GCS.

ADDITIVE ONLY — output powers 3D map viz; do NOT repoint engine flood/site-plan routes.

Usage (from legacy-design-tools repo root):
  python artifacts/tile-pipeline/terrain_rgb_tiles_bake.py \\
    --dem=./.terrain-bake/terrain-dem.<hash12>.tif \\
    --metadata=./.terrain-bake/terrain-dem.<hash12>.metadata.json \\
    --out-dir=./.terrain-bake

Requires: Python 3.10+, rio-rgbify, rasterio. GDAL via PATH or Docker
(ghcr.io/osgeo/gdal:ubuntu-full-latest for warp/gdal2tiles).
"""

from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import rasterio as rio
from riomucho import RioMucho
from rio_rgbify.encoders import data_to_rgb

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from gdal_runner import (
    GDAL_DOCKER_IMAGE_FULL,
    bake_content_hash,
    gdalinfo_json,
    run_gdal,
)

GCS_BUCKET = "hauska-map-tiles"
GCS_BASE = f"https://storage.googleapis.com/{GCS_BUCKET}"
NODATA = -9999
US_SURVEY_FOOT_TO_M = 1200 / 3937


def log(msg: str) -> None:
    print(f"[terrain-rgb-bake] {msg}", flush=True)


def fail(msg: str) -> None:
    log(f"ERROR: {msg}")
    sys.exit(1)


def vertical_unit_to_meters_factor(unit: str) -> float:
    u = unit.lower().strip()
    if "survey" in u and ("foot" in u or "ft" in u):
        return US_SURVEY_FOOT_TO_M
    if "foot" in u or "ft" in u:
        return 0.3048
    if u in ("meter", "meters", "metre", "metres", "m"):
        return 1.0
    fail(f"unsupported vertical_unit {unit!r}; extend vertical_unit_to_meters_factor")


def load_dem_metadata(path: Path) -> dict:
    if not path.exists():
        fail(f"metadata not found: {path}")
    meta = json.loads(path.read_text(encoding="utf-8"))
    for key in ("vertical_datum", "vertical_unit", "horizontal_crs", "content_hash"):
        if key not in meta:
            fail(f"metadata missing required key: {key}")
    return meta


def _rgb_worker_meters(data, window, ij, g_args):
    """Scale source elevations to meters before Mapbox RGB encoding."""
    band = data[0][g_args["bidx"] - 1].astype(np.float64)
    nodata = g_args.get("nodata", NODATA)
    scale = g_args["scale_factor"]
    scaled = np.where(band == nodata, nodata, band * scale)
    return data_to_rgb(scaled, g_args["base_val"], g_args["interval"])


def warp_to_3857(dem: Path, out: Path, work_dir: Path, *, force: bool) -> None:
    if out.exists() and not force:
        log(f"skip warp (exists): {out.name}")
        return
    run_gdal(
        [
            "gdalwarp",
            "-t_srs",
            "EPSG:3857",
            "-r",
            "bilinear",
            "-srcnodata",
            str(NODATA),
            "-dstnodata",
            str(NODATA),
            "-co",
            "COMPRESS=DEFLATE",
            "-co",
            "TILED=YES",
            str(dem),
            str(out),
        ],
        work_dir,
        docker_image=GDAL_DOCKER_IMAGE_FULL,
        log_prefix="terrain-rgb-bake",
    )


def run_rgbify(
    src: Path,
    dst: Path,
    *,
    scale_factor: float,
    base_val: float = -10000.0,
    interval: float = 0.1,
    workers: int = 4,
    force: bool,
) -> None:
    if dst.exists() and not force:
        log(f"skip rgbify (exists): {dst.name}")
        return
    log(
        f"rgbify Mapbox encoding base={base_val} interval={interval}m "
        f"(scale={scale_factor})"
    )
    gargs = {
        "interval": interval,
        "base_val": base_val,
        "bidx": 1,
        "scale_factor": scale_factor,
        "nodata": NODATA,
    }
    with rio.open(src) as src_ds:
        meta = {
            "driver": "GTiff",
            "height": src_ds.height,
            "width": src_ds.width,
            "count": 3,
            "dtype": np.uint8,
            "crs": src_ds.crs,
            "transform": src_ds.transform,
            "compress": "deflate",
            "tiled": True,
            "blockxsize": 256,
            "blockysize": 256,
        }
    with RioMucho(
        [str(src)], str(dst), _rgb_worker_meters, options=meta, global_args=gargs
    ) as rm:
        rm.run(workers)


def run_gdal2tiles(
    rgb_tif: Path,
    tile_dir: Path,
    work_dir: Path,
    *,
    min_zoom: int,
    max_zoom: int,
    processes: int,
    force: bool,
) -> None:
    if tile_dir.exists():
        has_tiles = any(tile_dir.glob("*/*.png"))
        if has_tiles and not force:
            log(f"skip gdal2tiles (exists): {tile_dir.name}/")
            return
        if force:
            shutil.rmtree(tile_dir)
    tile_dir.mkdir(parents=True, exist_ok=True)
    run_gdal(
        [
            "gdal2tiles.py",
            "-z",
            f"{min_zoom}-{max_zoom}",
            "--xyz",
            f"--processes={processes}",
            "--webviewer=none",
            "--resume",
            str(rgb_tif),
            str(tile_dir),
        ],
        work_dir,
        docker_image=GDAL_DOCKER_IMAGE_FULL,
        log_prefix="terrain-rgb-bake",
    )


def count_tiles(tile_dir: Path) -> int:
    return sum(1 for _ in tile_dir.rglob("*.png"))


def sample_tile_xyz(
    tile_dir: Path, lat: float, lon: float, zoom: int
) -> tuple[int, int, int] | None:
    n = 2**zoom
    x = int((lon + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    y = int(
        (1.0 - math.log(math.tan(lat_rad) + 1.0 / math.cos(lat_rad)) / math.pi)
        / 2.0
        * n
    )
    if (tile_dir / str(zoom) / str(x) / f"{y}.png").exists():
        return zoom, x, y
    return None


def write_bake_metadata(
    out_path: Path,
    *,
    dem_meta: dict,
    dem_path: Path,
    rgb_tif: Path,
    tile_dir: Path,
    content_hash: str,
    min_zoom: int,
    max_zoom: int,
    tile_count: int,
) -> dict:
    gi = gdalinfo_json(rgb_tif, tile_dir.parent, docker_image=GDAL_DOCKER_IMAGE_FULL)
    skip = {"output_geotiff", "gdalinfo_size", "gdalinfo_geoTransform"}
    metadata = {
        **{k: v for k, v in dem_meta.items() if k not in skip},
        "dem_source_geotiff": dem_path.name,
        "dem_content_hash": dem_meta.get("content_hash"),
        "horizontal_crs_reprojected": "EPSG:3857",
        "encoding": "mapbox",
        "rgbify_base_val": -10000,
        "rgbify_interval_m": 0.1,
        "elevation_unit_encoded": "meter",
        "content_hash": content_hash,
        "min_zoom": min_zoom,
        "max_zoom": max_zoom,
        "tile_format": "png",
        "tile_url_template": f"{GCS_BASE}/terrain-rgb.{content_hash}/{{z}}/{{x}}/{{y}}.png",
        "tile_count": tile_count,
        "baked_at": datetime.now(timezone.utc).isoformat(),
        "gdalinfo_rgb_size": gi.get("size"),
    }
    out_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    return metadata


def emit_wire_constants(content_hash: str, wire_path: Path) -> None:
    lines = [
        f"TERRAIN_RGB_URL={GCS_BASE}/terrain-rgb.{content_hash}/{{z}}/{{x}}/{{y}}.png",
        "TERRAIN_RGB_ENCODING=mapbox",
        f"TERRAIN_RGB_HASH={content_hash}",
    ]
    wire_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="Bake Mapbox terrain-RGB tiles from staged DTM")
    parser.add_argument("--dem", required=True, help="Staged terrain-dem.<hash>.tif from T-008")
    parser.add_argument(
        "--metadata", required=True, help="terrain-dem.<hash>.metadata.json sidecar"
    )
    parser.add_argument("--out-dir", default="./.terrain-bake", help="Working/output directory")
    parser.add_argument("--min-zoom", type=int, default=0)
    parser.add_argument("--max-zoom", type=int, default=16)
    parser.add_argument("--processes", type=int, default=4, help="gdal2tiles worker processes")
    parser.add_argument("--rgbify-workers", type=int, default=4)
    parser.add_argument(
        "--force", action="store_true", help="Rebuild warp/rgbify/tiles even when cached"
    )
    parser.add_argument(
        "--skip-tiles", action="store_true", help="Stop after rgbify (debug warp/encode only)"
    )
    parser.add_argument(
        "--keep-intermediates",
        action="store_true",
        help="Keep terrain-rgb.warp3857.tif after rgbify (default: delete)",
    )
    args = parser.parse_args()

    dem_path = Path(args.dem).resolve()
    meta_path = Path(args.metadata).resolve()
    work_dir = Path(args.out_dir).resolve()
    work_dir.mkdir(parents=True, exist_ok=True)

    if not dem_path.exists():
        fail(f"DEM not found: {dem_path}")

    dem_meta = load_dem_metadata(meta_path)
    v_factor = vertical_unit_to_meters_factor(dem_meta["vertical_unit"])
    log(
        f"input: {dem_path.name} | {dem_meta['horizontal_crs']} | "
        f"{dem_meta['vertical_datum']} | {dem_meta['vertical_unit']} -> meters x{v_factor:.10f}"
    )

    warped = work_dir / "terrain-rgb.warp3857.tif"
    rgb_tif = work_dir / "terrain-rgb.rgb.tif"

    warp_to_3857(dem_path, warped, work_dir, force=args.force)
    run_rgbify(
        warped,
        rgb_tif,
        scale_factor=v_factor,
        workers=args.rgbify_workers,
        force=args.force,
    )
    if not args.keep_intermediates and warped.exists():
        warped.unlink()
        log(f"removed intermediate: {warped.name}")

    content_hash = bake_content_hash(rgb_tif, args.min_zoom, args.max_zoom)
    tile_dir = work_dir / f"terrain-rgb.{content_hash}"
    meta_out = work_dir / f"terrain-rgb.{content_hash}.metadata.json"
    wire_out = work_dir / f"terrain-rgb.{content_hash}.wire.env"

    if args.skip_tiles:
        log(f"--skip-tiles: rgb GeoTIFF ready at {rgb_tif}")
        log(f"provisional hash: {content_hash}")
        return

    run_gdal2tiles(
        rgb_tif,
        tile_dir,
        work_dir,
        min_zoom=args.min_zoom,
        max_zoom=args.max_zoom,
        processes=args.processes,
        force=args.force,
    )

    tile_count = count_tiles(tile_dir)
    if tile_count == 0:
        fail(f"no PNG tiles produced under {tile_dir}")

    metadata = write_bake_metadata(
        meta_out,
        dem_meta=dem_meta,
        dem_path=dem_path,
        rgb_tif=rgb_tif,
        tile_dir=tile_dir,
        content_hash=content_hash,
        min_zoom=args.min_zoom,
        max_zoom=args.max_zoom,
        tile_count=tile_count,
    )
    emit_wire_constants(content_hash, wire_out)

    bbox = dem_meta.get("aoi_bbox_wgs84") or {}
    lat = (bbox.get("south", 30.11) + bbox.get("north", 30.11)) / 2
    lon = (bbox.get("west", -97.32) + bbox.get("east", -97.32)) / 2
    sample = sample_tile_xyz(tile_dir, lat, lon, min(15, args.max_zoom))

    log("---- bake summary ----")
    log(f"tile_dir:  {tile_dir} ({tile_count} PNGs)")
    log(f"metadata:  {meta_out}")
    log(f"wire:      {wire_out}")
    log(f"hash:      {content_hash}")
    log(f"encoding:  mapbox | zoom {args.min_zoom}-{args.max_zoom}")
    if sample:
        z, x, y = sample
        log(f"sample_tile (z{z}): {GCS_BASE}/terrain-rgb.{content_hash}/{z}/{x}/{y}.png")
        log(f"local_tile: {tile_dir / str(z) / str(x) / f'{y}.png'}")
    log("publish (planner-owned, after merge coordination):")
    log(
        f"  gcloud storage rsync -r {tile_dir} "
        f"gs://{GCS_BUCKET}/terrain-rgb.{content_hash}/ "
        f'--cache-control="public, max-age=31536000, immutable" '
        f"--project=legacy-design-tools-prod"
    )
    log(
        f"  gcloud storage cp {meta_out} "
        f"gs://{GCS_BUCKET}/terrain-rgb.{content_hash}.metadata.json "
        f'--cache-control="public, max-age=31536000, immutable" '
        f"--project=legacy-design-tools-prod"
    )
    log(f"vertical_datum preserved: {metadata['vertical_datum']} ({metadata['vertical_unit']})")


if __name__ == "__main__":
    main()
