"""Shared GDAL native/Docker runner for terrain tile pipeline scripts."""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path

GDAL_DOCKER_IMAGE_ALPINE = "ghcr.io/osgeo/gdal:alpine-small-latest"
GDAL_DOCKER_IMAGE_FULL = "ghcr.io/osgeo/gdal:ubuntu-full-latest"


def gdal_on_path() -> bool:
    return shutil.which("gdalwarp") is not None


def to_docker_path(p: Path) -> str:
    """Windows path -> Docker Desktop mount form."""
    s = str(p.resolve())
    win = re.match(r"^([A-Za-z]):[\\/](.*)$", s)
    if win:
        return f"/{win.group(1).lower()}/{win.group(2).replace(chr(92), '/')}"
    return s.replace(chr(92), "/")


def dockerize_args(args: list[str], work_dir: Path) -> list[str]:
    docker_args: list[str] = []
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
    return docker_args


def run_gdal(
    args: list[str],
    work_dir: Path,
    *,
    docker_image: str = GDAL_DOCKER_IMAGE_ALPINE,
    log_prefix: str = "gdal",
) -> None:
    if gdal_on_path():
        print(f"[{log_prefix}] gdal {' '.join(args[:4])}{'...' if len(args) > 4 else ''}", flush=True)
        subprocess.run(args, cwd=work_dir, check=True)
        return
    docker = shutil.which("docker")
    if not docker:
        raise RuntimeError("GDAL not on PATH and Docker unavailable")
    mount = f"{to_docker_path(work_dir)}:/data"
    docker_args = dockerize_args(args, work_dir)
    cmd = [docker, "run", "--rm", "-v", mount, docker_image, *docker_args]
    print(f"[{log_prefix}] docker {docker_args[0]} ... ({len(docker_args)} args)", flush=True)
    try:
        subprocess.run(cmd, check=True)
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(
            f"GDAL docker command failed (exit {exc.returncode}): {' '.join(cmd)}"
        ) from exc


def gdalinfo_json(
    tif_path: Path,
    work_dir: Path,
    *,
    docker_image: str = GDAL_DOCKER_IMAGE_ALPINE,
) -> dict:
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
            docker_image,
            "gdalinfo",
            "-json",
            f"/data/{rel}",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    return json.loads(result.stdout)


def content_hash12(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.digest().hex()[:12]


def bake_content_hash(rgb_tif: Path, min_zoom: int, max_zoom: int) -> str:
    """Hash rgbified GeoTIFF + zoom range for terrain-rgb.<hash12>/ directory name."""
    h = hashlib.sha256()
    h.update(f"mapbox|{min_zoom}|{max_zoom}".encode())
    with rgb_tif.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.digest().hex()[:12]
