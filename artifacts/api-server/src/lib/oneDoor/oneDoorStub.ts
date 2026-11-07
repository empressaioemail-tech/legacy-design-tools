/**
 * ONE DOOR `on` mode at STUB depth (`_design/2026-10-15_burnet_publish_without_bake.md`
 * item 4): screens, saved properties, `find_nearest_parcels` rows and the
 * MCP's multi-hit `find_parcel` map wiring all read the stub, and the stub
 * used to require a baked snapshot. In `on` every stub rail is the reader's
 * state for the same primary rail the node brief's section uses
 * (`ONE_DOOR_BRIEF_SECTIONS`), so the two depths cannot disagree.
 *
 * No bake, no atoms, no LDT slate. A rail the reader did not return is
 * `unread` (not read), never a guessed state.
 */

import type { OneDoorRecord } from "./oneDoorReaderClient";
import { dispositionForOneDoorState } from "./oneDoorSurfaces";
import { SMARTSITE_PARCEL_URL_PREFIX } from "../parcelDrawStub";
import { composeSitusLabel } from "../situsCompose";
import type { SmartSiteRailState, SmartSiteStub } from "../smartSiteStub";

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** The reader's state for one rail, on the stub's five-state vocabulary. */
export function oneDoorRailState(record: OneDoorRecord, rail: string): SmartSiteRailState {
  const fact = record.facts[rail];
  if (!fact) return "unread";
  return dispositionForOneDoorState(fact.state) as SmartSiteRailState;
}

function valueOf(record: OneDoorRecord, rail: string): string | null {
  const fact = record.facts[rail];
  return fact && fact.state === "value" ? str(fact.value) : null;
}

/** Stub rail -> the reader rail the node brief's section shows for it. */
const STUB_PRIMARY_RAIL = {
  zoning: "zoningDistrict",
  landUse: "landUseCode",
  flood: "flood",
  drainage: "drainage",
  envelope: "setbackFrontFt",
} as const;

export function composeOneDoorSmartSiteStub(
  parcelNodeId: string,
  record: OneDoorRecord,
): SmartSiteStub {
  const street = valueOf(record, "situsAddress");
  const situsFact = record.facts.situsAddress;
  const composed = composeSitusLabel({
    parcelNodeId,
    composed: street,
    parts: [street],
    components: {
      city: valueOf(record, "situsCity"),
      state: valueOf(record, "situsState"),
      zip: valueOf(record, "situsZip"),
    },
  });
  const situs: SmartSiteRailState = street
    ? composed.situs
    : situsFact
      ? oneDoorRailState(record, "situsAddress")
      : "unread";
  return {
    parcelNodeId,
    label: street ? composed.label : parcelNodeId,
    url: `${SMARTSITE_PARCEL_URL_PREFIX}${parcelNodeId}`,
    situs,
    zoning: oneDoorRailState(record, STUB_PRIMARY_RAIL.zoning),
    landUse: oneDoorRailState(record, STUB_PRIMARY_RAIL.landUse),
    flood: oneDoorRailState(record, STUB_PRIMARY_RAIL.flood),
    drainage: oneDoorRailState(record, STUB_PRIMARY_RAIL.drainage),
    envelope: oneDoorRailState(record, STUB_PRIMARY_RAIL.envelope),
  };
}

/**
 * The reader's acreage for a nearest-parcel row. The value is a number of
 * acres (or `{ value }`); anything else is not a number this row prints.
 */
export function oneDoorAcreage(record: OneDoorRecord): {
  acres: number | null;
  state: SmartSiteRailState;
} {
  const fact = record.facts.acreageAcres;
  if (!fact) return { acres: null, state: "unread" };
  if (fact.state !== "value") return { acres: null, state: oneDoorRailState(record, "acreageAcres") };
  const raw =
    typeof fact.value === "number"
      ? fact.value
      : fact.value && typeof fact.value === "object" && !Array.isArray(fact.value)
        ? (fact.value as Record<string, unknown>).value
        : fact.value;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() ? Number(raw) : NaN;
  return Number.isFinite(n) ? { acres: n, state: "present" } : { acres: null, state: "unknown" };
}
