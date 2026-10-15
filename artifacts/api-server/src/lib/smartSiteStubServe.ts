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
  lastKnownOneDoorMode,
  oneDoorModeOf,
  readOneDoorRecord,
  transportFailedRecord,
  type OneDoorRead,
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

/**
 * Per-REQUEST mode probe (operator ruling: live `off` counties keep today's
 * cost until Phase 2). One request (a screen, a saved list, a stub array, a
 * nearest list) shares one probe.
 *
 * - A county this process last saw `shadow`/`on` (the one-door client's
 *   per-county mode memory, LDT #820, 10-minute TTL): every row reads the
 *   reader, as `on` composition needs each row's record.
 * - A county last seen `off`, or never seen / expired: AT MOST ONE reader
 *   call for the whole request (the first row of that county). Its answer
 *   decides the rest: `off`/`shadow` rows take the old bake path with no
 *   reader call; if it says `on`, the remaining rows read the reader.
 *
 * Worst case for a flip to `on`: none beyond the reader itself. The memory
 * is never trusted to SKIP the probe -- every request still makes its one
 * call for an `off`/unseen county -- so the first request after the flip
 * sees `on` and serves every row from the reader. A flip back to `off` is
 * also seen on the first request (the per-row reads report `off`).
 */
export type StubModeProbe = { byCounty: Map<string, Promise<OneDoorRead>> };

export function newStubModeProbe(): StubModeProbe {
  return { byCounty: new Map() };
}

function countyOf(parcelNodeId: string): string | null {
  const m = /^(\d{5}):/.exec(parcelNodeId.trim());
  return m ? m[1]! : null;
}

function readStubRecord(parcelNodeId: string): Promise<OneDoorRead> {
  return readOneDoorRecord(parcelNodeId, { entitlements: [] });
}

/** The reader read for this row, or null when the row takes the old path without one. */
async function oneDoorReadForRow(
  parcelNodeId: string,
  probe: StubModeProbe,
): Promise<OneDoorRead | null> {
  const county = countyOf(parcelNodeId);
  const known = county ? lastKnownOneDoorMode(county) : "off";
  if (!county || known !== "off") return readStubRecord(parcelNodeId);
  const pending = probe.byCounty.get(county);
  if (!pending) {
    const first = readStubRecord(parcelNodeId);
    probe.byCounty.set(county, first);
    return first;
  }
  const decided = await pending;
  return oneDoorModeOf(decided) === "on" ? readStubRecord(parcelNodeId) : null;
}

export async function readSmartSiteStub(
  parcelNodeId: string,
  probe: StubModeProbe = newStubModeProbe(),
): Promise<SmartSiteStubRead> {
  const read = await oneDoorReadForRow(parcelNodeId, probe);
  if (read && oneDoorModeOf(read) === "on") {
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
  probe?: StubModeProbe,
): Promise<SmartSiteStub | null> {
  const read = await readSmartSiteStub(parcelNodeId, probe);
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
