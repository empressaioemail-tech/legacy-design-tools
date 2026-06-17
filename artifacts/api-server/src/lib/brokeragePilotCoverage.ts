import {
  JURISDICTIONS,
  listPilotJurisdictionManifest,
  countAtomsForJurisdiction,
  countReasoningAtomsForJurisdiction,
} from "@workspace/codes";

export async function buildBrokeragePilotCoverageBody(): Promise<{
  pilot: string;
  generatedAt: string;
  layers: Record<string, string>;
  jurisdictions: Array<{
    key: string;
    displayName: string;
    tier: string;
    atomCount: number | null;
    reasoningAtomCount: number | null;
  }>;
  notes: string[];
}> {
  const manifest = listPilotJurisdictionManifest();
  const jurisdictions: Array<{
    key: string;
    displayName: string;
    tier: string;
    atomCount: number | null;
    reasoningAtomCount: number | null;
  }> = [];

  for (const row of manifest) {
    let atomCount: number | null = null;
    let reasoningAtomCount: number | null = null;

    try {
      atomCount = await countAtomsForJurisdiction(row.key);
    } catch {
      atomCount = null;
    }

    try {
      reasoningAtomCount = await countReasoningAtomsForJurisdiction(row.key);
    } catch {
      reasoningAtomCount = null;
    }

    let tier = row.tier;
    const warmedInNeon =
      Boolean(JURISDICTIONS[row.key]) ||
      (atomCount ?? 0) > 0 ||
      (reasoningAtomCount ?? 0) > 0;

    if (tier !== "blocked_partnership" && warmedInNeon) {
      tier = "neon";
    }

    jurisdictions.push({
      key: row.key,
      displayName: row.displayName,
      tier,
      atomCount,
      reasoningAtomCount,
    });
  }

  return {
    pilot: "central-texas-v1",
    generatedAt: new Date().toISOString(),
    layers: {
      cotality: "national",
      fema: "national",
      icc: "active",
      partnerGis: "generate-layers-only",
    },
    jurisdictions,
    notes: [
      "tier neon = code_atoms and/or reasoning_atoms warmed in this database",
      "tier engine_only = substrate corpus exists; brief retrieval empty until codewarm",
      "dallas city UDC blocked (AmLegal partnership); suburbs may resolve via geocode",
    ],
  };
}
