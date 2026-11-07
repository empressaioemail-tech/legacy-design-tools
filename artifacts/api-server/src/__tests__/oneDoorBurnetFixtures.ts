/**
 * ONE DOOR Burnet 48053 fixtures: a county with NO baked snapshot and NO
 * boundary-edge atoms, served `on` by the reader with `facts.parcelGeometry`
 * (`_design/2026-10-15_burnet_publish_without_bake.md` §2, engine contract
 * `{ geometry, placementPoint: { lng, lat }, partCount, areaSqM }`).
 *
 * Synthetic values only: the node id, address and shape are invented; the
 * coordinates sit in Marble Falls so the Texas-envelope guard is exercised
 * with a realistic point.
 */

import type { OneDoorMode } from "../lib/oneDoor/oneDoorReaderClient";
import { odState, odValue } from "./oneDoorFixtures";

export const BURNET_PARCEL = "48053:990001";
export const BURNET_POINT = { lng: -98.2897, lat: 30.5851 };

/** A ~30 m x 40 m rectangle around BURNET_POINT, wound CLOCKWISE (the consumer must re-wind it). */
export const BURNET_POLYGON = {
  type: "Polygon",
  coordinates: [
    [
      [-98.2899, 30.5853],
      [-98.2895, 30.5853],
      [-98.2895, 30.5849],
      [-98.2899, 30.5849],
      [-98.2899, 30.5853],
    ],
  ],
};

export function burnetGeometryValue(geometry: unknown = BURNET_POLYGON): Record<string, unknown> {
  return { geometry, placementPoint: { ...BURNET_POINT }, partCount: 1, areaSqM: 1720 };
}

export function burnetFacts(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apn: odValue("SYN-990001"),
    situsAddress: odValue("100 SYNTHETIC ST"),
    situsCity: odValue("MARBLE FALLS"),
    situsState: odValue("TX"),
    zoningDistrict: odValue("R-1"),
    landUseCode: odValue("A1"),
    flood: odValue([{ zone: "X", subtype: null, isSfha: false }]),
    setbackFrontFt: odValue(25),
    acreageAcres: odValue(0.43),
    owner: odState("plan-gated"),
    parcelGeometry: odValue(burnetGeometryValue()),
    ...overrides,
  };
}

export function burnetReaderBody(
  mode: OneDoorMode,
  facts: Record<string, unknown> = burnetFacts(),
  parcelNodeId = BURNET_PARCEL,
): Record<string, unknown> {
  return {
    parcelNodeId,
    countyFips: "48053",
    contract: "one-door-v1",
    mode,
    readAt: "2026-10-15T12:00:00.000Z",
    facts,
  };
}
