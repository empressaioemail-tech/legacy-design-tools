/**
 * OPS-16 A-103 item 6 / A-104: the operator ruling that the MCP connector's
 * get_smart_site depth "node" (POST /property-explorer/v1/research/brief)
 * must carry the same basic property snapshot the web app's Brief/Inspect
 * dock shows. Investigation found assembleNodeBriefBody never fetched or
 * attached cityLimits, utilityService, overlayDistricts, agValuation,
 * schoolDistrict, maxImperviousCoverPct, or building footprint at all --
 * eight fields InspectCard.tsx (hauska-map) renders as ordinary fact rows,
 * from the exact same load* functions brokerageNodeFacets.ts's own
 * node-facets route already uses to serve those rows to the web dock. This
 * file pins that those fields now reach the wire, reusing the existing
 * loader functions (never re-deriving a second computation of the same
 * fact) and never breaking the existing brief/onRecord/draw contract.
 *
 * Mocked: db handle, entitlement gate, and every fact-read/serve-cutover
 * module assembleNodeBriefBody depends on, each returning a realistic
 * present-state fixture so the new fields can be asserted on real shapes
 * rather than nulls (propertyExplorerBriefAbsent.test.ts already covers the
 * miss paths with nulls; this file covers the success path those tests
 * don't reach).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";

const PARCEL = "48021:34137";

vi.mock("@workspace/db", () => ({
  db: {},
  peSavedProperties: {},
  peShareGrants: {},
  peWorkbenchState: {},
  peScreens: {},
  peScreenRows: {},
}));

vi.mock("../../lib/peEntitlement", () => ({
  PE_FREE_CHAT_MESSAGE_LIMIT: 3,
  createPePropertyUnlock: vi.fn(),
  getPeFreeChatMessagesUsed: vi.fn(),
  hasPeDevPaidBypass: vi.fn(async () => false),
  isPePropertyEntitled: vi.fn(async () => true),
  requirePeAuthenticated: (_req: Request, _res: Response, next: NextFunction) =>
    next(),
  requirePePaidOrPropertyUnlocked:
    () => (_req: Request, _res: Response, next: NextFunction) => next(),
  resolvePeEntitlement: vi.fn(),
  resolvePeOwnerUserId: () => "user-brief-node",
}));

vi.mock("../../lib/peScreenSaveDb", () => ({
  createDrizzleScreenSaveStore: vi.fn(),
}));

vi.mock("../../lib/peScreenSaveResolve", () => ({
  cortexNodeLookup: () => vi.fn(),
  cortexQueryResolver: vi.fn(),
}));

vi.mock("../../lib/txgioAddressResolve", () => ({
  lookupParcelNodeForScreen: vi.fn(),
}));

vi.mock("../../lib/peRecordsEngagement", () => ({
  ensurePeRecordsEngagement: vi.fn(),
  findPeRecordsEngagement: vi.fn(),
}));

vi.mock("../../lib/recordsRequestService", () => ({
  createRecordsRequestJob: vi.fn(),
  listRecordsRequestJobsWire: vi.fn(),
  listRecordsRequestInboxWire: vi.fn(),
}));

const SNAPSHOT = {
  parcelNodeId: PARCEL,
  facets: {
    bakedAt: "2026-08-20T00:00:00.000Z",
    baseFacts: { landUse: { code: "A1", description: "Residential single family" } },
    zoning: { district: "SF-3" },
    envelope: null,
  },
  snapshotAt: "2026-08-20T00:00:00.000Z",
  tier2: null,
  envelopeBriefRefusal: null,
  queryPoint: { latitude: 30.29, longitude: -97.72 },
};

vi.mock("../brokerageNodeFacets", () => ({
  isValidParcelNodeId: (raw: string) =>
    /^\d{5}:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(raw),
  loadBakedNodeFacetSnapshot: vi.fn(async () => SNAPSHOT),
}));

vi.mock("../../lib/floodHazardFactServeCutover", () => ({
  loadFloodHazardFactForServe: vi.fn(async () => ({
    state: "absent",
    source: "flood-hazard-fact",
    tried: [PARCEL],
  })),
}));
vi.mock("../../lib/parcelRecordFactRead", () => ({
  loadParcelRecordFloodFact: vi.fn(async () => ({
    state: "unaccounted",
    source: "parcel_record",
    placeKey: PARCEL,
  })),
}));
vi.mock("../../lib/zoningFactServeCutover", () => ({
  loadZoningFactForServe: vi.fn(async () => ({ state: "refused" })),
}));
vi.mock("../../lib/setbacksFactServeCutover", () => ({
  loadSetbacksFactForServe: vi.fn(async () => ({ state: "refused" })),
}));
vi.mock("../../lib/boundaryEdgeFactRead", () => ({
  loadBoundaryEdgeFactAtom: vi.fn(async () => null),
}));
vi.mock("../../lib/pipelineFactRead", () => ({
  loadPipelineFactAtom: vi.fn(async () => null),
}));
vi.mock("../../lib/wellFactServeCutover", () => ({
  loadWellFactForServe: vi.fn(async () => null),
}));
vi.mock("../../lib/structuralFactRead", () => ({
  loadStructuralFactAtom: vi.fn(async () => ({
    state: "present",
    source: "structural-fact",
    entityType: "cad_property",
    countyFips: "48021",
    propId: "34137",
    taxYear: 2025,
    tier: "cad-export",
    livingAreaSqft: 2000,
    yearBuilt: 1995,
    sourceVintage: "2025-cad-export",
  })),
}));
vi.mock("../../lib/specialDistrictFactServeCutover", () => ({
  loadSpecialDistrictFactForServe: vi.fn(async () => null),
}));
vi.mock("../../lib/cadRollServeCutover", () => ({
  resolveCadRollOverlaysForServe: vi.fn(async () => ({
    marketValue: 425000,
    assessedValue: 410000,
    landValue: 120000,
    improvementValue: 305000,
    livingAreaSqft: { status: "populated", value: 2145 },
    yearBuilt: { v: 1998, source: "cad-property", vintage: "2025-cad-export" },
  })),
}));

// The six facets this card exists to close the gap on. Each returns a
// realistic PRESENT fixture so the test proves real data reaches the wire,
// not just an attached-but-empty key.
const CITY_LIMITS_FIXTURE = {
  state: "present",
  incorporated: true,
  cityName: "Austin",
  source: "tx_city_boundary",
};
const UTILITY_SERVICE_FIXTURE = {
  state: "present",
  source: "parcel_record",
  entityId: `${PARCEL}:utility`,
  water: { provider: "Austin Water", entityType: "CCN" },
  sewer: { provider: "Austin Water", entityType: "CCN" },
  electric: { provider: "Austin Energy", entityType: "CCN" },
  sourceAdapter: "parcel_record",
  sourceVintage: "2026-tax-year",
  evaluatedAt: "2026-08-20T00:00:00.000Z",
};
const OVERLAY_DISTRICTS_FIXTURE = {
  state: "present",
  source: "parcel_record",
  entityId: `${PARCEL}:overlay`,
  districts: [{ name: "Waterfront Overlay", code: "WO" }],
};
const AG_VALUATION_FIXTURE = {
  state: "present",
  source: "parcel_record",
  entityId: `${PARCEL}:ag`,
  entries: [{ taxYear: 2025, agExempt: false }],
};
const SCHOOL_DISTRICT_FIXTURE = {
  state: "present",
  source: "parcel_record",
  entityId: `${PARCEL}:school`,
  districtName: "Austin ISD",
};
const MAX_IMPERVIOUS_COVER_FIXTURE = {
  state: "present",
  source: "parcel_record",
  entityId: `${PARCEL}:impervious`,
  maxImperviousCoverPct: 45,
};
const FOOTPRINT_FIXTURE = {
  state: "present",
  source: "building-footprint-fact",
  entityId: `${PARCEL}:footprint:1`,
  footprintSqFt: 1850,
};

vi.mock("../../lib/cityLimitsFactServeCutover", () => ({
  loadCityLimitsFactForServe: vi.fn(async () => CITY_LIMITS_FIXTURE),
}));
vi.mock("../../lib/utilityServiceFactServeCutover", () => ({
  loadUtilityServiceFactForServe: vi.fn(async () => UTILITY_SERVICE_FIXTURE),
}));
vi.mock("../../lib/overlayDistrictsFactServeCutover", () => ({
  loadOverlayDistrictsFactForServe: vi.fn(async () => OVERLAY_DISTRICTS_FIXTURE),
}));
vi.mock("../../lib/agValuationFactServeCutover", () => ({
  loadAgValuationFactForServe: vi.fn(async () => AG_VALUATION_FIXTURE),
}));
vi.mock("../../lib/schoolDistrictFactServeCutover", () => ({
  loadSchoolDistrictFactForServe: vi.fn(async () => SCHOOL_DISTRICT_FIXTURE),
}));
vi.mock("../../lib/maxImperviousCoverPctFactServeCutover", () => ({
  loadMaxImperviousCoverPctFactForServe: vi.fn(
    async () => MAX_IMPERVIOUS_COVER_FIXTURE,
  ),
}));
vi.mock("../../lib/buildingFootprintFactRead", () => ({
  loadBuildingFootprintFactAtom: vi.fn(async () => FOOTPRINT_FIXTURE),
}));

const propertyExplorerRouter = (await import("../propertyExplorer")).default;

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { tenantId: "default" } as Express.Request["session"];
    next();
  });
  app.use("/api", propertyExplorerRouter);
  return app;
}

describe("POST /property-explorer/v1/research/brief node depth, success path (OPS-16 A-103 item 6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("carries the six previously-missing fact fields, plus structuralFact, verbatim from their loaders", async () => {
    const res = await request(buildApp())
      .post("/api/property-explorer/v1/research/brief")
      .send({ parcelNodeId: PARCEL });

    expect(res.status).toBe(200);
    expect(res.body.cityLimitsFact).toEqual(CITY_LIMITS_FIXTURE);
    expect(res.body.utilityServiceFact).toEqual(UTILITY_SERVICE_FIXTURE);
    expect(res.body.overlayDistrictsFact).toEqual(OVERLAY_DISTRICTS_FIXTURE);
    expect(res.body.agValuationFact).toEqual(AG_VALUATION_FIXTURE);
    expect(res.body.schoolDistrictFact).toEqual(SCHOOL_DISTRICT_FIXTURE);
    expect(res.body.maxImperviousCoverPctFact).toEqual(
      MAX_IMPERVIOUS_COVER_FIXTURE,
    );
    expect(res.body.buildingFootprintFact).toEqual(FOOTPRINT_FIXTURE);
    // structuralFact was already fetched (for the draw's yearBuilt attr) but
    // never attached to the response body itself -- this is the free half of
    // the fix, no new loader call required. The cadRollOverlay values (P-39
    // living-area/year-built cutover) win over the legacy structural read's
    // own fields, per structuralFactWithParcelRecordOverlay's own contract.
    expect(res.body.structuralFact).toMatchObject({
      state: "present",
      livingAreaSqft: 2145,
      yearBuilt: 1998,
    });
  });

  it("does not regress the existing brief/onRecord/citations/bakedAt/source contract", async () => {
    const res = await request(buildApp())
      .post("/api/property-explorer/v1/research/brief")
      .send({ parcelNodeId: PARCEL });

    expect(res.status).toBe(200);
    expect(res.body.runId).toEqual(expect.any(String));
    expect(res.body.reportFamily).toBe("R1");
    expect(res.body.parcelNodeId).toBe(PARCEL);
    expect(res.body.brief.sections.map((s: { id: string }) => s.id)).toEqual([
      "zoning",
      "setbacks-envelope",
      "flood",
      "land-use",
      "drainage",
    ]);
    expect(res.body.onRecord).toMatchObject({
      apn: null,
      countyFips: null,
      countyName: null,
    });
    expect(res.body.bakedAt).toBe("2026-08-20T00:00:00.000Z");
    expect(res.body.source).toBe("baked-snapshot");
  });

  it("city limits is read AFTER the snapshot resolves, using the snapshot's own query point (matching brokerageNodeFacets.ts's documented call-order dependency)", async () => {
    const { loadCityLimitsFactForServe } = await import(
      "../../lib/cityLimitsFactServeCutover"
    );
    await request(buildApp())
      .post("/api/property-explorer/v1/research/brief")
      .send({ parcelNodeId: PARCEL });
    expect(loadCityLimitsFactForServe).toHaveBeenCalledWith(
      PARCEL,
      SNAPSHOT.queryPoint,
    );
  });
});
