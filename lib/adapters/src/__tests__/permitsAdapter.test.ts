/**
 * permits:record Property Brief adapter tests — the rehab-reality slot
 * from the owned Austin/San Antonio issued-permit corpus. Fixture rows
 * are real-shaped copies of rows from the Wave-3 acquisition CSVs
 * (public record; headers/values verified against the live GCS objects
 * 2026-07-15).
 */

import { describe, expect, it, vi } from "vitest";
import {
  PERMIT_ADAPTERS,
  PERMIT_HISTORY_LIMIT,
  PERMIT_MATCH_CAVEAT,
  permitStreetKey,
  permitsRecordAdapter,
  resolvePermitMetro,
  summarizePermitsPayload,
} from "../local/permits";
import { runAdapters } from "../runner";
import type {
  AdapterContext,
  PermitHistoryLookup,
  PermitHistoryMatch,
  PermitRecordHit,
} from "../types";

/** Real-shaped rows: City of Austin issued_construction_permits.csv. */
const AUSTIN_EP_ROW: PermitRecordHit = {
  permitNumber: "2026-061052 EP",
  permitType: "Electrical Permit",
  workClass: "Wall",
  permitClass: "Commercial",
  status: "Active",
  description: "Mi Casa Family Dentistry",
  appliedDate: "2026-05-20",
  issuedDate: "2026-06-11",
  valuation: null,
  addressRaw: "12800 PEARCE LN",
  sourceFile: "issued_construction_permits.csv",
  acquiredDate: "2026-06-21",
};

const AUSTIN_REMODEL_ROW: PermitRecordHit = {
  permitNumber: "2019-113345 BP",
  permitType: "Building Permit",
  workClass: "Remodel",
  permitClass: "Residential",
  status: "Final",
  description: "Interior remodel, kitchen and 2 baths",
  appliedDate: "2019-08-02",
  issuedDate: "2019-09-14",
  valuation: 68500,
  addressRaw: "12800 PEARCE LN",
  sourceFile: "issued_construction_permits.csv",
  acquiredDate: "2026-06-21",
};

/** Real-shaped row: San Antonio permits_issued_current.csv sub-permit. */
const SA_ROW: PermitRecordHit = {
  permitNumber: "COM-BLG-PMT24-40200788",
  permitType: "Comm New Building Permit",
  workClass: "New",
  permitClass: null,
  status: null,
  description: "Building No: N/A; Unit No: N/A",
  appliedDate: "2024-08-02",
  issuedDate: "2025-01-01",
  valuation: 3500000,
  addressRaw: "8751 STATE HWY 151",
  sourceFile: "permits_issued_current.csv",
  acquiredDate: "2026-06-21",
};

const AUSTIN_POINT = { latitude: 30.2672, longitude: -97.7431 };
const SA_POINT = { latitude: 29.42, longitude: -98.49 };
const HOUSTON_POINT = { latitude: 29.7604, longitude: -95.3698 };
const BASTROP_POINT = { latitude: 30.104, longitude: -97.31 };
const BOULDER_POINT = { latitude: 40.0102, longitude: -105.2705 };

function match(
  rows: PermitRecordHit[],
  extra?: Partial<PermitHistoryMatch>,
): PermitHistoryMatch {
  const issued = rows.map((r) => r.issuedDate).filter((d): d is string => !!d);
  return {
    rows,
    totalMatched: rows.length,
    earliestIssued: issued.length ? [...issued].sort()[0] : null,
    latestIssued: issued.length ? [...issued].sort().at(-1)! : null,
    ...extra,
  };
}

function austinCtx(
  permitLookup: PermitHistoryLookup,
  overrides?: Partial<AdapterContext["parcel"]>,
): AdapterContext {
  return {
    parcel: {
      ...AUSTIN_POINT,
      address: "12800 Pearce Ln, Austin, TX 78617",
      state: "TX",
      ...overrides,
    },
    jurisdiction: { stateKey: "texas", localKey: null },
    permitLookup,
  };
}

describe("permitStreetKey — the shared match normalization", () => {
  it("takes the first comma-segment and normalizes suffix tokens", () => {
    expect(permitStreetKey("12800 Pearce Lane, Austin, TX 78617")).toBe(
      "12800 PEARCE LN",
    );
    expect(
      permitStreetKey("7342 RAY BON Dr, City of San Antonio, TX 78218"),
    ).toBe("7342 RAY BON DR");
    expect(permitStreetKey("1600 Congress Avenue")).toBe("1600 CONGRESS AVE");
  });

  it("drops one trailing standalone ZIP token (dirty SA street lines)", () => {
    expect(permitStreetKey("9510 Maidenstone Dr 78250")).toBe(
      "9510 MAIDENSTONE DR",
    );
  });

  it("keeps highway-style numerics that are not a trailing ZIP", () => {
    expect(permitStreetKey("1124 S IH 35 SVRD SB")).toBe("1124 S IH 35 SVRD SB");
    expect(permitStreetKey("8751 STATE HWY 151")).toBe("8751 STATE HWY 151");
  });

  it("returns null without a leading house number (never over-match a street)", () => {
    // Real dirty SA row: a person's name in the address column.
    expect(permitStreetKey("April Edwards")).toBe(null);
    expect(permitStreetKey("")).toBe(null);
    expect(permitStreetKey(null)).toBe(null);
    expect(permitStreetKey(undefined)).toBe(null);
  });
});

describe("resolvePermitMetro — covered-metro routing", () => {
  it("routes Austin and San Antonio points", () => {
    expect(resolvePermitMetro(AUSTIN_POINT.latitude, AUSTIN_POINT.longitude)?.metro).toBe(
      "austin_tx",
    );
    expect(resolvePermitMetro(SA_POINT.latitude, SA_POINT.longitude)?.metro).toBe(
      "san_antonio_tx",
    );
  });

  it("is null everywhere else — including the rest of Central TX", () => {
    expect(resolvePermitMetro(HOUSTON_POINT.latitude, HOUSTON_POINT.longitude)).toBe(null);
    expect(resolvePermitMetro(BASTROP_POINT.latitude, BASTROP_POINT.longitude)).toBe(null);
    expect(resolvePermitMetro(BOULDER_POINT.latitude, BOULDER_POINT.longitude)).toBe(null);
    expect(resolvePermitMetro(Number.NaN, -97.74)).toBe(null);
  });
});

describe("permits:record — appliesTo gating", () => {
  it("gates off without the injected accessor", () => {
    const ctx = austinCtx(vi.fn());
    delete ctx.permitLookup;
    expect(permitsRecordAdapter.appliesTo(ctx)).toBe(false);
  });

  it("gates off outside the covered metros and outside Texas", () => {
    const lookup = vi.fn(async () => match([]));
    expect(
      permitsRecordAdapter.appliesTo(austinCtx(lookup, { ...HOUSTON_POINT })),
    ).toBe(false);
    expect(
      permitsRecordAdapter.appliesTo(austinCtx(lookup, { ...BOULDER_POINT, state: "CO" })),
    ).toBe(false);
    const wrongState = austinCtx(lookup);
    wrongState.jurisdiction = { stateKey: "utah", localKey: null };
    expect(permitsRecordAdapter.appliesTo(wrongState)).toBe(false);
  });

  it("gates off when no usable street key can be derived (address-based match)", () => {
    const lookup = vi.fn(async () => match([AUSTIN_EP_ROW]));
    expect(
      permitsRecordAdapter.appliesTo(austinCtx(lookup, { address: null })),
    ).toBe(false);
    expect(
      permitsRecordAdapter.appliesTo(austinCtx(lookup, { address: "Pearce Ln" })),
    ).toBe(false);
    expect(permitsRecordAdapter.appliesTo(austinCtx(lookup))).toBe(true);
  });
});

describe("permits:record — run", () => {
  it("emits the permits-history layer with the disclosed match strategy (Austin)", async () => {
    const lookup = vi.fn(async () => match([AUSTIN_EP_ROW, AUSTIN_REMODEL_ROW]));
    const outcomes = await runAdapters({
      adapters: [...PERMIT_ADAPTERS],
      context: austinCtx(lookup),
    });
    expect(outcomes).toHaveLength(1);
    const outcome = outcomes[0];
    expect(outcome.status).toBe("ok");
    expect(outcome.layerKind).toBe("permits-history");

    // The accessor is queried with the SHARED normalization output.
    expect(lookup).toHaveBeenCalledWith(
      "austin_tx",
      "12800 PEARCE LN",
      PERMIT_HISTORY_LIMIT,
    );

    const result = outcome.result!;
    expect(result.provider).toBe(
      "City of Austin issued-permit records (public record)",
    );
    const payload = result.payload as Record<string, unknown>;
    expect(payload.kind).toBe("permits-history");
    expect(payload.metro).toBe("austin_tx");
    expect(payload.totalMatched).toBe(2);
    expect(payload.returnedCount).toBe(2);
    expect(payload.match).toEqual({
      method: "normalized-street-address",
      key: "12800 PEARCE LN",
      caveat: PERMIT_MATCH_CAVEAT,
    });
    expect(payload.earliestIssued).toBe("2019-09-14");
    expect(payload.latestIssued).toBe("2026-06-11");
    // Acquisition date is the honest data vintage.
    expect(payload.sourceVintage).toBe("2026-06-21");
    expect(payload.acquiredDate).toBe("2026-06-21");
    expect(payload.sourcePortal).toContain("data.austintexas.gov");

    const permits = payload.permits as Array<Record<string, unknown>>;
    expect(permits[0].permitNumber).toBe("2026-061052 EP");
    // Valuation keeps the declared-not-appraised name.
    expect(permits[1].declaredValuation).toBe(68500);
  });

  it("routes a San Antonio point to the SA corpus", async () => {
    const lookup = vi.fn(async () => match([SA_ROW]));
    const outcomes = await runAdapters({
      adapters: [...PERMIT_ADAPTERS],
      context: austinCtx(lookup, {
        ...SA_POINT,
        address: "8751 State Hwy 151, San Antonio, TX 78245",
      }),
    });
    expect(outcomes[0].status).toBe("ok");
    expect(lookup).toHaveBeenCalledWith(
      "san_antonio_tx",
      "8751 STATE HWY 151",
      PERMIT_HISTORY_LIMIT,
    );
    const payload = outcomes[0].result!.payload as Record<string, unknown>;
    expect(payload.metroLabel).toBe("City of San Antonio");
    // SA coverage honesty: the note names the 2020-07 floor.
    expect(String(payload.coverageNote)).toContain("2020-07");
  });

  it("is an honest no-coverage on zero match — never an empty success", async () => {
    const lookup = vi.fn(async () => match([]));
    const outcomes = await runAdapters({
      adapters: [...PERMIT_ADAPTERS],
      context: austinCtx(lookup),
    });
    expect(outcomes[0].status).toBe("no-coverage");
    expect(outcomes[0].error?.message).toContain("No permit records matched");
    expect(outcomes[0].error?.message).toContain("City of Austin");
    // The miss caveat is part of the user-facing copy.
    expect(outcomes[0].error?.message).toMatch(/can miss/);
  });
});

describe("summarizePermitsPayload", () => {
  function payloadFor(rows: PermitRecordHit[], total = rows.length) {
    return {
      kind: "permits-history",
      metro: "austin_tx",
      metroLabel: "City of Austin",
      totalMatched: total,
      returnedCount: rows.length,
      permits: rows.map((r) => ({
        permitNumber: r.permitNumber,
        permitType: r.permitType,
        workClass: r.workClass,
        status: r.status,
        issuedDate: r.issuedDate,
        declaredValuation: r.valuation,
      })),
      earliestIssued: "2019-09-14",
      latestIssued: "2026-06-11",
      acquiredDate: "2026-06-21",
    };
  }

  it("says N permits since YYYY, the latest line, and the match caveat", () => {
    const summary = summarizePermitsPayload(
      "permits-history",
      payloadFor([AUSTIN_EP_ROW, AUSTIN_REMODEL_ROW], 14),
    );
    expect(summary).toContain("14 permits on record since 2019");
    expect(summary).toContain("(showing 2)");
    expect(summary).toContain("latest 2026-06-11: Electrical Permit (Wall) — Active");
    expect(summary).toContain("matched by street address");
    expect(summary).toContain("City of Austin issued-permit records, acquired 2026-06-21");
  });

  it("labels valuations as declared", () => {
    const summary = summarizePermitsPayload(
      "permits-history",
      payloadFor([AUSTIN_REMODEL_ROW]),
    );
    expect(summary).toContain("declared valuation $68,500");
    expect(summary).not.toContain("estimated");
  });

  it("returns null for other layer kinds and malformed payloads", () => {
    expect(summarizePermitsPayload("cad-property", payloadFor([AUSTIN_EP_ROW]))).toBe(null);
    expect(summarizePermitsPayload("permits-history", { kind: "other" })).toBe(null);
    expect(summarizePermitsPayload("permits-history", "nope")).toBe(null);
  });
});
