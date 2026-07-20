/**
 * Land-use join key normalizer for the parcels PMTiles bake (Wave D3).
 *
 * The bake joins a TxGIO parcel's `prop_id` to its `cad_property` row on
 * `(county_fips, normalizeForJoin(prop_id))`. The `cad_property` side is
 * keyed by the CAD-normalized prop id the ingest parsers wrote:
 * `stripLeadingZeros(propertyid)` (see lib/cad-ingest/src/normalize.ts and
 * the `normalizeCadPropId` mirror in ./parcelNodeId), i.e. a bare-numeric,
 * leading-zeros-stripped id ("000010001" -> "10001", "9").
 *
 * The mismatch this module exists to close: the TxGIO GIS layer encodes
 * some counties' prop ids in the appraisal-district "R-account" form
 * ("R000009"), while the CAD appraisal roll for the SAME parcel stores the
 * bare numeric ("9"). Williamson (48491) is the live case — its TxGIO
 * prop_ids are R-format, its cad_property prop_ids are bare numeric — so
 * without stripping the leading "R" every Williamson parcel failed the
 * join and baked geometry-only despite a fully loaded roll.
 *
 * So this normalizer strips a leading "R" (any case) that directly precedes
 * a digit, THEN strips leading zeros, producing the bare-numeric form the
 * cad_property key was stored in. Non-numeric junk values that survive the
 * strip (e.g. "PRIVATE ROAD") are returned as-is and remain non-matching,
 * which is correct — those are not parcels and have no appraisal row.
 *
 * Dependency-free by design (no @workspace/db), mirroring parcelNodeId.ts
 * and ptadLandUse.ts, so the offline bake and its unit test can import it
 * without dragging a DB connection into module load.
 */

/**
 * Normalize a TxGIO `prop_id` to the STORED `cad_property` join key form.
 *
 * "R000009" -> "9", "R123" -> "123", "000123" -> "123", "10001" -> "10001".
 * A value with no digits after the strip (e.g. "PRIVATE ROAD") is returned
 * unchanged and will not collide with any numeric cad key.
 */
export function normalizeForJoin(propId: string): string {
  const t = propId.trim();
  // R-account form ("R000009") -> strip the leading R (any case) that sits
  // directly in front of a digit, before the numeric leading-zero strip.
  // The (?=\d) lookahead means a bare "R" or "ROAD" is left untouched.
  const stripped = t.replace(/^[Rr](?=\d)/, "");
  // Non-numeric after strip (junk like "PRIVATE ROAD") stays as-is and
  // never matches a bare-numeric cad key.
  if (!/^\d+$/.test(stripped)) return stripped;
  return stripped.replace(/^0+(?=\d)/, "");
}
