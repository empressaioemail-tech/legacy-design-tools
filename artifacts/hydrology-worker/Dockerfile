# Hydrology worker — Cloud Run sidecar with pysheds (Phase 2D.2/2D.3)
FROM python:3.11-slim

WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      gdal-bin \
      libgdal-dev \
      gcc \
      g++ \
 && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY run.py .

ENV HYDROLOGY_PYSHEDS_INSTALLED=1

CMD ["python3", "run.py"]
