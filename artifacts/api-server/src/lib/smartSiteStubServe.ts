/**
 * Shared stub-depth assembly for get_smart_site and nearest-parcel reads.
 * One derivation, read at two routes (D2).
 *
 * ONE DOOR (burnet_publish_without_bake item 4): the reader decides the mode
 * per parcel. `on` composes the stub from the reader alone (no snapshot
 * gate, no bake, no atoms); `off` and `shadow` serve today's bake-backed
 * stub unchanged.
 */

import { loadBakedNodeFacetSnapshot } from "../routes/brokerageNodeFacets";
import { loadFloodHazardFactForServe } from "./floodHazardFactServeCutover";
import { loadZoningFactForServe } from "./zoningFactServeCutover";
import { loadSetbacksFactForServe } from "./setbacksFactServeCutover";
import { loadCityLimitsFactForServe } from "./cityLimitsFactServeCutover";
import { loadLandUseFactAtom } from "./landUseFactRead";
import { tryComposeEnvelopeModelForDraw } from "./buildableEnvelope/parcelDrawEnvelopeModel";
import { atomPathPending } from "./parcelDrawFromReads";
import {
  rollSitusCityFromFacets,
  rollSitusCityIsDeclaredAbsent,
  resolveSitusCity,
} from "./situsCompose";
import {
  composeSmartSiteStub,
  type RailReadInput,
  type SmartSiteStub,
} from "./smartSiteStub";
import type { FloodHazardFactRead } from "./floodHazardFactRead";
import {
  oneDoorModeOf,
  readOneDoorRecord,
  transportFailedRecord,
  type OneDoorRecord,
} from "./oneDoor/oneDoorReaderClient";
import { ONE_DOOR_SURFACE_RAILS } from "./oneDoor/oneDoorSurfaces";
import { composeOneDoorSmartSiteStub } from "./oneDoor/oneDoorStub";

function floodReadToRail(flood: FloodHazardFactRead): RailReadInput {
  return {
    attempted: true,
    state: flood.state,
    code: flood.state === "refused" ? flood.code : undefined,
    kind: "flood",
  };
}

/**
 * One stub read through the one-door switch.
 *
 * - `stub` with `record`: composed from the reader (`on`). `record` is the
 *   reader's record, for callers that need another rail (nearest acreage).
 * - `stub` with `record: null`: today's bake-backed stub (`off`/`shadow`).
 * - `miss`: today's no-snapshot miss (`off`/`shadow`).
 * - `parcel-not-found`: the reader's own 404 in `on` (not a bake miss).
 *
 * Stub rails carry no gated fact, so the reader is read with no entitlements.
 */
export type SmartSiteStubRead =
  | { kind: "stub"; stub: SmartSiteStub; record: OneDoorRecord | null }
  | { kind: "miss" }
  | { kind: "parcel-not-found" };

export async function readSmartSiteStub(parcelNodeId: string): Promise<SmartSiteStubRead> {
  const read = await readOneDoorRecord(parcelNodeId, { entitlements: [] });
  if (oneDoorModeOf(read) === "on") {
    if (read.kind === "parcel-not-found") return { kind: "parcel-not-found" };
    const record =
      read.kind === "record"
        ? read.record
        : transportFailedRecord(parcelNodeId, ONE_DOOR_SURFACE_RAILS);
    return { kind: "stub", stub: composeOneDoorSmartSiteStub(parcelNodeId, record), record };
  }
  const stub = await assembleLegacySmartSiteStubBody(parcelNodeId);
  return stub ? { kind: "stub", stub, record: null } : { kind: "miss" };
}

/** The stub, or null on any miss (bake miss in `off`/`shadow`, reader 404 in `on`). */
export async function assembleSmartSiteStubBody(
  parcelNodeId: string,
): Promise<SmartSiteStub | null> {
  const read = await readSmartSiteStub(parcelNodeId);
  return read.kind === "stub" ? read.stub : null;
}

/** Today's bake-backed stub (`off` / `shadow`). */
async function assembleLegacySmartSiteStubBody(
  parcelNodeId: string,
): Promise<SmartSiteStub | null> {
  const snapshot = await loadBakedNodeFacetSnapshot(parcelNodeId);
  if (!snapshot) return null;
  const needsCityLimits = rollSitusCityIsDeclaredAbsent(
    rollSitusCityFromFacets(snapshot.facets),
  );
  const [
    floodHazardFact,
    parcelRecordZoningFact,
    parcelRecordSetbacksFact,
    cityLimitsFact,
    landUseFact,
  ] = await Promise.all([
    loadFloodHazardFactForServe(parcelNodeId),
    loadZoningFactForServe(parcelNodeId),
    loadSetbacksFactForServe(parcelNodeId),
    needsCityLimits
      ? loadCityLimitsFactForServe(parcelNodeId, snapshot.queryPoint ?? null)
      : Promise.resolve(null),
    loadLandUseFactAtom(parcelNodeId),
  ]);

  const envelopeOutcome = atomPathPending(snapshot.envelopeBriefRefusal)
    ? await tryComposeEnvelopeModelForDraw({
        parcelNodeId,
        jurisdictionCity: resolveSitusCity({
          rollSitusCity: rollSitusCityFromFacets(snapshot.facets),
          cityLimits: cityLimitsFact,
        }).city,
        jurisdictionState: null,
        queryPoint: snapshot.queryPoint ?? null,
      })
    : null;

  return composeSmartSiteStub({
    parcelNodeId,
    facets: snapshot.facets,
    flood: floodReadToRail(floodHazardFact),
    drainage: { attempted: false },
    envelopeBriefRefusal: snapshot.envelopeBriefRefusal,
    parcelRecordZoningFact,
    parcelRecordSetbacksFact,
    cityLimitsFact,
    landUseFact,
    envelopeOutcome,
  });
}
