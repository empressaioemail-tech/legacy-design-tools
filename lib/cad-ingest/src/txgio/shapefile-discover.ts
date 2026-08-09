/**
 * TxGIO shapefile discovery for per-county StratMap archives.
 *
 * HISTORY. Through 2026-08-09 the CLI used `files.find(/\.shp$/i)`, which
 * returns the FIRST shapefile and silently discards every other. Harris
 * County 48201 ships `harris_east` + `harris_west`; the west half (~2× the
 * east by bytes) was extracted and thrown away, leaving a hard western wall
 * at lon ≈ -95.4364 with roughly two-thirds of the county missing. Every
 * count-based gate agreed with the truncated input. Honest-absence doctrine:
 * a discarded shapefile must NEVER be silent.
 *
 * POLICY. Discover ALL `.shp` sidecars. N == 1 proceeds as before. N > 1
 * FAILS CLOSED unless the operator passes `--multi-shp=concat`, which is
 * the explicit decision to concatenate layers under one continuous
 * `feature_index` stream. Silent auto-concat is refused because a second
 * shapefile might be a different feature class, not a geographic half —
 * concatenating the wrong thing is its own defect. Harris is currently the
 * only StratMap multi-shapefile county in Texas; it is east/west halves of
 * the same land-parcels layer and takes the flag.
 */

import { basename } from "node:path";

export interface ResolvedShapefile {
  shpFile: string;
  dbfFile: string;
  prjFile?: string;
}

export type MultiShpMode = "concat";

/**
 * Resolve every `.shp` in `files` to its `.dbf` (required) and `.prj`
 * (optional) siblings. Results are sorted by lowercase shapefile path so
 * `feature_index` assignment is deterministic across runs (Harris:
 * `harris_east` before `harris_west`).
 */
export function discoverAllShapefiles(files: string[]): ResolvedShapefile[] {
  const shpFiles = files
    .filter((f) => /\.shp$/i.test(f))
    .slice()
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

  const resolved: ResolvedShapefile[] = [];
  for (const shpFile of shpFiles) {
    const stem = shpFile.replace(/\.shp$/i, "");
    const dbfFile = files.find(
      (f) => f.toLowerCase() === `${stem.toLowerCase()}.dbf`,
    );
    if (!dbfFile) {
      throw new Error(`no .dbf next to ${basename(shpFile)}`);
    }
    const prjFile = files.find(
      (f) => f.toLowerCase() === `${stem.toLowerCase()}.prj`,
    );
    resolved.push({ shpFile, dbfFile, prjFile });
  }
  return resolved;
}

/**
 * Decide which layers to ingest. Throws with an operator-facing message
 * when the archive has no shapefile, or has more than one without an
 * explicit concat decision. Always returns at least one layer on success.
 */
export function selectShapefileLayers(
  files: string[],
  multiShp: MultiShpMode | undefined,
): { layers: ResolvedShapefile[]; discardedSilent: false } {
  const layers = discoverAllShapefiles(files);
  if (layers.length === 0) {
    throw new Error(
      "no .shp found in the input — expected the TxGIO per-county " +
        "land-parcels zip (shp/ entries) or an extracted shapefile",
    );
  }
  if (layers.length === 1) {
    return { layers, discardedSilent: false };
  }
  const names = layers.map((l) => basename(l.shpFile)).join(", ");
  if (multiShp === "concat") {
    return { layers, discardedSilent: false };
  }
  throw new Error(
    `archive contains ${layers.length} shapefiles (${names}). ` +
      "Refusing to silently load only the first — that truncated Harris " +
      "County 48201 to its east half (~565k of ~1.65M features). Re-run " +
      "with --multi-shp=concat to concatenate all layers under one " +
      "continuous feature_index stream, after confirming they are the " +
      "same feature class (e.g. east/west geographic halves), not a " +
      "different layer mixed into the archive.",
  );
}

/** Default vintage label when multiple shapefile stems are concatenated. */
export function multiShapefileVintage(layers: ResolvedShapefile[]): string {
  return layers
    .map((l) => basename(l.shpFile).replace(/\.shp$/i, "").toLowerCase())
    .join("+");
}
