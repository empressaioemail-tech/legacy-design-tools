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
import type { AddressLandUseEntry } from "./lib/joinIntegrityGate";
import {
  addressJoinKey,
  LANDUSE_JOIN_DISABLED_FIPS_SEED,
  landUseJoinKey,
  normalizeSitusAddress,
} from "./lib/joinNormalize";
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
  type ConformantTier1BuildInput,
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
  opts: {
    gateBlocked?: boolean;
    body?: Record<string, unknown>;
    countyFips?: string;
    countyName?: string;
    parcelNodeId?: string;
    situsAddress?: string | null;
    situsRow?: ParcelJoinRow | null;
    situsRecovery?: ConformantTier1BuildInput["situsRecovery"];
  } = {},
) {
  return buildConformantTier1Payload({
    body: opts.body ?? conformantBody(),
    parcelNodeId: opts.parcelNodeId ?? "48021:34137",
    countyFips: opts.countyFips ?? "48021",
    countyName: opts.countyName ?? "Bastrop",
    situsAddress: opts.situsAddress ?? "908 PINE , BASTROP, TX 78602",
    access: CANONICAL_ACCESS,
    accessNormalizedFrom: null,
    publishRunId: "8e7dc598-e079-41b9-88e1-df1e4c49e33d",
    parcelJoin: {
      table: "txgio_parcel",
      row,
      gateBlocked: opts.gateBlocked ?? false,
      ...(opts.situsRow !== undefined ? { situsRow: opts.situsRow } : {}),
    },
    ...(opts.situsRecovery ? { situsRecovery: opts.situsRecovery } : {}),
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

// ---------------------------------------------------------------------------
// CTX card H: owner-gated situs recovery on the conformant bake.
// These fixtures fail on origin/main (gate-blocked drops the offered row;
// landUseAddressRecovered is hardcoded false; no joined-situs state) and
// pass only after the recovery is wired. The seed is not lifted.
// ---------------------------------------------------------------------------

const HAYS_SITUS = "275 CIBOLO CREEK DR, KYLE, TX 78640";
const HAYS_ADDR_KEY = normalizeSitusAddress(HAYS_SITUS);
const WILL_SITUS = "1804 DAVIS ST, TAYLOR, TX 76574";
const WILL_ADDR_KEY = normalizeSitusAddress(WILL_SITUS);

function addrLookup(key: string, owner: string | null, code = "A1"): Map<string, AddressLandUseEntry> {
  return new Map([[key, { code, vintage: "2025", owner }]]);
}

function haysBody(overrides: Record<string, unknown> = {}) {
  return conformantBody({
    nodeId: "48209:135570",
    claim: {
      countyFips: "48209",
      sourceIdentifiers: { prop_id: "135570", taxYear: 2025 },
      situsAddress: HAYS_SITUS,
      situsCity: "KYLE",
      situsZip: "78640",
      propertyUseCode: "A1",
      ...overrides,
    },
  });
}

describe("CTX card H: situs recovery on blocked counties, never prop_id", () => {
  it("seed is still {48209, 48491} and landUseJoinKey stays null for both", () => {
    expect([...LANDUSE_JOIN_DISABLED_FIPS_SEED].sort()).toEqual(["48209", "48491"]);
    expect(landUseJoinKey("48209", "135570")).toBeNull();
    expect(landUseJoinKey("48209", "any")).toBeNull();
    expect(landUseJoinKey("48491", "76149")).toBeNull();
    expect(landUseJoinKey("48491", "R062578")).toBeNull();
  });

  it("blocked county: an offered prop_id txgio row is still unused (fail closed)", () => {
    const colliding = txgioRow({
      prop_id: "135570",
      zoning_district: "FABRICATED",
      zoning_jurisdiction: "wrong-city",
      situs_state: "TX",
    });
    const n = newPayload(colliding, {
      gateBlocked: true,
      body: haysBody(),
      countyFips: "48209",
      countyName: "Hays",
      parcelNodeId: "48209:135570",
      situsAddress: HAYS_SITUS,
    });
    expect(n.zoning).toBeNull();
    expect(n.envelope).toBeNull();
    expect(n.baseFacts.situsState).toBeNull();
    expect(n.provenance.parcelJoin.state).toBe("gate-blocked");
    expect(n.provenance.landUseAddressRecovered).toBe(false);
  });

  it("blocked county + owners AGREE: land-use recovered, source cad-roll-address-join", () => {
    const n = newPayload(null, {
      gateBlocked: true,
      body: haysBody(),
      countyFips: "48209",
      countyName: "Hays",
      parcelNodeId: "48209:135570",
      situsAddress: HAYS_SITUS,
      situsRecovery: {
        addressLandUse: addrLookup(HAYS_ADDR_KEY, "PURVIS MICHAEL", "F1"),
        txgioOwner: "PURVIS, MICHAEL J",
      },
    });
    expect(n.baseFacts.landUse?.code).toBe("F1");
    expect(n.baseFacts.landUse?.source).toBe("cad-roll-address-join");
    expect(n.provenance.landUseSource).toBe("cad-roll-address-join");
    expect(n.provenance.landUseAddressRecovered).toBe(true);
    expect(n.facetCoverage.landUse).toBe(true);
    expect(n.provenance.parcelJoin.state).toBe("joined-situs");
    expect(n.provenance.parcelJoin.basis).toMatch(/situs/i);
    expect(n.provenance.parcelJoin.basis).not.toMatch(/prop_id/);
  });

  it("blocked county + owners DISAGREE: land-use null (never the mismatched code)", () => {
    const n = newPayload(null, {
      gateBlocked: true,
      body: haysBody(),
      countyFips: "48209",
      countyName: "Hays",
      parcelNodeId: "48209:135570",
      situsAddress: HAYS_SITUS,
      situsRecovery: {
        addressLandUse: addrLookup(HAYS_ADDR_KEY, "PURVIS MICHAEL", "F1"),
        txgioOwner: "BREM SARAH",
      },
    });
    expect(n.baseFacts.landUse).toBeNull();
    expect(n.facetCoverage.landUse).toBe(false);
    expect(n.provenance.landUseSource).toBeNull();
    expect(n.provenance.landUseAddressRecovered).toBe(false);
    expect(n.provenance.parcelJoin.state).toBe("gate-blocked");
  });

  it("blocked county + blank owner: land-use null", () => {
    const blankCad = newPayload(null, {
      gateBlocked: true,
      body: haysBody(),
      countyFips: "48209",
      countyName: "Hays",
      parcelNodeId: "48209:135570",
      situsAddress: HAYS_SITUS,
      situsRecovery: {
        addressLandUse: addrLookup(HAYS_ADDR_KEY, null, "F1"),
        txgioOwner: "PURVIS MICHAEL",
      },
    });
    expect(blankCad.baseFacts.landUse).toBeNull();
    expect(blankCad.provenance.landUseAddressRecovered).toBe(false);

    const blankTxgio = newPayload(null, {
      gateBlocked: true,
      body: haysBody(),
      countyFips: "48209",
      countyName: "Hays",
      parcelNodeId: "48209:135570",
      situsAddress: HAYS_SITUS,
      situsRecovery: {
        addressLandUse: addrLookup(HAYS_ADDR_KEY, "PURVIS MICHAEL", "F1"),
        txgioOwner: null,
      },
    });
    expect(blankTxgio.baseFacts.landUse).toBeNull();
    expect(blankTxgio.provenance.parcelJoin.state).toBe("gate-blocked");
  });

  it("blocked county + blank situs: land-use null (addressJoinKey is null)", () => {
    expect(addressJoinKey("48209", null)).toBeNull();
    expect(addressJoinKey("48209", "")).toBeNull();
    const n = newPayload(null, {
      gateBlocked: true,
      body: haysBody({ situsAddress: null }),
      countyFips: "48209",
      countyName: "Hays",
      parcelNodeId: "48209:135570",
      situsAddress: null,
      situsRecovery: {
        addressLandUse: addrLookup(HAYS_ADDR_KEY, "PURVIS MICHAEL", "F1"),
        txgioOwner: "PURVIS MICHAEL",
      },
    });
    expect(n.baseFacts.landUse).toBeNull();
    expect(n.provenance.landUseAddressRecovered).toBe(false);
    expect(n.provenance.parcelJoin.state).toBe("gate-blocked");
  });

  it("situs-keyed row is used; prop_id-keyed row on the same blocked parcel is ignored", () => {
    const propIdRow = txgioRow({
      feature_index: 1,
      prop_id: "135570",
      zoning_district: "WRONG-PROP-ID",
      zoning_jurisdiction: "fabricated-city",
      situs_address: "999 COLLISION RD",
      situs_state: "ZZ",
      geometry: {
        type: "Polygon",
        coordinates: [[
          [-98, 29],
          [-98.001, 29],
          [-98.001, 29.001],
          [-98, 29.001],
          [-98, 29],
        ]],
      },
    });
    const situsRow = txgioRow({
      feature_index: 99,
      prop_id: "TXGIO-OTHER",
      situs_address: HAYS_SITUS,
      situs_city: "KYLE",
      situs_state: "TX",
      situs_zip: "78640",
      zoning_district: "SF-2",
      zoning_jurisdiction: "kyle-city-tx",
      source_vintage: "stratmap25-landparcels_48209_hays_202503",
      txgio_owner_for_gate: "PURVIS MICHAEL",
    });
    const n = newPayload(propIdRow, {
      gateBlocked: true,
      body: haysBody(),
      countyFips: "48209",
      countyName: "Hays",
      parcelNodeId: "48209:135570",
      situsAddress: HAYS_SITUS,
      situsRow,
      situsRecovery: {
        addressLandUse: addrLookup(HAYS_ADDR_KEY, "PURVIS MICHAEL", "A1"),
        txgioOwner: "PURVIS MICHAEL",
      },
    });
    expect(n.zoning?.district).toBe("SF-2");
    expect(n.zoning?.jurisdictionKey).toBe("kyle_city_tx");
    expect(n.baseFacts.situsState).toBe("TX");
    expect(n.baseFacts.landUse?.source).toBe("cad-roll-address-join");
    expect(n.provenance.landUseAddressRecovered).toBe(true);
    expect(n.provenance.parcelJoin.state).toBe("joined-situs");
    expect(n.provenance.parcelJoin).toMatchObject({
      table: "txgio_parcel",
      state: "joined-situs",
      featureIndex: 99,
      sourceVintage: "stratmap25-landparcels_48209_hays_202503",
    });
    expect(n.provenance.parcelJoin.basis).toMatch(/situs/i);
    expect(n.provenance.parcelJoin.basis).not.toMatch(/prop_id/);
    expect(n.zoning?.district).not.toBe("WRONG-PROP-ID");
    expect(n.envelope).not.toBeNull();
  });

  it("non-blocked county: addressJoinKey is null; prop_id join and cad-roll land-use stay", () => {
    expect(addressJoinKey("48021", "908 PINE , BASTROP, TX 78602")).toBeNull();
    expect(addressJoinKey("48453", WILL_SITUS)).toBeNull();
    expect(addressJoinKey("48055", HAYS_SITUS)).toBeNull();
    expect(addressJoinKey("48309", HAYS_SITUS)).toBeNull();
    const situsRow = txgioRow({
      zoning_district: "SHOULD-NOT-USE",
      feature_index: 777,
    });
    const n = newPayload(txgioRow(), {
      gateBlocked: false,
      situsRow,
      situsRecovery: {
        addressLandUse: addrLookup(
          normalizeSitusAddress("908 PINE , BASTROP, TX 78602"),
          "OWNER X",
          "Z9",
        ),
        txgioOwner: "OWNER X",
      },
    });
    expect(n.baseFacts.landUse?.code).toBe("A1");
    expect(n.baseFacts.landUse?.source).toBe("cad-roll");
    expect(n.provenance.landUseAddressRecovered).toBe(false);
    expect(n.provenance.parcelJoin.state).toBe("joined");
    expect(n.zoning?.district).toBe("SF-1");
    expect(n.zoning?.district).not.toBe("SHOULD-NOT-USE");
  });

  it("Williamson gold shape recovers the same way (agree) and refuses a prop_id row", () => {
    const propIdRow = txgioRow({
      prop_id: "76149",
      zoning_district: "COLLISION",
    });
    const situsRow = txgioRow({
      feature_index: 42,
      prop_id: "R-OTHER",
      situs_address: WILL_SITUS,
      situs_city: "TAYLOR",
      situs_state: "TX",
      zoning_district: "R-1",
      zoning_jurisdiction: "taylor-city-tx",
    });
    const n = newPayload(propIdRow, {
      gateBlocked: true,
      body: conformantBody({
        nodeId: "48491:76149",
        claim: {
          countyFips: "48491",
          sourceIdentifiers: { prop_id: "76149", taxYear: 2026 },
          situsAddress: WILL_SITUS,
          situsCity: "TAYLOR",
          situsZip: "76574",
          propertyUseCode: "A1",
        },
      }),
      countyFips: "48491",
      countyName: "Williamson",
      parcelNodeId: "48491:76149",
      situsAddress: WILL_SITUS,
      situsRow,
      situsRecovery: {
        addressLandUse: addrLookup(WILL_ADDR_KEY, "ACME HOLDINGS LLC", "A1"),
        txgioOwner: "ACME HOLDINGS INC",
      },
    });
    expect(n.baseFacts.landUse?.source).toBe("cad-roll-address-join");
    expect(n.provenance.landUseAddressRecovered).toBe(true);
    expect(n.zoning?.district).toBe("R-1");
    expect(n.zoning?.district).not.toBe("COLLISION");
    expect(n.provenance.parcelJoin.state).toBe("joined-situs");
  });

  it("owner never on the wire on the recovery path; an injected owner key is refused", () => {
    const situsRow = txgioRow({
      situs_address: HAYS_SITUS,
      txgio_owner_for_gate: "PURVIS MICHAEL MUST NEVER BAKE",
    });
    const n = newPayload(null, {
      gateBlocked: true,
      body: haysBody(),
      countyFips: "48209",
      countyName: "Hays",
      parcelNodeId: "48209:135570",
      situsAddress: HAYS_SITUS,
      situsRow,
      situsRecovery: {
        addressLandUse: addrLookup(HAYS_ADDR_KEY, "PURVIS MICHAEL", "A1"),
        txgioOwner: "PURVIS MICHAEL MUST NEVER BAKE",
      },
    });
    expect(() => assertNoOwnerKey(n)).not.toThrow();
    expect(JSON.stringify(n)).not.toMatch(/PURVIS|MUST NEVER BAKE/i);
    expect(JSON.stringify(n)).not.toMatch(/"owner/i);
    const poisoned = {
      ...(n as unknown as Record<string, unknown>),
      baseFacts: {
        ...(n.baseFacts as unknown as Record<string, unknown>),
        owner_name: "LEAK",
      },
    };
    expect(() => assertNoOwnerKey(poisoned)).toThrow(
      expect.objectContaining({ code: "OWNER_KEY_IN_PAYLOAD" }),
    );
  });
});
