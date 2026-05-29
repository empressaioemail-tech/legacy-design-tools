import { describe, it, expect } from "vitest";
import { buildBriefAtomProjection } from "../lib/brokerageBriefAtoms";

describe("buildBriefAtomProjection", () => {
  it("returns workspace and brief-run DIDs with citation inline refs", () => {
    const atoms = buildBriefAtomProjection({
      listingKey: "abc123",
      runId: "550e8400-e29b-41d4-a716-446655440000",
      address: "1 Main St",
      placeKey: "coord:30.11000:-97.32000",
      siteContext: {
        placeKey: "coord:30.11000:-97.32000",
        layers: [
          {
            layerKind: "regrid-parcel",
            adapterKey: "regrid:parcels",
            tier: "federal",
            status: "ok",
            payload: {
              parcel: {
                properties: {
                  fields: { ll_uuid: "parcel-uuid-1", parcelnumb: "R1" },
                },
              },
            },
          },
        ],
      },
      citations: [
        {
          atomDid: "atom-1",
          query: "ADU requirements",
          snippet: "snippet",
        },
      ],
    });

    expect(atoms.workspaceDid).toBe("did:hauska:property-workspace:abc123");
    expect(atoms.briefRunDid).toContain("550e8400-e29b-41d4-a716-446655440000");
    expect(atoms.citationRefs[0]?.citationDid).toContain("code-section");
    expect(atoms.inlineRefs.some((r) => r.entityType === "parcel")).toBe(true);
    expect(atoms.placeLayers).toHaveLength(1);
  });
});
