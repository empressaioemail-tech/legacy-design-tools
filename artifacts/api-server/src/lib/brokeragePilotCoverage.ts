import {
  JURISDICTIONS,
  listPilotJurisdictionManifest,
  countAtomsForJurisdiction,
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
  }>;
  notes: string[];
}> {
  const manifest = listPilotJurisdictionManifest();
  const jurisdictions: Array<{
    key: string;
    displayName: string;
    tier: string;
    atomCount: number | null;
  }> = [];

  for (const row of manifest) {
    let atomCount: number | null = null;
    if (JURISDICTIONS[row.key]) {
      try {
        atomCount = await countAtomsForJurisdiction(row.key);
      } catch {
        atomCount = null;
      }
    }
    jurisdictions.push({
      key: row.key,
      displayName: row.displayName,
      tier: row.tier,
      atomCount,
    });
  }

  return {
    pilot: "central-texas-v1",
    generatedAt: new Date().toISOString(),
    layers: {
      regrid: "premium",
      fema: "national",
      icc: "pending_credentials",
      partnerGis: "generate-layers-only",
    },
    jurisdictions,
    notes: [
      "tier neon = code_atoms warmed in this database",
      "tier engine_only = substrate corpus exists; brief retrieval empty until warmup",
      "dallas city UDC blocked (AmLegal partnership); suburbs may resolve via geocode",
    ],
  };
}
