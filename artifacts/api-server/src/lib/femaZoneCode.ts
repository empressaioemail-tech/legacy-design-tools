/**
 * Exact FEMA flood-zone code classification (no prefix matching).
 *
 * NFHL `FLD_ZONE` is a code OR free text ("AREA NOT INCLUDED", "OPEN WATER").
 * A prefix test ("starts with A") reads "AREA NOT INCLUDED" as a Special
 * Flood Hazard Area. This module matches whole codes only.
 *
 * - true:  A, AE, AH, AO, AR, A99, A1-A30, V, VE, V1-V30
 * - false: B, C, X (a leading "X" token is decisive: "X 0.2 PCT ..." is X)
 * - null:  everything else (D, AREA NOT INCLUDED, OPEN WATER, blank, unknown)
 *
 * Canonical fixture: __tests__/fixtures/fema-zone-sfha-fixture.json
 * (identical copies in hauska-map and hauska-engine).
 */

/** trim, uppercase, collapse internal whitespace. */
export function normalizeFemaZoneCode(zone: string | null | undefined): string {
  return typeof zone === "string" ? zone.trim().toUpperCase().replace(/\s+/g, " ") : "";
}

const SFHA_ZONE_RE = /^(?:A|AE|AH|AO|AR|A99|V|VE|A(?:[1-9]|[12]\d|30)|V(?:[1-9]|[12]\d|30))$/;

/** SFHA status implied by the zone code alone; null = not decisive. */
export function classifyFemaZoneSfha(zone: string | null | undefined): boolean | null {
  const z = normalizeFemaZoneCode(zone);
  if (!z) return null;
  if (SFHA_ZONE_RE.test(z)) return true;
  if (z === "B" || z === "C" || z === "X" || z.startsWith("X ")) return false;
  return null;
}
