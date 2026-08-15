/**
 * Smart Files contract tests (OPS-17 PLAN-ROW G-14).
 *
 * The STALE indicator tests are the load-bearing ones. DEV_PROCESS 2.2: a
 * gating indicator is tested for its ability to FIRE before it is trusted, and
 * a test that cannot fail for the right reason is a defect, not a test. So the
 * indicator is proven in BOTH directions — it fires on a backdated stamp AND
 * stays silent on a fresh one. A one-directional test would pass an indicator
 * that is permanently stuck firing.
 */

import { describe, expect, it } from "vitest";

import {
  SMART_FILE_ACCESS_POLICY_VALUES,
  SMART_FILE_DEFAULT_STALENESS_SECONDS,
  SMART_FILE_PLACEMENT_TARGET_TYPES,
  SMART_FILE_SCOPE_TYPES,
  buildSmartFileEntityId,
  evaluateSmartFileFreshness,
  jurisdictionFipsFromEntityParts,
  parseSmartFileEntityId,
  validateSmartFileRead,
} from "../atoms/smart-file.contract";

describe("smart-file entityId — declared, not reconstructed", () => {
  it("builds the declared scope-keyed shape for jurisdiction", () => {
    expect(
      buildSmartFileEntityId({
        scopeType: "jurisdiction",
        scopeId: "48021",
        docSlug: "udc-2024",
      }),
    ).toBe("smartfile:jurisdiction:48021:udc-2024");
  });

  it("builds tenant and site scopes", () => {
    expect(
      buildSmartFileEntityId({
        scopeType: "tenant",
        scopeId: "mox",
        docSlug: "unit-turn-sop",
      }),
    ).toBe("smartfile:tenant:mox:unit-turn-sop");
    expect(
      buildSmartFileEntityId({
        scopeType: "site",
        scopeId: "parcel:48021:R12345",
        docSlug: "geotech",
      }),
    ).toBe("smartfile:site:parcel:48021:R12345:geotech");
  });

  it("round-trips build -> parse on all three scope types", () => {
    const cases = [
      { scopeType: "jurisdiction" as const, scopeId: "48021", docSlug: "council.packet-01" },
      { scopeType: "tenant" as const, scopeId: "mox", docSlug: "unit-turn-sop" },
      {
        scopeType: "site" as const,
        scopeId: "parcel:48021:R12345",
        docSlug: "geotech",
      },
    ];
    for (const parts of cases) {
      const parsed = parseSmartFileEntityId(buildSmartFileEntityId(parts));
      expect(parsed).toEqual(parts);
    }
  });

  it("derives jurisdictionFips only for jurisdiction scope", () => {
    const j = {
      scopeType: "jurisdiction" as const,
      scopeId: "48021",
      docSlug: "udc",
    };
    expect(jurisdictionFipsFromEntityParts(j)).toBe("48021");
    expect(
      jurisdictionFipsFromEntityParts({
        scopeType: "tenant",
        scopeId: "mox",
        docSlug: "sop",
      }),
    ).toBeNull();
  });

  it("refuses a non-FIPS jurisdiction scopeId rather than coercing it", () => {
    expect(() =>
      buildSmartFileEntityId({
        scopeType: "jurisdiction",
        scopeId: "bastrop",
        docSlug: "udc-2024",
      }),
    ).toThrow(/scopeId must be numeric FIPS/);
  });

  it("refuses an unknown scopeType", () => {
    expect(() =>
      buildSmartFileEntityId({
        scopeType: "workspace" as "jurisdiction",
        scopeId: "w1",
        docSlug: "udc",
      }),
    ).toThrow(/scopeType/);
  });

  it("refuses an empty scopeId", () => {
    expect(() =>
      buildSmartFileEntityId({
        scopeType: "tenant",
        scopeId: "",
        docSlug: "udc",
      }),
    ).toThrow(/scopeId must be non-empty/);
  });

  it("refuses an uppercase or space-bearing slug", () => {
    expect(() =>
      buildSmartFileEntityId({
        scopeType: "jurisdiction",
        scopeId: "48021",
        docSlug: "UDC 2024",
      }),
    ).toThrow(/docSlug/);
  });

  it("declares the closed scopeType set", () => {
    expect(SMART_FILE_SCOPE_TYPES).toEqual(["jurisdiction", "tenant", "site"]);
  });

  /**
   * The reconstruction trap this declaration exists to prevent: a malformed or
   * foreign-shaped id must return null, NEVER a best-effort partial parse.
   */
  it.each([
    ["wrong prefix (the parcel-keyed shape)", "parcel:48021:R12345"],
    ["old three-segment FIPS form", "smartfile:48021:udc"],
    ["too few segments", "smartfile:48021"],
    ["too many segments without scopeType", "smartfile:48021:udc:2024"],
    ["empty", ""],
    ["non-numeric jurisdiction scopeId", "smartfile:jurisdiction:travis:udc-2024"],
    ["unknown scopeType", "smartfile:workspace:foo:bar"],
    ["wrong prefix", "not-smartfile:jurisdiction:48021:udc"],
    ["empty scopeId", "smartfile:jurisdiction::udc"],
    ["empty slug", "smartfile:jurisdiction:48021:"],
    ["CID-looking key", "smartfile:bafybeigdyrzt5sfp7udm7uh3cdgr2xywfrz5mfc3i3k5q4x5q4x5q4x5q4:udc"],
  ])("returns null for %s", (_label, raw) => {
    expect(parseSmartFileEntityId(raw)).toBeNull();
  });
});

describe("STALE indicator — proven in BOTH directions (DEV_PROCESS 2.2)", () => {
  const computedAt = "2026-06-01T00:00:00.000Z";

  /** Direction 1: it FIRES. A backdated stamp past the threshold is stale. */
  it("FIRES on a stamp backdated past the threshold", () => {
    const freshness = evaluateSmartFileFreshness({
      computedAt,
      // 45 days later, against a 30-day default threshold.
      servedAt: "2026-07-16T00:00:00.000Z",
      stalenessThresholdSeconds: SMART_FILE_DEFAULT_STALENESS_SECONDS,
    });
    expect(freshness.isStale).toBe(true);
    expect(freshness.ageSeconds).toBeGreaterThan(
      SMART_FILE_DEFAULT_STALENESS_SECONDS,
    );
  });

  /**
   * Direction 2: it stays SILENT. Without this case, an indicator hard-wired to
   * `true` would pass direction 1 and the gate would be dead-on.
   */
  it("stays SILENT on a fresh stamp", () => {
    const freshness = evaluateSmartFileFreshness({
      computedAt,
      // 1 day later, well inside the 30-day threshold.
      servedAt: "2026-06-02T00:00:00.000Z",
      stalenessThresholdSeconds: SMART_FILE_DEFAULT_STALENESS_SECONDS,
    });
    expect(freshness.isStale).toBe(false);
    expect(freshness.ageSeconds).toBeLessThan(
      SMART_FILE_DEFAULT_STALENESS_SECONDS,
    );
  });

  /** The boundary is exclusive: exactly-at-threshold is NOT yet stale. */
  it("does not fire exactly AT the threshold, and does one second past it", () => {
    const threshold = 60;
    const at = evaluateSmartFileFreshness({
      computedAt,
      servedAt: "2026-06-01T00:01:00.000Z",
      stalenessThresholdSeconds: threshold,
    });
    expect(at.ageSeconds).toBe(60);
    expect(at.isStale).toBe(false);

    const past = evaluateSmartFileFreshness({
      computedAt,
      servedAt: "2026-06-01T00:01:01.000Z",
      stalenessThresholdSeconds: threshold,
    });
    expect(past.isStale).toBe(true);
  });

  it("carries the threshold its verdict was reached against", () => {
    const freshness = evaluateSmartFileFreshness({
      computedAt,
      servedAt: "2026-06-02T00:00:00.000Z",
      stalenessThresholdSeconds: 4242,
    });
    // A ratio travels with its counting rule (DEV_PROCESS 1.2): the verdict is
    // meaningless without the threshold that produced it.
    expect(freshness.stalenessThresholdSeconds).toBe(4242);
  });

  it("throws on an unparseable stamp rather than defaulting to fresh", () => {
    // Failing closed matters: a silent fallback to `isStale: false` on a
    // garbage stamp is precisely the silent-fallback defect class.
    expect(() =>
      evaluateSmartFileFreshness({ computedAt: "not-a-date", servedAt: computedAt }),
    ).toThrow(/computedAt/);
    expect(() =>
      evaluateSmartFileFreshness({ computedAt, servedAt: "not-a-date" }),
    ).toThrow(/servedAt/);
  });

  it("rejects a non-positive threshold", () => {
    expect(() =>
      evaluateSmartFileFreshness({
        computedAt,
        servedAt: computedAt,
        stalenessThresholdSeconds: 0,
      }),
    ).toThrow(/stalenessThresholdSeconds/);
  });
});

describe("access policy — imported, not re-literalled (A-CP1-F3)", () => {
  it("carries exactly the contract's five values, in order", () => {
    expect(SMART_FILE_ACCESS_POLICY_VALUES).toEqual([
      "public-free",
      "public-paid",
      "platform-internal",
      "tenant-private",
      "tenant-shared",
    ]);
  });
});

describe("read shape — content cannot travel without a stamp", () => {
  const entityId = buildSmartFileEntityId({
    scopeType: "jurisdiction",
    scopeId: "48021",
    docSlug: "udc-2024",
  });

  const provenance = {
    sourceUri: "https://example.gov/udc-2024.pdf",
    sourceLabel: "Bastrop County Clerk",
    retrievedAt: "2026-06-01T00:00:00.000Z",
    sourceVintage: "2024-03-12",
  };

  const validRead = {
    document: {
      entityType: "smart-file-document" as const,
      entityId,
      scopeType: "jurisdiction" as const,
      scopeId: "48021",
      jurisdictionFips: "48021",
      docSlug: "udc-2024",
      title: "Unified Development Code (2024)",
      accessPolicy: "public-free" as const,
      currentVersion: 2,
      createdAt: "2026-05-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:00:00.000Z",
    },
    version: {
      entityType: "smart-file-version" as const,
      documentEntityId: entityId,
      version: 2,
      contentCid: "bafydoc-abc123",
      contentType: "application/pdf",
      byteSize: 1024,
      provenance,
      computedAt: "2026-06-01T00:00:00.000Z",
      supersededAt: null,
    },
    provenance,
    freshness: evaluateSmartFileFreshness({
      computedAt: "2026-06-01T00:00:00.000Z",
      servedAt: "2026-06-02T00:00:00.000Z",
    }),
    placements: [
      {
        entityType: "smart-file-placement" as const,
        documentEntityId: entityId,
        targetType: "folder" as const,
        targetId: "folder-planning",
        placedAt: "2026-05-01T00:00:00.000Z",
        placedBy: null,
      },
    ],
  };

  it("accepts a fully stamped, fully sourced read", () => {
    expect(() => validateSmartFileRead(validRead)).not.toThrow();
  });

  it("rejects a read whose freshness stamp is missing", () => {
    const { freshness: _dropped, ...withoutStamp } = validRead;
    expect(() => validateSmartFileRead(withoutStamp)).toThrow();
  });

  it("rejects provenance without a source", () => {
    expect(() =>
      validateSmartFileRead({
        ...validRead,
        provenance: { ...provenance, sourceUri: "" },
      }),
    ).toThrow();
  });

  it("rejects an access policy outside the five-value union", () => {
    expect(() =>
      validateSmartFileRead({
        ...validRead,
        document: { ...validRead.document, accessPolicy: "public" },
      }),
    ).toThrow();
  });

  it("rejects a placement target outside the closed set", () => {
    expect(() =>
      validateSmartFileRead({
        ...validRead,
        placements: [{ ...validRead.placements[0], targetType: "workspace" }],
      }),
    ).toThrow();
  });

  it("accepts a null sourceVintage as a positive determination", () => {
    expect(() =>
      validateSmartFileRead({
        ...validRead,
        provenance: { ...provenance, sourceVintage: null },
        version: {
          ...validRead.version,
          provenance: { ...provenance, sourceVintage: null },
        },
      }),
    ).not.toThrow();
  });

  it("declares every placement target type as a closed set", () => {
    expect(SMART_FILE_PLACEMENT_TARGET_TYPES).toContain("parcel");
    expect(SMART_FILE_PLACEMENT_TARGET_TYPES).not.toContain("workspace");
  });
});
