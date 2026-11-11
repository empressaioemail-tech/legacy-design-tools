/**
 * Provenance sidecar for the parcels PMTiles bake.
 *
 * Pure builder: no I/O, no clock, no git. The bake CLI supplies every input
 * (full sha256, writtenAt, git SHA, argv, per-county counts). The shape
 * mirrors hauska-map apps/property-explorer/public/tiles.json
 * (hash, sourceLayer, promoteId, counties, featured, writtenAt) plus the
 * provenance fields that file lacks (sha256, file, bake).
 *
 * `droppedByTileBuilder` is deliberately NOT emitted: tippecanoe does not
 * report which feature ids it dropped, so the bake cannot know it.
 */

export interface ParcelsPmtilesManifestCounty {
  fips: string;
  features: number;
}

export interface ParcelsPmtilesManifestInput {
  /** Full lowercase hex sha256 of the .pmtiles file. */
  sha256: string;
  /** ISO-8601 timestamp the bake finished. */
  writtenAt: string;
  sourceLayer: string;
  /** Git SHA of the bake checkout, or null when unavailable. */
  gitSha: string | null;
  /** process.argv.slice(2) of the bake run. */
  argv: readonly string[];
  /** Per-county feature counts; null when the bake did not export (--geojson). */
  perCounty: readonly ParcelsPmtilesManifestCounty[] | null;
}

export interface ParcelsPmtilesManifest {
  hash: string;
  sha256: string;
  file: string;
  sourceLayer: string;
  promoteId: "parcel_node_id";
  writtenAt: string;
  /** Sorted FIPS list; omitted when counties are unknown (--geojson bake). */
  counties?: string[];
  /** FIPS -> feature count (tiles.json calls this `featured`). */
  featured?: Record<string, number>;
  bake: { gitSha: string | null; argv: string[] };
}

export function parcelsPmtilesManifestName(hash: string): string {
  return `parcels.${hash}.manifest.json`;
}

export function buildParcelsPmtilesManifest(
  input: ParcelsPmtilesManifestInput,
): ParcelsPmtilesManifest {
  const sha256 = input.sha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error("sha256 must be 64 hex characters");
  }
  const hash = sha256.slice(0, 12);
  const out: ParcelsPmtilesManifest = {
    hash,
    sha256,
    file: `parcels.${hash}.pmtiles`,
    sourceLayer: input.sourceLayer,
    promoteId: "parcel_node_id",
    writtenAt: input.writtenAt,
    bake: { gitSha: input.gitSha, argv: [...input.argv] },
  };
  if (input.perCounty) {
    const featured: Record<string, number> = {};
    const sorted = [...input.perCounty].sort((a, b) =>
      a.fips < b.fips ? -1 : a.fips > b.fips ? 1 : 0,
    );
    for (const c of sorted) {
      featured[c.fips] = (featured[c.fips] ?? 0) + c.features;
    }
    out.counties = Object.keys(featured);
    out.featured = featured;
  }
  return out;
}
