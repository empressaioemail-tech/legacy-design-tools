"""Metadata sidecar schema checks for terrain_dem_acquire output."""

from __future__ import annotations

import json
import unittest


REQUIRED_KEYS = {
    "horizontal_crs",
    "vertical_datum",
    "vertical_unit",
    "source",
    "source_url",
    "acquired_at",
    "aoi",
    "content_hash",
}


class TerrainDemMetadataSchemaTest(unittest.TestCase):
    def test_required_keys_documented(self) -> None:
        sample = {
            "horizontal_crs": "EPSG:6343",
            "vertical_datum": "NAVD88",
            "vertical_unit": "US survey foot",
            "source": "TxGIO DataHub / StratMap 2017 Central Texas Lidar",
            "source_url": "https://data.tnris.org/collection/?c=0549d3ba-3f72-4710-b26c-28c65df9c70d",
            "acquired_at": "2026-07-31T00:00:00+00:00",
            "aoi": "bastrop-city-2mi",
            "content_hash": "abc123def456",
        }
        self.assertTrue(REQUIRED_KEYS.issubset(sample.keys()))
        # Round-trip JSON
        json.loads(json.dumps(sample))


if __name__ == "__main__":
    unittest.main()
