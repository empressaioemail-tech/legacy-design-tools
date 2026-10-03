import { describe, expect, it } from "vitest";
import {
  emptyContact,
  firstNameFrom,
  projectEvent,
  seedContact,
  ssContactProperties,
  type ContactState,
} from "./ssContactProjection";

const NOW = new Date("2026-10-03T12:00:00Z");

function ev(eventType: Parameters<typeof projectEvent>[1]["eventType"], payload: Record<string, unknown> = {}) {
  return { userId: "u1", email: "u1@example.com", eventType, payload };
}

function contact(over: Partial<ContactState> = {}): ContactState {
  return { ...emptyContact("u1", "u1@example.com"), ...over };
}

describe("E1 and the source mapping (contract v2 R6)", () => {
  it("utm_medium=paid from facebook is ad, with first-touch UTMs kept", () => {
    const p = projectEvent(
      null,
      ev("e1_account_created", {
        displayName: "Jane Smith",
        campaign: "utm_source=facebook&utm_medium=paid&utm_campaign=phase1&utm_content=v2",
      }),
      NOW,
    );
    expect(p.contact).toMatchObject({
      stage: "Explorer",
      source: "ad",
      firstName: "Jane",
      utmSource: "facebook",
      utmMedium: "paid",
      utmCampaign: "phase1",
      utmContent: "v2",
      plan: "free",
      billing: "none",
    });
  });

  it("no UTMs is direct; unmapped UTMs leave the source absent (never guessed)", () => {
    expect(projectEvent(null, ev("e1_account_created"), NOW).contact.source).toBe("direct");
    const unmapped = projectEvent(
      null,
      ev("e1_account_created", { campaign: "utm_source=linkedin&utm_medium=paid" }),
      NOW,
    ).contact;
    expect(unmapped.source).toBeNull();
    expect(unmapped.utmSource).toBe("linkedin");
  });

  it("first touch wins: a later E1 never overwrites an existing source", () => {
    const p = projectEvent(
      contact({ source: "share", utmMedium: "share" }),
      ev("e1_account_created", { campaign: "utm_source=facebook&utm_medium=paid" }),
      NOW,
    );
    expect(p.contact.source).toBe("share");
  });

  it("a display name that is an email gives no first name", () => {
    expect(firstNameFrom("someone@example.com")).toBeNull();
    expect(firstNameFrom("  ")).toBeNull();
    expect(firstNameFrom("Ada Lovelace")).toBe("Ada");
  });
});

describe("shares and became_sharer (once per contact, ever)", () => {
  it("the first share moves to Sharer and derives ss.became_sharer once", () => {
    const first = projectEvent(contact(), ev("e3_share_sent", { shares: 1 }), NOW);
    expect(first.contact.stage).toBe("Sharer");
    expect(first.contact.shares).toBe(1);
    expect(first.followups).toEqual([
      { event: "became_sharer", idempotencyKey: "became_sharer:u1" },
    ]);
    const second = projectEvent(first.contact, ev("e3_share_sent", { shares: 2 }), NOW);
    expect(second.contact.shares).toBe(2);
    expect(second.followups).toEqual([]);
  });

  it("a share never moves a Solo contact back to Sharer", () => {
    const p = projectEvent(contact({ stage: "Solo" }), ev("e3_share_sent", { shares: 1 }), NOW);
    expect(p.contact.stage).toBe("Solo");
  });
});

describe("paid events and previous_plan (contract v2 R1)", () => {
  it("unlock then Solo annual: Unlock then Solo, previous_plan=unlock", () => {
    const unlock = projectEvent(contact(), ev("e4_unlock_bought", { plan: "unlock", billing: "none" }), NOW);
    expect(unlock.contact).toMatchObject({ stage: "Unlock", plan: "unlock" });
    const solo = projectEvent(unlock.contact, ev("e5_plan_started", { plan: "solo", billing: "annual" }), NOW);
    expect(solo.contact).toMatchObject({ stage: "Solo", plan: "solo", billing: "annual" });
    expect(solo.resendEvent).toEqual({ previous_plan: "unlock" });
  });

  it("an unlock does not replace a plan the contact holds", () => {
    const p = projectEvent(contact({ stage: "Studio", plan: "studio", billing: "monthly" }), ev("e4_unlock_bought"), NOW);
    expect(p.contact).toMatchObject({ stage: "Studio", plan: "studio" });
  });

  it("cancel sets free/none, keeps the stage, and carries previous_plan", () => {
    const p = projectEvent(contact({ stage: "Team", plan: "team", billing: "annual" }), ev("plan_cancelled"), NOW);
    expect(p.contact).toMatchObject({ stage: "Team", plan: "free", billing: "none" });
    expect(p.resendEvent).toEqual({ previous_plan: "team" });
  });

  it("previous_plan is omitted, not guessed, when the record never saw the contact", () => {
    const p = projectEvent(null, ev("e5_plan_started", { plan: "solo", billing: "monthly" }), NOW);
    expect(p.resendEvent).toBeNull();
    expect(p.contact.plan).toBe("solo");
  });
});

describe("quiet and came back", () => {
  it("went_quiet sets quiet only when last active is 14+ days old", () => {
    const stale = projectEvent(contact({ lastActive: "2026-09-19" }), ev("went_quiet"), NOW);
    expect(stale.contact.quiet).toBe(true);
    expect(stale.suppressResend).toBeUndefined();
    const fresh = projectEvent(contact({ lastActive: "2026-09-25" }), ev("went_quiet"), NOW);
    expect(fresh.contact.quiet).toBe(false);
    expect(fresh.suppressResend).toBe("active_again_before_projection");
  });

  it("went_quiet on an already-quiet contact sends nothing", () => {
    const p = projectEvent(contact({ quiet: true, lastActive: "2026-09-01" }), ev("went_quiet"), NOW);
    expect(p.suppressResend).toBe("not_a_quiet_transition");
  });

  it("the first session after quiet clears it and derives ss.came_back once per transition", () => {
    const quietSince = new Date("2026-09-20T00:00:00Z");
    const p = projectEvent(
      contact({ quiet: true, quietSince, lastActive: "2026-09-05" }),
      ev("e6_last_active", { lastActive: "2026-10-03" }),
      NOW,
    );
    expect(p.contact).toMatchObject({ quiet: false, quietSince: null, lastActive: "2026-10-03" });
    expect(p.followups).toEqual([
      { event: "came_back", idempotencyKey: `came_back:u1:${quietSince.toISOString()}` },
    ]);
    const again = projectEvent(p.contact, ev("e6_last_active", { lastActive: "2026-10-04" }), NOW);
    expect(again.followups).toEqual([]);
  });
});

describe("claude_connected", () => {
  it("sets the flag; a second one sends nothing", () => {
    const p = projectEvent(contact(), ev("claude_connected"), NOW);
    expect(p.contact.claudeConnected).toBe(true);
    expect(projectEvent(p.contact, ev("claude_connected"), NOW).suppressResend).toBe("already_claude_connected");
  });
});

describe("contract v2 properties as Resend receives them", () => {
  it("booleans are the strings true/false (Resend properties are string|number); absent values are omitted", () => {
    expect(ssContactProperties(contact({ claudeConnected: true }))).toEqual({
      ss_stage: "Explorer",
      ss_plan: "free",
      ss_billing: "none",
      ss_saved_lots: 0,
      ss_shares: 0,
      ss_quiet: "false",
      ss_claude_connected: "true",
    });
    expect(ssContactProperties(contact({ source: "ad", lastActive: "2026-10-03" }))).toMatchObject({
      ss_source: "ad",
      ss_last_active: "2026-10-03",
    });
  });

  it("carries nothing parcel-shaped: exactly the contract keys", () => {
    const keys = Object.keys(
      ssContactProperties(contact({ source: "ad", lastActive: "2026-10-03" })),
    ).sort();
    expect(keys).toEqual(
      [
        "ss_billing",
        "ss_claude_connected",
        "ss_last_active",
        "ss_plan",
        "ss_quiet",
        "ss_saved_lots",
        "ss_shares",
        "ss_source",
        "ss_stage",
      ].sort(),
    );
  });
});

describe("seedContact: a first-seen user starts from what they paid for (P-492b)", () => {
  const studioAnnual = {
    row: { accessTier: "paid", subscriptionTier: "studio", billingInterval: "year" },
    hasLiveUnlock: false,
  };

  it("a Studio annual subscriber seeds as Studio, studio, annual", () => {
    const s = seedContact("u1", "u1@example.com", studioAnnual);
    expect(s.ok && s.contact).toMatchObject({ stage: "Studio", plan: "studio", billing: "annual" });
  });

  it("VIOLATION (the production defect): a Studio subscriber whose first event is claude_connected is not written as free", () => {
    const s = seedContact("u1", "u1@example.com", studioAnnual);
    if (!s.ok) throw new Error(s.error);
    const p = projectEvent(null, ev("claude_connected"), NOW, s.contact);
    expect(p.contact).toMatchObject({ plan: "studio", billing: "annual", stage: "Studio", claudeConnected: true });
    // Control: without the seed the same event produces the defaulted record the fix removes.
    expect(projectEvent(null, ev("claude_connected"), NOW).contact.plan).toBe("free");
  });

  it("a seeded first event still omits previous_plan: the record did not exist, so nothing is guessed", () => {
    const s = seedContact("u1", "u1@example.com", studioAnnual);
    if (!s.ok) throw new Error(s.error);
    const p = projectEvent(null, ev("e5_plan_started", { plan: "studio", billing: "annual" }), NOW, s.contact);
    expect(p.resendEvent).toBeNull();
  });

  it("a free row, and no row at all, read as free (a sign-in row, or no payment ever recorded)", () => {
    for (const row of [{ accessTier: "free", subscriptionTier: null, billingInterval: null }, null]) {
      const s = seedContact("u1", "u1@example.com", { row, hasLiveUnlock: false });
      expect(s.ok && s.contact).toMatchObject({ plan: "free", billing: "none", stage: "Explorer" });
    }
  });

  it("a live unlock with no subscription seeds as unlock", () => {
    const s = seedContact("u1", "u1@example.com", {
      row: { accessTier: "paid", subscriptionTier: null, billingInterval: null },
      hasLiveUnlock: true,
    });
    expect(s.ok && s.contact).toMatchObject({ plan: "unlock", stage: "Unlock" });
  });

  it("refuses rather than guesses: paid with no tier and no unlock, a paid tier with no interval, an unknown tier", () => {
    expect(seedContact("u1", "e", { row: { accessTier: "paid", subscriptionTier: null, billingInterval: null }, hasLiveUnlock: false }))
      .toEqual({ ok: false, error: "entitlement_paid_without_tier" });
    expect(seedContact("u1", "e", { row: { accessTier: "paid", subscriptionTier: "solo", billingInterval: null }, hasLiveUnlock: false }))
      .toEqual({ ok: false, error: "entitlement_paid_without_interval" });
    expect(seedContact("u1", "e", { row: { accessTier: "paid", subscriptionTier: "enterprise", billingInterval: "year" }, hasLiveUnlock: false }))
      .toEqual({ ok: false, error: "entitlement_tier_unknown:enterprise" });
  });
});
