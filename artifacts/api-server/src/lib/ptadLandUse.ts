/**
 * PTAD state-classification code -> human land-use description for the
 * map choropleth.
 *
 * Extracted from `txgioParcelStore.ts` (map 10x rebuild, Wave D3) so the
 * PMTiles bake job can reuse the SAME mapping without dragging in the
 * db-backed store module (`@workspace/db` instantiates a pool and throws
 * on a missing `DATABASE_URL` at import time — an offline bake resolves
 * its DB url lazily, so it must not import that eagerly). This module is
 * intentionally dependency-free; `txgioParcelStore.ts` re-exports it for
 * backward compatibility, so its existing import sites keep working.
 *
 * `cad_property.property_use_code` values are Texas comptroller (PTAD)
 * state classification codes, sometimes CAD-extended with a digit
 * suffix. Mapping derived from the ACTUAL code distribution in the
 * deployment `cad_property` store (queried 2026-07-15; 557,388 coded
 * rows — Travis 453,710 / Bastrop 71,954 / Caldwell 31,724; Hays and
 * Williamson rows carry NULL codes today, see txgioParcelStore header):
 *
 *   A1 321,512 / A4 54,681 / A2 16,366 / A3 3,395 ...  class A —
 *     single-family residential (incl. mobile-home/condo variants)
 *   B2 10,326 / B1 2,223 / B4 1,123, BB..BF locals      class B —
 *     multifamily residential (duplex, apartment)
 *   C1 39,805 / C3 7,646 / C 1,064                      class C —
 *     vacant lots and tracts
 *   D1 9,535 / D2 1,689 / D4 1,087 / D3 235             class D —
 *     qualified open-space / ag land (D2 = improvements on ag land)
 *   E1 13,389 / E2 4,881 / E3 3,846 / E 2,055 / E4 60   class E —
 *     rural land + farm/ranch improvements (E1 = farm/ranch house)
 *   F1 14,921 / F4 2,892 / F5 1,287 / F3 829 / F2 148   class F —
 *     commercial (F2 = industrial)
 *   J1..J6 (~82)                                        utilities
 *   M1 14,143 / M3 8,500                                mobile homes
 *   O1 13,135 / O 2,400                                 residential
 *     inventory (builder lots)
 *   S1 1                                                special inv.
 *   XV 1,744 / EX 277 / EX1..EX9 / XA XG XJ XR XU / X   exempt
 *
 * Descriptions are worded so the client choropleth's keyword matching
 * lands each class in the right color bucket (`gis-map-paint.js`
 * matches "single"/"multi"/"apartment"/"commercial"/"industrial"/
 * "agric"/"farm"/"residential"/... inside `landUseDescription`).
 * Unknown codes get NO description — the raw code still serves, but a
 * category is never guessed.
 */
export function ptadLandUseDescription(rawCode: string): string | null {
  const code = rawCode.trim().toUpperCase();
  if (!code) return null;
  if (code.startsWith("EX") || code.startsWith("X")) {
    return "Exempt property";
  }
  switch (code[0]) {
    case "A":
      return "Single-family residential";
    case "B":
      return "Multifamily residential";
    case "C":
      return "Vacant lot or tract";
    case "D":
      return code.startsWith("D2")
        ? "Improvements on agricultural land"
        : "Agricultural / qualified open-space land";
    case "E":
      return code.startsWith("E1")
        ? "Rural single-family residential (farm/ranch improvement)"
        : "Rural farm or ranch land";
    case "F":
      return code.startsWith("F2")
        ? "Industrial real property"
        : "Commercial real property";
    case "J":
      return "Utility";
    case "M":
      return "Mobile home (residential)";
    case "O":
      return "Residential inventory (builder lots)";
    case "S":
      return "Special inventory";
    default:
      return null;
  }
}
