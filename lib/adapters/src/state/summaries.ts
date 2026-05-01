/**
 * Plain-English summary chips for state-tier adapter payloads.
 *
 * Mirrors the pattern in `../federal/summaries.ts`: each adapter that
 * persists a structured payload exposes a small formatter that turns
 * the payload into a one-line chip suitable for inline rendering on
 * the Site Context tab. The shared {@link summarizeStatePayload}
 * dispatcher routes by `layerKind`.
 *
 * State-tier coverage (current pilot set):
 *   - UGRC (Utah):              dem, parcels, address-points
 *   - INSIDE Idaho:             dem, parcels
 *   - TCEQ (Texas):             edwards-aquifer (recharge + contributing)
 *
 * As with the federal formatters:
 *   - every formatter accepts `unknown` and degrades to a "no data"
 *     chip when fields are missing or malformed;
 *   - the dispatcher returns `null` for any layer kind that is not a
 *     state-tier layer (so callers can fall through to the next tier).
 */

import {
  formatAcres,
  isRecord,
  pickFirstNumber,
  pickFirstString,
  pickNumber,
  PARCEL_ACRES_KEYS,
  PARCEL_ID_KEYS,
} from "../_payloadSummaryHelpers";

/** Layer kinds emitted by the state-tier adapters. */
export type StateLayerKind =
  | "ugrc-dem"
  | "ugrc-parcels"
  | "ugrc-address-points"
  | "inside-idaho-dem"
  | "inside-idaho-parcels"
  | "tceq-edwards-aquifer";

/**
 * UGRC / INSIDE Idaho elevation-contour layer summary.
 *
 * Payload shape: `{ kind: "elevation-contours", featureCount, features }`.
 * The DEM layer returns zero contours when the lat/lng falls between
 * mapped intervals; we still emit a row in that case (it's not a "no
 * coverage" verdict — the parcel is still in-state), so the chip needs
 * a sensible empty state.
 *
 * Examples:
 *   - one contour:                     "1 elevation contour nearby"
 *   - many contours:                   "8 elevation contours nearby"
 *   - empty (between mapped contours): "No elevation contours nearby"
 */
export function summarizeElevationContoursPayload(
  payload: unknown,
): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "elevation-contours") return null;
  // Prefer the explicit count field; fall back to the array length so
  // the chip still works if the count gets dropped in transit.
  const count =
    pickNumber(payload["featureCount"]) ??
    (Array.isArray(payload["features"]) ? payload["features"].length : 0);
  if (count <= 0) return "No elevation contours nearby";
  const noun = count === 1 ? "contour" : "contours";
  return `${count} elevation ${noun} nearby`;
}

/**
 * Parcel summary used by both UGRC and INSIDE Idaho parcel adapters.
 *
 * Payload shape: `{ kind: "parcel", parcel: {attributes, geometry} | null, note? }`.
 * The UGRC parcels adapter persists `parcel: null` for points that fall
 * on public land (no parcel polygon). We mirror its `note` semantics
 * so the chip reads consistently with the row's existing note.
 *
 * Examples:
 *   - id + acres:                      "Parcel 01-12345 · 0.42 ac"
 *   - id only:                         "Parcel 01-12345"
 *   - acres only:                      "Parcel · 12.34 ac"
 *   - null (public land):              "No parcel at this point (public land)"
 *   - attributes empty:                "Parcel polygon present"
 */
export function summarizeParcelPayload(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "parcel") return null;
  const parcel = payload["parcel"];
  if (parcel === null || parcel === undefined) {
    return "No parcel at this point (public land)";
  }
  if (!isRecord(parcel)) return "Parcel polygon present";
  const attrs = isRecord(parcel["attributes"]) ? parcel["attributes"] : {};
  const id = pickFirstString(attrs, PARCEL_ID_KEYS);
  const acres = pickFirstNumber(attrs, PARCEL_ACRES_KEYS);
  if (id && acres !== null) return `Parcel ${id} · ${formatAcres(acres)}`;
  if (id) return `Parcel ${id}`;
  if (acres !== null) return `Parcel · ${formatAcres(acres)}`;
  return "Parcel polygon present";
}

/**
 * UGRC address-point summary.
 *
 * Payload shape: `{ kind: "address-point", feature: {attributes, ...} }`.
 * UGRC address points expose the full address under `FullAdd` (their
 * canonical column) but other variants exist; we look at a small
 * ranked list and fall back to a (number + street) reconstruction.
 *
 * Examples:
 *   - full address present:            "Address: 100 Main St"
 *   - only number+street:              "Address: 100 Main St" (reconstructed)
 *   - neither:                         "Address point present"
 */
export function summarizeAddressPointPayload(
  payload: unknown,
): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "address-point") return null;
  const feature = payload["feature"];
  if (!isRecord(feature)) return "Address point present";
  const attrs = isRecord(feature["attributes"]) ? feature["attributes"] : {};
  const fullAddress = pickFirstString(attrs, [
    "FullAdd",
    "FullAddress",
    "FULL_ADDR",
    "FULLADDR",
    "ADDRESS",
    "Address",
    "SiteAddress",
    "SITEADDR",
  ]);
  if (fullAddress) return `Address: ${fullAddress}`;
  const number = pickFirstString(attrs, [
    "AddNum",
    "ADD_NUM",
    "STREET_NUMBER",
    "HouseNumber",
    "HOUSE_NO",
  ]);
  const street = pickFirstString(attrs, [
    "StreetName",
    "STREET",
    "STR_NAME",
    "STNAME",
  ]);
  if (number && street) return `Address: ${number} ${street}`;
  if (street) return `Address: ${street}`;
  return "Address point present";
}

/**
 * TCEQ Edwards Aquifer recharge + contributing zone summary.
 *
 * Payload shape: `{ kind: "edwards-aquifer", inRecharge, inContributing,
 * rechargeZone, contributingZone }`. The two zones overlap in places so
 * a parcel can be in both — we list them in regulatory severity order
 * (recharge first; recharge has the stricter water-quality rules).
 *
 * Examples:
 *   - recharge only:                   "In Edwards Aquifer recharge zone"
 *   - contributing only:               "In Edwards Aquifer contributing zone"
 *   - both:                            "In Edwards Aquifer recharge & contributing zones"
 *   - neither:                         "Outside Edwards Aquifer zones"
 */
export function summarizeEdwardsAquiferPayload(
  payload: unknown,
): string | null {
  if (!isRecord(payload)) return null;
  if (payload["kind"] !== "edwards-aquifer") return null;
  const inRecharge = payload["inRecharge"] === true;
  const inContributing = payload["inContributing"] === true;
  if (inRecharge && inContributing) {
    return "In Edwards Aquifer recharge & contributing zones";
  }
  if (inRecharge) return "In Edwards Aquifer recharge zone";
  if (inContributing) return "In Edwards Aquifer contributing zone";
  return "Outside Edwards Aquifer zones";
}

/**
 * Single-entry-point dispatcher used by the Site Context tab. Routes
 * by `layerKind`; returns `null` for any layer kind that is not a
 * state-tier adapter (callers should fall back to the next tier or
 * to their existing rendering for those rows).
 */
export function summarizeStatePayload(
  layerKind: string,
  payload: unknown,
): string | null {
  switch (layerKind) {
    case "ugrc-dem":
    case "inside-idaho-dem":
      return summarizeElevationContoursPayload(payload);
    case "ugrc-parcels":
    case "inside-idaho-parcels":
      return summarizeParcelPayload(payload);
    case "ugrc-address-points":
      return summarizeAddressPointPayload(payload);
    case "tceq-edwards-aquifer":
      return summarizeEdwardsAquiferPayload(payload);
    default:
      return null;
  }
}

