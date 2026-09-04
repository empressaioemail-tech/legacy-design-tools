import { describe, expect, it } from "vitest";
import { enrichFacetsResponseWithRegistry } from "@workspace/instrument-registry";

describe("serve registry on facets response", () => {
  it("attaches classification metadata on pipeline and landUse facts", () => {
    const body = enrichFacetsResponseWithRegistry({
      parcelNodeId: "48021:34137",
      pipelineFact: {
        state: "present",
        source: "rrc-pipeline-fact",
        pipelineCount: 1,
      },
      landUseFact: {
        state: "present",
        source: "land-use-fact",
        landUseCode: "A1",
      },
    });
    expect(body.pipelineFact).toMatchObject({
      provenanceClass: "Derivation",
      serveLayer: "rrc-pipelines",
      subjectKind: "intensional",
      chainAnchoring: "backfill",
      entityType: "rrc-pipeline-fact",
    });
    expect(body.landUseFact).toMatchObject({
      provenanceClass: "Record",
      serveLayer: "landuse",
      entityType: "land-use-fact",
    });
  });
});
