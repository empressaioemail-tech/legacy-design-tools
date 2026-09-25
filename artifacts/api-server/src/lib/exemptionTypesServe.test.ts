/**
 * P-453. Non-homestead exemption types are refused at serve; homestead survives
 * for Studio-shaped (homestead-only) callers.
 */

import { describe, expect, it } from "vitest";
import {
  PERSONAL_ATTRIBUTE_EXEMPTION_REFUSAL,
  applyExemptionTypesServeToNodeFacetsResponse,
  applyExemptionTypesServeToResearchBriefBody,
  applyExemptionTypesServeToSiteContext,
  gateOwnerFactExemptionTypesForServe,
} from "./exemptionTypesServe";

const PLANTED_OWNER_FACT = {
  state: "present",
  source: "owner-fact",
  taxYear: 2025,
  ownerName: "PLANT OWNER",
  ownerMailingAddress: "1 PLANT ST",
  exemptionFlags: {
    homestead: true,
    seniorOrDisability: true,
    agricultural: false,
    veteran: false,
  },
} as const;

describe("gateOwnerFactExemptionTypesForServe", () => {
  it("homestead-only: planted over-65 (seniorOrDisability) is a personal-attribute refusal; homestead boolean survives", () => {
    const out = gateOwnerFactExemptionTypesForServe(
      PLANTED_OWNER_FACT,
      "homestead-only",
    ) as typeof PLANTED_OWNER_FACT & {
      exemptionFlags: Record<string, unknown>;
    };
    expect(out.exemptionFlags.homestead).toBe(true);
    expect(out.exemptionFlags.seniorOrDisability).toEqual(
      PERSONAL_ATTRIBUTE_EXEMPTION_REFUSAL,
    );
    expect(out.exemptionFlags.veteran).toEqual(PERSONAL_ATTRIBUTE_EXEMPTION_REFUSAL);
  });

  it("none: drops exemptionFlags entirely for public/card surfaces", () => {
    const out = gateOwnerFactExemptionTypesForServe(
      PLANTED_OWNER_FACT,
      "none",
    ) as { exemptionFlags: unknown };
    expect(out.exemptionFlags).toBeNull();
  });

  it("FALSIFIER: without gating, the planted seniorOrDisability boolean survives", () => {
    expect(PLANTED_OWNER_FACT.exemptionFlags.seniorOrDisability).toBe(true);
  });
});

describe("applyExemptionTypesServeToResearchBriefBody — MCP / run_report upstream", () => {
  it("Studio-shaped (homestead-only): refuses seniorOrDisability on ownerFact", () => {
    const out = applyExemptionTypesServeToResearchBriefBody(
      { parcelNodeId: "48021:1", ownerFact: PLANTED_OWNER_FACT },
      "homestead-only",
    );
    const flags = (out.ownerFact as typeof PLANTED_OWNER_FACT).exemptionFlags;
    expect(flags.seniorOrDisability).toEqual(PERSONAL_ATTRIBUTE_EXEMPTION_REFUSAL);
    expect(flags.homestead).toBe(true);
  });

  it("Solo/anonymous-shaped (none): ownerFact exemption detail removed", () => {
    const out = applyExemptionTypesServeToResearchBriefBody(
      { ownerFact: PLANTED_OWNER_FACT },
      "none",
    );
    expect((out.ownerFact as { exemptionFlags: unknown }).exemptionFlags).toBeNull();
  });
});

describe("applyExemptionTypesServeToNodeFacetsResponse — PE facets route", () => {
  it("refuses non-homestead codes on baseFacts.exemptionCodes for every tier shape", () => {
    const out = applyExemptionTypesServeToNodeFacetsResponse(
      {
        facets: {
          baseFacts: {
            exemptionCodes: { v: ["HS", "OV65"], source: "cad_property", vintage: "2026" },
          },
        },
        ownerFact: PLANTED_OWNER_FACT,
      },
      "homestead-only",
    );
    const codes = (
      out.facets as { baseFacts: { exemptionCodes: { v: string[] } } }
    ).baseFacts.exemptionCodes;
    expect(codes.v).toEqual(["HS"]);
    const flags = (out.ownerFact as typeof PLANTED_OWNER_FACT).exemptionFlags;
    expect(flags.seniorOrDisability).toEqual(PERSONAL_ATTRIBUTE_EXEMPTION_REFUSAL);
  });

  it("anonymous (none): strips exemptionCodes and ownerFact flags", () => {
    const out = applyExemptionTypesServeToNodeFacetsResponse(
      {
        facets: {
          baseFacts: {
            exemptionCodes: { v: ["HS", "OV65"], source: "cad_property", vintage: "2026" },
          },
        },
        ownerFact: PLANTED_OWNER_FACT,
      },
      "none",
    );
    expect(
      (out.facets as { baseFacts: { exemptionCodes: unknown } }).baseFacts
        .exemptionCodes,
    ).toBeNull();
    expect((out.ownerFact as { exemptionFlags: unknown }).exemptionFlags).toBeNull();
  });
});

describe("applyExemptionTypesServeToSiteContext — brokerage brief / export site layers", () => {
  const cadTaxLayer = {
    layerKind: "cad-tax",
    adapterKey: "cad:tax",
    tier: "local",
    status: "ok" as const,
    summary: "legacy",
    payload: {
      kind: "cad-tax",
      cadName: "Test CAD",
      taxYear: 2026,
      assessedValue: 285_000,
      exemptionCodes: ["HS", "OV65"],
      exemptions: [
        { code: "HS", label: "Homestead" },
        { code: "OV65", label: "Over-65" },
      ],
      valueBasis: "county-assessed",
    },
  };

  it("homestead-only: summary names homestead only, not Over-65", () => {
    const out = applyExemptionTypesServeToSiteContext(
      { layers: [cadTaxLayer] },
      "homestead-only",
    );
    expect(out.layers[0]?.summary).toContain("Homestead");
    expect(out.layers[0]?.summary).not.toMatch(/Over-65|OV65/i);
    expect(out.layers[0]?.summary).toContain("$285,000");
  });

  it("none: drops exemption codes from payload and summary", () => {
    const out = applyExemptionTypesServeToSiteContext(
      { layers: [cadTaxLayer] },
      "none",
    );
    const payload = out.layers[0]?.payload as Record<string, unknown>;
    expect(payload.exemptionCodes).toBeUndefined();
    expect(payload.exemptions).toBeUndefined();
    expect(out.layers[0]?.summary).not.toMatch(/Over-65|Homestead \(HS\)/i);
  });
});

describe("RED-TEST PROOF: bypassing the serve helper leaks OV65", () => {
  it("unsuppressed body still carries seniorOrDisability true (what tests must catch if serve is removed)", () => {
    const raw = {
      ownerFact: PLANTED_OWNER_FACT,
      facets: { baseFacts: { exemptionCodes: { v: ["HS", "OV65"] } } },
    };
    expect(JSON.stringify(raw)).toContain('"seniorOrDisability":true');
    expect(JSON.stringify(raw)).toContain("OV65");
    const served = applyExemptionTypesServeToResearchBriefBody(raw, "homestead-only");
    expect(JSON.stringify(served)).not.toContain('"seniorOrDisability":true');
    expect(JSON.stringify(served)).not.toContain("OV65");
  });
});
