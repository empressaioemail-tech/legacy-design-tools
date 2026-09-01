/**
 * P-98: the price-id -> billing-interval inverse.
 *
 * `pe_user_entitlements.billing_interval` exists so the next-action rail's
 * `annual_upgrade` rung can tell a monthly subscriber from an annual one.
 * The one output that must never happen is a fabricated `"month"`: it would
 * make the rail offer "switch to annual" to somebody who already bought
 * annual. Every case below that could plausibly produce a wrong `"month"` is
 * asserted as `null` instead, and each is labelled VIOLATION so the negative
 * direction is visible rather than implied.
 *
 * `@workspace/db` is replaced with a factory mock (no `importActual`) so the
 * module graph never constructs lib/db's Pool. That keeps this file in the
 * DB-free bucket -- the same seam `peTeamSeatsFromStripe.unit.test.ts` uses
 * -- so these assertions actually run rather than failing at import wherever
 * DATABASE_URL is absent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  peUserEntitlements: {},
  brokerageWallets: {},
}));

const {
  peBillingIntervalForPriceId,
  peBillingIntervalFromPriceItems,
  stripePriceIdForPeTier,
} = await import("./pePaywallStripe");

const SOLO = "price_solo_monthly";
const STUDIO = "price_studio_monthly";
const TEAM = "price_team_monthly";
const SOLO_YR = "price_solo_annual";
const STUDIO_YR = "price_studio_annual";
const TEAM_YR = "price_team_annual";
const SEAT = "price_team_seat_monthly";

const PRICE_ENV_NAMES = [
  "STRIPE_SOLO_PRICE_ID",
  "STRIPE_STUDIO_PRICE_ID",
  "STRIPE_TEAM_PRICE_ID",
  "STRIPE_SOLO_ANNUAL_PRICE_ID",
  "STRIPE_STUDIO_ANNUAL_PRICE_ID",
  "STRIPE_TEAM_ANNUAL_PRICE_ID",
  "STRIPE_TEAM_SEAT_PRICE_ID",
] as const;

function clearPriceEnv(): void {
  for (const name of PRICE_ENV_NAMES) delete process.env[name];
}

function configureAllSixPrices(): void {
  process.env.STRIPE_SOLO_PRICE_ID = SOLO;
  process.env.STRIPE_STUDIO_PRICE_ID = STUDIO;
  process.env.STRIPE_TEAM_PRICE_ID = TEAM;
  process.env.STRIPE_SOLO_ANNUAL_PRICE_ID = SOLO_YR;
  process.env.STRIPE_STUDIO_ANNUAL_PRICE_ID = STUDIO_YR;
  process.env.STRIPE_TEAM_ANNUAL_PRICE_ID = TEAM_YR;
}

beforeEach(clearPriceEnv);
afterEach(clearPriceEnv);

describe("peBillingIntervalForPriceId", () => {
  it("maps each configured monthly price id to month", () => {
    configureAllSixPrices();
    expect(peBillingIntervalForPriceId(SOLO)).toBe("month");
    expect(peBillingIntervalForPriceId(STUDIO)).toBe("month");
    expect(peBillingIntervalForPriceId(TEAM)).toBe("month");
  });

  it("maps each configured annual price id to year", () => {
    configureAllSixPrices();
    expect(peBillingIntervalForPriceId(SOLO_YR)).toBe("year");
    expect(peBillingIntervalForPriceId(STUDIO_YR)).toBe("year");
    expect(peBillingIntervalForPriceId(TEAM_YR)).toBe("year");
  });

  it("round-trips against stripePriceIdForPeTier for all six (tier, interval) pairs", () => {
    // Two independently written functions over one config: the forward
    // mapping picks the env name, the inverse searches the same set. If
    // either drifts (a renamed env, a tier added to one table only) this
    // fails. A presence check on the column could not catch that.
    configureAllSixPrices();
    for (const tier of ["solo", "studio", "team"] as const) {
      for (const interval of ["month", "year"] as const) {
        const priceId = stripePriceIdForPeTier(tier, interval);
        expect(priceId, `${tier}/${interval} price id must be configured`).toBeTruthy();
        expect(peBillingIntervalForPriceId(priceId)).toBe(interval);
      }
    }
  });

  it("VIOLATION: an unmatched price id yields null, NOT month", () => {
    configureAllSixPrices();
    expect(peBillingIntervalForPriceId("price_something_we_never_configured")).toBeNull();
    // The Team extra-seat price is a real, monthly price we configure -- but
    // it is not a tier BASE price, so on its own it says nothing about the
    // subscription's plan and must not answer for it.
    process.env.STRIPE_TEAM_SEAT_PRICE_ID = SEAT;
    expect(peBillingIntervalForPriceId(SEAT)).toBeNull();
  });

  it("VIOLATION: with NOTHING configured every price id yields null, not month", () => {
    // The starved case. If the env group is missing in a deployment, the
    // inverse must go silent rather than answer "month" for everyone -- an
    // empty config set must not be able to match.
    expect(peBillingIntervalForPriceId(SOLO)).toBeNull();
    expect(peBillingIntervalForPriceId(SOLO_YR)).toBeNull();
    expect(peBillingIntervalForPriceId("anything")).toBeNull();
  });

  it("VIOLATION: null, undefined, empty and whitespace price ids yield null", () => {
    configureAllSixPrices();
    expect(peBillingIntervalForPriceId(null)).toBeNull();
    expect(peBillingIntervalForPriceId(undefined)).toBeNull();
    expect(peBillingIntervalForPriceId("")).toBeNull();
    expect(peBillingIntervalForPriceId("   ")).toBeNull();
  });

  it("VIOLATION: a blank price id is refused even when blank env vars are set", () => {
    // The sentinel attack: an item with no readable price must not resolve
    // to an interval.
    //
    // NOTE ON WHAT THIS DOES AND DOES NOT PROVE. Two independent guards can
    // produce this outcome -- the empty-input check at the top of
    // peBillingIntervalForPriceId, and the blank-env filter inside
    // configuredPeTierPriceIds. This assertion is satisfied by the input
    // guard ALONE: injecting a defect that admitted unset env vars into the
    // configured set left this test green. It was run against that defect
    // and did not fail, so on its own it is not a check on the filter. It
    // is kept because it does pin the input guard (removing that guard while
    // blank envs are admitted makes it fail), and the env-side filter gets
    // its own non-vacuous test below.
    process.env.STRIPE_SOLO_PRICE_ID = "   ";
    process.env.STRIPE_SOLO_ANNUAL_PRICE_ID = "";
    expect(peBillingIntervalForPriceId("")).toBeNull();
    expect(peBillingIntervalForPriceId("   ")).toBeNull();
  });

  it("configured price ids are read through the trimming accessor, not raw env", () => {
    // Non-vacuous companion to the test above, and the one that actually
    // fails if configuredPeTierPriceIds stops going through
    // stripePriceIdForPeTier: a padded env value must still match the clean
    // price id Stripe sends back. Reading process.env directly puts
    // "  price_padded  " in the set, "price_padded" misses it, and a real
    // monthly subscriber silently stores a null interval.
    process.env.STRIPE_SOLO_PRICE_ID = "  price_padded  ";
    expect(peBillingIntervalForPriceId("price_padded")).toBe("month");
  });

  it("VIOLATION: one price id configured as BOTH monthly and annual is ambiguous -> null", () => {
    // A misconfiguration. We cannot tell which env name the customer was
    // billed under, so we refuse rather than let declaration order decide.
    process.env.STRIPE_SOLO_PRICE_ID = "price_same";
    process.env.STRIPE_STUDIO_ANNUAL_PRICE_ID = "price_same";
    expect(peBillingIntervalForPriceId("price_same")).toBeNull();
  });

  it("tolerates surrounding whitespace on the incoming price id", () => {
    configureAllSixPrices();
    expect(peBillingIntervalForPriceId(`  ${SOLO_YR}  `)).toBe("year");
  });
});

describe("peBillingIntervalFromPriceItems", () => {
  it("reads the interval off the tier base item and ignores the extra-seat line", () => {
    configureAllSixPrices();
    process.env.STRIPE_TEAM_SEAT_PRICE_ID = SEAT;
    expect(
      peBillingIntervalFromPriceItems([
        { priceId: TEAM, quantity: 1 },
        { priceId: SEAT, quantity: 2 },
      ]),
    ).toBe("month");
  });

  it("reads an annual subscription's single base item", () => {
    configureAllSixPrices();
    expect(
      peBillingIntervalFromPriceItems([{ priceId: STUDIO_YR, quantity: 1 }]),
    ).toBe("year");
  });

  it("VIOLATION: no items at all yields null, not month", () => {
    configureAllSixPrices();
    expect(peBillingIntervalFromPriceItems([])).toBeNull();
  });

  it("VIOLATION: items that match nothing configured yield null, not month", () => {
    configureAllSixPrices();
    expect(
      peBillingIntervalFromPriceItems([
        { priceId: "price_unknown_a", quantity: 1 },
        { priceId: null, quantity: 1 },
      ]),
    ).toBeNull();
  });

  it("VIOLATION: two items disagreeing on interval refuse rather than take the first", () => {
    // Stripe cannot mix intervals in one subscription, so this payload is
    // already impossible -- which is exactly why answering it confidently
    // would be answering a contradiction.
    configureAllSixPrices();
    expect(
      peBillingIntervalFromPriceItems([
        { priceId: SOLO, quantity: 1 },
        { priceId: STUDIO_YR, quantity: 1 },
      ]),
    ).toBeNull();
    expect(
      peBillingIntervalFromPriceItems([
        { priceId: STUDIO_YR, quantity: 1 },
        { priceId: SOLO, quantity: 1 },
      ]),
    ).toBeNull();
  });

  it("two items agreeing on interval resolve to it", () => {
    configureAllSixPrices();
    expect(
      peBillingIntervalFromPriceItems([
        { priceId: SOLO, quantity: 1 },
        { priceId: STUDIO, quantity: 1 },
      ]),
    ).toBe("month");
  });
});
