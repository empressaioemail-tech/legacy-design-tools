/**
 * Geometry-helper tests after anti-zombie cut: derive returns geometry only;
 * product confidence is null (never labeling×district multiply).
 */

import { describe, it, expect, vi } from "vitest";
import type { SetbackTable } from "@workspace/adapters";
import { feetToMeters, insetPerEdge, type Ring } from "./geometry";
import { labelEdges, insetFeetForLabeling } from "./edgeLabeling";
import { mapDistrict } from "./districtMapping";
import { deriveBuildableEnvelope } from "./derive";

// Partial mock so the P60b reason-split test can force a gate rejection
// (unreachable with honest inputs now that the gates only fire on genuine
// violations); every other test runs the real insetPerEdge.
vi.mock("./geometry", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./geometry")>();
  return { ...actual, insetPerEdge: vi.fn(actual.insetPerEdge) };
});

// Spy-only (calls through to the real implementation) so the road-class
// default-retirement test below can inspect what derive.ts actually passes
// as `roadClassTable`, without changing behavior for any other test.
vi.mock("./edgeLabeling", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./edgeLabeling")>();
  return { ...actual, insetFeetForLabeling: vi.fn(actual.insetFeetForLabeling) };
});

const LNG0 = -97.31;
const LAT0 = 30.11;

function rectRing(wFt = 100, hFt = 200): Ring {
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const mPerDegLng = mPerDegLat * Math.cos((LAT0 * Math.PI) / 180);
  const halfW = feetToMeters(wFt) / 2 / mPerDegLng;
  const halfH = feetToMeters(hFt) / 2 / mPerDegLat;
  return [
    [LNG0 - halfW, LAT0 - halfH],
    [LNG0 + halfW, LAT0 - halfH],
    [LNG0 + halfW, LAT0 + halfH],
    [LNG0 - halfW, LAT0 + halfH],
    [LNG0 - halfW, LAT0 - halfH],
  ];
}

const TABLE: SetbackTable = {
  jurisdictionKey: "test-tx",
  jurisdictionDisplayName: "Test, TX",
  districts: [
    {
      district_name: "R-MD Residential Medium Density",
      front_ft: 25,
      rear_ft: 20,
      side_ft: 7.5,
      side_corner_ft: 15,
      max_height_ft: 35,
      max_lot_coverage_pct: 40,
      max_impervious_pct: 55,
      citation_url: "https://library.municode.com/tx/test",
    },
    {
      district_name: "R-LD Residential Low Density",
      front_ft: 30,
      rear_ft: 25,
      side_ft: 10,
      side_corner_ft: 20,
      max_height_ft: 35,
      max_lot_coverage_pct: 35,
      max_impervious_pct: 50,
      citation_url: "https://library.municode.com/tx/test",
    },
  ],
};

function roadSouthOf(): [number, number][] {
  const mPerDegLat = (Math.PI / 180) * 6_378_137;
  const roadLat = LAT0 - feetToMeters(120) / mPerDegLat;
  return [
    [LNG0 - 0.002, roadLat],
    [LNG0 + 0.002, roadLat],
  ];
}

describe("deriveBuildableEnvelope — geometry helper (no product confidence)", () => {
  it("road front + matched district -> geometry, confidence null", () => {
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const district = mapDistrict(TABLE, "R-MD")!;
    const res = deriveBuildableEnvelope({ ring, table: TABLE, district, labeling });

    expect(res.empty).toBe(false);
    expect(res.confidence).toBeNull();
    expect(res.citationUrl).toContain("municode");
    const feat = res.geojson.features[0]!;
    expect(feat.geometry).not.toBeNull();
    expect(feat.properties.notSurveyGrade).toBe(true);
    expect(feat.properties.buildableAreaSqFt).toBeGreaterThan(12_000);
    expect(feat.properties.maxFootprintSqFt).toBeCloseTo(8_000, -2);
    expect(feat.properties.disclosure).toMatch(/not survey grade/i);
  });

  it("shape signal -> approximate geometry, confidence still null", () => {
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: null, refPoint: null })!;
    const district = mapDistrict(TABLE, "R-MD")!;
    const res = deriveBuildableEnvelope({ ring, table: TABLE, district, labeling });

    expect(res.approximate).toBe(true);
    expect(res.confidence).toBeNull();
    expect(res.geojson.features[0]!.properties.edgeSignal).toBe("shape");
  });

  it("setbacks exceed a tiny lot -> null geometry + honest consume-lot reason", () => {
    const ring = rectRing(40, 40);
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const district = mapDistrict(TABLE, "R-LD")!;
    const res = deriveBuildableEnvelope({ ring, table: TABLE, district, labeling });

    expect(res.empty).toBe(true);
    expect(res.emptyKind).toBe("consumed");
    expect(res.confidence).toBeNull();
    const props = res.geojson.features[0]!;
    expect(props.geometry).toBeNull();
    expect(props.properties.emptyKind).toBe("consumed");
    expect(props.properties.disclosure).toMatch(/no buildable area/i);
    expect(props.properties.emptyReason).toMatch(/exceed the lot/i);
  });

  it("P60b reason split: gate rejection surfaces as validation decline, never consume-lot", () => {
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const district = mapDistrict(TABLE, "R-MD")!;
    vi.mocked(insetPerEdge).mockReturnValueOnce({
      ring: null,
      areaSqFt: 0,
      parcelAreaSqFt: 20_000,
      empty: true,
      emptyReason:
        "geometry validation failed (inset overlaps forbidden setback strips by 12.00 m² (ε 0.50))",
      emptyKind: "validation-failed",
    });
    const res = deriveBuildableEnvelope({ ring, table: TABLE, district, labeling });

    expect(res.empty).toBe(true);
    expect(res.emptyKind).toBe("validation-failed");
    const props = res.geojson.features[0]!.properties;
    expect(props.emptyKind).toBe("validation-failed");
    expect(props.emptyReason).toMatch(/geometry validation failed/i);
    expect(props.disclosure).toMatch(/geometry validation failed/i);
    expect(props.disclosure).not.toMatch(/exceed the lot/i);
  });

  it("not_specified side/rear (P-3 shape) does not consume the lot", () => {
    const p3Table: SetbackTable = {
      jurisdictionKey: "bastrop-city-tx",
      jurisdictionDisplayName: "Bastrop B3",
      districts: [
        {
          district_name: "P-3 Neighborhood",
          front_ft: 25,
          rear_ft: 0,
          side_ft: 0,
          side_corner_ft: 0,
          max_height_ft: 100,
          max_lot_coverage_pct: 50,
          max_impervious_pct: 100,
          citation_url: "https://example.test/b3",
          provenance: {
            front_ft: { not_specified: false },
            side_ft: { not_specified: true },
            rear_ft: { not_specified: true },
            side_corner_ft: { not_specified: true },
          },
        },
      ],
    };
    const ring = rectRing(100, 200);
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const district = mapDistrict(p3Table, "P-3")!;
    const res = deriveBuildableEnvelope({
      ring,
      table: p3Table,
      district,
      labeling,
    });
    expect(res.empty).toBe(false);
    expect(res.geojson.features[0]!.geometry).not.toBeNull();
    expect(res.geojson.features[0]!.properties.setbacks.not_specified).toEqual({
      side: true,
      rear: true,
      side_corner: true,
    });
    expect(res.geojson.features[0]!.properties.disclosure).toMatch(/build-to-line/i);
    expect(res.geojson.features[0]!.properties.disclosure).not.toMatch(/consume/i);
  });
});

describe("deriveBuildableEnvelope — road-class setback default retirement (F-11 / 293633a precedent)", () => {
  const P5_TABLE: SetbackTable = {
    jurisdictionKey: "bastrop-city-tx",
    jurisdictionDisplayName: "Bastrop B3",
    districts: [
      {
        district_name: "P-5 Core",
        front_ft: 25,
        rear_ft: 20,
        side_ft: 7.5,
        side_corner_ft: 15,
        max_height_ft: 35,
        max_lot_coverage_pct: 40,
        max_impervious_pct: 55,
        citation_url: "https://library.municode.com/tx/bastrop",
      },
    ],
  };

  it("never auto-applies a road-class table by default, even for bastrop-city-tx P-5 (the one jurisdiction/district the retired default used to match)", () => {
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const district = mapDistrict(P5_TABLE, "P-5")!;

    deriveBuildableEnvelope({ ring, table: P5_TABLE, district, labeling });

    expect(insetFeetForLabeling).toHaveBeenCalledWith(
      labeling,
      expect.anything(),
      expect.objectContaining({ roadClassTable: null }),
    );
  });

  it("still honors a caller-supplied roadClassSetbackTable (opt-in stays available)", () => {
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const district = mapDistrict(P5_TABLE, "P-5")!;
    const explicitTable = {
      district_code: "P-5",
      entries: [{ road_class: "residential" as const, edge_role: "front" as const, setback_ft: 15 }],
    };

    deriveBuildableEnvelope({
      ring,
      table: P5_TABLE,
      district,
      labeling,
      roadClassSetbackTable: explicitTable,
    });

    expect(insetFeetForLabeling).toHaveBeenCalledWith(
      labeling,
      expect.anything(),
      expect.objectContaining({ roadClassTable: explicitTable }),
    );
  });
});

/**
 * P-299 — a height the code does not state must not reach the props as the
 * corpus's 999 stated-absence sentinel.
 *
 * Real row under test: Round Rock's own table (Round Rock states its
 * commercial/industrial heights in STORIES), flagged `not_specified: true`.
 * Before this change `maxHeightFt` was copied straight off the row, so the
 * envelope props — and every consumer sizing an ADU or an addition against them
 * — read 999 as a 999-foot limit.
 */
describe("P-299 — a flagged height is ABSENT, never 999", () => {
  const P299_TABLE: SetbackTable = {
    jurisdictionKey: "round-rock-tx",
    jurisdictionDisplayName: "City of Round Rock, TX",
    districts: [
      {
        district_name: "SF-2 Single-Family Residential 2 (Conventional)",
        front_ft: 25,
        rear_ft: 20,
        side_ft: 5,
        side_corner_ft: 15,
        max_height_ft: 999,
        max_lot_coverage_pct: 40,
        max_impervious_pct: 55,
        citation_url: "https://library.municode.com/tx/round_rock",
        provenance: {
          max_height_ft: {
            section_number: "Sec. 2-36",
            quote: "C-1 Standard = '5 stories' — stories only, no feet figure.",
            confidence: 0.7,
            verification_state: "transcription-read",
            not_specified: true,
          },
        },
      },
      {
        district_name: "MU-1 Mixed-Use Historic Commercial Core District",
        front_ft: 0,
        rear_ft: 10,
        side_ft: 0,
        side_corner_ft: 10,
        max_height_ft: 48,
        max_lot_coverage_pct: 60,
        max_impervious_pct: 80,
        citation_url: "https://library.municode.com/tx/round_rock",
      },
    ],
  } as unknown as SetbackTable;

  function deriveDistrict(code: string) {
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const district = mapDistrict(P299_TABLE, code)!;
    const res = deriveBuildableEnvelope({ ring, table: P299_TABLE, district, labeling });
    return res.geojson.features[0]!.properties;
  }

  it("FALSIFIER 3: the SF-2 flagged height arrives as null, not 999, and the envelope JSON carries no 999 anywhere", () => {
    const props = deriveDistrict("SF-2");
    expect(props.maxHeightFt).toBeNull();
    expect(props.setbacks.not_specified?.max_height).toBe(true);
    expect(JSON.stringify(props)).not.toContain("999");
    expect(props.disclosure).toMatch(/states no feet-based maximum height/i);
  });

  it("a real feet height is untouched (the fix cannot pass by nulling every height)", () => {
    const props = deriveDistrict("MU-1");
    expect(props.maxHeightFt).toBe(48);
    expect(props.setbacks.not_specified?.max_height).toBeUndefined();
  });

  it("a bare 999 with no flag is treated as absent too — this reader fails closed on the value as well as the flag", () => {
    const bare: SetbackTable = {
      ...P299_TABLE,
      districts: [{ ...P299_TABLE.districts[0]!, provenance: undefined, max_height_ft: 999 }],
    };
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const props = deriveBuildableEnvelope({
      ring,
      table: bare,
      district: mapDistrict(bare, "SF-2")!,
      labeling,
    }).geojson.features[0]!.properties;
    expect(props.maxHeightFt).toBeNull();
    expect(props.setbacks.not_specified?.max_height).toBe(true);
  });
});

/**
 * P-270 (OPS-24 scope X11) — the drawn envelope's citation is served WITH its
 * vintage, or with a declaration saying the vintage could not be read.
 *
 * WHAT THE DEFECT WAS, in this file's own terms: `derive.ts` composed
 * `citationUrl` out of the district row and never read the table's
 * `effectiveDate` field at all, so the drawn envelope could not say whether
 * the rule a customer was looking at was adopted this year or in 2011. That is
 * the `never-looked` state, and it is what these tests remove: the first
 * assertion below is that the look now HAPPENS (the state is a read, not a
 * shrug).
 *
 * FALSIFIERS: absent-at-source and unparseable are asserted as DIFFERENT row
 * states off the same citation; the agreeing control (a readable date) asserts
 * NO row and a disclosure byte-identical to the pre-lane one; the consume-lot
 * case asserts the declaration survives an EMPTY envelope, where a naive
 * implementation that put the row only in the non-empty branch would drop it.
 */
describe("deriveBuildableEnvelope — setback-rule citation vintage (P-270, OPS-24 X11)", () => {
  const VINTAGE_NOTE =
    "Setback rule vintage unknown — the rule is served undated, not as current. Verify with the city.";

  function props(overrides?: Partial<SetbackTable>, ring?: Ring) {
    const table: SetbackTable = { ...TABLE, ...overrides } as SetbackTable;
    const r = ring ?? rectRing();
    const labeling = labelEdges({ ring: r, road: roadSouthOf() })!;
    const district = mapDistrict(table, "R-MD")!;
    const res = deriveBuildableEnvelope({ ring: r, table, district, labeling });
    return { props: res.geojson.features[0]!.properties, res };
  }

  it("THE DEFECT ITSELF: the shipped table shape (a citation, no `effectiveDate`) yields a declared vintage, not a silent pick", () => {
    // This is `pflugerville-tx.json`'s live shape: `citation_url` per district,
    // and no `effectiveDate` key on the table at all.
    const { props: p, res } = props();

    expect(p.citationUrl).toContain("municode");
    expect(p.citationVintage).toBeDefined();
    expect(p.citationVintage!.state).toBe("unreadable-absent-at-source");
    expect(p.citationVintage!.kind).toBe("setback-citation-vintage-unreadable");
    expect(p.citationVintage!.note).toBe(VINTAGE_NOTE);
    // The look HAPPENED — this is not `never-looked` any more. If derive.ts
    // ever stops reading the table, this is the assertion that fails.
    expect(p.citationVintage!.state).not.toBe("unreadable-never-looked");
    // The customer sentence reaches the disclosure paragraph too, APPENDED to
    // the survey caveat rather than replacing it.
    expect(p.disclosure).toMatch(/not survey grade/i);
    expect(p.disclosure!.endsWith(VINTAGE_NOTE)).toBe(true);
    // ...and it is on the result as well as the feature, so a caller reading
    // the envelope without walking features still sees it.
    expect(res.citationVintage).toEqual(p.citationVintage);
  });

  it("the row names the citation it is about, and it is the same citation printed beside it", () => {
    const { props: p } = props();
    expect(p.citationVintage!.citationUrl).toBe(p.citationUrl);
    expect(p.citationVintage!.sourceLabel).toContain("test-tx");
  });

  it("THE AGREEING CONTROL: a table whose own effectiveDate is readable publishes a date, NO row, and a pre-lane disclosure", () => {
    // `bastrop-development-code.json`'s live shape.
    const { props: p, res } = props({ effectiveDate: "2026-04-14" } as Partial<SetbackTable>);

    expect(p.citationEffectiveDate).toBe("2026-04-14");
    expect(res.citationEffectiveDate).toBe("2026-04-14");
    expect(p.citationVintage).toBeUndefined();
    expect(res.citationVintage).toBeUndefined();
    // A readable vintage is not a conflict, so the disclosure is UNTOUCHED:
    // this is what keeps every already-dated jurisdiction byte-identical.
    expect(p.disclosure).not.toContain("vintage unknown");
  });

  it("KEEPS THE CAUSES APART: a present-but-unreadable `effectiveDate` is `unparseable`, not `absent-at-source`", () => {
    const { props: p } = props({ effectiveDate: "2011" } as Partial<SetbackTable>);
    expect(p.citationVintage).toBeDefined();
    expect(p.citationVintage!.state).toBe("unreadable-unparseable");
    // ...and the other direction, on the identical citation:
    expect(props().props.citationVintage!.state).toBe("unreadable-absent-at-source");
  });

  it("no citation being served means NOTHING is declared — there is no instrument to qualify", () => {
    const noCitation: SetbackTable = {
      ...TABLE,
      districts: TABLE.districts.map((d) => ({ ...d, citation_url: undefined })),
    } as unknown as SetbackTable;
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const p = deriveBuildableEnvelope({
      ring,
      table: noCitation,
      district: mapDistrict(noCitation, "R-MD")!,
      labeling,
    }).geojson.features[0]!.properties;

    expect(p.citationVintage).toBeUndefined();
    expect(p.citationEffectiveDate).toBeUndefined();
    expect(p.disclosure).not.toContain("vintage unknown");
  });

  it("NEVER DEFAULTS THE DATE: the key is ABSENT, not null and not a placeholder, when nothing was readable", () => {
    const { props: p } = props();
    expect("citationEffectiveDate" in p).toBe(false);
    expect(p.citationEffectiveDate).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("1970-01-01");
  });

  it("the declaration SURVIVES AN EMPTY envelope: a consume-lot result still serves its citation, so it still declares the vintage", () => {
    // Falsifier for the naive implementation that attaches the row only where
    // the buildable ring exists. The citation is served either way.
    const { props: p, res } = props(undefined, rectRing(40, 40));
    expect(res.empty).toBe(true);
    expect(p.citationUrl).toContain("municode");
    expect(p.citationVintage).toBeDefined();
    expect(p.citationVintage!.note).toBe(VINTAGE_NOTE);
  });
});

describe("P-354 (2026-09-18) — a district ROW that carries its own dates", () => {
  const GEORGETOWN_ADOPTED = "2026-08-11";
  const GEORGETOWN_EFFECTIVE = "2026-11-01";

  /**
   * Build the envelope with row-level dates on the R-MD district row. This is
   * the shape Georgetown's rewrite rows carry after P-354: the row states its
   * own `adoptedDate`/`effectiveDate` and the table states none.
   */
  function rowProps(rowDates: Record<string, unknown>) {
    const table = {
      ...TABLE,
      districts: TABLE.districts.map((d) =>
        d.district_name.startsWith("R-MD") ? { ...d, ...rowDates } : d,
      ),
    } as SetbackTable;
    const ring = rectRing();
    const labeling = labelEdges({ ring, road: roadSouthOf() })!;
    const res = deriveBuildableEnvelope({
      ring,
      table,
      district: mapDistrict(table, "R-MD")!,
      labeling,
    });
    return { props: res.geojson.features[0]!.properties, res };
  }

  it("THE ROW IS ASKED FIRST: a row date is the rule's date, and both dates are named", () => {
    // The falsifier for a silently-undefined import: if `adoptedKeys` never
    // reaches `readSetbackDateFromRowAtSource`, the note loses the adoption
    // date and this fails. (It did exactly that before this test existed: the
    // constant was imported but never exported, so it arrived as `undefined`
    // and the adoption date was skipped without a single failing test.)
    const { props: p, res } = rowProps({
      effectiveDate: GEORGETOWN_EFFECTIVE,
      adoptedDate: GEORGETOWN_ADOPTED,
    });

    expect(p.citationVintage).toBeDefined();
    expect(p.citationVintage!.kind).toBe("setback-citation-future-effective");
    expect(p.citationVintage!.note).toContain(`adopted ${GEORGETOWN_ADOPTED}`);
    expect(p.citationVintage!.note).toContain(`takes effect ${GEORGETOWN_EFFECTIVE}`);
    expect(res.citationVintage).toEqual(p.citationVintage);
    // The rule is NOT printed as if already in force...
    expect(p.citationVintage!.note).not.toBe(
      "Setback rule vintage unknown — the rule is served undated, not as current. Verify with the city.",
    );
    // ...and NOT published as an in-force `citationEffectiveDate`, which is
    // what "the date it takes effect" must never be confused with.
    expect(p.citationEffectiveDate).toBeUndefined();
    expect("citationEffectiveDate" in p).toBe(false);
    // The sentence reaches the disclosure, appended to the survey caveat.
    expect(p.disclosure!.endsWith(p.citationVintage!.note)).toBe(true);
  });

  it("A ROW DATE BEATS THE TABLE DATE: a table date in force does not win over the row's own", () => {
    const { props: p } = rowProps({
      effectiveDate: GEORGETOWN_EFFECTIVE,
      adoptedDate: GEORGETOWN_ADOPTED,
    });
    // TABLE carries no effectiveDate, so this asserts the row read happened at
    // all; the precedence itself is pinned in the corpus resolver's own tests.
    expect(p.citationVintage!.kind).toBe("setback-citation-future-effective");
  });

  it("A ROW WITH NO DATE FALLS BACK TO THE TABLE, unchanged: the paired control", () => {
    // The row states neither field, so the table read is used exactly as
    // before this lane — same state, same sentence, same bytes.
    const { props: p } = rowProps({});
    expect(p.citationVintage).toBeDefined();
    expect(p.citationVintage!.state).toBe("unreadable-absent-at-source");
    expect(p.citationVintage!.kind).toBe("setback-citation-vintage-unreadable");
    expect(p.citationVintage!.note).toBe(
      "Setback rule vintage unknown — the rule is served undated, not as current. Verify with the city.",
    );
  });

  it("A ROW DATE ALREADY IN FORCE reads `read` and publishes no declaration", () => {
    const { props: p } = rowProps({ effectiveDate: "2026-04-14", adoptedDate: "2026-01-01" });
    expect(p.citationEffectiveDate).toBe("2026-04-14");
    expect(p.citationVintage).toBeUndefined();
  });

  it("A SHAPE-ONLY ROW DATE IS NOT PROMOTED: `2026-13-99` prints no nonsense", () => {
    // The corpus's reader is shape-only, so this IS a date to it and the rail
    // must not call it unreadable. But its arrival cannot be reasoned about, so
    // it is never promoted to "takes effect 2026-13-99".
    const { props: p } = rowProps({ effectiveDate: "2026-13-99" });
    expect(p.citationEffectiveDate).toBe("2026-13-99");
    expect(p.citationVintage).toBeUndefined();
    expect(JSON.stringify(p)).not.toContain("takes effect");
  });
});
