/**
 * The `payload.parcel.zoningCode` the buildable-envelope answer serves, and
 * where it came from.
 *
 * WHY. Measured 2026-11-04 on `48021:34105` (902 Chestnut St, Bastrop): the
 * answer declined with the setback cell's own sentence, `district "GC" is on
 * file for this parcel in Bastrop, ...`, while `payload.parcel.zoningCode` in
 * the same answer was null. One answer said the zoning was both empty and on
 * file.
 *
 * The null was not an empty stamp. `txgio_parcel.zoning_district` for 34105
 * holds `GC` (read-only measurement, same date). Bastrop's parcel ring comes
 * from the county's own live ArcGIS layer (`brokerageTxParcels.ts`, Bastrop's
 * `normalizeProps`), and that layer carries no zoning field, so the ring the
 * route reads never has a `zoningCode` on it. The district the answer is about
 * is the parcel record's `zoningDistrict` cell (P-465: the ledger rail is the
 * envelope's one district authority; a GIS stamp is not a setback source).
 *
 * THE RULE. The ring's own stamp is served when it has one. When it has none
 * and the ledger served a district, the ledger district is served and
 * `zoningCodeSource` says so. When neither has one, it stays null. Nothing is
 * ever derived or guessed here.
 */

export type ZoningCodeSource = "parcel-stamp" | "ledger";

export type ParcelZoningCodeWire = {
  zoningCode: string | null;
  zoningCodeSource: ZoningCodeSource | null;
};

function nonBlank(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length > 0 ? t : null;
}

export function parcelZoningCodeWire(
  stamp: string | null | undefined,
  ledgerDistrict: string | null | undefined,
): ParcelZoningCodeWire {
  const fromStamp = nonBlank(stamp);
  if (fromStamp) return { zoningCode: fromStamp, zoningCodeSource: "parcel-stamp" };
  const fromLedger = nonBlank(ledgerDistrict);
  if (fromLedger) return { zoningCode: fromLedger, zoningCodeSource: "ledger" };
  return { zoningCode: null, zoningCodeSource: null };
}
