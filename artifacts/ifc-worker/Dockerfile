# IFC-authoring worker — Cloud Run sidecar with ifcopenshell (Layer 2).
FROM python:3.11-slim

WORKDIR /app

# ifcopenshell's manylinux wheel bundles the native IfcOpenShell library,
# but the shared object links against libgomp (OpenMP) and the usual C++
# runtime; python:3.11-slim ships neither libgomp1 nor a full libstdc++
# by default. Install the runtime libs the wheel dlopen's at import time.
# (No compiler toolchain is needed — the wheel is prebuilt — so this stays
# lighter than the hydrology worker's gdal/gcc layer.)
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libgomp1 \
      libstdc++6 \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Fail the build if the native lib cannot import (catches a missing system
# lib now instead of at first request).
RUN python3 -c "import ifcopenshell; print('ifcopenshell', ifcopenshell.version)"

COPY run.py .

ENV HAUSKA_IFC_WORKER_INSTALLED=1

CMD ["python3", "run.py"]
