import { describe, expect, it } from "vitest";
import {
  absenceClassificationForEntityType,
  classificationFieldsForFactSource,
  enrichFacetsResponseWithRegistry,
  getClassification,
  getClassifications,
  withServeClassification,
} from "./index";

describe("instrument-registry", () => {
  it("loads active registry with 21 keys", () => {
    expect(Object.keys(getClassifications())).toHaveLength(21);
  });

  it("maps land-use-fact source to landuse serveLayer", () => {
    const fields = classificationFieldsForFactSource("land-use-fact");
    expect(fields).toMatchObject({
      entityType: "land-use-fact",
      provenanceClass: "Record",
      serveLayer: "landuse",
      chainAnchoring: "backfill",
      subjectKind: "extensional",
    });
  });

  it("handles road-node provenanceClassSplit", () => {
    const osm = getClassification("road-node", "osm-assumed");
    expect(osm?.provenanceClass).toBe("Derivation");
    const county = getClassification("road-node", "county-authoritative");
    expect(county?.provenanceClass).toBe("Record");
  });

  it("defaults road-node split to osm-assumed when adapter unknown", () => {
    expect(getClassification("road-node")?.provenanceClass).toBe("Derivation");
  });

  it("withServeClassification attaches fields on fact objects", () => {
    const enriched = withServeClassification(
      { state: "present", source: "rrc-pipeline-fact" },
      "rrc-pipeline-fact",
    );
    expect(enriched).toMatchObject({
      provenanceClass: "Derivation",
      serveLayer: "rrc-pipelines",
      subjectKind: "intensional",
    });
  });

  it("enrichFacetsResponseWithRegistry decorates root siblings", () => {
    const out = enrichFacetsResponseWithRegistry({
      parcelNodeId: "48021:34137",
      pipelineFact: { state: "present", source: "rrc-pipeline-fact" },
      landUseFact: { state: "present", source: "land-use-fact" },
    });
    expect(out.pipelineFact).toMatchObject({
      provenanceClass: "Derivation",
      serveLayer: "rrc-pipelines",
    });
    expect(out.landUseFact).toMatchObject({
      provenanceClass: "Record",
      serveLayer: "landuse",
    });
  });

  it("absenceClassificationForEntityType returns zoning-fact Record", () => {
    expect(absenceClassificationForEntityType("zoning-fact")).toMatchObject({
      provenanceClass: "Record",
      serveLayer: "zoning",
    });
  });
});
