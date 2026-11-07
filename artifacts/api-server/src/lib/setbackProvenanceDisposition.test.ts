/**
 * F-11 — three setback populations, both directions.
 * A check observed only passing has not been observed working: the
 * road-class fixture must fail if served as value; the placeholder
 * fixture must fail if served as absent-verified.
 */

import { describe, expect, it } from "vitest";
import {
  PLACEHOLDER_SETBACK_PROVENANCE,
  PLACEHOLDER_SETBACK_UNKNOWN_BASIS,
  RETIRED_ROAD_CLASS_SETBACK_BASIS,
  ROAD_CLASS_SETBACK_PROVENANCE,
  serveBoundaryEdgeSetback,
} from "./setbackProvenanceDisposition";

describe("serveBoundaryEdgeSetback — three populations", () => {
  it("serves refused with the retired derivation named when provenance is road-class-setback-table", () => {
    const served = serveBoundaryEdgeSetback({
      feet: 15,
      provenance: ROAD_CLASS_SETBACK_PROVENANCE,
      atomCitation: "bastrop_tx",
    });
    expect(served.state).toBe("refused");
    expect(served.basis).toBe(RETIRED_ROAD_CLASS_SETBACK_BASIS);
    expect(served.basis).toMatch(/retired road-class derivation/);
    expect(served.basis).not.toContain(ROAD_CLASS_SETBACK_PROVENANCE);
    expect(served).not.toHaveProperty("feet");
    expect(served).not.toHaveProperty("provenance");
  });

  it("does not fall back to the stored feet, a road class, a district default, or zero", () => {
    const served = serveBoundaryEdgeSetback({
      feet: 15,
      provenance: ROAD_CLASS_SETBACK_PROVENANCE,
    });
    expect(served.state).toBe("refused");
    expect(JSON.stringify(served)).not.toMatch(/"feet"\s*:/);
    expect(JSON.stringify(served)).not.toMatch(/"state"\s*:\s*"value"/);
  });

  it("serves value when the edge is a dimensional record (layer-23 / Lockhart / Austin shape)", () => {
    const layer23 = serveBoundaryEdgeSetback({
      feet: 30,
      provenance: "bastrop-per-parcel-record-layer-23",
      atomCitation: "did:hauska:code-section:bdc:14.02.003",
    });
    expect(layer23.state).toBe("value");
    if (layer23.state !== "value") return;
    expect(layer23.feet).toBe(30);
    expect(layer23.provenance).toBe("bastrop-per-parcel-record-layer-23");
    expect(layer23.basis).toContain("bastrop-per-parcel-record-layer-23");

    const lockhart = serveBoundaryEdgeSetback({
      feet: 25,
      provenance: "district-setback-table",
      atomCitation: "did:hauska:code-section:lockhart-udc:4.2",
    });
    expect(lockhart.state).toBe("value");

    const austin = serveBoundaryEdgeSetback({
      feet: 25,
      provenance: "district-setback-table",
      atomCitation: "did:hauska:code-section:austin-lcl:25-2",
    });
    expect(austin.state).toBe("value");
  });

  it("serves unknown — never absent-verified — for storage-port-proof/phase-1a", () => {
    const served = serveBoundaryEdgeSetback({
      feet: 0,
      provenance: PLACEHOLDER_SETBACK_PROVENANCE,
    });
    expect(served.state).toBe("unknown");
    expect(served.basis).toBe(PLACEHOLDER_SETBACK_UNKNOWN_BASIS);
    expect(served.basis).toMatch(/phase-1a storage-port proof/);
    expect(served.basis).not.toContain(PLACEHOLDER_SETBACK_PROVENANCE);
    expect(served.state).not.toBe("absent");
    expect(JSON.stringify(served)).not.toContain("absent-verified");
    expect(served).not.toHaveProperty("feet");
  });

  it("treats a placeholder DID citation as unknown, not refused", () => {
    const served = serveBoundaryEdgeSetback({
      feet: 10,
      provenance: "property-atom-proof",
      atomCitation: `did:hauska:code-section:${PLACEHOLDER_SETBACK_PROVENANCE}`,
    });
    expect(served.state).toBe("unknown");
    expect(served.state).not.toBe("refused");
    expect(JSON.stringify(served)).not.toContain("absent-verified");
  });

  it("does not treat unmapped absence as refused or unknown", () => {
    const served = serveBoundaryEdgeSetback({
      kind: "unmapped-adjacency",
      reason: "No parcel or ROW adjacency mapped for this edge.",
    });
    expect(served.state).toBe("absent");
    expect(served.basis).toMatch(/No parcel or ROW adjacency/);
  });
});

describe("serveBoundaryEdgeSetback — violation of the value arm", () => {
  it("fails (this test) if a road-class payload is served as value", () => {
    const served = serveBoundaryEdgeSetback({
      feet: 15,
      provenance: ROAD_CLASS_SETBACK_PROVENANCE,
    });
    expect(served.state === "value").toBe(false);
  });

  it("fails (this test) if a placeholder payload is served as absent-verified", () => {
    const served = serveBoundaryEdgeSetback({
      feet: 0,
      provenance: PLACEHOLDER_SETBACK_PROVENANCE,
    });
    expect(served.state).not.toBe("absent");
    expect(JSON.stringify(served)).not.toMatch(/absent-verified/);
  });
});
