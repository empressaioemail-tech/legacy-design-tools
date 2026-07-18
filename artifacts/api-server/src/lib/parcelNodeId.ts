/**
 * Canonical parcel node identity (map 10x rebuild, Wave D1).
 *
 * `parcel_node_id = "{county_fips}:{normalizeCadPropId(prop_id)}"`
 *   e.g. "48021:47822"
 *
 * This is the ONE id the browse tile layer (parcels baked into PMTiles
 * from the self-hosted `txgio_parcel` store) and the live-detail layer
 * (fresh county-ArcGIS polygons) both stamp, so feature-state highlight
 * and click-to-resolve can key on the same value regardless of which
 * layer served the feature.
 *
 * Why county-qualified + CAD-normalized:
 *   - County FIPS makes it globally unique across Texas (raw appraisal
 *     prop ids collide across counties).
 *   - `normalizeCadPropId` (leading-zeros-stripped) is the SAME key the
 *     `cad:*` Brief adapters join `cad_property` on, so a parcel's node
 *     id lines up with its appraisal-roll row for free.
 *   - It survives geometry re-ingest, unlike the shapefile
 *     `feature_index`, which is assigned at load time.
 *
 * This module is intentionally dependency-free (no `@workspace/db`) so
 * BOTH api-server emit paths import ONE implementation:
 *   - `brokerageTxParcels.ts`  (live county-ArcGIS provider) is db-free
 *      by design and must stay that way.
 *   - `txgioParcelStore.ts`    (self-hosted store reader) is db-backed.
 *   - the future PMTiles bake job will import the same helper.
 *
 * `cadPropertyLookup.ts` re-exports `normalizeCadPropId` from here for
 * backward compatibility, so its existing import sites keep working.
 */

/**
 * Normalize an appraisal-district prop id to the `cad_property` store's
 * key form: leading zeros stripped from an all-digit id, left untouched
 * otherwise (non-numeric ids are kept verbatim). Mirrors
 * `@workspace/cad-ingest`'s `stripLeadingZeros`.
 */
export function normalizeCadPropId(propId: string): string {
  const t = propId.trim();
  if (!/^\d+$/.test(t)) return t;
  return t.replace(/^0+(?=\d)/, "");
}

/**
 * Build the canonical `parcel_node_id` from a county FIPS and a RAW prop
 * id (each emit path passes the raw id it already has; normalization is
 * applied here so both paths produce identical ids for the same parcel).
 *
 * Honesty: returns `null` when either input is missing/empty (or the
 * county FIPS is not a plausible 5-digit code). A parcel with no prop id
 * cannot be node-identified and must NOT get a fabricated id — callers
 * omit `parcel_node_id` from the feature rather than stamp a guess.
 */
export function parcelNodeId(
  countyFips: string | null | undefined,
  propId: string | null | undefined,
): string | null {
  const fips = (countyFips ?? "").trim();
  const raw = (propId ?? "").trim();
  if (!fips || !raw) return null;
  const normalized = normalizeCadPropId(raw);
  if (!normalized) return null;
  return `${fips}:${normalized}`;
}
