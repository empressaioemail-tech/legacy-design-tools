/**
 * Conformant-v1 Tier-1 bake: the bake projects the FULL old facet set, and
 * old-versus-new is a TEST (OPS-19 A-025 items 1 and 2; CTX card E items 2
 * and 3, 2026-08-28).
 *
 * DB-free. The old bake's `buildTier1Payload` and the conformant
 * `buildConformantTier1Payload` are run on ONE fixture parcel (same txgio row,
 * a claim consistent with it) and their leaf key-path sets must agree, minus
 * the root keys the new shape carries on purpose and a named allowlist. The
 * instrument is itself verified by violation (a thinned payload must fail),
 * and the live production thin shape is a fixture that must fail.
 */

import { describe, it, expect } from "vitest";
import { buildTier1Payload } from "./nodeFacetBakeTier1Cli";
import type { Ring } from "./lib/nodeFacetBakeTier1";
import type { ParcelJoinRow } from "./lib/nodeFacetTier1ParcelJoin";
import {
  assertNoOwnerKey,
  buildConformantTier1Payload,
  conformantAcreageFromClaim,
  conformantClaimRecord,
  diffAgainstRequiredFacetPaths,
  diffTier1KeyPaths,
  DIVERGENCE_ALLOWLIST_NEW_SHAPE_PREFIXES,
  DIVERGENCE_IGNORE_NEW_SHAPE_KEYS,
  hasKeyPath,
  leafKeyPaths,
  OLD_SHAPE_SCHEMA_VERSION_REJECTED_BY_WALK,
  parcelNodeIdFromBody,
  readConformantCadClaim,
  REQUIRED_TIER1_FACET_PATHS,
  TIER1_CONFORMANT_FACET_SCHEMA_VERSION,
} from "./lib/nodeFacetBakeTier1Conformant";

// A ~100ft x 150ft rectangular lot near Bastrop, TX (same as the old test).
const LNG0 = -97.31;
const LAT0 = 30.11;
const D_LNG = 0.00032;
const D_LAT = 0.00041;
const BASTROP_LOT: Ring = [
  [LNG0, LAT0],
  [LNG0 + D_LNG, LAT0],
  [LNG0 + D_LNG, LAT0 + D_LAT],
  [LNG0, LAT0 + D_LAT],
  [LNG0, LAT0],
];

const NOW = "2026-08-28T14:00:00.000Z";
const CANONICAL_ACCESS = { discoverability: "catalog-listed", entitlement: "anyone-free" };

/** The txgio row for gold 48021:34137 as production holds it (read 2026-08-28). */
function txgioRow(overrides: Partial<ParcelJoinRow> = {}): ParcelJoinRow {
  return {
    feature_index: 24587,
    prop_id: "34137",
    situs_address: "908 PINE , BASTROP, TX 78602",
    situs_city: "BASTROP",
    situs_state: "TX",
    situs_zip: "78602",
    zoning_district: "SF-1",
    zoning_jurisdiction: "bastrop-city-tx",
    source_vintage: "stratmap25-landparcels_48021_bastrop_202503",
    geometry: { type: "Polygon", coordinates: [BASTROP_LOT] },
    txgio_owner_for_gate: null,
    ...overrides,
  };
}

/** A conformant cad-parcel-roll atom body (hauska-factory stageRows shape). */
function conformantBody(overrides: Record<string, unknown> = {}) {
  return {
    shape: "conformant-v1",
    nodeId: "48021:34137",
    entityType: "cad-parcel-roll",
    claim: {
      kind: "cad-parcel-roll",
      countyFips: "48021",
      sourceIdentifiers: { prop_id: "34137", taxYear: 2025 },
      situsAddress: "908 PINE , BASTROP, TX 78602",
      situsCity: "BASTROP",
      situsZip: "78602",
      // The claim carries the owner. The bake must never read it.
      ownerName: "OWNER MUST NEVER BAKE",
      legalDescription: "LOT 1 BLK 2",
      landValue: 10000,
      improvementValue: 90000,
      marketValue: 100000,
      assessedValue: 100000,
      yearBuilt: 1950,
      livingAreaSqft: 1200,
      landAcres: 0.3815,
      propertyUseCode: "A1",
      centroid: null,
      ...((overrides.claim as Record<string, unknown> | undefined) ?? {}),
    },
    access: CANONICAL_ACCESS,
    ...Object.fromEntries(Object.entries(overrides).filter(([k]) => k !== "claim")),
  };
}

/** The old bake on the same parcel: txgio row + the CAD roll's land-use join. */
function oldPayload(row: ParcelJoinRow, landUseCode: string | null = "A1") {
  const landUse = new Map(
    landUseCode ? [["34137", { landUseCode, landUseVintage: "2025" }]] : [],
  );
  const p = buildTier1Payload(
    { ...row, txgioOwnerForGate: null },
    "48021",
    "Bastrop",
    landUse,
    NOW,
  );
  if (!p) throw new Error("fixture: old bake returned null");
  return p;
}

function newPayload(
  row: ParcelJoinRow | null,
  opts: { gateBlocked?: boolean; body?: Record<string, unknown> } = {},
) {
  return buildConformantTier1Payload({
    body: opts.body ?? conformantBody(),
    parcelNodeId: "48021:34137",
    countyFips: "48021",
    countyName: "Bastrop",
    situsAddress: "908 PINE , BASTROP, TX 78602",
    access: CANONICAL_ACCESS,
    accessNormalizedFrom: null,
    publishRunId: "8e7dc598-e079-41b9-88e1-df1e4c49e33d",
    parcelJoin: {
      table: "txgio_parcel",
      row,
      gateBlocked: opts.gateBlocked ?? false,
    },
    nowIso: NOW,
  });
}

/**
 * The FLAT body the Factory's stage E stores (hauska-factory src/stages/write/index.mjs
 * stageRows spreads the six-field candidate): claim fields at the root, a minted
 * nid_ nodeId, no `claim` key. Field values are the production golds' as read on
 * 2026-08-28 19:54Z and 20:00Z (owner redacted; the reader never touches it).
 */
function flatProductionBody(
  countyFips: string,
  propId: string,
  taxYear: number,
  fields: { situsAddress: string | null; situsCity: string | null; situsZip: string | null; landAcres?: number | null; propertyUseCode?: string | null },
) {
  return {
    kind: "cad-parcel-roll",
    time: { validTo: null, validFrom: `${taxYear}-01-01T00:00:00.000Z`, knowledgeAt: "2026-08-28T08:43:19.097Z" },
    shape: "conformant-v1",
    access: CANONICAL_ACCESS,
    nodeId: "nid_df21d4edd33d1226597be35aec2df3bf",
    centroid: null,
    citation: { locator: "nid_df21d4edd33d1226597be35aec2df3bf", sourceId: "tx:cad-property" },
    situsZip: fields.situsZip,
    landAcres: fields.landAcres ?? null,
    landValue: 0,
    ownerName: "OWNER MUST NEVER BAKE",
    situsCity: fields.situsCity,
    yearBuilt: null,
    confidence: { basis: "county-cad-roll", value: "asserted" },
    countyFips,
    provenance: { class: "Record", sourceId: "tx:cad-property" },
    marketValue: 2120,
    logicVersion: "cad-six-field/1",
    situsAddress: fields.situsAddress,
    assessedValue: null,
    livingAreaSqft: null,
    propertyUseCode: fields.propertyUseCode ?? null,
    improvementValue: 0,
    legalDescription: "LEGAL",
    sourceIdentifiers: { prop_id: propId, taxYear },
  } as Record<string, unknown>;
}

/** The literal thin row production served for 48021:34137 at 12:39Z on 2026-08-28. */
const PRODUCTION_THIN_ROW_2026_08_28 = {
  baked: true,
  access: { entitlement: "anyone-free", discoverability: "catalog-listed" },
  facets: {
    base: {
      apn: "34137",
      parcelNodeId: "48021:34137",
      situsAddress: "908 PINE , BASTROP, TX 78602",
    },
  },
  source: "conformant-v1-cad-parcel-roll",
  shapeSource: "conformant-v1",
  publishRunId: "8e7dc598-e079-41b9-88e1-df1e4c49e33d",
  facetCoverage: { tier1: "populated" },
};

describe("old versus new is a test: same fixture parcel through both bakes", () => {
  it("stamp + claim: every leaf the old bake carries is on the conformant payload; nothing unallowed is added", () => {
    const diff = diffTier1KeyPaths(oldPayload(txgioRow()), newPayload(txgioRow()));
    expect(diff.missing).toEqual([]);
    expect(diff.unexpected).toEqual([]);
    // The old leaf set is not trivially small (zoning + provenance + envelope
    // are all present on a stamped parcel).
    expect(diff.oldLeafCount).toBeGreaterThan(30);
  });

  it("stamp + claim: the derived VALUES agree where both bakes read the same source", () => {
    const o = oldPayload(txgioRow());
    const n = newPayload(txgioRow());
    expect(n.zoning).toEqual(o.zoning);
    expect(n.envelope).toEqual(o.envelope);
    expect(n.baseFacts.acreage).toEqual(o.baseFacts.acreage);
    expect(n.baseFacts.apn).toBe(o.baseFacts.apn);
    expect(n.baseFacts.situsAddress).toBe(o.baseFacts.situsAddress);
    expect(n.baseFacts.situsCity).toBe(o.baseFacts.situsCity);
    expect(n.baseFacts.situsCity).toBe("BASTROP");
    expect(n.baseFacts.situsState).toBe(o.baseFacts.situsState);
    // Card F: the two new base-fact paths agree in value as well as in presence.
    expect(n.baseFacts.situsZip).toBe(o.baseFacts.situsZip);
    expect(n.baseFacts.situsZip).toBe("78602");
    expect(n.baseFacts.landUse?.code).toBe("A1");
    expect(n.baseFacts.landUse?.description).toBe(o.baseFacts.landUse?.description);
    expect(n.baseFacts.landUse?.source).toBe("cad-roll");
    expect(n.baseFacts.landUse?.vintage).toBe("2025");
    expect(n.facetCoverage).toEqual({ ...o.facetCoverage, tier1: "populated" });
    expect(n.provenance.zoningSource).toBe(o.provenance.zoningSource);
    expect(n.provenance.parcelSource).toBe("conformant-v1-cad-parcel-roll");
    expect(n.provenance.parcelJoin).toMatchObject({
      table: "txgio_parcel",
      state: "joined",
      featureIndex: 24587,
      sourceVintage: "stratmap25-landparcels_48021_bastrop_202503",
    });
  });

  it("no stamp: zoning is an explicit null, envelope declines no-zoning-stamp, every key stays present", () => {
    const row = txgioRow({ zoning_district: null, zoning_jurisdiction: null });
    const o = oldPayload(row);
    const n = newPayload(row);
    expect(n.zoning).toBeNull();
    expect(n.facetCoverage.zoning).toBe(false);
    expect(n.envelope?.status).toBe("declined");
    expect(n.envelope?.declineReason).toBe("no-zoning-stamp");
    expect(hasKeyPath(n, "zoning")).toBe(true);
    expect(hasKeyPath(n, "envelope")).toBe(true);
    const diff = diffTier1KeyPaths(o, n);
    expect(diff.missing).toEqual([]);
    expect(diff.unexpected).toEqual([]);
  });

  it("kept new-shape keys: shapeSource, access, publishRunId, source, facets.base, facetCoverage.tier1", () => {
    const n = newPayload(txgioRow());
    expect(n.shapeSource).toBe("conformant-v1");
    expect(n.source).toBe("conformant-v1-cad-parcel-roll");
    expect(n.access).toEqual(CANONICAL_ACCESS);
    expect(n).not.toHaveProperty("accessNormalizedFrom");
    expect(n.publishRunId).toBe("8e7dc598-e079-41b9-88e1-df1e4c49e33d");
    expect(n.facets.base).toEqual({
      parcelNodeId: "48021:34137",
      situsAddress: "908 PINE , BASTROP, TX 78602",
      apn: "34137",
    });
    expect(n.facetCoverage.tier1).toBe("populated");
    // The body still says conformant-v1 (the Factory walk greps for it).
    expect(JSON.stringify(n)).toContain("conformant-v1");
  });

  it("facetSchemaVersion is NOT the literal hauska-factory verify-walk.mjs rejects as old shape", () => {
    const n = newPayload(txgioRow());
    expect(n.facetSchemaVersion).toBe(TIER1_CONFORMANT_FACET_SCHEMA_VERSION);
    expect(n.facetSchemaVersion).not.toBe(OLD_SHAPE_SCHEMA_VERSION_REJECTED_BY_WALK);
  });
});

describe("explicit absence where a facet has no source (never an omitted key)", () => {
  it("no txgio row: zoning null, envelope null, acreage from the claim's landAcres under its own method, parcelJoin no-row", () => {
    const n = newPayload(null);
    expect(n.zoning).toBeNull();
    expect(n.envelope).toBeNull();
    expect(n.baseFacts.situsState).toBeNull();
    expect(n.baseFacts.acreage).toEqual({
      value: 0.3815,
      sqft: Math.round(0.3815 * 43560),
      method: "cad-roll-land-acres",
    });
    expect(n.facetCoverage).toEqual({
      baseFacts: true,
      landUse: true,
      acreage: true,
      zoning: false,
      envelope: false,
      tier1: "populated",
    });
    expect(n.provenance.parcelJoin.state).toBe("no-row");
    expect(n.provenance.parcelVintage).toBe("2025");
    const req = diffAgainstRequiredFacetPaths(n);
    expect(req.missing).toEqual([]);
    expect(req.unexpectedRoots).toEqual([]);
  });

  it("no txgio row and no landAcres and no use code: every facet is an explicit null and coverage says so", () => {
    const n = newPayload(null, {
      body: conformantBody({ claim: { landAcres: null, propertyUseCode: null } }),
    });
    expect(n.baseFacts.landUse).toBeNull();
    expect(n.baseFacts.acreage).toBeNull();
    expect(n.zoning).toBeNull();
    expect(n.envelope).toBeNull();
    expect(n.facetCoverage.landUse).toBe(false);
    expect(n.facetCoverage.acreage).toBe(false);
    expect(n.provenance.landUseSource).toBeNull();
    expect(diffAgainstRequiredFacetPaths(n).missing).toEqual([]);
  });

  it("gate-blocked county: an offered row is NOT used (fail closed), and the join state says gate-blocked", () => {
    const n = newPayload(txgioRow(), { gateBlocked: true });
    expect(n.zoning).toBeNull();
    expect(n.envelope).toBeNull();
    expect(n.baseFacts.situsState).toBeNull();
    // Acreage comes from the claim, not the (refused) ring.
    expect(n.baseFacts.acreage?.method).toBe("cad-roll-land-acres");
    expect(n.provenance.parcelJoin.state).toBe("gate-blocked");
    expect(n.provenance.parcelJoin.basis).toMatch(/unmeasured/);
    // Land use is the claim's own field: the join gate does not strip it.
    expect(n.baseFacts.landUse?.code).toBe("A1");
    expect(n.provenance.landUseGateBlocked).toBe(false);
    expect(diffAgainstRequiredFacetPaths(n).missing).toEqual([]);
  });

  it("the situs the guard validated is what both facets.base and baseFacts carry (null when absent)", () => {
    const n = buildConformantTier1Payload({
      body: conformantBody({ claim: { situsAddress: null } }),
      parcelNodeId: "48021:34137",
      countyFips: "48021",
      situsAddress: null,
      access: CANONICAL_ACCESS,
      accessNormalizedFrom: null,
      publishRunId: undefined,
      parcelJoin: { table: "txgio_parcel", row: txgioRow(), gateBlocked: false },
      nowIso: NOW,
    });
    expect(n.facets.base.situsAddress).toBeNull();
    expect(n.baseFacts.situsAddress).toBeNull();
    expect(n.facetCoverage.baseFacts).toBe(true); // apn still present
    expect(n).not.toHaveProperty("publishRunId");
    expect(n.countyName).toBe("Bastrop");
  });
});

describe("owner never enters a baked payload", () => {
  it("the claim's ownerName is not read and not serialized", () => {
    const n = newPayload(txgioRow({ txgio_owner_for_gate: "TXGIO OWNER" }));
    expect(() => assertNoOwnerKey(n)).not.toThrow();
    expect(JSON.stringify(n)).not.toMatch(/OWNER MUST NEVER BAKE|TXGIO OWNER/);
    expect(JSON.stringify(n)).not.toMatch(/"owner/i);
    expect(Object.keys(readConformantCadClaim(conformantBody()))).not.toContain("ownerName");
  });

  it("the guard can fail: an injected owner-shaped key at depth is refused with OWNER_KEY_IN_PAYLOAD", () => {
    const n = newPayload(txgioRow()) as unknown as Record<string, unknown>;
    const poisoned = {
      ...n,
      baseFacts: { ...(n.baseFacts as Record<string, unknown>), owner_name: "LEAK" },
    };
    expect(() => assertNoOwnerKey(poisoned)).toThrow(
      expect.objectContaining({ code: "OWNER_KEY_IN_PAYLOAD" }),
    );
    expect(() => assertNoOwnerKey({ ...n, txgioOwner: "LEAK" })).toThrow();
  });
});

describe("the divergence instrument fails when it should", () => {
  it("a thinned payload is caught: deleting zoning and baseFacts.landUse lists them as missing", () => {
    const o = oldPayload(txgioRow());
    const n = newPayload(txgioRow()) as unknown as Record<string, unknown>;
    const thinned = {
      ...n,
      baseFacts: Object.fromEntries(
        Object.entries(n.baseFacts as Record<string, unknown>).filter(([k]) => k !== "landUse"),
      ),
    };
    delete (thinned as Record<string, unknown>).zoning;
    const diff = diffTier1KeyPaths(o, thinned);
    expect(diff.missing).toContain("zoning.district");
    expect(diff.missing).toContain("baseFacts.landUse.code");
    expect(diff.missing.length).toBeGreaterThanOrEqual(6);
    const req = diffAgainstRequiredFacetPaths(thinned);
    expect(req.missing).toEqual(["baseFacts.landUse", "zoning"]);
  });

  it("the production thin row of 2026-08-28 12:39Z fails on every required facet path (the regression fixture)", () => {
    const req = diffAgainstRequiredFacetPaths(PRODUCTION_THIN_ROW_2026_08_28);
    expect(req.missing).toEqual([...REQUIRED_TIER1_FACET_PATHS]);
    expect(req.present).toBe(0);
    expect(req.unexpectedRoots).toEqual([]);
    const strict = diffTier1KeyPaths(oldPayload(txgioRow()), PRODUCTION_THIN_ROW_2026_08_28);
    expect(strict.missing.length).toBe(strict.oldLeafCount);
  });

  it("an unallowed new root key is reported as unexpected", () => {
    const n = { ...(newPayload(txgioRow()) as unknown as Record<string, unknown>), bonus: 1 };
    expect(diffTier1KeyPaths(oldPayload(txgioRow()), n).unexpected).toEqual(["bonus"]);
    expect(diffAgainstRequiredFacetPaths(n).unexpectedRoots).toEqual(["bonus"]);
  });

  it("REQUIRED_TIER1_FACET_PATHS is exactly the old bake's leaf set on a parcel with no stamp, no ring and no land-use (cannot drift from the code)", () => {
    const bare = buildTier1Payload(
      {
        feature_index: 1,
        prop_id: "34137",
        situs_address: null,
        situs_city: null,
        situs_state: null,
        zoning_district: null,
        zoning_jurisdiction: null,
        source_vintage: null,
        geometry: null,
        txgioOwnerForGate: null,
      },
      "48021",
      "Bastrop",
      new Map(),
      NOW,
    );
    expect(bare).not.toBeNull();
    expect([...leafKeyPaths(bare)].sort()).toEqual([...REQUIRED_TIER1_FACET_PATHS].sort());
  });

  it("the ignore list and the allowlist are the ones the card names", () => {
    expect([...DIVERGENCE_IGNORE_NEW_SHAPE_KEYS].sort()).toEqual(
      ["access", "accessNormalizedFrom", "baked", "publishRunId", "shapeSource", "source"].sort(),
    );
    expect([...DIVERGENCE_ALLOWLIST_NEW_SHAPE_PREFIXES].sort()).toEqual(
      ["facetCoverage.tier1", "facets.base", "provenance.parcelJoin"].sort(),
    );
  });
});

describe("claim reading and node identity", () => {
  it("reads claim fields by name, never defaults, coerces numeric strings, and ignores the owner", () => {
    const c = readConformantCadClaim(
      conformantBody({ claim: { landAcres: "0.5", propertyUseCode: " B2 " } }) as Record<string, unknown>,
    );
    expect(c).toEqual({
      countyFips: "48021",
      propId: "34137",
      taxYear: 2025,
      situsAddress: "908 PINE , BASTROP, TX 78602",
      situsCity: "BASTROP",
      situsZip: "78602",
      landAcres: 0.5,
      propertyUseCode: "B2",
    });
    expect(readConformantCadClaim({})).toEqual({
      countyFips: null,
      propId: null,
      taxYear: null,
      situsAddress: null,
      situsCity: null,
      situsZip: null,
      landAcres: null,
      propertyUseCode: null,
    });
  });

  it("card F: the FLAT body hauska_mcp actually stores (claim fields at the root, minted nid_ nodeId, no body.claim) is read by name; every field the nested reader read is read here", () => {
    const flat = flatProductionBody("48453", "493738", 2026, { situsAddress: "4707 SHOALWOOD AVE", situsCity: "AUSTIN", situsZip: "78756" });
    expect(flat).not.toHaveProperty("claim");
    expect(conformantClaimRecord(flat).placement).toBe("flat");
    expect(conformantClaimRecord(conformantBody()).placement).toBe("nested");
    expect(readConformantCadClaim(flat)).toEqual({
      countyFips: "48453",
      propId: "493738",
      taxYear: 2026,
      situsAddress: "4707 SHOALWOOD AVE",
      situsCity: "AUSTIN",
      situsZip: "78756",
      landAcres: null,
      propertyUseCode: null,
    });
    // A flat body with a use code and acreage reaches the bake too (until card F both baked null on every production row).
    const withUse = flatProductionBody("48021", "34137", 2025, { situsAddress: "908 PINE , BASTROP, TX 78602", situsCity: "BASTROP", situsZip: "78602", landAcres: 0.3815, propertyUseCode: "A1" });
    expect(readConformantCadClaim(withUse)).toMatchObject({ landAcres: 0.3815, propertyUseCode: "A1", situsCity: "BASTROP", situsZip: "78602" });
    // The nested placement reads identically: one reader, two placements, same values.
    const nested = { claim: { ...withUse }, access: withUse.access };
    expect(readConformantCadClaim(nested)).toEqual(readConformantCadClaim(withUse));
    expect(parcelNodeIdFromBody(flat, "48453")).toBe("48453:493738");
  });

  it("card F: a claim with a city bakes a city and a zip (flat production bodies of the golds)", () => {
    const travis = buildConformantTier1Payload({
      body: flatProductionBody("48453", "493738", 2026, { situsAddress: "4707 SHOALWOOD AVE", situsCity: "AUSTIN", situsZip: "78756" }),
      parcelNodeId: "48453:493738",
      countyFips: "48453",
      situsAddress: "4707 SHOALWOOD AVE",
      access: CANONICAL_ACCESS,
      accessNormalizedFrom: null,
      publishRunId: undefined,
      parcelJoin: { table: "txgio_parcel", row: null, gateBlocked: false },
      nowIso: NOW,
    });
    expect(travis.baseFacts.situsCity).toBe("AUSTIN");
    expect(travis.baseFacts.situsZip).toBe("78756");
    expect(travis.provenance.parcelVintage).toBe("2026");
    expect(travis.countyName).toBe("Travis");
    const bastrop = buildConformantTier1Payload({
      body: flatProductionBody("48021", "34137", 2025, { situsAddress: "908 PINE , BASTROP, TX 78602", situsCity: "BASTROP", situsZip: "78602" }),
      parcelNodeId: "48021:34137",
      countyFips: "48021",
      situsAddress: "908 PINE , BASTROP, TX 78602",
      access: CANONICAL_ACCESS,
      accessNormalizedFrom: null,
      publishRunId: undefined,
      parcelJoin: { table: "txgio_parcel", row: txgioRow(), gateBlocked: false },
      nowIso: NOW,
    });
    expect(bastrop.baseFacts.situsCity).toBe("BASTROP");
    expect(bastrop.baseFacts.situsZip).toBe("78602");
    expect(bastrop.zoning?.district).toBe("SF-1");
    // Explicit null, never an omitted key, when the claim carries no city or zip
    // (the literal 48021 prop 10090 body read 2026-08-28: situs ", ,", city and zip null).
    const noCity = buildConformantTier1Payload({
      body: flatProductionBody("48021", "10090", 2025, { situsAddress: null, situsCity: null, situsZip: null }),
      parcelNodeId: "48021:10090",
      countyFips: "48021",
      situsAddress: null,
      access: CANONICAL_ACCESS,
      accessNormalizedFrom: null,
      publishRunId: undefined,
      parcelJoin: { table: "txgio_parcel", row: null, gateBlocked: false },
      nowIso: NOW,
    });
    expect(noCity.baseFacts.situsCity).toBeNull();
    expect(noCity.baseFacts.situsZip).toBeNull();
    expect(hasKeyPath(noCity, "baseFacts.situsCity")).toBe(true);
    expect(hasKeyPath(noCity, "baseFacts.situsZip")).toBe(true);
    expect(JSON.stringify(noCity)).not.toMatch(/owner/i);
  });

  it("card F: the divergence test carries baseFacts.situsCity and baseFacts.situsZip (a thinned payload missing either is caught)", () => {
    const o = oldPayload(txgioRow());
    const n = newPayload(txgioRow()) as unknown as Record<string, unknown>;
    expect(REQUIRED_TIER1_FACET_PATHS).toContain("baseFacts.situsCity");
    expect(REQUIRED_TIER1_FACET_PATHS).toContain("baseFacts.situsZip");
    const thinned = { ...n, baseFacts: Object.fromEntries(Object.entries(n.baseFacts as Record<string, unknown>).filter(([k]) => k !== "situsCity" && k !== "situsZip")) };
    const diff = diffTier1KeyPaths(o, thinned);
    expect(diff.missing).toEqual(["baseFacts.situsCity", "baseFacts.situsZip"]);
    expect(diffAgainstRequiredFacetPaths(thinned).missing).toEqual(["baseFacts.situsCity", "baseFacts.situsZip"]);
    // The literal 2026-08-28 production row for 48453:493738 (read 19:48Z) carried situsCity null and NO situsZip key.
    const productionRow = { ...n, baseFacts: { apn: "493738", acreage: null, landUse: null, situsCity: null, situsState: null, situsAddress: "4707 SHOALWOOD AVE" } };
    expect(diffAgainstRequiredFacetPaths(productionRow).missing).toEqual(["baseFacts.situsZip"]);
  });

  it("conformantAcreageFromClaim refuses zero, negative and non-finite (never a fabricated 0)", () => {
    expect(conformantAcreageFromClaim(0)).toBeNull();
    expect(conformantAcreageFromClaim(-1)).toBeNull();
    expect(conformantAcreageFromClaim(Number.NaN)).toBeNull();
    expect(conformantAcreageFromClaim(null)).toBeNull();
    expect(conformantAcreageFromClaim(1)).toEqual({ value: 1, sqft: 43560, method: "cad-roll-land-acres" });
  });

  it("parcelNodeIdFromBody: nodeId first, then county:prop_id, never invented", () => {
    expect(parcelNodeIdFromBody({ nodeId: "48021:34137" }, "48021")).toBe("48021:34137");
    expect(parcelNodeIdFromBody({ claim: { sourceIdentifiers: { prop_id: "34137" } } }, "48021")).toBe("48021:34137");
    expect(parcelNodeIdFromBody({ sourceIdentifiers: { prop_id: 34137 } }, "48021")).toBe("48021:34137");
    expect(parcelNodeIdFromBody({ claim: {} }, "48021")).toBeNull();
  });
});
