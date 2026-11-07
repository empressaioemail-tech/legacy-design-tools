/**
 * Postgres half of the lifecycle outbox (P-413, P-492).
 *
 * Claiming is a short lease taken in one statement:
 *   UPDATE ... SET claimed_until = now + lease
 *   WHERE id IN (SELECT id ... due ... FOR UPDATE SKIP LOCKED LIMIT n)
 *   RETURNING *
 * so two drains (two App Platform instances, or a drain and a request) never
 * claim the same row, and a drain that dies mid-send releases its rows when
 * the lease runs out. Sends happen outside any transaction.
 *
 * Every function takes an optional `db` so tests run against a per-file
 * schema; production uses the shared pool.
 */

import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import {
  affiliatePartner,
  peSavedProperties,
  peShareGrants,
  db as prodDb,
  peLifecycleOutbox,
  pePropertyUnlocks,
  peUserEntitlements,
  ssContact,
  type PeLifecycleOutbox,
  type SsContact,
} from "@workspace/db";
import type { LifecycleEventType } from "./peLifecycleTypes";
import type {
  ClaimOptions,
  OutboxOutcome,
  OutboxRecord,
  OutboxStore,
  ProjectionResult,
} from "./peLifecycleOutbox";
import {
  emptyContact,
  projectEvent,
  seedContact,
  ssContactProperties,
  type ContactState,
  type EntitlementFacts,
} from "./ssContactProjection";
import type { ResendSubject } from "./peResendLifecycle";
import { RESEND_EVENT_NAMES } from "./peLifecycleTypes";

type Db = typeof prodDb;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

function toRecord(r: PeLifecycleOutbox): OutboxRecord {
  return {
    id: r.id,
    subject: r.ownerUserId
      ? { kind: "user", userId: r.ownerUserId }
      : { kind: "affiliate", affiliatePartnerId: r.affiliatePartnerId! },
    eventType: r.eventType as LifecycleEventType,
    idempotencyKey: r.idempotencyKey,
    email: r.email,
    payload: (r.payloadJson ?? {}) as Record<string, unknown>,
    status: r.status,
    attempts: r.attempts,
    lastError: r.lastError,
    legs: {
      local: { status: r.localStatus, attempts: r.localAttempts, error: r.localError },
      resend: { status: r.resendStatus, attempts: r.resendAttempts, error: r.resendError },
      meta: { status: r.metaStatus, attempts: r.metaAttempts, error: r.metaError },
    },
    resendEvent: (r.resendEventJson ?? null) as Record<string, unknown> | null,
    nextAttemptAt: r.nextAttemptAt,
    createdAt: r.createdAt,
  };
}

function insertValues(row: OutboxRecord) {
  return {
    id: row.id,
    ownerUserId: row.subject.kind === "user" ? row.subject.userId : null,
    affiliatePartnerId:
      row.subject.kind === "affiliate" ? row.subject.affiliatePartnerId : null,
    eventType: row.eventType,
    idempotencyKey: row.idempotencyKey,
    email: row.email,
    payloadJson: row.payload,
    status: row.status,
    attempts: 0,
    localStatus: row.legs.local.status,
    localError: row.legs.local.error,
    resendStatus: row.legs.resend.status,
    resendError: row.legs.resend.error,
    metaStatus: row.legs.meta.status,
    metaError: row.legs.meta.error,
    nextAttemptAt: row.nextAttemptAt,
  };
}

export function drizzleOutboxStore(db: Db = prodDb): OutboxStore {
  return {
    async insert(row) {
      const inserted = await db
        .insert(peLifecycleOutbox)
        .values(insertValues(row))
        .onConflictDoNothing({ target: peLifecycleOutbox.idempotencyKey })
        .returning({ id: peLifecycleOutbox.id });
      return inserted.length > 0 ? "inserted" : "duplicate";
    },
    async findIdByIdempotencyKey(idempotencyKey) {
      const found = await db
        .select({ id: peLifecycleOutbox.id })
        .from(peLifecycleOutbox)
        .where(eq(peLifecycleOutbox.idempotencyKey, idempotencyKey))
        .limit(1);
      return found[0]?.id ?? null;
    },
    async claimDue(opts: ClaimOptions) {
      const t = peLifecycleOutbox;
      const due = db
        .select({ id: t.id })
        .from(t)
        .where(
          and(
            inArray(t.status, ["pending", "failed"]),
            lte(t.nextAttemptAt, opts.now),
            or(isNull(t.claimedUntil), lte(t.claimedUntil, opts.now)),
            opts.ids ? inArray(t.id, opts.ids) : undefined,
          ),
        )
        .orderBy(t.nextAttemptAt, t.createdAt)
        .limit(opts.limit)
        .for("update", { skipLocked: true });
      const claimed = await db
        .update(t)
        .set({ claimedUntil: new Date(opts.now.getTime() + opts.leaseMs) })
        .where(inArray(t.id, due))
        .returning();
      return claimed.map(toRecord);
    },
    async saveOutcome(id: string, o: OutboxOutcome) {
      await db
        .update(peLifecycleOutbox)
        .set({
          status: o.status,
          attempts: o.attempts,
          lastError: o.lastError,
          localStatus: o.legs.local.status,
          localAttempts: o.legs.local.attempts,
          localError: o.legs.local.error,
          resendStatus: o.legs.resend.status,
          resendAttempts: o.legs.resend.attempts,
          resendError: o.legs.resend.error,
          metaStatus: o.legs.meta.status,
          metaAttempts: o.legs.meta.attempts,
          metaError: o.legs.meta.error,
          resendEventJson: o.resendEvent,
          nextAttemptAt: o.nextAttemptAt,
          claimedUntil: null,
          ...(o.sentAt ? { sentAt: o.sentAt } : {}),
        })
        .where(eq(peLifecycleOutbox.id, id));
    },
  };
}

function toContactState(r: SsContact): ContactState {
  return {
    userId: r.userId,
    email: r.email,
    firstName: r.firstName,
    stage: r.stage,
    plan: r.plan,
    billing: r.billing,
    source: r.source,
    utmSource: r.utmSource,
    utmMedium: r.utmMedium,
    utmCampaign: r.utmCampaign,
    utmContent: r.utmContent,
    savedLots: r.savedLots,
    shares: r.shares,
    lastActive: r.lastActive,
    quiet: r.quiet,
    quietSince: r.quietSince,
    claudeConnected: r.claudeConnected,
    becameSharerAt: r.becameSharerAt,
  };
}

/**
 * The `local` leg: lock (or create) the contact, apply the pure projection,
 * write it, and enqueue the derived events — all in one transaction, so a
 * derived event exists only if the contact change that implies it committed.
 */
/**
 * Saved-lot and share counts, read from their own tables. The projection uses
 * these instead of the count carried in the payload: rows can be projected
 * out of order (equal timestamps, retries), and an older payload count would
 * otherwise overwrite a newer one (measured in CI on 2026-10-03: two shares
 * projected newest-first left ss_shares at 1).
 */
export type CountReader = (tx: Tx, userId: string) => Promise<{ savedLots: number; shares: number }>;

export const readLifecycleCounts: CountReader = async (tx, userId) => {
  const [saved] = await tx
    .select({ n: count() })
    .from(peSavedProperties)
    .where(eq(peSavedProperties.ownerUserId, userId));
  const [shared] = await tx
    .select({ n: count() })
    .from(peShareGrants)
    .where(eq(peShareGrants.grantorUserId, userId));
  return { savedLots: Number(saved?.n ?? 0), shares: Number(shared?.n ?? 0) };
};

/**
 * What the money tables say about a user (P-492b), read inside the
 * projection's transaction the first time the record sees them.
 */
export type EntitlementReader = (tx: Tx, userId: string, now: Date) => Promise<EntitlementFacts>;

export const readEntitlementFacts: EntitlementReader = async (tx, userId, now) => {
  const [row] = await tx
    .select({
      accessTier: peUserEntitlements.accessTier,
      subscriptionTier: peUserEntitlements.subscriptionTier,
      billingInterval: peUserEntitlements.billingInterval,
    })
    .from(peUserEntitlements)
    .where(eq(peUserEntitlements.ownerUserId, userId))
    .limit(1);
  const [unlock] = await tx
    .select({ n: count() })
    .from(pePropertyUnlocks)
    .where(
      and(
        eq(pePropertyUnlocks.ownerUserId, userId),
        or(isNull(pePropertyUnlocks.expiresAt), sql`${pePropertyUnlocks.expiresAt} > ${now}`),
      ),
    );
  return {
    row: row
      ? {
          accessTier: row.accessTier,
          subscriptionTier: row.subscriptionTier ?? null,
          billingInterval: row.billingInterval ?? null,
        }
      : null,
    hasLiveUnlock: Number(unlock?.n ?? 0) > 0,
  };
};

/** Thrown inside the transaction so the contact insert rolls back with it. */
class ContactSeedRefused extends Error {}

export async function projectOutboxRowToContact(
  row: OutboxRecord,
  db: Db = prodDb,
  now: Date = new Date(),
  readCounts: CountReader = readLifecycleCounts,
  readEntitlements: EntitlementReader = readEntitlementFacts,
): Promise<ProjectionResult> {
  if (row.subject.kind !== "user") {
    return { ok: false, error: "projection_requires_user_subject" };
  }
  const userId = row.subject.userId;
  try {
    return await projectInTransaction(row, userId, db, now, readCounts, readEntitlements);
  } catch (err) {
    if (err instanceof ContactSeedRefused) return { ok: false, error: err.message };
    throw err;
  }
}

async function projectInTransaction(
  row: OutboxRecord,
  userId: string,
  db: Db,
  now: Date,
  readCounts: CountReader,
  readEntitlements: EntitlementReader,
): Promise<ProjectionResult> {
  return db.transaction(async (tx: Tx) => {
    const created = await tx
      .insert(ssContact)
      .values({ userId, email: row.email })
      .onConflictDoNothing({ target: ssContact.userId })
      .returning({ userId: ssContact.userId });
    const [locked] = await tx
      .select()
      .from(ssContact)
      .where(eq(ssContact.userId, userId))
      .for("update");
    if (!locked) return { ok: false, error: "ss_contact_missing_after_upsert" } as const;
    const current = created.length > 0 ? null : toContactState(locked);
    let payload = row.payload;
    if (row.eventType === "e2_lot_saved" || row.eventType === "e3_share_sent") {
      const counts = await readCounts(tx, userId);
      payload =
        row.eventType === "e2_lot_saved"
          ? { ...payload, savedLots: counts.savedLots }
          : { ...payload, shares: counts.shares };
    }
    let seed: ContactState | undefined;
    if (current === null) {
      const seeded = seedContact(userId, row.email, await readEntitlements(tx, userId, now));
      if (!seeded.ok) throw new ContactSeedRefused(seeded.error);
      seed = seeded.contact;
    }
    const plan = projectEvent(
      current,
      { userId, email: row.email, eventType: row.eventType, payload },
      now,
      seed,
    );
    const c = plan.contact;
    await tx
      .update(ssContact)
      .set({
        email: c.email,
        firstName: c.firstName,
        stage: c.stage,
        plan: c.plan,
        billing: c.billing,
        source: c.source,
        utmSource: c.utmSource,
        utmMedium: c.utmMedium,
        utmCampaign: c.utmCampaign,
        utmContent: c.utmContent,
        savedLots: c.savedLots,
        shares: c.shares,
        lastActive: c.lastActive,
        quiet: c.quiet,
        quietSince: c.quietSince,
        claudeConnected: c.claudeConnected,
        becameSharerAt: c.becameSharerAt,
        updatedAt: now,
      })
      .where(eq(ssContact.userId, userId));
    for (const f of plan.followups) {
      await tx
        .insert(peLifecycleOutbox)
        .values({
          id: randomUUID(),
          ownerUserId: userId,
          eventType: f.event,
          idempotencyKey: f.idempotencyKey,
          email: c.email,
          payloadJson: { event: f.event },
          nextAttemptAt: now,
        })
        .onConflictDoNothing({ target: peLifecycleOutbox.idempotencyKey });
    }
    return {
      ok: true,
      resendEvent: plan.resendEvent,
      ...(plan.suppressResend ? { suppressResend: plan.suppressResend } : {}),
    } as const;
  });
}

/** Read what the Resend leg sends, from the record (latest truth, not a snapshot). */
export async function loadResendSubject(
  row: OutboxRecord,
  db: Db = prodDb,
): Promise<ResendSubject | null> {
  if (row.subject.kind === "affiliate") {
    const [a] = await db
      .select()
      .from(affiliatePartner)
      .where(eq(affiliatePartner.id, row.subject.affiliatePartnerId))
      .limit(1);
    if (!a) return null;
    return {
      kind: "affiliate",
      email: a.email,
      firstName: a.firstName,
      properties: {},
      // Affiliates are added on creation and re-added harmlessly; the record
      // keeps no segment flag for them.
      inSegment: false,
    };
  }
  const [c] = await db
    .select()
    .from(ssContact)
    .where(eq(ssContact.userId, row.subject.userId))
    .limit(1);
  const state = c ? toContactState(c) : emptyContact(row.subject.userId, row.email);
  return {
    kind: "smart_site",
    email: state.email,
    firstName: state.firstName,
    properties: ssContactProperties(state),
    inSegment: Boolean(c?.resendSegmentAt),
  };
}

export async function markResendSegment(userId: string, db: Db = prodDb): Promise<void> {
  await db
    .update(ssContact)
    .set({ resendSegmentAt: sql`now()` })
    .where(and(eq(ssContact.userId, userId), isNull(ssContact.resendSegmentAt)));
}

export function resendEventName(event: LifecycleEventType): string | null {
  return RESEND_EVENT_NAMES[event];
}
