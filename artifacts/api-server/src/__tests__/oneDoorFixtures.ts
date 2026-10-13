/**
 * ONE DOOR test fixtures, shaped per `_design/2026-10-13_one_door_build_spec.md`
 * §2 (the reader contract WP-R publishes). Synthetic values only.
 */

import type { OneDoorMode, OneDoorState } from "../lib/oneDoor/oneDoorReaderClient";

export const OD_PARCEL = "48209:49502";

/** §2's default words per state. */
export const OD_WORDS: Record<OneDoorState, string> = {
  value: "",
  "not-on-record": "Not on the county record",
  "not-applicable": "Unincorporated — the county does not zone",
  "not-loaded": "Not available for this county yet",
  held: "Held while we verify this source",
  "plan-gated": "Included in Studio",
  failed: "Couldn't load this just now — retry",
};

const SOURCE = { adapter: "cad_property", vintage: "2026-09-20", asOf: "2026-09-20" };

export function odValue(value: unknown, source = SOURCE): Record<string, unknown> {
  return { state: "value", value, words: "", source };
}

export function odState(state: Exclude<OneDoorState, "value">, words = OD_WORDS[state]): Record<string, unknown> {
  return { state, words, source: SOURCE };
}

/** A full reader body for one parcel. */
export function odReaderBody(
  mode: OneDoorMode,
  facts: Record<string, unknown> = odDefaultFacts(),
): Record<string, unknown> {
  return {
    parcelNodeId: OD_PARCEL,
    countyFips: "48209",
    mode,
    readAt: "2026-10-13T12:00:00.000Z",
    facts,
  };
}

export function odDefaultFacts(): Record<string, unknown> {
  return {
    apn: odValue("R-SYNTH-1"),
    situsAddress: odValue("101 SYNTHETIC WAY"),
    situsCity: odValue("SYNTHVILLE"),
    zoningDistrict: odState("not-applicable"),
    landUseCode: odValue("C1"),
    landUseDescription: odState("not-loaded"),
    flood: odValue({ floodZone: "X", inSpecialFloodHazardArea: false }),
    setbackFrontFt: odState("held"),
    owner: odState("plan-gated"),
    marketValue: odState("plan-gated"),
    cityLimits: odState("not-on-record"),
    etjStatus: odState("failed"),
  };
}
