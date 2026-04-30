/**
 * Testing utilities for `@workspace/empressa-atom`.
 *
 * Future A1+ atom registrations import {@link runAtomContractTests} to
 * prove their registration is well-formed in one function call. The
 * in-memory event service lets unit tests exercise the
 * `EventAnchoringService` interface without spinning up Postgres.
 *
 * This module is intentionally **not** re-exported from the main barrel
 * (`src/index.ts`) — it lives behind the `./testing` subpath so production
 * bundles never pull it in.
 */

import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { createAtomRegistry, type AtomRegistry } from "../registry";
import {
  parseInlineReferences,
  serializeInlineReference,
} from "../inline-reference";
import { defaultScope } from "../scope";
import type {
  AtomRegistration,
  AtomReference,
  AtomMode,
  AnyAtomRegistration,
} from "../registration";
import type { ContextSummary } from "../context";
import type {
  AppendEventInput,
  AtomEvent,
  EventActor,
  EventAnchoringService,
  ReadHistoryOptions,
} from "../history";

/**
 * Convenience wrapper around {@link createAtomRegistry} for tests. Accepts
 * an initial set of registrations so a single call can register and
 * return the registry.
 */
export function createTestRegistry(
  initial: ReadonlyArray<AnyAtomRegistration> = [],
): AtomRegistry {
  const registry = createAtomRegistry();
  for (const reg of initial) {
    // Pre-built (type-erased) registrations can't satisfy the literal
    // `entityType` constraint enforced by `register`; use the trusted
    // `registerAny` escape hatch instead.
    registry.registerAny(reg);
  }
  return registry;
}

/**
 * In-memory {@link EventAnchoringService} implementation. Mirrors
 * {@link PostgresEventAnchoringService}'s chain-hash semantics so unit
 * tests can assert against the same invariants without touching Postgres.
 */
export function createInMemoryEventService(): EventAnchoringService {
  const events: AtomEvent[] = [];
  let counter = 0;

  function chainKey(entityType: string, entityId: string): string {
    return `${entityType}::${entityId}`;
  }

  function lastFor(entityType: string, entityId: string): AtomEvent | null {
    const key = chainKey(entityType, entityId);
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e && chainKey(e.entityType, e.entityId) === key) return e;
    }
    return null;
  }

  return {
    async appendEvent(input: AppendEventInput): Promise<AtomEvent> {
      const occurredAt = input.occurredAt ?? new Date();
      const prev = lastFor(input.entityType, input.entityId);
      const prevHash = prev?.chainHash ?? null;
      const stable = JSON.stringify({
        prevHash,
        payload: input.payload,
        occurredAt: occurredAt.toISOString(),
        eventType: input.eventType,
        actor: input.actor,
      });
      const chainHash = createHash("sha256").update(stable).digest("hex");
      counter += 1;
      const event: AtomEvent = {
        id: `mem-${String(counter).padStart(8, "0")}`,
        entityType: input.entityType,
        entityId: input.entityId,
        eventType: input.eventType,
        actor: input.actor,
        payload: input.payload,
        prevHash,
        chainHash,
        occurredAt,
        recordedAt: new Date(),
      };
      events.push(event);
      return event;
    },

    async readHistory(
      ref: AtomReference,
      opts: ReadHistoryOptions = {},
    ): Promise<AtomEvent[]> {
      const matching = events.filter(
        (e) => e.entityType === ref.entityType && e.entityId === ref.entityId,
      );
      const sorted = [...matching].sort((a, b) => {
        const cmp = a.occurredAt.getTime() - b.occurredAt.getTime();
        if (cmp !== 0) return cmp;
        return a.id.localeCompare(b.id);
      });
      const ordered = opts.reverse ? sorted.reverse() : sorted;
      const offset = Math.max(0, opts.offset ?? 0);
      const limit = Math.max(1, Math.min(opts.limit ?? 1000, 10_000));
      return ordered.slice(offset, offset + limit);
    },

    async latestEvent(ref: AtomReference): Promise<AtomEvent | null> {
      const rows = await this.readHistory(ref, { limit: 1, reverse: true });
      return rows[0] ?? null;
    },
  };
}

/**
 * Optional fixture callback an atom may pass to seed the contract suite
 * with whatever shape its `contextSummary` expects.
 */
export interface AtomContractFixture {
  /** Entity id the contract suite will pass to `contextSummary`. */
  entityId: string;
  /** Optional pre-registration setup (DB seed, fetch mocking, etc.). */
  setUp?: () => Promise<void> | void;
  /** Cleanup hook invoked after the suite. */
  tearDown?: () => Promise<void> | void;
}

export interface AtomContractOptions {
  /** Per-atom fixture. Defaults to `{ entityId: "contract-test-id" }`. */
  withFixture?: AtomContractFixture;
  /**
   * Other atoms that must be in the registry for composition validation
   * to pass. Defaults to `[]`.
   */
  alsoRegister?: ReadonlyArray<AnyAtomRegistration>;
}

/**
 * Contract test suite future A1+ atom registrations import to prove
 * compliance with one function call.
 *
 * Asserts:
 * 1. identity is present and `entityType` is non-empty,
 * 2. `defaultMode` is in `supportedModes`,
 * 3. `contextSummary` returns a valid four-layer shape with
 *    `historyProvenance` and `scopeFiltered`,
 * 4. every composition edge resolves against `alsoRegister + this`,
 * 5. inline-reference round-trips: `parse(serialize(ref))[0].reference`
 *    equals `ref` modulo `mode`.
 *
 * @example
 *   import { describe } from "vitest";
 *   import { runAtomContractTests } from "@workspace/empressa-atom/testing";
 *   import { taskAtom } from "./task.reg";
 *   describe("task atom contract", () => {
 *     runAtomContractTests(taskAtom, { withFixture: { entityId: "t1" } });
 *   });
 */
export function runAtomContractTests<
  TType extends string,
  TSupported extends ReadonlyArray<AtomMode>,
>(
  registration: AtomRegistration<TType, TSupported>,
  opts: AtomContractOptions = {},
): void {
  const fixture: AtomContractFixture = opts.withFixture ?? {
    entityId: "contract-test-id",
  };
  const alsoRegister = opts.alsoRegister ?? [];

  describe(`atom contract: ${registration.entityType}`, () => {
    it("declares identity and a non-empty entityType", () => {
      expect(registration.entityType).toBeTypeOf("string");
      expect(registration.entityType.length).toBeGreaterThan(0);
      expect(registration.domain).toBeTypeOf("string");
      expect(registration.domain.length).toBeGreaterThan(0);
    });

    it("declares defaultMode within supportedModes", () => {
      expect(registration.supportedModes.length).toBeGreaterThan(0);
      expect(registration.supportedModes).toContain(registration.defaultMode);
    });

    it("returns a four-layer ContextSummary with provenance + scopeFiltered", async () => {
      if (fixture.setUp) await fixture.setUp();
      try {
        const result: ContextSummary<TType> = await registration.contextSummary(
          fixture.entityId,
          defaultScope(),
        );
        expect(result).toBeDefined();
        expect(typeof result.prose).toBe("string");
        expect(typeof result.typed).toBe("object");
        expect(Array.isArray(result.keyMetrics)).toBe(true);
        expect(Array.isArray(result.relatedAtoms)).toBe(true);
        expect(result.historyProvenance).toBeDefined();
        expect(typeof result.historyProvenance.latestEventId).toBe("string");
        expect(typeof result.historyProvenance.latestEventAt).toBe("string");
        expect(typeof result.scopeFiltered).toBe("boolean");
      } finally {
        if (fixture.tearDown) await fixture.tearDown();
      }
    });

    it("composition references resolve in the registry", () => {
      const registry = createTestRegistry([
        ...alsoRegister,
        registration as unknown as AnyAtomRegistration,
      ]);
      const result = registry.validate();
      expect(result.ok).toBe(true);
    });

    it("inline-reference round-trips for an instance of this atom", () => {
      const ref: AtomReference = {
        kind: "atom",
        entityType: registration.entityType,
        entityId: fixture.entityId,
        displayLabel: "Round-trip label",
      };
      const text = `Some prose ${serializeInlineReference(ref)} continues.`;
      const parsed = parseInlineReferences(text);
      const atomSegments = parsed.filter((s) => s.kind === "atom");
      expect(atomSegments).toHaveLength(1);
      const got = atomSegments[0];
      if (!got || got.kind !== "atom") throw new Error("unreachable");
      expect(got.reference.entityType).toBe(ref.entityType);
      expect(got.reference.entityId).toBe(ref.entityId);
      expect(got.reference.displayLabel).toBe(ref.displayLabel);
    });
  });
}

/** Default fixture used when an atom passes none. Exported for tests. */
export const DEFAULT_CONTRACT_FIXTURE: AtomContractFixture = {
  entityId: "contract-test-id",
};
