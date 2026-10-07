/**
 * Shared stub-depth assembly for get_smart_site and nearest-parcel reads.
 * One derivation, read at two routes (D2).
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

function floodReadToRail(flood: FloodHazardFactRead): RailReadInput {
  return {
    attempted: true,
    state: flood.state,
    code: flood.state === "refused" ? flood.code : undefined,
    kind: "flood",
  };
}

export async function assembleSmartSiteStubBody(
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
