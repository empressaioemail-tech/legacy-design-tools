/**
 * P-100 item 6 — the readout that can go red. The QUERY half.
 *
 * Every rule about when a number is honest lives in
 * `gtmShareFunnelReadoutShape.ts` and is tested without a database. This file
 * only supplies the two counts each rule needs, and it supplies them as TWO
 * QUERIES with different predicates rather than one query and a flag.
 *
 * SHARE AND AFFILIATE ARE REPORTED SIDE BY SIDE, as the locked handoff
 * requires. Affiliate comes back unmeasured today and says why. That is not a
 * placeholder — it is the answer, and being able to give it is the reason
 * this readout exists rather than another dashboard that always finds a
 * number.
 *
 * THE SMART SITE AND BROKERAGE SHARE SUBJECTS ARE NEVER SUMMED. Both surfaces
 * emit `share_created` and `share_viewed`; a workspace share and a Smart Site
 * parcel share are different things. Every share figure below is scoped to
 * `source_surface = 'property-explorer'`, and the brokerage counts are
 * reported alongside under their own key so the split is visible instead of
 * being a footnote nobody reads.
 */

import { and, count, eq, gte, sql } from "drizzle-orm";
import {
  db,
  gtmEventRefusals,
  gtmEvents,
  peShareAttributions,
  peShareGrants,
  users,
} from "@workspace/db";

import {
  measureAffiliateArrivals,
  measureEventMetric,
  measureOrganicArrivals,
  measureStoreMetric,
  shareCreatedDivergence,
  type Measurement,
} from "./gtmShareFunnelReadoutShape";

export const SMART_SITE_SURFACE = "property-explorer";
export const BROKERAGE_SURFACE = "api";

/**
 * Store names that would hold a LOCAL affiliate attribution. None exists
 * today. The list is searched against `information_schema` on every call, so
 * adding one flips the affiliate rail to measured without anybody editing
 * this file.
 */
export const AFFILIATE_STORE_CANDIDATES = [
  "pe_affiliate_attributions",
  "affiliate_attributions",
  "promotekit_referrals",
] as const;

export type ShareFunnelReadout = {
  windowDays: number;
  since: string;
  generatedAt: string;
  sharesCreated: Measurement<number>;
  sharesViewed: Measurement<number>;
  shareSignups: Measurement<number>;
  sharersWithSignups: Measurement<Array<{ grantorUserId: string; signups: number }>>;
  arrivals: {
    newAccounts: Measurement<number>;
    share: Measurement<number>;
    affiliate: Measurement<number>;
    organic: Measurement<number>;
  };
  /** The grant registry reconciled against the event rail. A free finding. */
  shareCreatedReconciliation: Measurement<{
    grants: number;
    events: number;
    delta: number;
    agree: boolean;
  }>;
  /** The brokerage-workspace share subject, reported apart and never summed in. */
  brokerageWorkspaceShares: {
    created: Measurement<number>;
    viewed: Measurement<number>;
  };
  /** Events this system declined to write for want of consent. */
  eventsRefused: Measurement<number>;
};

async function eventCounts(
  eventType: string,
  surface: string,
  since: Date,
): Promise<{ windowCount: number; allTimeCount: number }> {
  const [windowRow] = await db
    .select({ n: count() })
    .from(gtmEvents)
    .where(
      and(
        eq(gtmEvents.eventType, eventType),
        eq(gtmEvents.sourceSurface, surface),
        gte(gtmEvents.createdAt, since),
      ),
    );
  const [allRow] = await db
    .select({ n: count() })
    .from(gtmEvents)
    .where(
      and(
        eq(gtmEvents.eventType, eventType),
        eq(gtmEvents.sourceSurface, surface),
      ),
    );
  return { windowCount: windowRow?.n ?? 0, allTimeCount: allRow?.n ?? 0 };
}

async function measureEvent(
  eventType: string,
  surface: string,
  since: Date,
): Promise<Measurement<number>> {
  const { windowCount, allTimeCount } = await eventCounts(eventType, surface, since);
  return measureEventMetric({ eventType, surface, windowCount, allTimeCount });
}

/**
 * Which of the candidate affiliate stores exists, read from THE CATALOG.
 *
 * Whether a table exists is in `information_schema`, not in the shape of a
 * query against it. That distinction is a recorded incident in this
 * operation: a link table holding 33,066 rows was declared absent because
 * its absence had been inferred from an orphan query rather than by
 * enumerating tables. So this asks the catalog directly.
 *
 * The candidate list is a module constant, never caller input, and it is
 * still passed as a bound parameter rather than interpolated — a string
 * built into SQL is a habit, and the habit is what eventually meets input.
 */
async function findAffiliateStore(): Promise<string | null> {
  const result = await db.execute<{ table_name: string }>(sql`
    SELECT table_name FROM information_schema.tables
    WHERE table_name = ANY(${[...AFFILIATE_STORE_CANDIDATES]})
    LIMIT 1
  `);
  const list: unknown[] = Array.isArray(result)
    ? result
    : ((result as { rows?: unknown[] }).rows ?? []);
  const first = list[0] as { table_name?: string } | undefined;
  return typeof first?.table_name === "string" ? first.table_name : null;
}

export async function computeShareFunnelReadout(
  windowDays: number,
  now: Date = new Date(),
): Promise<ShareFunnelReadout> {
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

  const sharesCreated = await measureEvent("share_created", SMART_SITE_SURFACE, since);
  const sharesViewed = await measureEvent("share_viewed", SMART_SITE_SURFACE, since);
  const brokerageCreated = await measureEvent("share_created", BROKERAGE_SURFACE, since);
  const brokerageViewed = await measureEvent("share_viewed", BROKERAGE_SURFACE, since);

  // The grant registry. It exists (migration 0085), so an empty week is a
  // measured zero rather than an unmeasured rail.
  const [grantsWindow] = await db
    .select({ n: count() })
    .from(peShareGrants)
    .where(gte(peShareGrants.createdAt, since));
  const grantsCreated = measureStoreMetric({
    store: "pe_share_grants",
    storeExists: true,
    windowCount: grantsWindow?.n ?? 0,
  });

  const [signupsWindow] = await db
    .select({ n: count() })
    .from(peShareAttributions)
    .where(gte(peShareAttributions.attributedAt, since));
  const shareSignups = measureStoreMetric({
    store: "pe_share_attributions",
    storeExists: true,
    windowCount: signupsWindow?.n ?? 0,
  });

  // Which sharer each signup belongs to. The grantor is resolved by joining
  // the grant row; it is not stored on the attribution, so there is nothing
  // here that can disagree with the grant registry.
  const perSharer = await db
    .select({
      grantorUserId: peShareGrants.grantorUserId,
      signups: count(),
    })
    .from(peShareAttributions)
    .innerJoin(peShareGrants, eq(peShareGrants.id, peShareAttributions.grantId))
    .where(gte(peShareAttributions.attributedAt, since))
    .groupBy(peShareGrants.grantorUserId);

  const [accountsWindow] = await db
    .select({ n: count() })
    .from(users)
    .where(gte(users.createdAt, since));
  const newAccounts = measureStoreMetric({
    store: "users",
    storeExists: true,
    windowCount: accountsWindow?.n ?? 0,
  });

  const affiliateStore = await findAffiliateStore();
  const affiliate = measureAffiliateArrivals({
    searchedFor: AFFILIATE_STORE_CANDIDATES,
    foundStore: affiliateStore,
    // No local store, so there is no count to take. If one appears, this
    // call site is the next thing to change and the unmeasured basis names it.
    windowCount: 0,
  });

  const [refusalsWindow] = await db
    .select({ n: count() })
    .from(gtmEventRefusals)
    .where(gte(gtmEventRefusals.refusedAt, since));
  const eventsRefused = measureStoreMetric({
    store: "gtm_event_refusals",
    storeExists: true,
    windowCount: refusalsWindow?.n ?? 0,
  });

  return {
    windowDays,
    since: since.toISOString(),
    generatedAt: now.toISOString(),
    sharesCreated,
    sharesViewed,
    shareSignups,
    sharersWithSignups: {
      state: "measured",
      value: perSharer.map((r) => ({
        grantorUserId: r.grantorUserId,
        signups: r.signups,
      })),
    },
    arrivals: {
      newAccounts,
      share: shareSignups,
      affiliate,
      organic: measureOrganicArrivals({
        newAccounts,
        shareAttributed: shareSignups,
        affiliateAttributed: affiliate,
      }),
    },
    shareCreatedReconciliation: shareCreatedDivergence({
      grantsCreated,
      shareCreatedEvents: sharesCreated,
    }),
    brokerageWorkspaceShares: {
      created: brokerageCreated,
      viewed: brokerageViewed,
    },
    eventsRefused,
  };
}
