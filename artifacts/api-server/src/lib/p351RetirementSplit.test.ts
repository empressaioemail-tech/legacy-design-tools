/**
 * P-351. THE COMMITTED ANSWER FOR HAYS 48209'S 1,386 WRITER-(a) RETIREMENTS.
 *
 * `__fixtures__/p351-hays-served-keys-retirement-split.json` is a measurement, not a stub: every
 * row is one served key writer (a) retired on production, with the published identifier that
 * names its account and the verdict this lane measured against the declared roll. The next bake
 * applies the answer; a later reader re-derives it from the rows.
 *
 * WHY A TEST AND NOT JUST A FILE. The file's own header carries counts, and a header that can
 * disagree with the rows it describes is the "a number is measured once and published as state"
 * failure this program keeps meeting: the counts here are RECOMPUTED from the rows on every run
 * rather than trusted. Same shape as `cellServeRule.test.ts`'s "the fixture is the contract".
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FIXTURE_URL = new URL(
  "./__fixtures__/p351-hays-served-keys-retirement-split.json",
  import.meta.url,
);

interface SplitRow {
  nodeKey: string;
  nodeGeoId: string | null;
  registerKey: string | null;
  declaredRegister: {
    accountKey: string;
    accountsPublishingIt: number;
    propertyNumber: string | null;
    marketValue: number | null;
  } | null;
  priorVintageRegister: {
    accountKey: string;
    accountsPublishingIt: number;
    propertyNumber: string | null;
  } | null;
  resolution: string;
  verdict: string;
  nextBakeApplies: string;
}

interface SplitArtifact {
  _keyCount: number;
  _counts: Record<string, number>;
  _countsByResolution: Record<string, number>;
  _whatTheNextBakeApplies: Record<string, number>;
  rows: SplitRow[];
}

const artifact = JSON.parse(readFileSync(FIXTURE_URL, "utf8")) as SplitArtifact;

const counted = <T extends string>(values: T[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
};

describe("P-351 Hays split artifact: the header and the rows cannot disagree", () => {
  it("carries one row per key, and the header count is that number", () => {
    expect(artifact.rows.length).toBeGreaterThan(0);
    expect(artifact._keyCount).toBe(artifact.rows.length);
  });

  it("re-derives every header count from the rows", () => {
    const verdicts = counted(artifact.rows.map((r) => r.verdict));
    expect(artifact._counts).toEqual(verdicts);
    const resolutions = counted(artifact.rows.map((r) => r.resolution));
    expect(artifact._countsByResolution).toEqual(resolutions);
    // All three outcomes are ALWAYS present, including the zero: "0 still retired" is a
    // finding about the county, and a header that omits it reads as "not measured".
    const applies: Record<string, number> = {
      "not-retired; dollars from the account its own published number names": 0,
      "not-retired; declared undetermined (the payload says why)": 0,
      "still retired (its account is off the declared roll)": 0,
    };
    for (const r of artifact.rows) {
      applies[
        r.nextBakeApplies.startsWith("not-retired; dollars")
          ? "not-retired; dollars from the account its own published number names"
          : r.nextBakeApplies.startsWith("retired (")
            ? "still retired (its account is off the declared roll)"
            : "not-retired; declared undetermined (the payload says why)"
      ] += 1;
    }
    expect(artifact._whatTheNextBakeApplies).toEqual(applies);
  });

  it("never retires a key whose account the declared roll still publishes", () => {
    for (const r of artifact.rows) {
      const onTheDeclaredRoll = r.declaredRegister != null && r.declaredRegister.accountsPublishingIt === 1;
      if (onTheDeclaredRoll) {
        expect(r.nextBakeApplies).not.toContain("retired (");
      }
    }
  });

  it("retires ONLY through the prior vintage, which is the one live retirement signal", () => {
    for (const r of artifact.rows) {
      if (r.nextBakeApplies.startsWith("retired (")) {
        expect(r.resolution).toBe("resolved:r-account-register-prior-vintage");
        expect(r.declaredRegister).toBeNull();
        expect(r.priorVintageRegister).not.toBeNull();
        expect(r.verdict).toContain("genuine");
      }
    }
  });

  it("gives every key a named identifier and a decided verdict, never a blank", () => {
    for (const r of artifact.rows) {
      expect(r.nodeKey).not.toBe("");
      expect(r.registerKey).toBe(`R${r.nodeKey}`);
      expect(r.resolution).not.toBe("");
      expect(r.verdict).not.toBe("");
      expect(r.nextBakeApplies).not.toBe("");
      // Every key carries at least one published identifier: its own R account number.
      if (r.declaredRegister == null && r.priorVintageRegister == null) {
        expect(r.verdict).toBe("false-retirement--no-resolvable-account");
      }
    }
  });

  it("keeps the two-identifier contradiction a refusal, not a winner", () => {
    const contradicted = artifact.rows.filter(
      (r) => r.resolution === "unresolved:contradicted-by-node-identifier",
    );
    for (const r of contradicted) {
      expect(r.nodeGeoId).not.toBeNull();
      expect(r.declaredRegister?.propertyNumber).not.toBe(r.nodeGeoId);
      expect(r.nextBakeApplies).toBe("not-retired; declared undetermined");
    }
  });
});
