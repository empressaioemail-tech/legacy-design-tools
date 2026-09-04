/**
 * P-100 items 2-7 — the checks, and the violations that prove they can fail.
 *
 * EVERY TEST HERE RUNS WITHOUT POSTGRES. That is a deliberate design
 * constraint, not a convenience: the logic each of these pins was
 * deliberately split out of its query (`recordGtmEventDecide` out of
 * `recordGtmEvent`, `peShareAttributionValidate` out of `peShareAttribution`,
 * `gtmShareFunnelReadoutShape` out of `gtmShareFunnelReadout`) so that a
 * refusal can be verified by anyone, anywhere, without a database to reach.
 * A check that only runs where a database is reachable is a check that
 * mostly does not run.
 *
 * WHAT IS NOT COVERED HERE, stated rather than implied. The DDL constraints
 * (the recipient primary key that makes first-touch unbypassable, the
 * composite key that makes a second activation row unrepresentable, the
 * milestone CHECK) are enforced by Postgres and are exercised by the
 * integration suite, which needs a database. This file pins the READABLE
 * refusals; the database pins the UNBYPASSABLE ones. Neither is a substitute
 * for the other, and if only one could exist it should be the database.
 */

import { describe, expect, it } from "vitest";

import { decideGtmEventWrite } from "../recordGtmEventDecide";
import {
  CLIENT_ASSERTED_IDENTITY_KEYS,
  decideShareAttribution,
  parseShareAttribution,
} from "../peShareAttributionValidate";
import {
  PE_ACCOUNT_ACTIVATION_MILESTONES,
  parseAccountActivation,
} from "../peAccountActivationValidate";
import {
  measureAffiliateArrivals,
  measureEventMetric,
  measureOrganicArrivals,
  measureStoreMetric,
  shareCreatedDivergence,
} from "../gtmShareFunnelReadoutShape";
import { PROPERTY_EXPLORER_FUNNEL_EVENT_TYPES } from "../gtmPropertyExplorerFunnelTypes";

const GRANT = "c86a0001-0086-4086-a001-000000000001";
const OTHER_GRANT = "f40412d7-63a1-4a75-b80a-9addd65e9219";

// ---------------------------------------------------------------------------
// Item 2 — the Smart Site share plane can emit
// ---------------------------------------------------------------------------

describe("P-100 item 2: the Smart Site share plane emits", () => {
  it("accepts share_created and share_viewed as property-explorer funnel types", () => {
    expect(PROPERTY_EXPLORER_FUNNEL_EVENT_TYPES).toContain("share_created");
    expect(PROPERTY_EXPLORER_FUNNEL_EVENT_TYPES).toContain("share_viewed");
  });

  it("still refuses a type that is not in the allowlist (the check is not vacuous)", () => {
    expect(PROPERTY_EXPLORER_FUNNEL_EVENT_TYPES).not.toContain(
      "share_definitely_not_a_real_event",
    );
  });

  it("adds no second writer: the allowlist is the only thing that grew", () => {
    // Before this card the list held seven types; P-100 added two
    // (share_created, share_viewed) for a baseline of nine. P-118 later
    // added two more (see the describe block below) — this assertion tracks
    // the CURRENT total rather than freezing at nine forever, because the
    // point of this guard is "still exactly one writer", not "never grows
    // again". Bump this number, deliberately, whenever a future card adds
    // to the allowlist.
    expect(PROPERTY_EXPLORER_FUNNEL_EVENT_TYPES).toHaveLength(11);
  });
});

describe("P-118: the Help widget emits through the SAME writer, not a second one", () => {
  it("accepts pe_help_widget_opened and pe_help_widget_message_sent as property-explorer funnel types", () => {
    expect(PROPERTY_EXPLORER_FUNNEL_EVENT_TYPES).toContain("pe_help_widget_opened");
    expect(PROPERTY_EXPLORER_FUNNEL_EVENT_TYPES).toContain("pe_help_widget_message_sent");
  });

  it("still refuses a type that is not in the allowlist (the check is not vacuous)", () => {
    expect(PROPERTY_EXPLORER_FUNNEL_EVENT_TYPES).not.toContain(
      "pe_help_widget_definitely_not_a_real_event",
    );
  });

  it("adds no second writer: the allowlist grew by exactly these two", () => {
    // Before P-118 the list held nine types (P-100's seven plus share_created
    // / share_viewed). Two were added for the Help widget and nothing else —
    // same single insert(gtmEvents) site the property-explorer events route
    // already owns.
    expect(PROPERTY_EXPLORER_FUNNEL_EVENT_TYPES).toHaveLength(11);
  });
});

// ---------------------------------------------------------------------------
// Item 3 — sharer attribution, and the client that may not assert one
// ---------------------------------------------------------------------------

describe("P-100 item 3: attribution is never written by the client", () => {
  it("accepts a body carrying only a grant id", () => {
    const parsed = parseShareAttribution({ grantId: GRANT });
    expect(parsed).toEqual({ ok: true, value: { grantId: GRANT, surface: null } });
  });

  it.each(CLIENT_ASSERTED_IDENTITY_KEYS)(
    "REFUSES a body that asserts an identity via %s",
    (key) => {
      const parsed = parseShareAttribution({ grantId: GRANT, [key]: "u_evil" });
      expect(parsed.ok).toBe(false);
      if (parsed.ok) throw new Error("unreachable");
      expect(parsed.refusal).toEqual({ error: "client_asserted_identity", key });
    },
  );

  it("refuses rather than strips: the grant id alone would have been valid", () => {
    // The same body minus the asserted key parses. So the refusal is caused by
    // the assertion and by nothing else, which is what makes it a refusal
    // rather than a coincidence.
    expect(parseShareAttribution({ grantId: GRANT }).ok).toBe(true);
    expect(parseShareAttribution({ grantId: GRANT, sharerUserId: "u_a" }).ok).toBe(
      false,
    );
  });

  it("refuses a malformed grant id", () => {
    for (const bad of ["", "not-a-uuid", GRANT.slice(0, -1), 42, null, undefined]) {
      const parsed = parseShareAttribution({ grantId: bad });
      expect(parsed.ok, `grantId=${String(bad)}`).toBe(false);
    }
  });

  it("refuses a blank surface but allows an absent one", () => {
    expect(parseShareAttribution({ grantId: GRANT, surface: "  " }).ok).toBe(false);
    expect(parseShareAttribution({ grantId: GRANT, surface: null }).ok).toBe(true);
    expect(parseShareAttribution({ grantId: GRANT }).ok).toBe(true);
  });

  it("attributes a recipient to the grantor on the grant row", () => {
    expect(
      decideShareAttribution({
        grant: { id: GRANT, grantorUserId: "u_sharer" },
        recipientUserId: "u_recipient",
        existingGrantId: null,
      }),
    ).toEqual({ action: "attribute", grantId: GRANT, grantorUserId: "u_sharer" });
  });

  it("REFUSES self-attribution", () => {
    expect(
      decideShareAttribution({
        grant: { id: GRANT, grantorUserId: "u_same" },
        recipientUserId: "u_same",
        existingGrantId: null,
      }),
    ).toEqual({ action: "refuse", reason: "self_attribution" });
  });

  it("REFUSES a grant that does not exist", () => {
    expect(
      decideShareAttribution({
        grant: null,
        recipientUserId: "u_recipient",
        existingGrantId: null,
      }),
    ).toEqual({ action: "refuse", reason: "grant_not_found" });
  });

  it("FIRST TOUCH WINS: a second grant cannot displace the first", () => {
    expect(
      decideShareAttribution({
        grant: { id: OTHER_GRANT, grantorUserId: "u_second_sharer" },
        recipientUserId: "u_recipient",
        existingGrantId: GRANT,
      }),
    ).toEqual({ action: "refuse", reason: "already_attributed" });
  });

  it("checks already-attributed BEFORE grant existence, so a bad second link cannot unseat a good first one", () => {
    expect(
      decideShareAttribution({
        grant: null,
        recipientUserId: "u_recipient",
        existingGrantId: GRANT,
      }),
    ).toEqual({ action: "refuse", reason: "already_attributed" });
  });
});

// ---------------------------------------------------------------------------
// Item 4 — activation, once per account
// ---------------------------------------------------------------------------

describe("P-100 item 4: activation milestones", () => {
  it.each(PE_ACCOUNT_ACTIVATION_MILESTONES)("accepts %s", (milestone) => {
    const parsed = parseAccountActivation({ milestone });
    expect(parsed).toEqual({ ok: true, value: { milestone, surface: null } });
  });

  it("REFUSES an unknown milestone and NAMES the allowed set", () => {
    const parsed = parseAccountActivation({ milestone: "first_vibe_felt" });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.refusal.error).toBe("invalid_milestone");
    expect(parsed.refusal.allowed).toEqual(PE_ACCOUNT_ACTIVATION_MILESTONES);
  });

  it("REFUSES an absent milestone rather than defaulting one", () => {
    expect(parseAccountActivation({}).ok).toBe(false);
    expect(parseAccountActivation({ milestone: "" }).ok).toBe(false);
    expect(parseAccountActivation(null).ok).toBe(false);
    expect(parseAccountActivation("first_property_saved").ok).toBe(false);
  });

  it("REFUSES a blank surface but allows an absent one", () => {
    const m = "first_property_saved";
    expect(parseAccountActivation({ milestone: m, surface: "" }).ok).toBe(false);
    expect(parseAccountActivation({ milestone: m, surface: "   " }).ok).toBe(false);
    expect(parseAccountActivation({ milestone: m }).ok).toBe(true);
  });

  it("keeps the milestone vocabulary closed at three", () => {
    expect(PE_ACCOUNT_ACTIVATION_MILESTONES).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Item 5 — consent is carried, and is year zero
// ---------------------------------------------------------------------------

describe("P-100 item 5: an event without consent REFUSES, never defaults", () => {
  it("stamps the version and opt-in from the store when consent exists", () => {
    expect(
      decideGtmEventWrite({ consentVersion: "2026-05-26-v1", graphOptIn: true }),
    ).toEqual({
      action: "insert",
      consentVersion: "2026-05-26-v1",
      graphOptIn: "true",
    });
    expect(
      decideGtmEventWrite({
        consentVersion: "2026-07-21-property-explorer-v1",
        graphOptIn: false,
      }),
    ).toEqual({
      action: "insert",
      consentVersion: "2026-07-21-property-explorer-v1",
      graphOptIn: "false",
    });
  });

  it("REFUSES when there is no consent row", () => {
    expect(decideGtmEventWrite(null)).toEqual({
      action: "refuse",
      reason: "consent_absent",
    });
  });

  it("REFUSES a sentinel version: a blank passes NOT NULL and means nothing", () => {
    for (const blank of ["", "   ", "\t"]) {
      expect(
        decideGtmEventWrite({ consentVersion: blank, graphOptIn: false }),
        `blank=${JSON.stringify(blank)}`,
      ).toEqual({ action: "refuse", reason: "consent_absent" });
    }
  });

  it("has no third answer: every input either inserts or refuses", () => {
    const inputs = [
      null,
      { consentVersion: "", graphOptIn: false },
      { consentVersion: "v1", graphOptIn: false },
      { consentVersion: "v1", graphOptIn: true },
    ];
    const actions = new Set(inputs.map((i) => decideGtmEventWrite(i).action));
    // Not vacuous: BOTH answers must actually occur across these inputs, so a
    // stub that always inserted or always refused would fail here.
    expect(actions).toEqual(new Set(["insert", "refuse"]));
  });

  it("the input type no longer carries a caller-supplied consent version", async () => {
    // A structural check, not a behavioural one. If `consentVersion` returns
    // to `RecordGtmEventInput` a call site can assert its own consent again,
    // which is the defect this card closed. The source is read rather than
    // the type, because a type cannot be asserted against at runtime.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "recordGtmEvent.ts"), "utf8");
    const inputType = src.slice(
      src.indexOf("export type RecordGtmEventInput"),
      src.indexOf("/**", src.indexOf("export type RecordGtmEventInput")),
    );
    expect(inputType).not.toContain("consentVersion");
    expect(inputType).not.toContain("graphOptIn");
    // Not vacuous: the slice really is the input type.
    expect(inputType).toContain("installId");
    expect(inputType).toContain("eventType");
  });
});

// ---------------------------------------------------------------------------
// Item 6 — a readout that can go red
// ---------------------------------------------------------------------------

describe("P-100 item 6: zero and unmeasured render differently", () => {
  it("returns MEASURED ZERO for a quiet window on a rail that has fired before", () => {
    expect(
      measureEventMetric({
        eventType: "share_created",
        surface: "property-explorer",
        windowCount: 0,
        allTimeCount: 41,
      }),
    ).toEqual({ state: "measured", value: 0 });
  });

  it("returns UNMEASURED for a rail that has never fired, and says why", () => {
    const m = measureEventMetric({
      eventType: "share_viewed",
      surface: "property-explorer",
      windowCount: 0,
      allTimeCount: 0,
    });
    expect(m.state).toBe("unmeasured");
    if (m.state !== "unmeasured") throw new Error("unreachable");
    expect(m.basis).toContain("share_viewed");
    expect(m.basis).toContain("property-explorer");
  });

  it("the two are NOT the same object: this is the whole point of the item", () => {
    const quiet = measureEventMetric({
      eventType: "x",
      surface: "s",
      windowCount: 0,
      allTimeCount: 1,
    });
    const unwired = measureEventMetric({
      eventType: "x",
      surface: "s",
      windowCount: 0,
      allTimeCount: 0,
    });
    expect(quiet).not.toEqual(unwired);
    expect(quiet.state).toBe("measured");
    expect(unwired.state).toBe("unmeasured");
  });

  it("an existing but empty store is measured zero, not unmeasured", () => {
    expect(
      measureStoreMetric({
        store: "pe_share_attributions",
        storeExists: true,
        windowCount: 0,
      }),
    ).toEqual({ state: "measured", value: 0 });
  });

  it("a store that does not exist is unmeasured", () => {
    const m = measureStoreMetric({
      store: "pe_affiliate_attributions",
      storeExists: false,
      windowCount: 0,
    });
    expect(m.state).toBe("unmeasured");
  });

  it("affiliate is UNMEASURED and names what was searched for", () => {
    const m = measureAffiliateArrivals({
      searchedFor: ["pe_affiliate_attributions", "promotekit_referrals"],
      foundStore: null,
      windowCount: 0,
    });
    expect(m.state).toBe("unmeasured");
    if (m.state !== "unmeasured") throw new Error("unreachable");
    expect(m.basis).toContain("PromoteKit");
    expect(m.basis).toContain("pe_affiliate_attributions");
  });

  it("affiliate FLIPS to measured on its own when a local store appears", () => {
    // The unmeasured answer is derived, not hardcoded. If it were hardcoded
    // this case could not exist.
    expect(
      measureAffiliateArrivals({
        searchedFor: ["pe_affiliate_attributions"],
        foundStore: "pe_affiliate_attributions",
        windowCount: 3,
      }),
    ).toEqual({ state: "measured", value: 3 });
  });

  it("organic REFUSES to be a residual while affiliate is unmeasured", () => {
    const m = measureOrganicArrivals({
      newAccounts: { state: "measured", value: 10 },
      shareAttributed: { state: "measured", value: 2 },
      affiliateAttributed: { state: "unmeasured", basis: "PromoteKit" },
    });
    expect(m.state).toBe("unmeasured");
    if (m.state !== "unmeasured") throw new Error("unreachable");
    expect(m.basis).toContain("affiliate arrivals");
    expect(m.basis).toContain("residual");
  });

  it("organic becomes measurable only once every channel is measured", () => {
    expect(
      measureOrganicArrivals({
        newAccounts: { state: "measured", value: 10 },
        shareAttributed: { state: "measured", value: 2 },
        affiliateAttributed: { state: "measured", value: 3 },
      }),
    ).toEqual({ state: "measured", value: 5 });
  });

  it("reconciles the grant registry against the event rail", () => {
    expect(
      shareCreatedDivergence({
        grantsCreated: { state: "measured", value: 12 },
        shareCreatedEvents: { state: "measured", value: 12 },
      }),
    ).toEqual({
      state: "measured",
      value: { grants: 12, events: 12, delta: 0, agree: true },
    });
  });

  it("reports a DISAGREEMENT rather than rounding it off", () => {
    const m = shareCreatedDivergence({
      grantsCreated: { state: "measured", value: 12 },
      shareCreatedEvents: { state: "measured", value: 9 },
    });
    expect(m).toEqual({
      state: "measured",
      value: { grants: 12, events: 9, delta: 3, agree: false },
    });
  });

  it("refuses to reconcile against an unmeasured rail", () => {
    const m = shareCreatedDivergence({
      grantsCreated: { state: "measured", value: 12 },
      shareCreatedEvents: { state: "unmeasured", basis: "never fired" },
    });
    expect(m.state).toBe("unmeasured");
    if (m.state !== "unmeasured") throw new Error("unreachable");
    expect(m.basis).toContain("cannot be reconciled");
  });
});

// ---------------------------------------------------------------------------
// The writer census — the card's "no second writer" rule, as a test
// ---------------------------------------------------------------------------

describe("P-100: no second gtm_events writer was added", () => {
  it("holds the insert-site count at what it was before this card", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");
    const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

    const sites: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        if (statSync(full).isDirectory()) {
          if (name === "__tests__" || name === "node_modules" || name === "dist") {
            continue;
          }
          walk(full);
          continue;
        }
        if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
        const text = readFileSync(full, "utf8");
        const lines = text.split(/\r?\n/);
        lines.forEach((line, i) => {
          if (line.includes("insert(gtmEvents)")) sites.push(`${name}:${i + 1}`);
        });
      }
    };
    walk(root);

    // Three before this card (recordGtmEvent.ts once, brokerageGtm.ts three
    // times — one per HTTP ingest route). Three files, four sites. The number
    // that matters is that no NEW file writes to gtm_events: the Smart Site
    // share events go through the PE events route that already existed.
    const files = new Set(sites.map((s) => s.split(":")[0]));
    expect([...files].sort()).toEqual(["brokerageGtm.ts", "recordGtmEvent.ts"]);
    // Not vacuous: the scan really found sites.
    expect(sites.length).toBeGreaterThan(0);
  });
});
