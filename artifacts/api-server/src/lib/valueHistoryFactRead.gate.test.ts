/**
 * gateValueHistoryFactValuation (P-246). Pure unit tests -- no DB. The
 * fixture-named entitlement-resolution tests (Solo/free/Studio/Property-
 * Unlock) live in brokerageNodeFacets.test.ts's "valueHistoryFact dollar
 * gate (P-246)" describe block, which exercises the real route end to end;
 * this file tests the gate function itself in isolation, which is what
 * this lane can actually execute in an environment with no test Postgres
 * (see DEV_PROCESS -- the instrument that produced a claim is part of the
 * claim; this file's claims are backed by a real local vitest run, the
 * route-level claims are backed by CI).
 */

import { describe, expect, it } from "vitest";
import { gateValueHistoryFactValuation } from "./valueHistoryFactRead";
import type { ValueHistoryFactRead } from "./valueHistoryFactRead";

const PRESENT: ValueHistoryFactRead = {
  state: "present",
  source: "value-history-fact",
  entityId: "48021:34137",
  sourceAdapter: "parcel_record",
  sourceVintage: "2025",
  evaluatedAt: "2026-09-16T00:00:00Z",
  entries: [
    {
      taxYear: 2025,
      marketValue: 511345,
      assessedValue: null,
      landValue: 106715,
      improvementValue: 404630,
      viaCrosswalk: false,
    },
    {
      taxYear: 2024,
      marketValue: 480000,
      assessedValue: 480000,
      landValue: 100000,
      improvementValue: 380000,
      viaCrosswalk: false,
    },
  ],
};

const ABSENT: ValueHistoryFactRead = {
  state: "absent",
  source: "value-history-fact",
  entityId: "48021:34137",
  absence: { kind: "no-rows", reason: "test" },
  verifiedAbsence: true,
  sourceTier: null,
  sourceAdapter: "parcel_record",
  sourceVintage: null,
};

const REFUSED: ValueHistoryFactRead = {
  state: "refused",
  code: "not-cut-over",
  source: "value-history-fact",
  entityId: "48021:34137",
  reason: "test",
};

describe("gateValueHistoryFactValuation", () => {
  it("granted=true: passes a present fact through byte-identical (Studio/Team/Property-Unlock outcome)", () => {
    const result = gateValueHistoryFactValuation(PRESENT, true);
    expect(result).toEqual(PRESENT);
    expect(result).toBe(PRESENT);
  });

  it("granted=false: every dollar key on every entry becomes a typed studio-gated refusal (Solo/free/anon/identified-only outcome)", () => {
    const result = gateValueHistoryFactValuation(PRESENT, false);
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.entries).toHaveLength(2);
    for (const entry of result.entries) {
      for (const field of [
        "marketValue",
        "assessedValue",
        "landValue",
        "improvementValue",
      ] as const) {
        expect(entry[field]).toEqual({
          state: "refused",
          code: "studio-gated",
          reason: expect.stringContaining("Studio or Team only"),
        });
      }
    }
    // taxYear and viaCrosswalk survive untouched.
    expect(result.entries[0].taxYear).toBe(2025);
    expect(result.entries[0].viaCrosswalk).toBe(false);
    expect(result.entries[1].taxYear).toBe(2024);
    // The real dollar figures never appear anywhere in the gated output.
    expect(JSON.stringify(result)).not.toContain("511345");
    expect(JSON.stringify(result)).not.toContain("404630");
    expect(JSON.stringify(result)).not.toContain("480000");
  });

  it("RED-TEST PROOF (falsifier 2): a caller that forgets to gate sees the real dollar value the granted=false branch above must never leak -- this assertion is what goes red if gateValueHistoryFactValuation is bypassed", () => {
    const ungated = PRESENT; // what the wire looked like before this lane's fix
    expect(ungated.state === "present" && ungated.entries[0].marketValue).toBe(
      511345,
    );
    const gated = gateValueHistoryFactValuation(PRESENT, false);
    if (gated.state !== "present") throw new Error("unreachable");
    expect(gated.entries[0].marketValue).not.toBe(511345);
  });

  it("absent fact passes through unchanged regardless of granted", () => {
    expect(gateValueHistoryFactValuation(ABSENT, false)).toBe(ABSENT);
    expect(gateValueHistoryFactValuation(ABSENT, true)).toBe(ABSENT);
  });

  it("refused (not-cut-over) fact passes through unchanged regardless of granted", () => {
    expect(gateValueHistoryFactValuation(REFUSED, false)).toBe(REFUSED);
    expect(gateValueHistoryFactValuation(REFUSED, true)).toBe(REFUSED);
  });

  it("never drops an entry -- entry count is identical before and after gating", () => {
    const result = gateValueHistoryFactValuation(PRESENT, false);
    if (result.state !== "present") throw new Error("unreachable");
    expect(result.entries.length).toBe(PRESENT.entries.length);
  });
});
