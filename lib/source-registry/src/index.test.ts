import { describe, it, expect } from "vitest";
import {
  SOURCE_REGISTRY,
  validateRegistry,
  validateRegistryEntry,
  assertValidRegistry,
  getRegistryEntry,
  partitionTableName,
  partitionDdlForProvider,
} from "./index";

describe("SOURCE_REGISTRY (seed data)", () => {
  it("is valid as committed", () => {
    const result = validateRegistry(SOURCE_REGISTRY);
    expect(result.issues).toEqual([]);
    expect(result.valid).toBe(true);
    expect(() => assertValidRegistry()).not.toThrow();
  });

  it("has exactly the two seeded providers (txgio.address-points, txgio.parcels)", () => {
    expect(SOURCE_REGISTRY.map((e) => e.provider).sort()).toEqual([
      "txgio.address-points",
      "txgio.parcels",
    ]);
  });

  it("txgio.address-points keys on the provider's own objectid", () => {
    const entry = getRegistryEntry("txgio.address-points");
    expect(entry?.keyRule).toEqual({ kind: "provider-id", attribute: "objectid" });
  });

  it("txgio.parcels declares a content-derived key (no usable provider id)", () => {
    const entry = getRegistryEntry("txgio.parcels");
    expect(entry?.keyRule.kind).toBe("declared");
  });

  it("getRegistryEntry returns undefined for an unknown provider", () => {
    expect(getRegistryEntry("nobody.nothing")).toBeUndefined();
  });
});

describe("validateRegistryEntry: refuses positional/bigserial/missing keyRule", () => {
  const base = {
    provider: "fema.nfhl-fld-haz-ar",
    description: "fixture",
    expectedCountSource: { description: "fixture" },
    partitionIndexes: [],
  };

  it("refuses a missing keyRule", () => {
    const issues = validateRegistryEntry({ ...base });
    expect(issues).toContainEqual(expect.objectContaining({ reason: "keyRule is missing" }));
  });

  it('refuses keyRule.kind="positional"', () => {
    const issues = validateRegistryEntry({
      ...base,
      keyRule: { kind: "positional", attribute: "feature_index" },
    });
    expect(issues.some((i) => /keyRule\.kind must be/.test(i.reason))).toBe(true);
  });

  it('refuses keyRule.kind="bigserial"', () => {
    const issues = validateRegistryEntry({
      ...base,
      keyRule: { kind: "bigserial" },
    });
    expect(issues.some((i) => /keyRule\.kind must be/.test(i.reason))).toBe(true);
  });

  it("refuses kind=provider-id with no attribute", () => {
    const issues = validateRegistryEntry({ ...base, keyRule: { kind: "provider-id" } });
    expect(issues.some((i) => /keyRule\.attribute/.test(i.reason))).toBe(true);
  });

  it("refuses kind=declared with no name or rule", () => {
    const issues = validateRegistryEntry({ ...base, keyRule: { kind: "declared" } });
    expect(issues.some((i) => /keyRule\.name/.test(i.reason))).toBe(true);
    expect(issues.some((i) => /keyRule\.rule/.test(i.reason))).toBe(true);
  });

  it("accepts a well-formed provider-id entry", () => {
    const issues = validateRegistryEntry({
      ...base,
      keyRule: { kind: "provider-id", attribute: "objectid" },
    });
    expect(issues).toEqual([]);
  });

  it("accepts a well-formed declared entry", () => {
    const issues = validateRegistryEntry({
      ...base,
      keyRule: { kind: "declared", name: "x", rule: "sha256(...)" },
    });
    expect(issues).toEqual([]);
  });

  it("refuses a malformed provider key (missing namespace.layer shape)", () => {
    const issues = validateRegistryEntry({
      ...base,
      provider: "TXGIO_Address_Points",
      keyRule: { kind: "provider-id", attribute: "objectid" },
    });
    expect(issues.some((i) => /provider must be a/.test(i.reason))).toBe(true);
  });
});

describe("validateRegistry: cross-entry rules", () => {
  it("flags a duplicate provider key", () => {
    const dup = {
      provider: "dup.layer",
      description: "fixture",
      keyRule: { kind: "provider-id" as const, attribute: "id" },
      expectedCountSource: { description: "fixture" },
      partitionIndexes: [],
    };
    const result = validateRegistry([dup, { ...dup }]);
    expect(result.valid).toBe(false);
    expect(result.issues.some((i) => /duplicate provider key/.test(i.reason))).toBe(true);
  });
});

describe("partitionTableName", () => {
  it("slugifies a dotted/hyphenated provider key", () => {
    expect(partitionTableName("txgio.address-points")).toBe(
      "source_feature_txgio_address_points",
    );
  });
});

describe("partitionDdlForProvider", () => {
  it("generates a CREATE TABLE ... PARTITION OF plus one CREATE INDEX per declared index, for the seeded txgio.address-points entry", () => {
    const entry = getRegistryEntry("txgio.address-points");
    if (!entry) throw new Error("fixture missing");
    const ddl = partitionDdlForProvider(entry);

    expect(ddl[0]).toBe(
      `CREATE TABLE IF NOT EXISTS "source_feature_txgio_address_points" PARTITION OF "source_feature" FOR VALUES IN ('txgio.address-points');`,
    );
    expect(ddl).toHaveLength(1 + entry.partitionIndexes.length);
    expect(ddl[1]).toBe(
      `CREATE INDEX IF NOT EXISTS "source_feature_txgio_address_points_geom_gist_idx" ON "source_feature_txgio_address_points" USING GIST ("geom") WHERE geom IS NOT NULL;`,
    );
    expect(ddl[2]).toBe(
      `CREATE INDEX IF NOT EXISTS "source_feature_txgio_address_points_full_addr_norm_idx" ON "source_feature_txgio_address_points" ((normalized_full_addr(payload ->> 'full_addr')));`,
    );
  });

  it("refuses to generate DDL for an invalid entry", () => {
    expect(() =>
      partitionDdlForProvider({
        provider: "fixture.bad",
        description: "fixture",
        // @ts-expect-error -- deliberately invalid for the test
        keyRule: { kind: "positional" },
        expectedCountSource: { description: "fixture" },
        partitionIndexes: [],
      }),
    ).toThrow(/invalid registry entry/);
  });
});
