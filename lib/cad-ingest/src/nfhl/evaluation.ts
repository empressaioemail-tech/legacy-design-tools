/**
 * Parcel flood-zone evaluation against an in-memory NFHL polygon index.
 *
 * Pure logic (no db, no network): given normalized flood-zone polygons and
 * a parcel geometry, return intersecting FEMA zones with honest absence
 * where the statewide layer does not cover the parcel.
 *
 * Unmapped territory (parcel outside every stored polygon) is returned as
 * `{ status: 'outside-mapped-zones' }` — a finding, not a gap or failure.
 */

import {
  bboxOfGeometry,
  bboxesIntersect,
  pointInGeometry,
  type GeoBbox,
  type GeoJsonGeometry,
} from "../txgio/geo";
import { representativePoint } from "../boundary/containment";
import type { TxFemaNfhlFloodZoneRecord } from "./parse";

export interface NfhlZoneIndexEntry {
  zoneRowId: string;
  dfirmId: string;
  fldArId: string;
  fldZone: string | null;
  zoneSubty: string | null;
  sfhaTf: string | null;
  staticBfe: number | null;
  geometry: GeoJsonGeometry;
  bbox: GeoBbox;
}

export interface ParcelFloodZoneHit {
  zoneRowId: string;
  dfirmId: string;
  fldArId: string;
  fldZone: string | null;
  zoneSubty: string | null;
  inSpecialFloodHazardArea: boolean;
  staticBfe: number | null;
  basis: string;
}

export type ParcelFloodZoneResult =
  | {
      status: "in-zones";
      zones: ParcelFloodZoneHit[];
      basis: string;
    }
  | {
      status: "outside-mapped-zones";
      zones: [];
      basis: string;
    }
  | {
      status: "no-coverage";
      zones: [];
      basis: string;
    };

export function buildNfhlZoneIndex(
  entries: Array<
    Pick<
      TxFemaNfhlFloodZoneRecord,
      | "zoneRowId"
      | "dfirmId"
      | "fldArId"
      | "fldZone"
      | "zoneSubty"
      | "sfhaTf"
      | "staticBfe"
      | "geometry"
      | "bbox"
    >
  >,
): NfhlZoneIndexEntry[] {
  const out: NfhlZoneIndexEntry[] = [];
  for (const e of entries) {
    const bbox = e.bbox ?? bboxOfGeometry(e.geometry);
    if (!bbox) continue;
    out.push({
      zoneRowId: e.zoneRowId,
      dfirmId: e.dfirmId,
      fldArId: e.fldArId,
      fldZone: e.fldZone,
      zoneSubty: e.zoneSubty,
      sfhaTf: e.sfhaTf,
      staticBfe: e.staticBfe,
      geometry: e.geometry,
      bbox,
    });
  }
  return out;
}

function parcelIntersectsZone(
  parcel: GeoJsonGeometry,
  zone: GeoJsonGeometry,
  parcelBbox: GeoBbox,
  zoneBbox: GeoBbox,
): boolean {
  if (!bboxesIntersect(parcelBbox, zoneBbox)) return false;
  const parcelPt = representativePoint(parcel);
  if (parcelPt && pointInGeometry(parcelPt[0], parcelPt[1], zone)) {
    return true;
  }
  const zonePt = representativePoint(zone);
  if (zonePt && pointInGeometry(zonePt[0], zonePt[1], parcel)) {
    return true;
  }
  return false;
}

/** Evaluate flood zones for a parcel geometry against an in-memory index. */
export function resolveParcelFloodZones(
  parcelGeometry: GeoJsonGeometry,
  index: NfhlZoneIndexEntry[],
): ParcelFloodZoneResult {
  if (index.length === 0) {
    return {
      status: "no-coverage",
      zones: [],
      basis:
        "tx_fema_nfhl_flood_zone index is empty — statewide layer not loaded",
    };
  }
  const parcelBbox = bboxOfGeometry(parcelGeometry);
  if (parcelBbox === null) {
    return {
      status: "outside-mapped-zones",
      zones: [],
      basis:
        "parcel geometry yielded no bbox — cannot intersect NFHL polygons",
    };
  }

  const hits: ParcelFloodZoneHit[] = [];
  for (const entry of index) {
    if (!parcelIntersectsZone(parcelGeometry, entry.geometry, parcelBbox, entry.bbox)) {
      continue;
    }
    hits.push({
      zoneRowId: entry.zoneRowId,
      dfirmId: entry.dfirmId,
      fldArId: entry.fldArId,
      fldZone: entry.fldZone,
      zoneSubty: entry.zoneSubty,
      inSpecialFloodHazardArea: entry.sfhaTf === "T",
      staticBfe: entry.staticBfe,
      basis: `intersects tx_fema_nfhl_flood_zone row ${entry.zoneRowId}`,
    });
  }

  if (hits.length === 0) {
    return {
      status: "outside-mapped-zones",
      zones: [],
      basis:
        "parcel does not intersect any tx_fema_nfhl_flood_zone polygon " +
        "(outside mapped FEMA flood zones for Texas — honest absence, not a gap)",
    };
  }

  return {
    status: "in-zones",
    zones: hits,
    basis: `parcel intersects ${hits.length} tx_fema_nfhl_flood_zone polygon(s)`,
  };
}
