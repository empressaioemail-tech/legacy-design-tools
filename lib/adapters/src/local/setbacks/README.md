# Per-jurisdiction setback tables

Hand-curated JSON tables (locked decision #9 / DA-PI-4) populated from
publicly available ordinances. One file per jurisdiction; one row per
zoning district.

## Schema

```json
{
  "district_name": "string",
  "front_ft": "number",
  "rear_ft": "number",
  "side_ft": "number",
  "side_corner_ft": "number",
  "max_height_ft": "number",
  "max_lot_coverage_pct": "number",
  "max_impervious_pct": "number",
  "citation_url": "string"
}
```

## Why hand-curated rather than scraped from the GIS layer?

The GIS layer carries the polygon and the district code, but the
dimensional rules live in the ordinance text — typically a PDF that
isn't reliably structured. Code-ontology ingestion (zoning ordinances
→ `code-section` atoms) is explicitly out of scope for this sprint per
Spec 51 OQ-1, so the table is the bridge between the polygon and the
prose-only ordinance until the A05 code-atom pipeline ships.

## Adding a jurisdiction

1. Drop a `<jurisdiction-key>.json` file here (use the same slug the
   adapter writes to `briefing_sources.provider`).
2. Append the import + record entry in `index.ts`.
3. Adjust the test asserting completeness in `__tests__/`.
