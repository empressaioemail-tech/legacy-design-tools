import { describe, expect, it } from "vitest";
import { peWireBillingInterval } from "../peWireBillingInterval";

// THE DEFECT THIS EXISTS FOR, found 2026-09-01 between two sibling lanes.
//
// The column and the Stripe-derived mapper speak "month" | "year". The client's
// parse resolves ONLY "monthly" | "annual" and returns null for anything else.
// Nobody translated. A raw "month" on the wire would have read as UNKNOWN, so
// the rail's annual_upgrade rung would never have fired — silently, forever,
// while looking shipped. The client's own unrecognised-is-null safety is what
// would have made it silent rather than loud.
//
// This file imports no database module on purpose, so these run without
// DATABASE_URL. The body-level wiring is asserted in the route suite, which
// needs a database and therefore first runs in CI.

describe("peWireBillingInterval", () => {
  it("translates the storage vocabulary to the product vocabulary", () => {
    expect(peWireBillingInterval("month")).toBe("monthly");
    expect(peWireBillingInterval("year")).toBe("annual");
  });

  it("NEVER emits the storage vocabulary — the assertion that would have caught it", () => {
    for (const v of ["month", "year"] as const) {
      const out = peWireBillingInterval(v);
      expect(out).not.toBe("month");
      expect(out).not.toBe("year");
    }
  });

  it("yields null for unknown rather than passing a value through", () => {
    expect(peWireBillingInterval(null)).toBeNull();
    expect(peWireBillingInterval(undefined)).toBeNull();
    // Already-translated input is NOT re-accepted: a value this function does
    // not understand is not a fact about anyone's billing.
    expect(peWireBillingInterval("monthly" as never)).toBeNull();
    expect(peWireBillingInterval("annual" as never)).toBeNull();
    expect(peWireBillingInterval("" as never)).toBeNull();
  });
});
