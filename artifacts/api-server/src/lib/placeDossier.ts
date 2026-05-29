import {
  retrieveAtomsForQuestion,
  type RetrievedAtom,
} from "@workspace/codes";
import type { BrokerageSiteContext, BrokerageSiteContextLayer } from "./brokerageSiteContext";
import {
  buildBriefAtomProjection,
  buildCodeSectionDid,
  buildPlaceLayerDid,
} from "./brokerageBriefAtoms";
import { BROKERAGE_CODE_QUERIES } from "./brokerageCodeQueries";

const MAX_CODE_INLINE_REFS = 3;

export interface PlaceFieldCitation {
  source: string;
  adapterKey?: string;
  provider?: string;
  asOf: string;
}

export interface PlaceDossierLayer {
  layerKind: string;
  adapterKey: string;
  tier: string;
  status: string;
  provenance: string;
  did: string;
  summary: string | null;
  citation: PlaceFieldCitation;
}

export interface PlaceDossierInlineRef {
  did: string;
  entityType: string;
  entityId: string;
  label: string;
  citation: PlaceFieldCitation;
}

export interface PlaceDossierFederalSummary {
  layerKind: string;
  summary: string | null;
  citation: PlaceFieldCitation;
}

export interface PlaceDossierBody {
  placeKey: string;
  jurisdiction_key: string | null;
  asOf: string;
  layers: PlaceDossierLayer[];
  inlineRefs: PlaceDossierInlineRef[];
  federalSummaries: PlaceDossierFederalSummary[];
  reasoningStub?: string;
}

function layerCitation(layer: BrokerageSiteContextLayer): PlaceFieldCitation {
  const asOf =
    layer.snapshotDate ??
    new Date().toISOString();
  if (layer.fromArchive) {
    return {
      source: "place_layer_snapshot",
      adapterKey: layer.adapterKey,
      provider: layer.provider,
      asOf,
    };
  }
  return {
    source: layer.provider ?? layer.adapterKey,
    adapterKey: layer.adapterKey,
    provider: layer.provider,
    asOf,
  };
}

function atomSnippet(atom: RetrievedAtom): string {
  const title = atom.sectionTitle?.trim();
  const body = atom.body?.trim() ?? "";
  if (title && body) return `${title}: ${body}`;
  return title || body;
}

function atomCitation(atom: RetrievedAtom, query: string): PlaceFieldCitation {
  return {
    source: atom.sourceName ?? "code_atoms",
    asOf: new Date().toISOString(),
    provider: query.slice(0, 48),
  };
}

async function topCodeAtoms(
  jurisdictionKey: string | null,
): Promise<Array<{ atom: RetrievedAtom; query: string }>> {
  if (!jurisdictionKey) return [];
  const out: Array<{ atom: RetrievedAtom; query: string }> = [];
  for (const query of BROKERAGE_CODE_QUERIES.slice(0, MAX_CODE_INLINE_REFS)) {
    const hits = await retrieveAtomsForQuestion({
      jurisdictionKey,
      question: query,
      limit: 1,
    });
    const top = hits[0];
    if (top) out.push({ atom: top, query });
  }
  return out;
}

export async function buildPlaceDossier(input: {
  placeKey: string;
  jurisdiction_key: string | null;
  siteContext: BrokerageSiteContext;
  listingKey: string;
}): Promise<PlaceDossierBody> {
  const asOf = new Date().toISOString();
  const layers: PlaceDossierLayer[] = input.siteContext.layers.map((layer) => ({
    layerKind: layer.layerKind,
    adapterKey: layer.adapterKey,
    tier: layer.tier,
    status: layer.status,
    provenance: layer.fromArchive ? "snapshot" : "live",
    did: buildPlaceLayerDid(layer.layerKind, input.placeKey),
    summary: layer.summary ?? null,
    citation: layerCitation(layer),
  }));

  const federalSummaries: PlaceDossierFederalSummary[] = input.siteContext.layers
    .filter((l) => l.layerKind.startsWith("fema"))
    .map((l) => ({
      layerKind: l.layerKind,
      summary: l.summary ?? null,
      citation: layerCitation(l),
    }));

  const codeHits = await topCodeAtoms(input.jurisdiction_key);
  const citations = codeHits.map((h) => ({
    atomDid: h.atom.id,
    query: h.query,
    snippet: atomSnippet(h.atom).slice(0, 280),
  }));

  const projection = buildBriefAtomProjection({
    listingKey: input.listingKey,
    runId: "place-dossier",
    address: input.listingKey,
    siteContext: input.siteContext,
    citations,
    placeKey: input.placeKey,
  });

  const inlineRefs: PlaceDossierInlineRef[] = projection.inlineRefs
    .slice(0, MAX_CODE_INLINE_REFS + 1)
    .map((ref) => {
      const codeHit = codeHits.find((h) => buildCodeSectionDid(h.atom.id) === ref.did);
      return {
        did: ref.did,
        entityType: ref.entityType,
        entityId: ref.entityId,
        label: ref.label,
        citation: codeHit
          ? atomCitation(codeHit.atom, codeHit.query)
          : {
              source: ref.entityType === "parcel" ? "regrid" : "unknown",
              asOf,
            },
      };
    });

  return {
    placeKey: input.placeKey,
    jurisdiction_key: input.jurisdiction_key,
    asOf,
    layers,
    inlineRefs,
    federalSummaries,
    reasoningStub:
      "Automated place dossier (read-only). Verify with city staff and licensed professionals.",
  };
}
