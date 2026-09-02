/**
 * P-100 item 6 — the readout that can go red. The SHAPING half.
 *
 * Pure. Imports no database. Every rule about when a number is honest lives
 * here, so all of it is testable without Postgres and none of it can be
 * quietly satisfied by a query returning a convenient row.
 *
 * THE DEFECT THIS IS NAMED AGAINST. A readout that always finds a number.
 * `computePropertyExplorerFunnelMetrics` does exactly that today:
 * `byType.get(eventType) ?? 0` renders "no rows in this window" and "this
 * event type has never existed" as the same `0`. The affiliate program would
 * then read a fully instrumented funnel with a quiet week, when what it
 * actually has is a rail that was never wired.
 *
 * THE DISCRIMINATOR IS TWO COUNTS, NOT A FLAG. A metric is UNMEASURED when
 * its event type has never held a row at all; it is MEASURED-ZERO when rows
 * exist historically and none fall in the window. Those are two independent
 * queries over the same table with different predicates, and no single
 * sentinel value can satisfy both. A boolean `isInstrumented` column would
 * have been hand-declared, and hand-declared gating indicators in this
 * operation have a measured history of being uniform across every cell and
 * therefore unable to fire.
 *
 * SUBTRACTION IS NOT MEASUREMENT. `organic` is not `newAccounts - share -
 * affiliate`. DEV_PROCESS 1.3 exists because deriving a class by subtraction
 * turns every gap in the other classes into a confident number in this one.
 * Affiliate attribution lives in PromoteKit against Stripe and this system
 * holds no copy of it, so affiliate is unmeasured — and therefore organic is
 * unmeasured too, because a residual of an unmeasured class is not a
 * measurement of anything. Reporting an organic count here would be the
 * fabricated number the whole card is written against.
 */

export type Measurement<T> =
  | { state: "measured"; value: T }
  | { state: "unmeasured"; basis: string };

/**
 * Turn a window count and an all-time count into a measurement.
 *
 * The all-time count is the second derivation. It answers "has this rail ever
 * carried anything", which the window count cannot answer and which is the
 * only thing that separates a quiet week from an unwired one.
 */
export function measureEventMetric(input: {
  eventType: string;
  surface: string;
  windowCount: number;
  allTimeCount: number;
}): Measurement<number> {
  if (input.allTimeCount === 0) {
    return {
      state: "unmeasured",
      basis:
        `no ${input.eventType} row has ever existed on source_surface=${input.surface}; ` +
        "a zero here would be indistinguishable from an unwired rail",
    };
  }
  return { state: "measured", value: input.windowCount };
}

/**
 * Turn a row count from a first-class store into a measurement.
 *
 * A store that EXISTS and is empty is measured-zero: the table is the
 * instrument, so its emptiness is a real observation about the world rather
 * than a gap in instrumentation. A store that does not exist is unmeasured.
 */
export function measureStoreMetric(input: {
  store: string;
  storeExists: boolean;
  windowCount: number;
}): Measurement<number> {
  if (!input.storeExists) {
    return {
      state: "unmeasured",
      basis: `${input.store} does not exist in this database`,
    };
  }
  return { state: "measured", value: input.windowCount };
}

/**
 * Affiliate arrivals.
 *
 * DERIVED, NOT ASSERTED. The caller passes the names it searched for and
 * whichever of them exists. If a local affiliate-attribution store is ever
 * added, this flips to measured on its own rather than waiting for somebody
 * to remember to edit a constant. That is the difference between a control
 * and a comment.
 */
export function measureAffiliateArrivals(input: {
  searchedFor: readonly string[];
  foundStore: string | null;
  windowCount: number;
}): Measurement<number> {
  if (input.foundStore === null) {
    return {
      state: "unmeasured",
      basis:
        "affiliate attribution is held by PromoteKit against Stripe and this database holds no copy; " +
        `searched for ${input.searchedFor.join(", ")} and found none`,
    };
  }
  return { state: "measured", value: input.windowCount };
}

/**
 * Organic arrivals — accounts that came from neither share nor affiliate.
 *
 * This function exists to REFUSE, and its refusal is the point. Organic can
 * only be measured once every other arrival channel can be measured, because
 * an account is organic exactly when nothing else claims it. While affiliate
 * is unmeasured, an organic number would be `newAccounts - share`, which
 * silently books every affiliate arrival as organic.
 */
export function measureOrganicArrivals(input: {
  newAccounts: Measurement<number>;
  shareAttributed: Measurement<number>;
  affiliateAttributed: Measurement<number>;
}): Measurement<number> {
  const unmeasured: string[] = [];
  if (input.newAccounts.state === "unmeasured") unmeasured.push("new accounts");
  if (input.shareAttributed.state === "unmeasured") unmeasured.push("share arrivals");
  if (input.affiliateAttributed.state === "unmeasured") {
    unmeasured.push("affiliate arrivals");
  }
  if (unmeasured.length > 0) {
    return {
      state: "unmeasured",
      basis:
        "organic is what no other channel claims, so it cannot be measured while " +
        `${unmeasured.join(" and ")} ${unmeasured.length === 1 ? "is" : "are"} unmeasured; ` +
        "reporting a residual here would book every unmeasured arrival as organic",
    };
  }
  const organic =
    (input.newAccounts as { value: number }).value -
    (input.shareAttributed as { value: number }).value -
    (input.affiliateAttributed as { value: number }).value;
  return { state: "measured", value: Math.max(organic, 0) };
}

/**
 * The share-created divergence: the grant registry against the event rail.
 *
 * `pe_share_grants` is written server-side by the mint route and is the
 * authoritative count of shares created. `share_created` on the
 * property-explorer surface is written by the client after the mint returns.
 * They measure the same subject from two independent derivations, so a
 * disagreement is a free finding rather than something to round off — a lost
 * event, a client that crashed mid-flow, or a share minted by something that
 * is not the app.
 *
 * The divergence is only reportable when BOTH sides are measured. Comparing a
 * number against an unmeasured rail and calling the gap a defect would blame
 * the instrument for the absence of an instrument.
 */
export function shareCreatedDivergence(input: {
  grantsCreated: Measurement<number>;
  shareCreatedEvents: Measurement<number>;
}): Measurement<{ grants: number; events: number; delta: number; agree: boolean }> {
  if (input.grantsCreated.state === "unmeasured") {
    return { state: "unmeasured", basis: input.grantsCreated.basis };
  }
  if (input.shareCreatedEvents.state === "unmeasured") {
    return {
      state: "unmeasured",
      basis:
        "the event rail is unmeasured, so it cannot be reconciled against the grant registry: " +
        input.shareCreatedEvents.basis,
    };
  }
  const grants = input.grantsCreated.value;
  const events = input.shareCreatedEvents.value;
  return {
    state: "measured",
    value: { grants, events, delta: grants - events, agree: grants === events },
  };
}
