import { describe, expect, it } from "vitest";
import {
  runSetbackGate,
  formatGateReport,
  type SourceAtom,
  type GatedSetbackTable,
  type GatedSetbackDistrict,
} from "../local/setbacks/gate";
import { getSetbackTable } from "../local/setbacks";

/**
 * Setback extraction acceptance gate tests.
 *
 * Spec: docs/setback-extraction-acceptance-gate.md
 *
 * These exercise the checker against realistic corpus-atom fixtures — a clean
 * citation-backed table that PASSES, and a battery of tables that each trip a
 * specific rule (G1 uncited, G2 fabricated citation, G3 out-of-band, G4
 * missing district, G5 quote mismatch, G6 no verification state). This is the
 * end-to-end proof that the gate blocks bad extractions and admits good ones.
 */

// Two source code-section atoms in the shape the retrieval-api snapshot uses.
const ATOMS: SourceAtom[] = [
  {
    entityId: "demo_tx/demo-udc-2025/4.1.2",
    sectionNumber: "4.1.2",
    bodyText:
      "SF-6 Single Family Residential. Minimum front yard: 25 feet. " +
      "Minimum rear yard: 10 feet. Minimum side yard: 5 feet. " +
      "Corner side yard: 15 feet. Maximum building height: 35 feet.",
    sourceUrl: "https://example.gov/udc#4.1.2",
  },
  {
    entityId: "demo_tx/demo-udc-2025/4.1.3",
    sectionNumber: "4.1.3",
    bodyText:
      "Maximum lot coverage: 40 percent. Maximum impervious cover: 55 percent.",
    sourceUrl: "https://example.gov/udc#4.1.3",
  },
];

function cleanDistrict(): GatedSetbackDistrict {
  return {
    district_name: "SF-6 Single Family",
    front_ft: 25,
    rear_ft: 10,
    side_ft: 5,
    side_corner_ft: 15,
    max_height_ft: 35,
    max_lot_coverage_pct: 40,
    max_impervious_pct: 55,
    citation_url: "https://example.gov/udc#4.1.2",
    provenance: {
      front_ft: {
        atom_did: "demo_tx/demo-udc-2025/4.1.2",
        section_number: "4.1.2",
        quote: "Minimum front yard: 25 feet.",
        confidence: 0.95,
        verification_state: "human-verified",
      },
      rear_ft: {
        atom_did: "demo_tx/demo-udc-2025/4.1.2",
        section_number: "4.1.2",
        quote: "Minimum rear yard: 10 feet.",
        confidence: 0.95,
        verification_state: "human-verified",
      },
      side_ft: {
        atom_did: "demo_tx/demo-udc-2025/4.1.2",
        section_number: "4.1.2",
        quote: "Minimum side yard: 5 feet.",
        confidence: 0.95,
        verification_state: "human-verified",
      },
      side_corner_ft: {
        atom_did: "demo_tx/demo-udc-2025/4.1.2",
        section_number: "4.1.2",
        quote: "Corner side yard: 15 feet.",
        confidence: 0.9,
        verification_state: "human-verified",
      },
      max_height_ft: {
        atom_did: "demo_tx/demo-udc-2025/4.1.2",
        section_number: "4.1.2",
        quote: "Maximum building height: 35 feet.",
        confidence: 0.95,
        verification_state: "human-verified",
      },
      max_lot_coverage_pct: {
        atom_did: "demo_tx/demo-udc-2025/4.1.3",
        section_number: "4.1.3",
        quote: "Maximum lot coverage: 40 percent.",
        confidence: 0.95,
        verification_state: "human-verified",
      },
      max_impervious_pct: {
        atom_did: "demo_tx/demo-udc-2025/4.1.3",
        section_number: "4.1.3",
        quote: "Maximum impervious cover: 55 percent.",
        confidence: 0.95,
        verification_state: "human-verified",
      },
    },
  };
}

function tableWith(d: GatedSetbackDistrict): GatedSetbackTable {
  return {
    jurisdictionKey: "demo-tx",
    jurisdictionDisplayName: "Demo, TX",
    districts: [d],
  };
}

describe("runSetbackGate", () => {
  it("PASSES a clean citation-backed human-verified table", () => {
    const report = runSetbackGate({
      table: tableWith(cleanDistrict()),
      atoms: ATOMS,
      expectedDistricts: ["SF-6 Single Family"],
    });
    expect(report.passed).toBe(true);
    expect(report.counts.block).toBe(0);
    expect(report.counts.flag).toBe(0);
    expect(report.gated).toBe(true);
  });

  it("G1 BLOCKS a value with no provenance/citation", () => {
    const d = cleanDistrict();
    delete d.provenance!.front_ft;
    const report = runSetbackGate({
      table: tableWith(d),
      atoms: ATOMS,
      expectedDistricts: ["SF-6 Single Family"],
    });
    expect(report.passed).toBe(false);
    expect(report.results.some((r) => r.rule === "G1" && r.field === "front_ft")).toBe(
      true,
    );
  });

  it("G2 BLOCKS a fabricated citation (atom not in corpus)", () => {
    const d = cleanDistrict();
    d.provenance!.front_ft!.atom_did = "demo_tx/demo-udc-2025/9.9.9-does-not-exist";
    const report = runSetbackGate({
      table: tableWith(d),
      atoms: ATOMS,
      expectedDistricts: ["SF-6 Single Family"],
    });
    expect(report.passed).toBe(false);
    expect(
      report.results.some(
        (r) => r.rule === "G2" && /not found in corpus/.test(r.message),
      ),
    ).toBe(true);
  });

  it("G2 BLOCKS a citation whose section does not match the atom", () => {
    const d = cleanDistrict();
    d.provenance!.front_ft!.section_number = "99.99";
    const report = runSetbackGate({
      table: tableWith(d),
      atoms: ATOMS,
      expectedDistricts: ["SF-6 Single Family"],
    });
    expect(report.passed).toBe(false);
    expect(report.results.some((r) => r.rule === "G2")).toBe(true);
  });

  it("G3 FLAGS an out-of-band value but does not BLOCK", () => {
    const d = cleanDistrict();
    d.front_ft = 250; // outside [0,100]
    d.provenance!.front_ft!.quote = "Minimum front yard: 250 feet.";
    // keep it asserted so G5 mismatch is a flag not a block, isolating G3
    d.provenance!.front_ft!.verification_state = "asserted";
    // give the atom the matching quote so G5 stays clean
    const atoms = structuredClone(ATOMS);
    atoms[0]!.bodyText = atoms[0]!.bodyText!.replace(
      "Minimum front yard: 25 feet.",
      "Minimum front yard: 250 feet.",
    );
    const report = runSetbackGate({
      table: tableWith(d),
      atoms,
      expectedDistricts: ["SF-6 Single Family"],
    });
    expect(report.counts.flag).toBeGreaterThan(0);
    expect(report.results.some((r) => r.rule === "G3" && r.level === "flag")).toBe(
      true,
    );
    // No G3 block for an in-corpus, cited value that is merely out of band.
    expect(report.results.some((r) => r.rule === "G3" && r.level === "block")).toBe(
      false,
    );
  });

  it("G4 BLOCKS when an ordinance-named district has no row", () => {
    const report = runSetbackGate({
      table: tableWith(cleanDistrict()),
      atoms: ATOMS,
      expectedDistricts: ["SF-6 Single Family", "CD-5 Commercial Downtown"],
    });
    expect(report.passed).toBe(false);
    expect(
      report.results.some(
        (r) => r.rule === "G4" && /CD-5 Commercial Downtown/.test(r.message),
      ),
    ).toBe(true);
  });

  it("G4 FLAGS (not blocks) when expectedDistricts is not supplied", () => {
    const report = runSetbackGate({
      table: tableWith(cleanDistrict()),
      atoms: ATOMS,
    });
    expect(report.results.some((r) => r.rule === "G4" && r.level === "flag")).toBe(
      true,
    );
  });

  it("G5 BLOCKS a human-verified value whose quote is not in the atom body", () => {
    const d = cleanDistrict();
    d.provenance!.front_ft!.quote = "this text is not anywhere in the atom";
    const report = runSetbackGate({
      table: tableWith(d),
      atoms: ATOMS,
      expectedDistricts: ["SF-6 Single Family"],
    });
    expect(report.passed).toBe(false);
    expect(
      report.results.some(
        (r) => r.rule === "G5" && r.level === "block" && r.field === "front_ft",
      ),
    ).toBe(true);
  });

  it("G5 only FLAGS a quote mismatch when the value is merely asserted", () => {
    const d = cleanDistrict();
    for (const f of Object.keys(d.provenance!)) {
      d.provenance![f as keyof typeof d.provenance]!.verification_state = "asserted";
    }
    d.provenance!.front_ft!.quote = "garbled pdf text 223 of 265";
    const report = runSetbackGate({
      table: tableWith(d),
      atoms: ATOMS,
      expectedDistricts: ["SF-6 Single Family"],
    });
    // asserted mismatch is a flag, not a block -> table still passes CI gate
    expect(report.passed).toBe(true);
    expect(
      report.results.some(
        (r) => r.rule === "G5" && r.level === "flag" && r.field === "front_ft",
      ),
    ).toBe(true);
  });

  it("G6 BLOCKS a missing verification_state", () => {
    const d = cleanDistrict();
    // @ts-expect-error deliberately break the shape for the test
    d.provenance!.front_ft!.verification_state = undefined;
    const report = runSetbackGate({
      table: tableWith(d),
      atoms: ATOMS,
      expectedDistricts: ["SF-6 Single Family"],
    });
    expect(report.passed).toBe(false);
    expect(report.results.some((r) => r.rule === "G6")).toBe(true);
  });

  it("accepts a not_specified value with a citation to the searched section", () => {
    const d = cleanDistrict();
    d.max_impervious_pct = 0;
    d.provenance!.max_impervious_pct = {
      atom_did: "demo_tx/demo-udc-2025/4.1.3",
      section_number: "4.1.3",
      quote: "Maximum lot coverage: 40 percent.",
      confidence: 0.5,
      verification_state: "asserted",
      not_specified: true,
    };
    const report = runSetbackGate({
      table: tableWith(d),
      atoms: ATOMS,
      expectedDistricts: ["SF-6 Single Family"],
    });
    // not_specified skips G3/G5; citation still required (present) -> passes
    expect(report.passed).toBe(true);
  });

  it("formatGateReport renders a readable summary line", () => {
    const report = runSetbackGate({
      table: tableWith(cleanDistrict()),
      atoms: ATOMS,
      expectedDistricts: ["SF-6 Single Family"],
    });
    const text = formatGateReport(report);
    expect(text).toContain("demo-tx");
    expect(text).toContain("PASS");
  });
});

describe("San Marcos pilot registration", () => {
  it("serves a cited, populated table with explicit omitted-code gaps", () => {
    const table = getSetbackTable("san-marcos-tx");
    expect(table).not.toBeNull();
    expect(table!.districts).toHaveLength(2);
    expect(table!.note).toMatch(/ND-3/i);
    expect(table!.note).toMatch(/conditional/i);
    expect(table!.districts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          district_name: "SF-6 Single Family 6",
          front_ft: 25,
          rear_ft: 20,
          side_ft: 5,
          side_corner_ft: 15,
        }),
      ]),
    );
    expect(table!.note).toMatch(/OMITTED.*MF-12/i);
  });

  it("serves Cedar Park as an ordinance-backed populated table", () => {
    const table = getSetbackTable("cedar_park_tx");
    expect(table).not.toBeNull();
    expect(table!.jurisdictionKey).toBe("cedar-park-tx");
    expect(table!.districts).toHaveLength(16);
    expect(table!.districts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          district_name: "SR Suburban Residential",
          front_ft: 30,
          rear_ft: 25,
          side_ft: 12,
          side_corner_ft: 20,
        }),
      ]),
    );
    expect(table!.note).toMatch(/https:\/\//);
  });

  it("serves Pflugerville as a cited, populated table", () => {
    const table = getSetbackTable("pflugerville_tx");
    expect(table).not.toBeNull();
    expect(table!.jurisdictionKey).toBe("pflugerville-tx");
    expect(table!.districts).toHaveLength(10);
    expect(table!.districts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          district_name: "SF-S Single Family Suburban",
          front_ft: 25,
          rear_ft: 20,
          side_ft: 7.5,
          side_corner_ft: 15,
        }),
      ]),
    );
    expect(table!.note).toMatch(/GB1/i);
    expect(table!.note).toMatch(/OMITTED/i);
    expect(table!.note).toMatch(/^.*https:\/\//);
  });

  it("reports the legacy Bastrop table as un-gated (no provenance)", () => {
    // Bastrop predates the gate: its rows carry a municode-root citation_url
    // and no per-value provenance, so the gate treats it as legacy/un-gated.
    const bastrop = getSetbackTable("bastrop-tx");
    expect(bastrop).not.toBeNull();
    const anyProvenance = (bastrop!.districts as GatedSetbackDistrict[]).some(
      (d) => d.provenance && Object.keys(d.provenance).length > 0,
    );
    expect(anyProvenance).toBe(false);
  });
});
