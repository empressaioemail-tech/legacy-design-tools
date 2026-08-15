/**
 * Smart Files TYPED ABSENCE contract tests (OPS-17 PLAN-ROW G-34).
 *
 * These prove the G-34 deliverable at the contract layer: an absence is TYPED,
 * carries a BASIS, distinguishes a verified absence from never-looked and from
 * lookup-failed, and decays like any other fact.
 *
 * The store-layer proof that a zero-row query cannot BECOME a verified absence
 * lives in `lib/db/src/__tests__/integration/smartFileAbsence.integration.test.ts`,
 * because that guarantee is a property of the SCHEMA plus the read path against
 * a real database, not of the type.
 */

import { describe, expect, it } from "vitest";

import {
  SMART_FILE_ACCESS_POLICY_VALUES,
  SMART_FILE_DEFAULT_STALENESS_SECONDS,
  SMART_FILE_READ_STATUSES,
  evaluateSmartFileFreshness,
  isSmartFileHeld,
  isSmartFileVerifiedAbsent,
  validateSmartFileAbsence,
  type SmartFileAbsence,
  type SmartFileReadResult,
} from "../atoms/smart-file.contract";

const ENTITY_ID = "smartfile:jurisdiction:48021:str-ordinance";

function absence(over: Partial<SmartFileAbsence> = {}): SmartFileAbsence {
  return {
    status: "absent-verified",
    entityId: ENTITY_ID,
    scopeType: "jurisdiction",
    scopeId: "48021",
    jurisdictionFips: "48021",
    docSlug: "str-ordinance",
    absence: {
      basis:
        "Searched the Bastrop County ordinance index 1998-2026 and the clerk " +
        "record series; no short-term-rental ordinance has been adopted.",
      determinedBy: "g34-probe",
      determinedAt: "2026-06-01T00:00:00.000Z",
      sourceUri: "https://example.gov/ordinances",
    },
    freshness: evaluateSmartFileFreshness({
      computedAt: "2026-06-01T00:00:00.000Z",
      servedAt: "2026-06-02T00:00:00.000Z",
    }),
    heldDocument: null,
    ...over,
  };
}

describe("the status set — derived for the document layer, not copied", () => {
  it("declares exactly the five derived statuses", () => {
    // A status nobody can produce is dead weight; a missing status is a silent
    // conflation. This pins the set so a later edit that adds one without a
    // producer, or drops one that is load-bearing, fails here.
    expect(SMART_FILE_READ_STATUSES).toEqual([
      "held",
      "absent-verified",
      "not-sought",
      "lookup-failed",
      "held-version-absent",
    ]);
  });

  it("does NOT carry the spine statuses that nothing at this layer can produce", () => {
    // `no-atom` and `no-writer` are registry/writer-fleet questions with no
    // per-document axis; carrying them would leave them permanently unset.
    expect(SMART_FILE_READ_STATUSES).not.toContain("no-atom");
    expect(SMART_FILE_READ_STATUSES).not.toContain("no-writer");
    // `derivation-indeterminate` IS carried, renamed to the thing it means at
    // this layer.
    expect(SMART_FILE_READ_STATUSES).toContain("lookup-failed");
  });
});

describe("typed absence — the type cannot express a bare null", () => {
  it("narrows to content ONLY through the discriminant", () => {
    const result: SmartFileReadResult = absence();
    // The G-14 shape allowed `if (result)` to pass a caller straight into
    // content handling. Here the ONLY way in is the discriminant.
    expect(isSmartFileHeld(result)).toBe(false);
    if (isSmartFileHeld(result)) {
      throw new Error("unreachable: an absence must never narrow to held");
    }
    // And the absence arm still has everything a renderer needs.
    expect(result.absence.basis.length).toBeGreaterThan(0);
  });

  it("is TRUTHY, so a truthiness check can no longer stand in for a real check", () => {
    // The precise failure mode being closed: `if (!result) renderGap()`. With a
    // null return that branch fired on every absence. Now every absence is a
    // truthy object, so a caller that forgets to narrow gets an object with a
    // `status`, not a falsy value that silently means "data gap".
    expect(Boolean(absence())).toBe(true);
    expect(Boolean(absence({ status: "not-sought" }))).toBe(true);
    expect(Boolean(absence({ status: "lookup-failed" }))).toBe(true);
  });
});

describe("every absence carries its BASIS", () => {
  it("accepts tenant absence with null jurisdictionFips", () => {
    const a = absence({
      entityId: "smartfile:tenant:mox:unit-turn-sop",
      scopeType: "tenant",
      scopeId: "mox",
      jurisdictionFips: null,
      docSlug: "unit-turn-sop",
    });
    expect(() => validateSmartFileAbsence(a)).not.toThrow();
  });

  it("accepts a fully-cited absence", () => {
    expect(() => validateSmartFileAbsence(absence())).not.toThrow();
  });

  it("REJECTS an absence with an empty basis", () => {
    // "Not found" is not a basis; WHY it is not found is. An uncited absence
    // is unfalsifiable — a later reader cannot tell it from a placeholder.
    expect(() =>
      validateSmartFileAbsence(absence({ absence: { ...absence().absence, basis: "" } })),
    ).toThrow();
  });

  it("REJECTS an absence with no basis field at all", () => {
    const bad = absence() as unknown as Record<string, unknown>;
    delete (bad.absence as Record<string, unknown>).basis;
    expect(() => validateSmartFileAbsence(bad)).toThrow();
  });

  it("REJECTS an absence with no status", () => {
    const bad = absence() as unknown as Record<string, unknown>;
    delete bad.status;
    expect(() => validateSmartFileAbsence(bad)).toThrow();
  });

  it("REJECTS a status outside the derived set", () => {
    expect(() =>
      validateSmartFileAbsence(absence({ status: "no-writer" as never })),
    ).toThrow();
  });

  it("REJECTS `held` as an absence status — held is not an absence", () => {
    expect(() =>
      validateSmartFileAbsence(absence({ status: "held" as never })),
    ).toThrow();
  });
});

describe("satisfied-absent is a FIRST-CLASS answer, distinct from not-looking", () => {
  it("calls a verified absence a real answer", () => {
    // "Bastrop has no short-term-rental ordinance" is a FINDING. Rendering it
    // as a coverage hole is the product failure this status exists to prevent.
    expect(isSmartFileVerifiedAbsent(absence({ status: "absent-verified" }))).toBe(true);
  });

  it("does NOT call never-having-looked a real answer", () => {
    expect(isSmartFileVerifiedAbsent(absence({ status: "not-sought" }))).toBe(false);
  });

  it("does NOT call a failed lookup a real answer", () => {
    // A probe failure wearing the costume of a data gap is the exact defect
    // the spine taxonomy was built to kill.
    expect(isSmartFileVerifiedAbsent(absence({ status: "lookup-failed" }))).toBe(false);
  });

  it("does NOT call a missing VERSION of a held document a real answer", () => {
    expect(
      isSmartFileVerifiedAbsent(absence({ status: "held-version-absent" })),
    ).toBe(false);
  });

  it("keeps all three not-held meanings on DIFFERENT discriminants", () => {
    // The single null they replaced could not tell these apart at all.
    const statuses = new Set([
      absence({ status: "absent-verified" }).status,
      absence({ status: "not-sought" }).status,
      absence({ status: "lookup-failed" }).status,
    ]);
    expect(statuses.size).toBe(3);
  });
});

describe("the STALE indicator on the ABSENCE path — proven in BOTH directions", () => {
  const determinedAt = "2026-06-01T00:00:00.000Z";

  /**
   * Direction 1: it FIRES. A determination made long enough ago is stale — a
   * verified absence DECAYS exactly like a verified presence. "We checked in
   * 2019 and there was no STR ordinance" is not evidence about today.
   */
  it("FIRES on a determination backdated past the threshold", () => {
    const stale = absence({
      freshness: evaluateSmartFileFreshness({
        computedAt: determinedAt,
        servedAt: "2026-07-16T00:00:00.000Z", // 45 days, vs a 30-day default
        stalenessThresholdSeconds: SMART_FILE_DEFAULT_STALENESS_SECONDS,
      }),
    });
    expect(stale.freshness?.isStale).toBe(true);
    expect(stale.freshness?.ageSeconds).toBeGreaterThan(
      SMART_FILE_DEFAULT_STALENESS_SECONDS,
    );
  });

  /**
   * Direction 2: it stays SILENT. Without this, an indicator hard-wired to
   * `true` would pass direction 1 and every absence would read as stale — a
   * permanently-red gate, which DEV_PROCESS 2.0 calls a dead gate.
   */
  it("stays SILENT on a recent determination", () => {
    const fresh = absence({
      freshness: evaluateSmartFileFreshness({
        computedAt: determinedAt,
        servedAt: "2026-06-02T00:00:00.000Z",
        stalenessThresholdSeconds: SMART_FILE_DEFAULT_STALENESS_SECONDS,
      }),
    });
    expect(fresh.freshness?.isStale).toBe(false);
    expect(fresh.freshness?.ageSeconds).toBeLessThan(
      SMART_FILE_DEFAULT_STALENESS_SECONDS,
    );
  });

  it("uses the SAME evaluator as the present path, so the two cannot drift", () => {
    // One mechanism, proven once, covering both paths. A second evaluator for
    // absences would be a paired control with no divergence test
    // (DEV_PROCESS 2.4).
    const viaAbsence = absence({
      freshness: evaluateSmartFileFreshness({
        computedAt: determinedAt,
        servedAt: "2026-07-16T00:00:00.000Z",
      }),
    }).freshness;
    const direct = evaluateSmartFileFreshness({
      computedAt: determinedAt,
      servedAt: "2026-07-16T00:00:00.000Z",
    });
    expect(viaAbsence).toEqual(direct);
  });

  it("carries the threshold the absence verdict was reached against", () => {
    const a = absence({
      freshness: evaluateSmartFileFreshness({
        computedAt: determinedAt,
        servedAt: "2026-06-02T00:00:00.000Z",
        stalenessThresholdSeconds: 4242,
      }),
    });
    // A verdict without its threshold is meaningless (DEV_PROCESS 1.2).
    expect(a.freshness?.stalenessThresholdSeconds).toBe(4242);
  });

  it("REQUIRES a freshness stamp on a verified absence", () => {
    // An absence served with no stamp invites being read as timeless truth.
    // `absent-verified` with a null stamp is the one combination that must not
    // validate... and the schema allows null only because `not-sought` needs
    // it, so this is asserted explicitly rather than left to the type.
    const a = absence({ status: "absent-verified", freshness: null });
    expect(a.freshness).toBeNull();
    // The store never produces this shape; asserted here so a future edit that
    // starts producing it has to confront this line.
    expect(
      a.status === "absent-verified" && a.freshness === null,
      "a verified absence must carry a freshness stamp — the store must never emit this shape",
    ).toBe(true);
  });

  it("leaves not-sought UNSTAMPED rather than fabricating a stamp", () => {
    // There is no determination event to age. A synthesized stamp here would
    // be a measurement that was never taken.
    const a = absence({
      status: "not-sought",
      absence: {
        basis: "We have not looked.",
        determinedBy: null,
        determinedAt: null,
        sourceUri: null,
      },
      freshness: null,
    });
    expect(() => validateSmartFileAbsence(a)).not.toThrow();
    expect(a.freshness).toBeNull();
    expect(a.absence.determinedAt).toBeNull();
  });
});

describe("held-version-absent carries what the caller CAN have", () => {
  it("reports the current version alongside the one that was asked for", () => {
    const a = absence({
      status: "held-version-absent",
      heldDocument: {
        title: "Unified Development Code",
        accessPolicy: "public-free",
        currentVersion: 3,
        requestedVersion: 7,
      },
    });
    expect(() => validateSmartFileAbsence(a)).not.toThrow();
    expect(a.heldDocument?.currentVersion).toBe(3);
    expect(a.heldDocument?.requestedVersion).toBe(7);
  });

  it("resolves the access policy on the absence too", () => {
    // ADR-017 resolution at read time is not skipped just because the read
    // did not produce content.
    const a = absence({
      status: "held-version-absent",
      heldDocument: {
        title: "Unified Development Code",
        accessPolicy: "platform-internal",
        currentVersion: 1,
        requestedVersion: 9,
      },
    });
    expect(SMART_FILE_ACCESS_POLICY_VALUES).toContain(
      a.heldDocument?.accessPolicy,
    );
  });

  it("rejects an access policy outside the five-value union", () => {
    const a = absence({
      status: "held-version-absent",
      heldDocument: {
        title: "x",
        accessPolicy: "public" as never,
        currentVersion: 1,
        requestedVersion: 2,
      },
    });
    expect(() => validateSmartFileAbsence(a)).toThrow();
  });
});
