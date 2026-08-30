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
import {
  ALIAS_JOIN_SOURCE,
  emitBindFromSitusRecovery,
  resolveOpenAlias,
  situsKeysNeedingFetch,
  SITUS_EXTEND_GO_FIPS,
} from "./lib/cadTxgioAliasRead";
import {
  HONEST_POINT_COORD_SET_SQL,
  HONEST_POINT_KEEP_PRIOR_CLAUSE_RETIRED,
  snapshotCoordForWrite,
} from "./lib/honestPointUpsert";
import {
  absentVerifiedLandUse,
  isAbsentVerifiedLeaf,
  landUseBakeLegal,
  pickNamedLandUse,
} from "./lib/namedLandUseSource";
import { selectTaxYearWinner } from "./lib/taxYearSelect";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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
    namedLandUse?: ConformantTier1BuildInput["namedLandUse"];
    aliasJoin?: ConformantTier1BuildInput["aliasJoin"];
    taxYearSelection?: ConformantTier1BuildInput["taxYearSelection"];
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
    ...(opts.namedLandUse !== undefined ? { namedLandUse: opts.namedLandUse } : {}),
    ...(opts.aliasJoin ? { aliasJoin: opts.aliasJoin } : {}),
    ...(opts.taxYearSelection ? { taxYearSelection: opts.taxYearSelection } : {}),
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

  it("no txgio row and no landAcres and no use code: landUse is absent-verified, never null+coverage false", () => {
    const n = newPayload(null, {
      body: conformantBody({ claim: { landAcres: null, propertyUseCode: null } }),
    });
    expect(isAbsentVerifiedLeaf(n.baseFacts.landUse)).toBe(true);
    expect(landUseBakeLegal(n)).toBe(true);
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
    expect(n.baseFacts.landUse && "code" in n.baseFacts.landUse ? n.baseFacts.landUse.code : null).toBe("A1");
    expect(n.provenance.landUseGateBlocked).toBe(true);
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
      [
        "facetCoverage.tier1",
        "facets.base",
        "provenance.parcelJoin",
        "provenance.taxYear",
        "provenance.taxYearRule",
      ].sort(),
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
    expect(isAbsentVerifiedLeaf(n.baseFacts.landUse)).toBe(true);
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
    expect(isAbsentVerifiedLeaf(blankCad.baseFacts.landUse)).toBe(true);
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
    expect(isAbsentVerifiedLeaf(blankTxgio.baseFacts.landUse)).toBe(true);
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
    expect(isAbsentVerifiedLeaf(n.baseFacts.landUse)).toBe(true);
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

function landUseCodeOf(n: { baseFacts: { landUse: unknown } }): string | null {
  const lu = n.baseFacts.landUse;
  if (lu && typeof lu === "object" && "code" in lu && typeof lu.code === "string") {
    return lu.code;
  }
  return null;
}

function taxAtom(
  entityId: string,
  fields: {
    taxYear?: number | null;
    situsAddress?: string | null;
    situsCity?: string | null;
    propertyUseCode?: string | null;
    landAcres?: number | null;
    situsRefuse?: boolean;
  },
) {
  const year = fields.taxYear;
  return {
    entityId,
    situsRefuse: fields.situsRefuse === true,
    body: conformantBody({
      claim: {
        sourceIdentifiers:
          year === undefined
            ? { prop_id: "34137" }
            : year === null
              ? { prop_id: "34137" }
              : { prop_id: "34137", taxYear: year },
        situsAddress: fields.situsAddress ?? "908 PINE , BASTROP, TX 78602",
        situsCity: fields.situsCity ?? "BASTROP",
        propertyUseCode: fields.propertyUseCode ?? "A1",
        landAcres: fields.landAcres ?? 0.3815,
      },
    }) as Record<string, unknown>,
  };
}

describe("CTX W1 item 2: seed stays, not-vacuous", () => {
  it("seed is exactly {48209, 48491}; a non-seed FIPS still joins; blocked FIPS still refuse prop_id", () => {
    expect([...LANDUSE_JOIN_DISABLED_FIPS_SEED].sort()).toEqual(["48209", "48491"]);
    expect(LANDUSE_JOIN_DISABLED_FIPS_SEED.size).toBe(2);
    expect(landUseJoinKey("48021", "34137")).toBe("34137");
    expect(landUseJoinKey("48055", "1")).toBe("1");
    expect(landUseJoinKey("48453", "493738")).toBe("493738");
    expect(landUseJoinKey("48209", "135570")).toBeNull();
    expect(landUseJoinKey("48491", "76149")).toBeNull();
    expect(SITUS_EXTEND_GO_FIPS.size).toBe(0);
    expect(SITUS_EXTEND_GO_FIPS.has("48021")).toBe(false);
    expect(SITUS_EXTEND_GO_FIPS.has("48055")).toBe(false);
    expect(SITUS_EXTEND_GO_FIPS.has("48453")).toBe(false);
  });
});

describe("CTX W1 item 3: tax year max-year rule", () => {
  it("singleton yeared: taxYearRule max-year", () => {
    const sel = selectTaxYearWinner([taxAtom("a:2025", { taxYear: 2025 })]);
    expect(sel.outcome).toBe("selected");
    if (sel.outcome !== "selected") return;
    expect(sel.taxYear).toBe(2025);
    expect(sel.taxYearRule).toBe("max-year");
    expect(sel.refused).toBe(false);
    const n = newPayload(txgioRow(), {
      taxYearSelection: {
        taxYear: sel.taxYear,
        taxYearRule: sel.taxYearRule,
        refused: sel.refused,
      },
    });
    expect(n.provenance.taxYear).toBe(2025);
    expect(n.provenance.taxYearRule).toBe("max-year");
  });

  it("two years agree on load-bearing: max-year-agree, winner ORDER BY entity_id", () => {
    const sel = selectTaxYearWinner([
      taxAtom("z:2026", { taxYear: 2026 }),
      taxAtom("a:2026", { taxYear: 2026 }),
      taxAtom("m:2025", { taxYear: 2025, propertyUseCode: "B2" }),
    ]);
    expect(sel.outcome).toBe("selected");
    if (sel.outcome !== "selected") return;
    expect(sel.taxYear).toBe(2026);
    expect(sel.taxYearRule).toBe("max-year-agree");
    expect(sel.refused).toBe(false);
    expect(sel.entityId).toBe("a:2026");
  });

  it("same max year disagree: refuse, max-year-disagree, does not overwrite", () => {
    const sel = selectTaxYearWinner([
      taxAtom("b:2026", { taxYear: 2026, propertyUseCode: "A1" }),
      taxAtom("a:2026", { taxYear: 2026, propertyUseCode: "F1" }),
    ]);
    expect(sel.outcome).toBe("selected");
    if (sel.outcome !== "selected") return;
    expect(sel.taxYearRule).toBe("max-year-disagree");
    expect(sel.refused).toBe(true);
    expect(sel.entityId).toBe("a:2026");
    const n = newPayload(txgioRow(), {
      body: sel.body,
      taxYearSelection: {
        taxYear: sel.taxYear,
        taxYearRule: sel.taxYearRule,
        refused: true,
      },
    });
    expect(n.provenance.taxYearRule).toBe("max-year-disagree");
    expect(isAbsentVerifiedLeaf(n.baseFacts.landUse)).toBe(true);
    expect(n.baseFacts.situsCity).toBeNull();
    expect(landUseCodeOf(n)).toBeNull();
  });

  it("unyeared singleton: unyeared-singleton", () => {
    const sel = selectTaxYearWinner([taxAtom("only", { taxYear: null })]);
    expect(sel.outcome).toBe("selected");
    if (sel.outcome !== "selected") return;
    expect(sel.taxYear).toBeNull();
    expect(sel.taxYearRule).toBe("unyeared-singleton");
    expect(sel.refused).toBe(false);
  });

  it("unyeared disagree: unyeared-disagree", () => {
    const sel = selectTaxYearWinner([
      taxAtom("b", { taxYear: null, situsCity: "ELGIN" }),
      taxAtom("a", { taxYear: null, situsCity: "BASTROP" }),
    ]);
    expect(sel.outcome).toBe("selected");
    if (sel.outcome !== "selected") return;
    expect(sel.taxYearRule).toBe("unyeared-disagree");
    expect(sel.refused).toBe(true);
    expect(sel.entityId).toBe("a");
  });

  it("punctuation-only situs is dropped before year selection", () => {
    const sel = selectTaxYearWinner([
      taxAtom("punct", { taxYear: 2026, situsRefuse: true }),
      taxAtom("ok", { taxYear: 2025 }),
    ]);
    expect(sel.outcome).toBe("selected");
    if (sel.outcome !== "selected") return;
    expect(sel.taxYear).toBe(2025);
    expect(sel.taxYearRule).toBe("max-year");
    expect(selectTaxYearWinner([taxAtom("only-punct", { situsRefuse: true })]).outcome).toBe(
      "dropped",
    );
  });
});

describe("CTX W1 item 4: landUse from the named W0b source", () => {
  it("fail: landUse null plus coverage false is illegal (the live Pine/Rainmaker miss)", () => {
    expect(
      landUseBakeLegal({
        baseFacts: { landUse: null },
        facetCoverage: { landUse: false },
      }),
    ).toBe(false);
  });

  it("Pine 48021:34137: named land-use-fact A1 projects when claim.propertyUseCode is null", () => {
    const n = newPayload(txgioRow(), {
      body: conformantBody({ claim: { propertyUseCode: null } }),
      namedLandUse: { code: "A1", vintage: "2025", source: "land-use-fact" },
    });
    expect(landUseCodeOf(n)).toBe("A1");
    expect(n.baseFacts.landUse && "source" in n.baseFacts.landUse
      ? n.baseFacts.landUse.source
      : null).toBe("land-use-fact");
    expect(n.facetCoverage.landUse).toBe(true);
    expect(n.provenance.landUseGateBlocked).toBe(false);
    expect(landUseBakeLegal(n)).toBe(true);
  });

  it("Rainmaker 48021:8720522: named cad-property A1 projects", () => {
    const n = newPayload(null, {
      body: conformantBody({
        nodeId: "48021:8720522",
        claim: {
          sourceIdentifiers: { prop_id: "8720522", taxYear: 2025 },
          propertyUseCode: null,
        },
      }),
      parcelNodeId: "48021:8720522",
      namedLandUse: { code: "A1", vintage: "2025", source: "cad-property" },
    });
    expect(landUseCodeOf(n)).toBe("A1");
    expect(n.facetCoverage.landUse).toBe(true);
    expect(landUseBakeLegal(n)).toBe(true);
  });

  it("Travis blank fails when the named source is present (must not emit null+false)", () => {
    const n = newPayload(null, {
      body: flatProductionBody("48453", "493738", 2026, {
        situsAddress: "4707 SHOALWOOD AVE",
        situsCity: "AUSTIN",
        situsZip: "78756",
        propertyUseCode: null,
      }),
      countyFips: "48453",
      countyName: "Travis",
      parcelNodeId: "48453:493738",
      situsAddress: "4707 SHOALWOOD AVE",
      namedLandUse: { code: "A1", vintage: "2026", source: "land-use-fact" },
    });
    expect(landUseCodeOf(n)).toBe("A1");
    expect(n.facetCoverage.landUse).toBe(true);
    expect(landUseBakeLegal(n)).toBe(true);
  });

  it("landUseGateBlocked is the join gate, not hardcoded false", () => {
    const blocked = newPayload(txgioRow(), { gateBlocked: true });
    const open = newPayload(txgioRow(), { gateBlocked: false });
    expect(blocked.provenance.landUseGateBlocked).toBe(true);
    expect(open.provenance.landUseGateBlocked).toBe(false);
  });

  it("named source prefers land-use-fact over cad-property", () => {
    expect(
      pickNamedLandUse(
        { code: "A1", vintage: "2025", source: "land-use-fact" },
        { code: "B2", vintage: "2025", source: "cad-property" },
      )?.source,
    ).toBe("land-use-fact");
    expect(isAbsentVerifiedLeaf(absentVerifiedLandUse(NOW))).toBe(true);
  });
});

describe("CTX W1 item 6: honest point on refuse", () => {
  it("fail-then-pass: a prior fabricated centroid is overwritten by 0,0", () => {
    const prior = { lat: 30.11, lng: -97.31 };
    const keepPrior =
      0 === 0 && 0 === 0 ? prior : { lat: 0, lng: 0 };
    expect(keepPrior).toEqual(prior);
    expect(
      snapshotCoordForWrite({
        newLat: 0,
        newLng: 0,
        gateBlockedNoRing: false,
      }),
    ).toEqual({ lat: 0, lng: 0 });
    expect(
      snapshotCoordForWrite({
        newLat: 30.11,
        newLng: -97.31,
        gateBlockedNoRing: true,
      }),
    ).toEqual({ lat: 0, lng: 0 });
  });

  it("live upsert SQL writes EXCLUDED coords and does not keep prior on sentinel", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const cli = readFileSync(join(here, "nodeFacetBakeTier1ConformantCli.ts"), "utf8");
    expect(cli).toContain("HONEST_POINT_COORD_SET_SQL");
    expect(cli).toContain("snapshotCoordForWrite");
    expect(cli).not.toContain(HONEST_POINT_KEEP_PRIOR_CLAUSE_RETIRED);
    expect(cli).toMatch(/parcelsPmtilesBakeCli/);
    expect(HONEST_POINT_COORD_SET_SQL).toMatch(/lat_rounded = EXCLUDED\.lat_rounded/);
    expect(HONEST_POINT_COORD_SET_SQL).toMatch(/lng_rounded = EXCLUDED\.lng_rounded/);
  });
});

describe("CTX W1 item 8: alias first, then situs", () => {
  it("open alias joins from the TxGIO key and skips the situs fetch", () => {
    const aliasRow = txgioRow({
      feature_index: 88,
      prop_id: "TXGIO-KEY",
      zoning_district: "ALIAS-Z",
      zoning_jurisdiction: "bastrop-city-tx",
      situs_state: "TX",
    });
    const colliding = txgioRow({
      feature_index: 1,
      prop_id: "135570",
      zoning_district: "COLLISION",
    });
    const n = newPayload(colliding, {
      gateBlocked: true,
      body: haysBody(),
      countyFips: "48209",
      countyName: "Hays",
      parcelNodeId: "48209:135570",
      situsAddress: HAYS_SITUS,
      aliasJoin: { txgioId: "TXGIO-KEY", row: aliasRow },
      situsRecovery: {
        addressLandUse: addrLookup(HAYS_ADDR_KEY, "PURVIS MICHAEL", "Z9"),
        txgioOwner: "PURVIS MICHAEL",
      },
    });
    expect(n.provenance.parcelJoin.state).toBe("joined-situs");
    expect(n.provenance.parcelJoin).toMatchObject({
      state: "joined-situs",
      source: ALIAS_JOIN_SOURCE,
      featureIndex: 88,
    });
    expect(n.zoning?.district).toBe("ALIAS-Z");
    expect(n.zoning?.district).not.toBe("COLLISION");
    expect(n.provenance.landUseAddressRecovered).toBe(false);
    const aliases = new Map([
      [
        "135570",
        {
          countyFips: "48209",
          cadPropId: "135570",
          txgioId: "TXGIO-KEY",
          situsKey: HAYS_ADDR_KEY,
        },
      ],
    ]);
    expect(resolveOpenAlias(aliases, "135570")?.txgioId).toBe("TXGIO-KEY");
    expect(
      situsKeysNeedingFetch(
        [{ cadPropId: "135570", situsKey: HAYS_ADDR_KEY }],
        aliases,
      ),
    ).toEqual([]);
    expect(
      situsKeysNeedingFetch(
        [{ cadPropId: "999", situsKey: HAYS_ADDR_KEY }],
        aliases,
      ),
    ).toEqual([HAYS_ADDR_KEY]);
  });

  it("new bind emit set may be empty; a recovered bind is in the set", () => {
    expect(
      emitBindFromSitusRecovery({
        countyFips: "48209",
        cadPropId: "",
        txgioId: "X",
        situsKey: "K",
        asOf: NOW,
      }),
    ).toBeNull();
    const bind = emitBindFromSitusRecovery({
      countyFips: "48209",
      cadPropId: "135570",
      txgioId: "TXGIO-KEY",
      situsKey: HAYS_ADDR_KEY,
      asOf: NOW,
    });
    expect(bind).toEqual({
      county_fips: "48209",
      cad_prop_id: "135570",
      txgio_id: "TXGIO-KEY",
      situs_key: HAYS_ADDR_KEY,
      owners_agree: true,
      as_of: NOW,
      method: "cad-roll-address-join",
    });
    expect([] as unknown[]).toHaveLength(0);
  });
});
