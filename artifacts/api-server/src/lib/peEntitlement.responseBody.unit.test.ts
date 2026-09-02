/**
 * P-98: the two `GET /api/property-explorer/v1/entitlement` response shapes.
 *
 * Deliverable 2 makes `parcelNodeId` optional. The hard requirement is that
 * the WITH-parcel response stays byte-identical to what it was before, and
 * the WITHOUT-parcel response carries the account fields while OMITTING the
 * `property` key entirely -- an omitted block and a block full of falsy
 * values are different facts.
 *
 * The frozen expectations below are transcribed from `origin/main`'s
 * `routes/propertyExplorer.ts` (the `base` literal at lines 274-285 and the
 * `property` literal at lines 303-308 of that file), not from the code under
 * test, so this compares two independent derivations rather than restating
 * the implementation. Field ORDER is asserted, not just field presence,
 * because `res.json` serialises in insertion order and "byte-identical" is
 * the requirement.
 *
 * `@workspace/db` is factory-mocked so this file runs without DATABASE_URL.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {},
  peUserEntitlements: {},
  pePropertyUnlocks: {},
  peChatMessageCounts: {},
}));

const { peEntitlementAccountBody, peEntitlementBaseBody } = await import(
  "./peEntitlement"
);
type PeEntitlementSnapshot = Parameters<typeof peEntitlementBaseBody>[0];

/**
 * The key list the R1/P-98 contract emitted, in its order. Any removal or
 * reorder of THESE keys breaks the pinned contract.
 *
 * P-104 DELIBERATELY WIDENS this body by exactly one key, appended last. The
 * prefix stays frozen and is still asserted separately below, so a reorder or
 * a drop inside the P-98 prefix still fails even though the total key list
 * grew. Widening the contract is an amendment; it is recorded here rather
 * than absorbed by relaxing the assertion.
 */
const MAIN_BASE_KEYS = [
  "authenticated",
  "tier",
  "subscriptionTier",
  "tenantId",
  "userId",
  "devRole",
  "entitlementSource",
] as const;

/** The P-104 contract: the P-98 prefix, then the computed Studio answer. */
const BASE_KEYS = [...MAIN_BASE_KEYS, "studioGranted"] as const;

const MAIN_PROPERTY_KEYS = [
  "parcelNodeId",
  "unlocked",
  "freeMessagesUsed",
  "freeMessagesLimit",
] as const;

function paidTeamSnapshot(): PeEntitlementSnapshot {
  return {
    tier: "paid",
    subscriptionTier: "team",
    tenantId: "default",
    userId: "user-p98",
    authenticated: true,
    devRole: false,
    entitlementSource: "stripe_sub",
    seatsPurchased: 5,
    billingInterval: "month",
    hasBillingAccount: true,
  };
}

function anonymousSnapshot(): PeEntitlementSnapshot {
  return {
    tier: "free",
    subscriptionTier: null,
    tenantId: "default",
    userId: null,
    authenticated: false,
    devRole: false,
    entitlementSource: null,
    seatsPurchased: null,
    billingInterval: null,
    hasBillingAccount: false,
  };
}

describe("with-parcel response (pinned contract, must not move)", () => {
  it("is byte-identical to the P-104 contract", () => {
    const body = {
      ...peEntitlementBaseBody(paidTeamSnapshot()),
      property: {
        parcelNodeId: "48055:10068",
        unlocked: true,
        freeMessagesUsed: 2,
        freeMessagesLimit: 3,
      },
    };
    expect(JSON.stringify(body)).toBe(
      '{"authenticated":true,"tier":"paid","subscriptionTier":"team",' +
        '"tenantId":"default","userId":"user-p98","devRole":false,' +
        '"entitlementSource":"stripe_sub","studioGranted":true,' +
        '"property":{"parcelNodeId":"48055:10068",' +
        '"unlocked":true,"freeMessagesUsed":2,"freeMessagesLimit":3}}',
    );
    expect(Object.keys(body)).toEqual([...BASE_KEYS, "property"]);
    expect(Object.keys(body.property)).toEqual([...MAIN_PROPERTY_KEYS]);
  });

  it("VIOLATION: the P-98 prefix is untouched by the P-104 widening", () => {
    // The widening is exactly one key, appended. If a future change reorders
    // or drops anything inside the frozen prefix, this fails even though the
    // total key list would still "contain" studioGranted.
    const keys = Object.keys(peEntitlementBaseBody(paidTeamSnapshot()));
    expect(keys.slice(0, MAIN_BASE_KEYS.length)).toEqual([...MAIN_BASE_KEYS]);
    expect(keys[keys.length - 1]).toBe("studioGranted");
    expect(keys).toHaveLength(MAIN_BASE_KEYS.length + 1);
  });

  it("VIOLATION: the base body does NOT gain the account-only fields", () => {
    // The whole failure mode this test exists for: adding seatsPurchased or
    // billingInterval to `base` would widen every with-parcel response too,
    // silently changing a contract the PE BFF is pinned to.
    const body = peEntitlementBaseBody(paidTeamSnapshot());
    expect(Object.keys(body)).toEqual([...BASE_KEYS]);
    expect("seatsPurchased" in body).toBe(false);
    expect("billingInterval" in body).toBe(false);
    // A-062 joins the same list. The portal card needs this bit on the
    // ACCOUNT body only; widening `base` would put it on every with-parcel
    // response the PE BFF is pinned to, which is the defect this test names.
    expect("hasBillingAccount" in body).toBe(false);
    expect("property" in body).toBe(false);
  });

  it("anonymous body carries studioGranted false, never an absent key", () => {
    // Anonymous callers get the base body with or without a parcel. They have
    // no account, so studioGranted is a determined false, not an omission:
    // the BFF distinguishes "server said no" from "server did not say".
    expect(JSON.stringify(peEntitlementBaseBody(anonymousSnapshot()))).toBe(
      '{"authenticated":false,"tier":"free","subscriptionTier":null,' +
        '"tenantId":"default","userId":null,"devRole":false,' +
        '"entitlementSource":null,"studioGranted":false}',
    );
  });
});

describe("P-104 studioGranted — the server computes the predicate", () => {
  it("VIOLATION: a Solo subscriber is paid and is NOT granted Studio", () => {
    // The whole P-104 defect in one assertion. tier === "paid" is TRUE for a
    // $49 Solo subscriber, which is why gating CAD and terrain on bare tier
    // handed them the $129 deliverables.
    const solo = peEntitlementBaseBody({
      ...paidTeamSnapshot(),
      subscriptionTier: "solo",
    });
    expect(solo.tier).toBe("paid");
    expect(solo.studioGranted).toBe(false);
  });

  it("Studio and Team are granted", () => {
    expect(
      peEntitlementBaseBody({ ...paidTeamSnapshot(), subscriptionTier: "studio" })
        .studioGranted,
    ).toBe(true);
    expect(
      peEntitlementBaseBody({ ...paidTeamSnapshot(), subscriptionTier: "team" })
        .studioGranted,
    ).toBe(true);
  });

  it("VIOLATION: a paid row with an unknown rung fails CLOSED", () => {
    // resolvePeEntitlement reads a stored null as "solo", but if a null ever
    // reaches this function directly it must not read as granted.
    const body = peEntitlementBaseBody({
      ...paidTeamSnapshot(),
      subscriptionTier: null,
    });
    expect(body.tier).toBe("paid");
    expect(body.studioGranted).toBe(false);
  });

  it("the account body carries the same computed answer", () => {
    expect(
      peEntitlementAccountBody({ ...paidTeamSnapshot(), subscriptionTier: "solo" })
        .studioGranted,
    ).toBe(false);
    expect(
      peEntitlementAccountBody({ ...paidTeamSnapshot(), subscriptionTier: "studio" })
        .studioGranted,
    ).toBe(true);
  });

  it("studioGranted is a boolean on every path, never undefined", () => {
    // An absent key on the wire is the BFF's "unmeasured" signal. The server
    // must never produce it: every response here has looked and decided.
    for (const snap of [
      paidTeamSnapshot(),
      anonymousSnapshot(),
      { ...paidTeamSnapshot(), subscriptionTier: "solo" as const },
      { ...paidTeamSnapshot(), subscriptionTier: null },
    ]) {
      expect(typeof peEntitlementBaseBody(snap).studioGranted).toBe("boolean");
      expect("studioGranted" in peEntitlementBaseBody(snap)).toBe(true);
    }
  });
});

describe("without-parcel account response (P-98)", () => {
  it("carries the account block and OMITS the property key entirely", () => {
    const body = peEntitlementAccountBody(paidTeamSnapshot());
    expect(Object.keys(body)).toEqual([
      ...BASE_KEYS,
      "seatsPurchased",
      "billingInterval",
      "hasBillingAccount",
    ]);
    expect(body.seatsPurchased).toBe(5);
    expect(body.billingInterval).toBe("month");
  });

  it("A-062: hasBillingAccount travels straight through, both ways", () => {
    // Settings renders a real Manage-billing control on true and the honest
    // "no billing history" row on false. Nothing here derives it from tier:
    // a paid account whose customer id never landed is a real state, and a
    // free account that once subscribed still has a portal to open.
    expect(peEntitlementAccountBody(paidTeamSnapshot()).hasBillingAccount).toBe(
      true,
    );
    expect(
      peEntitlementAccountBody({
        ...paidTeamSnapshot(),
        hasBillingAccount: false,
      }).hasBillingAccount,
    ).toBe(false);
    // NOT INFERRED FROM TIER. A free snapshot that DOES carry a customer
    // (subscribed once, cancelled) still reports true, because the portal is
    // exactly what that person needs and a tier-derived answer would hide it.
    expect(
      peEntitlementAccountBody({
        ...paidTeamSnapshot(),
        tier: "free",
        subscriptionTier: null,
        entitlementSource: null,
        hasBillingAccount: true,
      }).hasBillingAccount,
    ).toBe(true);
  });

  it("A-062 VIOLATION: the Stripe customer id itself is never on the wire", () => {
    // The bit, not the value. The portal route refuses a caller-supplied
    // customer id; serialising the real one here would hand every caller the
    // exact string that route exists to reject.
    const json = JSON.stringify(peEntitlementAccountBody(paidTeamSnapshot()));
    expect(json).not.toContain("stripeCustomerId");
    expect(json).not.toContain("stripe_customer_id");
    expect(json).not.toContain("cus_");
    expect(json).toContain('"hasBillingAccount":true');
  });

  it("VIOLATION: `property` is absent, not an empty or defaulted block", () => {
    const body = peEntitlementAccountBody(paidTeamSnapshot());
    // `in` distinguishes "key absent" from "key present holding undefined".
    // res.json drops an explicit undefined, so a body carrying
    // `property: undefined` would serialise the same and pass a
    // toBeUndefined() check while being the wrong construction.
    expect("property" in body).toBe(false);
    expect(JSON.stringify(body)).not.toContain("property");
  });

  it("VIOLATION: an unknown interval stays null, never defaulted to month", () => {
    // The pre-0092 population, and anyone whose billed price id matched no
    // configured id. Reading null as monthly is what would make the rail
    // upsell annual subscribers.
    const body = peEntitlementAccountBody({
      ...paidTeamSnapshot(),
      billingInterval: null,
      seatsPurchased: null,
    });
    expect(body.billingInterval).toBeNull();
    expect(body.seatsPurchased).toBeNull();
    expect(JSON.stringify(body)).toContain('"billingInterval":null');
  });

  it("VIOLATION: seats 0 and seats unknown do not collapse", () => {
    // A stored 0 is a fact (zero seats purchased); null is the absence of
    // one. The wire must keep them apart, as the column comment requires.
    expect(
      peEntitlementAccountBody({ ...paidTeamSnapshot(), seatsPurchased: 0 })
        .seatsPurchased,
    ).toBe(0);
    expect(
      peEntitlementAccountBody({ ...paidTeamSnapshot(), seatsPurchased: null })
        .seatsPurchased,
    ).toBeNull();
  });

  it("annual subscriber reads year, so the rail can decline to upsell", () => {
    const body = peEntitlementAccountBody({
      ...paidTeamSnapshot(),
      billingInterval: "year",
    });
    expect(body.billingInterval).toBe("year");
  });
});
