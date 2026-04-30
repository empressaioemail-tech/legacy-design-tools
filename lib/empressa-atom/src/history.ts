/**
 * Event-anchored history for atoms.
 *
 * Spec 20 §6 prescribes an `EventAnchoringService` interface that every
 * atom mutation flows through. A0 ships the interface verbatim plus a
 * Postgres-backed implementation that writes deterministic SHA-256
 * `chainHash` values into the `atom_events` table. Cryptographic anchoring
 * (Merkle root, external ledger anchor) lands later without changing the
 * consumer interface — this is the central "interface-stable /
 * implementation-evolves" promise of A0.
 *
 * TODO(M2-C): replace deterministic chainHash with cryptographic anchor.
 */

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { AtomReference } from "./registration";

/**
 * Name of the host application's atom-events table. The host project owns
 * the schema (declared in `@workspace/db/schema/atomEvents.ts`); this
 * library is decoupled from it at runtime — we issue raw SQL against the
 * agreed table name only. Keeping the table name in one constant makes
 * the contract explicit and lets future versions of the framework move
 * to a host-injected name without touching call sites.
 */
const ATOM_EVENTS_TABLE = sql.identifier("atom_events");

/**
 * Identity of the actor that produced an event. `kind` is `"agent"` for
 * AI/bot writes and `"user"` for human writes. `id` is opaque to the
 * framework — application code chooses its identity scheme.
 */
export interface EventActor {
  kind: "user" | "agent" | "system";
  id: string;
}

/**
 * Input to {@link EventAnchoringService.appendEvent}. `payload` is the
 * mutation payload as the atom recorded it; the framework does not
 * interpret it and stores it verbatim as JSONB.
 */
export interface AppendEventInput {
  entityType: string;
  entityId: string;
  eventType: string;
  actor: EventActor;
  payload: Record<string, unknown>;
  /** Defaults to "now" when omitted. */
  occurredAt?: Date;
}

/**
 * Materialized event row. `chainHash` is deterministic SHA-256 in A0;
 * `prevHash` is the previous event's `chainHash` for the same
 * `(entityType, entityId)` pair, or `null` for the first event.
 */
export interface AtomEvent {
  id: string;
  entityType: string;
  entityId: string;
  eventType: string;
  actor: EventActor;
  payload: Record<string, unknown>;
  prevHash: string | null;
  chainHash: string;
  occurredAt: Date;
  recordedAt: Date;
}

/**
 * Options accepted by {@link EventAnchoringService.readHistory}. Pagination
 * is via `offset/limit` because the row count for a single entity is
 * expected to be small in A0; cursor pagination can be added later.
 */
export interface ReadHistoryOptions {
  limit?: number;
  offset?: number;
  /** When true, return rows newest-first instead of the default oldest-first. */
  reverse?: boolean;
}

/**
 * The Spec 20 §6 interface. Implementations must guarantee:
 * - `appendEvent` is atomic with respect to its `(entityType, entityId)`
 *   chain — concurrent appends serialize and the resulting `chainHash`
 *   chain is gap-free.
 * - `readHistory` returns events in stable order.
 * - `latestEvent` returns the same row as `readHistory({ reverse: true,
 *   limit: 1 })[0] ?? null`.
 */
export interface EventAnchoringService {
  appendEvent(input: AppendEventInput): Promise<AtomEvent>;
  readHistory(
    ref: AtomReference,
    opts?: ReadHistoryOptions,
  ): Promise<AtomEvent[]>;
  latestEvent(ref: AtomReference): Promise<AtomEvent | null>;
}

/**
 * Generate a ULID-like monotonic id. Time prefix (10 chars Crockford32)
 * keeps ids time-sortable; random suffix makes them unique. We don't use
 * the `ulid` package to avoid a runtime dep for one ~30-line helper.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function generateId(): string {
  let time = Date.now();
  let timeChars = "";
  for (let i = 0; i < 10; i++) {
    timeChars = (CROCKFORD[time % 32] ?? "0") + timeChars;
    time = Math.floor(time / 32);
  }
  let rand = "";
  for (let i = 0; i < 16; i++) {
    rand += CROCKFORD[Math.floor(Math.random() * 32)] ?? "0";
  }
  return timeChars + rand;
}

/**
 * Compute the deterministic SHA-256 chain hash for an event. Inputs are
 * stringified with stable key order so two callers computing the same
 * event get the same hash. TODO(M2-C): swap for the real cryptographic
 * anchor — same signature, no consumer change.
 */
function computeChainHash(args: {
  prevHash: string | null;
  payload: Record<string, unknown>;
  occurredAt: Date;
  eventType: string;
  actor: EventActor;
}): string {
  // JSON.stringify with sorted keys is stable enough for A0; we don't
  // worry about deeply-nested object key ordering yet.
  const stable = JSON.stringify({
    prevHash: args.prevHash,
    payload: args.payload,
    occurredAt: args.occurredAt.toISOString(),
    eventType: args.eventType,
    actor: args.actor,
  });
  return createHash("sha256").update(stable).digest("hex");
}

/**
 * Drizzle/node-postgres database surface this service needs. Declared
 * structurally so we don't require a hard dep on `drizzle-orm`'s concrete
 * `db` type (which varies by driver). The host application passes its
 * own `db` instance from `@workspace/db`.
 */
export interface DrizzleLikeDb {
  // Drizzle's `transaction` callback signature; loose-typed by design.
  transaction: <T>(cb: (tx: DrizzleLikeDb) => Promise<T>) => Promise<T>;
  execute: (query: unknown) => Promise<{ rows: Array<Record<string, unknown>> }>;
}

/**
 * Postgres-backed {@link EventAnchoringService} implementation. Uses raw
 * SQL via Drizzle's `sql` template so the boundary to `@workspace/db`
 * stays minimal — we depend on the `atom_events` table existing but not
 * on the driver flavor.
 */
export class PostgresEventAnchoringService implements EventAnchoringService {
  constructor(private readonly db: DrizzleLikeDb) {}

  async appendEvent(input: AppendEventInput): Promise<AtomEvent> {
    const occurredAt = input.occurredAt ?? new Date();
    return await this.db.transaction(async (tx) => {
      // Per-entity serialization (recon §6 / Spec 20: appendEvent is
      // atomic with respect to its (entityType, entityId) chain — the
      // resulting hash chain must be gap-free even under concurrent
      // appends).
      //
      // We use a transaction-scoped Postgres advisory lock keyed on a
      // 64-bit hash of `${entityType}:${entityId}`. Concurrent
      // transactions touching the same chain serialize on the lock;
      // transactions on different chains run in parallel. The lock
      // releases automatically at COMMIT/ROLLBACK.
      const lockKey = `${input.entityType}:${input.entityId}`;
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`,
      );

      // Find the chain tail by structure, not by timestamp. Postgres'
      // `now()` (used by `recorded_at` defaults) returns transaction-
      // start time, not statement time, so under concurrent appends two
      // rows can have equal/out-of-order recorded_at values and a
      // timestamp-based ORDER BY cannot reliably identify the most-
      // recently-inserted row. The tail is well-defined: it's the only
      // row whose `chain_hash` is not any other row's `prev_hash`. The
      // advisory lock above guarantees there is at most one such row.
      const latestRows = await tx.execute(
        sql`SELECT chain_hash FROM ${ATOM_EVENTS_TABLE} e1
            WHERE entity_type = ${input.entityType}
              AND entity_id = ${input.entityId}
              AND NOT EXISTS (
                SELECT 1 FROM ${ATOM_EVENTS_TABLE} e2
                WHERE e2.entity_type = e1.entity_type
                  AND e2.entity_id = e1.entity_id
                  AND e2.prev_hash = e1.chain_hash
              )
            LIMIT 1`,
      );
      const prevHash =
        latestRows.rows.length > 0
          ? ((latestRows.rows[0]?.chain_hash as string | null) ?? null)
          : null;
      const id = generateId();
      const chainHash = computeChainHash({
        prevHash,
        payload: input.payload,
        occurredAt,
        eventType: input.eventType,
        actor: input.actor,
      });
      const inserted = await tx.execute(
        sql`INSERT INTO ${ATOM_EVENTS_TABLE}
              (id, entity_type, entity_id, event_type, actor, payload,
               prev_hash, chain_hash, occurred_at)
            VALUES
              (${id}, ${input.entityType}, ${input.entityId},
               ${input.eventType}, ${JSON.stringify(input.actor)}::jsonb,
               ${JSON.stringify(input.payload)}::jsonb,
               ${prevHash}, ${chainHash}, ${occurredAt.toISOString()})
            RETURNING id, entity_type, entity_id, event_type, actor,
                      payload, prev_hash, chain_hash, occurred_at,
                      recorded_at`,
      );
      const row = inserted.rows[0];
      if (!row) throw new Error("appendEvent: insert returned no rows");
      // `chain_hash` carries a UNIQUE constraint at the schema level —
      // if the lock failed for any reason, the duplicate insert would
      // surface here instead of silently forking the chain.
      return rowToEvent(row);
    });
  }

  async readHistory(
    ref: AtomReference,
    opts: ReadHistoryOptions = {},
  ): Promise<AtomEvent[]> {
    const limit = Math.max(1, Math.min(opts.limit ?? 1000, 10_000));
    const offset = Math.max(0, opts.offset ?? 0);
    const direction = opts.reverse ? sql`DESC` : sql`ASC`;
    const result = await this.db.execute(
      sql`SELECT id, entity_type, entity_id, event_type, actor, payload,
                 prev_hash, chain_hash, occurred_at, recorded_at
          FROM ${ATOM_EVENTS_TABLE}
          WHERE entity_type = ${ref.entityType}
            AND entity_id = ${ref.entityId}
          ORDER BY occurred_at ${direction}, recorded_at ${direction}, id ${direction}
          LIMIT ${limit} OFFSET ${offset}`,
    );
    return result.rows.map(rowToEvent);
  }

  async latestEvent(ref: AtomReference): Promise<AtomEvent | null> {
    const rows = await this.readHistory(ref, { limit: 1, reverse: true });
    return rows[0] ?? null;
  }
}

function rowToEvent(row: Record<string, unknown>): AtomEvent {
  const actor = row.actor as EventActor;
  const payload = row.payload as Record<string, unknown>;
  return {
    id: row.id as string,
    entityType: row.entity_type as string,
    entityId: row.entity_id as string,
    eventType: row.event_type as string,
    actor,
    payload,
    prevHash: (row.prev_hash as string | null) ?? null,
    chainHash: row.chain_hash as string,
    occurredAt: new Date(row.occurred_at as string | Date),
    recordedAt: new Date(row.recorded_at as string | Date),
  };
}

/** Re-exported for tests that want to assert the chain-hash formula. */
export const __internal = { computeChainHash, generateId };
