/**
 * OPS-16 P-185 — PROMOTEKIT AFFILIATE REFERRAL, the DB-free half.
 *
 * Why a separate, DB-free suite: the api-server integration suites need a real
 * Postgres (`@workspace/db/testing` reads TEST_DATABASE_URL/DATABASE_URL), and
 * the cc-agent workstation has none — so a rule that only has an integration
 * test has no locally reproducible guard at all (DEV_PROCESS 0: a control that
 * depends on remembering is not a control). `promotekitReferral.ts` imports
 * nothing, so this suite runs anywhere.
 *
 * What it pins, both directions:
 *   - with a referral, the session form body carries the key and the
 *     subscription form body carries BOTH keys (renewals must attribute);
 *   - without one, NEITHER key appears — an absent key, never a null/empty
 *     placeholder, which is the falsifier the dispatch names;
 *   - a malformed id is DROPPED, never thrown: a bad attribution token must
 *     not be able to block a purchase.
 *
 * The end-to-end route wiring (that the two PE routes forward the field) is
 * covered by the DB-backed suite `pe-paywall-stripe.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
  applyPromotekitReferral,
  normalizePromotekitReferral,
  PE_PROMOTEKIT_REFERRAL_MAX_LENGTH,
  PROMOTEKIT_REFERRAL_METADATA_KEY,
  PROMOTEKIT_REFERRAL_SUBSCRIPTION_METADATA_KEY,
} from "../lib/promotekitReferral";

const SESSION_KEY = PROMOTEKIT_REFERRAL_METADATA_KEY;
const SUBSCRIPTION_KEY = PROMOTEKIT_REFERRAL_SUBSCRIPTION_METADATA_KEY;

describe("normalizePromotekitReferral", () => {
  it("keeps a plain id, trimmed", () => {
    expect(normalizePromotekitReferral("  aff_abc123  ")).toBe("aff_abc123");
  });

  it("accepts an id exactly at the length cap", () => {
    const atCap = "x".repeat(PE_PROMOTEKIT_REFERRAL_MAX_LENGTH);
    expect(normalizePromotekitReferral(atCap)).toBe(atCap);
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 42],
    ["an object", { via: "aff" }],
    ["an array", ["aff"]],
    ["empty", ""],
    ["whitespace only", "   "],
    ["internal whitespace", "aff abc"],
    ["a newline", "aff\nabc"],
    ["over the length cap", "x".repeat(PE_PROMOTEKIT_REFERRAL_MAX_LENGTH + 1)],
  ])("drops %s without throwing", (_name, raw) => {
    expect(normalizePromotekitReferral(raw)).toBeNull();
  });
});

describe("applyPromotekitReferral — payment path (the $15 unlock)", () => {
  it("writes metadata[promotekit_referral] and NOT the subscription key", () => {
    const params: Record<string, string> = { mode: "payment" };
    const applied = applyPromotekitReferral(params, "aff_abc123");
    expect(applied).toBe(true);
    expect(params[SESSION_KEY]).toBe("aff_abc123");
    expect(SUBSCRIPTION_KEY in params).toBe(false);
  });

  it("writes NOTHING for a missing referral — absent, not empty", () => {
    const params: Record<string, string> = { mode: "payment" };
    expect(applyPromotekitReferral(params, undefined)).toBe(false);
    expect(SESSION_KEY in params).toBe(false);
    expect(SUBSCRIPTION_KEY in params).toBe(false);
  });

  it("writes NOTHING for a malformed referral", () => {
    const params: Record<string, string> = { mode: "payment" };
    expect(applyPromotekitReferral(params, "has whitespace")).toBe(false);
    expect(SESSION_KEY in params).toBe(false);
  });
});

describe("applyPromotekitReferral — subscription path (renewals must attribute)", () => {
  it("writes BOTH keys with the same id", () => {
    const params: Record<string, string> = { mode: "subscription" };
    const applied = applyPromotekitReferral(params, "aff_abc123", {
      subscription: true,
    });
    expect(applied).toBe(true);
    expect(params[SESSION_KEY]).toBe("aff_abc123");
    expect(params[SUBSCRIPTION_KEY]).toBe("aff_abc123");
  });

  it("writes NEITHER key for a missing referral", () => {
    const params: Record<string, string> = { mode: "subscription" };
    expect(applyPromotekitReferral(params, null, { subscription: true })).toBe(
      false,
    );
    expect(SESSION_KEY in params).toBe(false);
    expect(SUBSCRIPTION_KEY in params).toBe(false);
  });

  it("writes NEITHER key for a malformed referral", () => {
    const params: Record<string, string> = { mode: "subscription" };
    expect(
      applyPromotekitReferral(params, "x".repeat(200), { subscription: true }),
    ).toBe(false);
    expect(SESSION_KEY in params).toBe(false);
    expect(SUBSCRIPTION_KEY in params).toBe(false);
  });

  it("does not disturb the params already on the body", () => {
    const params: Record<string, string> = {
      mode: "subscription",
      "metadata[pe_user_id]": "user-1",
      "metadata[checkout_kind]": "pe_sub",
    };
    applyPromotekitReferral(params, "aff_abc123", { subscription: true });
    expect(params["metadata[pe_user_id]"]).toBe("user-1");
    expect(params["metadata[checkout_kind]"]).toBe("pe_sub");
  });
});
