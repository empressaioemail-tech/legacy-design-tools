#!/usr/bin/env bash
set -euo pipefail

OVERPASS_URL="${OVERPASS_URL:-http://127.0.0.1:8080/api/interpreter}"
# Downtown Austin: this is deliberately the same highway-way query shape used
# by buildableEnvelope/roads.ts, but at a known road-dense coordinate.
QUERY='[out:json][timeout:20];way(around:90,30.2672,-97.7431)[highway];out body geom;'

response="$(
  curl --fail --silent --show-error \
    --data-urlencode "data=${QUERY}" \
    "${OVERPASS_URL}"
)"
ways="$(jq '[.elements[] | select(.type == "way" and (.tags.highway? != null) and ((.geometry | length) >= 2))] | length' <<<"${response}")"

if [[ "${ways}" -lt 1 ]]; then
  echo "Overpass answered, but returned no highway ways for the Austin smoke query." >&2
  exit 1
fi

echo "PASS: ${ways} highway ways returned by ${OVERPASS_URL}"
