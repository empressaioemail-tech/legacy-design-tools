/**
 * P-85 — PE Records Request engagement bridge tests (mocked DB).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockSelectChain = vi.fn();
const mockInsertValues = vi.fn();
const mockTransaction = vi.fn();
const mockTxgio = vi.fn();
const mockResolveParcel = vi.fn();

vi.mock("@workspace/db", () => {
  const engagements = {
    id: "id",
    ownerUserId: "owner_user_id",
    tenantId: "tenant_id",
    nameLower: "name_lower",
  };
  const peSavedProperties = {
    snapshot: "snapshot",
    tenantId: "tenant_id",
    ownerUserId: "owner_user_id",
    parcelNodeId: "parcel_node_id",
  };
  const parcelBriefings = {
    id: "id",
    engagementId: "engagement_id",
    updatedAt: "updated_at",
  };
  const briefingSources = {
    id: "id",
    briefingId: "briefing_id",
    layerKind: "layer_kind",
    supersededAt: "superseded_at",
    supersededById: "superseded_by_id",
  };

  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: (...args: unknown[]) => mockSelectChain(...args),
        }),
      }),
    }),
    insert: () => ({
      values: (v: unknown) => {
        mockInsertValues(v);
        return {
          returning: () =>
            Promise.resolve([{ id: "11111111-1111-4111-8111-111111111111" }]),
          onConflictDoUpdate: () => ({
            returning: () =>
              Promise.resolve([
                { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
              ]),
          }),
        };
      },
    }),
    transaction: (fn: (tx: unknown) => Promise<unknown>) => mockTransaction(fn),
  };

  return {
    db,
    engagements,
    peSavedProperties,
    parcelBriefings,
    briefingSources,
  };
});

vi.mock("../txgioParcelStore", () => ({
  queryTxgioParcelByPropId: (...args: unknown[]) => mockTxgio(...args),
}));

vi.mock("../siteTopographyIngest", () => ({
  resolveParcelInput: (...args: unknown[]) => mockResolveParcel(...args),
}));

const PARCEL_POLYGON = {
  type: "Polygon" as const,
  coordinates: [
    [
      [-97.74, 30.26],
      [-97.739, 30.26],
      [-97.739, 30.261],
      [-97.74, 30.261],
      [-97.74, 30.26],
    ],
  ],
};

const USER_ID = "33333333-3333-4333-8333-333333333333";
const TENANT_ID = "default";
const PARCEL_NODE = "48453:280238";
const PARCEL_KEY = "apn:48453:280238";
const ENGAGEMENT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const {
  ensurePeRecordsEngagement,
  findPeRecordsEngagement,
} = await import("../peRecordsEngagement");

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectChain.mockResolvedValue([]);
  mockResolveParcel.mockResolvedValue({
    origin: "county-gis-parcel",
    briefingSourceId: "bs-1",
    layerKind: "pe-records-parcel",
    geometry: PARCEL_POLYGON,
    parcelBbox: [-97.74, 30.26, -97.739, 30.261],
  });
  mockTxgio.mockResolvedValue({
    geojson: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: PARCEL_POLYGON,
          properties: { apn: "280238" },
        },
      ],
    },
    featureCount: 1,
    queryMode: "pin",
  });
  mockTransaction.mockImplementation(async (fn) => {
    const tx = {
      insert: () => ({
        values: () => ({
          onConflictDoUpdate: () => ({
            returning: () =>
              Promise.resolve([
                { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
              ]),
          }),
          returning: () =>
            Promise.resolve([{ id: "src-new-1" }]),
        }),
      }),
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
      update: () => ({
        set: () => ({
          where: () => Promise.resolve(undefined),
        }),
      }),
    };
    return fn(tx);
  });
});

describe("findPeRecordsEngagement", () => {
  it("returns engagement id when a PE-scoped row exists", async () => {
    mockSelectChain.mockResolvedValueOnce([{ id: ENGAGEMENT_ID }]);

    const found = await findPeRecordsEngagement(USER_ID, TENANT_ID, PARCEL_NODE);
    expect(found).toEqual({ ok: true, engagementId: ENGAGEMENT_ID });
  });

  it("returns ok:false when no row exists", async () => {
    mockSelectChain.mockResolvedValueOnce([]);
    const found = await findPeRecordsEngagement(USER_ID, TENANT_ID, PARCEL_NODE);
    expect(found).toEqual({ ok: false });
  });
});

describe("ensurePeRecordsEngagement", () => {
  it("reuses an existing engagement that already has geometry", async () => {
    mockSelectChain
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: ENGAGEMENT_ID }]);

    const result = await ensurePeRecordsEngagement(
      USER_ID,
      TENANT_ID,
      PARCEL_NODE,
      PARCEL_KEY,
      "48453",
    );

    expect(result).toEqual({
      ok: true,
      engagementId: ENGAGEMENT_ID,
      created: false,
      geometrySeeded: false,
    });
    expect(mockInsertValues).not.toHaveBeenCalled();
  });

  it("creates engagement and seeds briefing when txgio returns geometry", async () => {
    mockSelectChain
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const result = await ensurePeRecordsEngagement(
      USER_ID,
      TENANT_ID,
      PARCEL_NODE,
      PARCEL_KEY,
      "48453",
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.created).toBe(true);
      expect(result.geometrySeeded).toBe(true);
    }
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerUserId: USER_ID,
        tenantId: TENANT_ID,
        geocodeSource: "pe-records-bridge",
      }),
    );
    expect(mockTxgio).toHaveBeenCalledWith(
      expect.objectContaining({
        countyFips: "48453",
        propId: "280238",
      }),
    );
  });

  it("fail-closes when txgio has no polygon", async () => {
    mockSelectChain
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mockTxgio.mockResolvedValueOnce(null);

    const result = await ensurePeRecordsEngagement(
      USER_ID,
      TENANT_ID,
      PARCEL_NODE,
      PARCEL_KEY,
      "48453",
    );

    expect(result).toEqual({
      ok: false,
      status: 422,
      body: expect.objectContaining({
        error: "no_parcel_geometry",
        blocker: expect.stringContaining("txgio"),
      }),
    });
  });

  it("422s on county mismatch between parcelNodeId and countyFips", async () => {
    const result = await ensurePeRecordsEngagement(
      USER_ID,
      TENANT_ID,
      PARCEL_NODE,
      PARCEL_KEY,
      "48021",
    );

    expect(result).toEqual({
      ok: false,
      status: 422,
      body: expect.objectContaining({
        error: "parcel_node_county_mismatch",
      }),
    });
  });

  it("uses saved-property engagementId linkage when owned and geometry resolves", async () => {
    mockSelectChain
      .mockResolvedValueOnce([
        { snapshot: { engagementId: ENGAGEMENT_ID } },
      ])
      .mockResolvedValueOnce([{ id: ENGAGEMENT_ID }]);

    const result = await ensurePeRecordsEngagement(
      USER_ID,
      TENANT_ID,
      PARCEL_NODE,
      PARCEL_KEY,
      "48453",
    );

    expect(result).toEqual({
      ok: true,
      engagementId: ENGAGEMENT_ID,
      created: false,
      geometrySeeded: true,
    });
  });
});
