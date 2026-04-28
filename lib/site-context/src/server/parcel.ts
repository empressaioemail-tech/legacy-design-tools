import type { Parcel } from "../types";

// TODO Wave 1.3+: integrate Regrid or county GIS APIs for parcel boundaries
// and zoning lookups. For now this is a stub so consuming code can wire the
// import without behavior.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function lookupParcel(
  _lat: number,
  _lng: number,
): Promise<Parcel | null> {
  return null;
}
