/**
 * Integration test for the empressa-atom framework.
 *
 * Spins up a real Postgres schema via `@workspace/db/testing#withTestSchema`,
 * registers a stub atom **inline in this file** (catalog atoms are
 * forbidden in A0 — see task spec), and exercises the full path:
 * register parent + child → validate → resolve → contextSummary →
 * appendEvent → readHistory → latestEvent.
 *
 * Also asserts the lib/empressa-atom/src/ → artifacts/ import boundary
 * (recon §A package boundary; task step #10).
 */

import { describe, it, expect, beforeAll } from "vitest";
import { spawnSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { withTestSchema } from "@workspace/db/testing";
import {
  createAtomRegistry,
  defaultScope,
  PostgresEventAnchoringService,
  resolveComposition,
  type AtomRegistration,
  type ContextSummary,
} from "../index";

const SKIP_DB = !process.env.DATABASE_URL;

const STUB_FIXTURE = {
  briefing: {
    id: "brief-1",
    title: "Stub Briefing",
    sheets: [
      { id: "sheet-1", name: "A100" },
      { id: "sheet-2", name: "A101" },
    ],
  },
};

function makeBriefingAtom(): AtomRegistration<"test-briefing", ["card"]> {
  return {
    entityType: "test-briefing",
    domain: "test",
    supportedModes: ["card"],
    defaultMode: "card",
    composition: [
      { childEntityType: "test-sheet", childMode: "compact", dataKey: "sheets" },
    ],
    async contextSummary(
      entityId: string,
    ): Promise<ContextSummary<"test-briefing">> {
      return {
        prose: `Briefing ${entityId}`,
        typed: { id: entityId, sheetCount: STUB_FIXTURE.briefing.sheets.length },
        keyMetrics: [
          { label: "Sheets", value: STUB_FIXTURE.briefing.sheets.length },
        ],
        relatedAtoms: STUB_FIXTURE.briefing.sheets.map((s) => ({
          kind: "atom" as const,
          entityType: "test-sheet",
          entityId: s.id,
          displayLabel: s.name,
        })),
        historyProvenance: {
          latestEventId: "",
          latestEventAt: new Date(0).toISOString(),
        },
        scopeFiltered: false,
      };
    },
  };
}

function makeSheetAtom(): AtomRegistration<"test-sheet", ["compact"]> {
  return {
    entityType: "test-sheet",
    domain: "test",
    supportedModes: ["compact"],
    defaultMode: "compact",
    composition: [],
    async contextSummary(
      entityId: string,
    ): Promise<ContextSummary<"test-sheet">> {
      return {
        prose: `Sheet ${entityId}`,
        typed: { id: entityId },
        keyMetrics: [],
        relatedAtoms: [],
        historyProvenance: {
          latestEventId: "",
          latestEventAt: new Date(0).toISOString(),
        },
        scopeFiltered: false,
      };
    },
  };
}

describe("empressa-atom registry+history integration", () => {
  it.skipIf(SKIP_DB)(
    "register → resolve → contextSummary → compose → appendEvent → readHistory",
    async () => {
      await withTestSchema(async ({ db }) => {
        const registry = createAtomRegistry();
        registry.register(makeBriefingAtom());
        registry.register(makeSheetAtom());

        // Validation: composition refs all resolve.
        expect(registry.validate().ok).toBe(true);

        // Resolve narrows the literal type.
        const resolved = registry.resolve("test-briefing");
        expect(resolved.ok).toBe(true);
        if (!resolved.ok) throw new Error("unreachable");

        // ContextSummary returns the four-layer shape.
        const summary = await resolved.registration.contextSummary(
          "brief-1",
          defaultScope(),
        );
        expect(summary.prose).toContain("brief-1");
        expect(summary.typed).toMatchObject({ sheetCount: 2 });
        expect(summary.keyMetrics).toHaveLength(1);
        expect(summary.relatedAtoms).toHaveLength(2);
        expect(summary.historyProvenance).toBeDefined();
        expect(typeof summary.scopeFiltered).toBe("boolean");

        // Compose: resolve the parent's declared composition edges
        // against the parent payload. Spec 20 §F: composition is one of
        // the four contract layers — the registry must consume it and
        // produce typed children ready for render.
        const composed = resolveComposition(
          resolved.registration,
          { kind: "atom", entityType: "test-briefing", entityId: "brief-1" },
          { sheets: STUB_FIXTURE.briefing.sheets },
          registry,
        );
        expect(composed.ok).toBe(true);
        if (!composed.ok) throw new Error("unreachable");
        expect(composed.children).toHaveLength(2);
        expect(composed.children[0]?.reference).toMatchObject({
          kind: "atom",
          entityType: "test-sheet",
          entityId: "sheet-1",
          mode: "compact",
        });
        expect(composed.children[1]?.reference.entityId).toBe("sheet-2");
        expect(composed.children[0]?.composition.dataKey).toBe("sheets");
        expect(composed.children[0]?.registration.entityType).toBe("test-sheet");

        // History: append two events and read them back with chained hashes.
        const history = new PostgresEventAnchoringService(
          db as unknown as ConstructorParameters<
            typeof PostgresEventAnchoringService
          >[0],
        );
        const e1 = await history.appendEvent({
          entityType: "test-briefing",
          entityId: "brief-1",
          eventType: "briefing.created",
          actor: { kind: "user", id: "u1" },
          payload: { title: "Stub Briefing" },
          occurredAt: new Date("2026-01-01T00:00:00Z"),
        });
        const e2 = await history.appendEvent({
          entityType: "test-briefing",
          entityId: "brief-1",
          eventType: "briefing.updated",
          actor: { kind: "user", id: "u1" },
          payload: { title: "Stub Briefing v2" },
          occurredAt: new Date("2026-01-02T00:00:00Z"),
        });

        expect(e1.prevHash).toBeNull();
        expect(e2.prevHash).toBe(e1.chainHash);
        expect(e2.chainHash).not.toBe(e1.chainHash);

        const history1 = await history.readHistory({
          kind: "atom",
          entityType: "test-briefing",
          entityId: "brief-1",
        });
        expect(history1).toHaveLength(2);
        expect(history1[0]?.id).toBe(e1.id);
        expect(history1[1]?.id).toBe(e2.id);

        const latest = await history.latestEvent({
          kind: "atom",
          entityType: "test-briefing",
          entityId: "brief-1",
        });
        expect(latest?.id).toBe(e2.id);
        expect(latest?.eventType).toBe("briefing.updated");
      });
    },
  );

  it.skipIf(SKIP_DB)(
    "concurrent appendEvent calls produce a gap-free chain (per-entity lock)",
    async () => {
      // Fires N concurrent appends against the same (entityType, entityId)
      // pair. Without the per-entity advisory lock added in
      // PostgresEventAnchoringService.appendEvent, two callers can read
      // the same `latest` row, compute the same `prevHash`, and insert
      // sibling chain hashes — forking the chain into a tree.
      //
      // The chain is ordered by insertion (whoever acquires the lock
      // first), not by `occurred_at`, so the gap-free invariant is
      // verified by walking `prevHash` links: there must be exactly one
      // root (`prevHash === null`), every `chainHash` is unique, and
      // following the linked list from the root visits every row exactly
      // once with no orphans and no cycles.
      await withTestSchema(async ({ db }) => {
        const history = new PostgresEventAnchoringService(
          db as unknown as ConstructorParameters<
            typeof PostgresEventAnchoringService
          >[0],
        );
        const N = 8;
        const ref = {
          kind: "atom" as const,
          entityType: "test-briefing",
          entityId: "race-1",
        };
        await Promise.all(
          Array.from({ length: N }, (_, i) =>
            history.appendEvent({
              entityType: ref.entityType,
              entityId: ref.entityId,
              eventType: "briefing.touched",
              actor: { kind: "user", id: "u1" },
              payload: { i },
              occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
            }),
          ),
        );
        const rows = await history.readHistory(ref);
        expect(rows).toHaveLength(N);

        // chainHash uniqueness (also enforced at the schema layer).
        const seenHashes = new Set<string>(rows.map((r) => r.chainHash));
        expect(seenHashes.size).toBe(N);

        // Exactly one root.
        const roots = rows.filter((r) => r.prevHash === null);
        expect(roots).toHaveLength(1);

        // Each non-root prevHash points to a chainHash in this set
        // (no dangling refs).
        for (const row of rows) {
          if (row.prevHash !== null) {
            expect(seenHashes.has(row.prevHash)).toBe(true);
          }
        }

        // Walk the chain forward from the root: each step has exactly
        // one successor (no fork) and we visit all N rows.
        const byPrev = new Map<string | null, typeof rows>();
        for (const row of rows) {
          const k = row.prevHash;
          const arr = byPrev.get(k) ?? [];
          arr.push(row);
          byPrev.set(k, arr);
        }
        for (const [, succs] of byPrev) {
          expect(succs.length).toBe(1);
        }
        const visited = new Set<string>();
        let cursor: string | null = roots[0]?.chainHash ?? null;
        while (cursor !== null) {
          expect(visited.has(cursor)).toBe(false);
          visited.add(cursor);
          const next: typeof rows = byPrev.get(cursor) ?? [];
          cursor = next[0]?.chainHash ?? null;
        }
        expect(visited.size).toBe(N);
      });
    },
  );
});

describe("empressa-atom import boundary", () => {
  beforeAll(() => {
    // Fast safety check: this file should be located inside lib/empressa-atom.
    expect(__dirname).toMatch(/lib\/empressa-atom\/src\/__tests__$/);
  });

  it("never imports from artifacts/*", () => {
    // Use ripgrep to scan every file under lib/empressa-atom/src for an
    // import path beginning with `artifacts/`. Any match is a boundary
    // violation per task spec architectural decision #1.
    const root = resolvePath(__dirname, "..", "..");
    const result = spawnSync(
      "rg",
      [
        "--type",
        "ts",
        "--no-heading",
        "--line-number",
        '(from\\s+["\']\\.\\.?/.*artifacts/|from\\s+["\']artifacts/|from\\s+["\']@workspace/(plan-review|design-tools|api-server|mockup-sandbox))',
        "src",
      ],
      { cwd: root, encoding: "utf8" },
    );
    // rg exits 1 with no output when nothing matches — that's the success case.
    if (result.status === 0 && result.stdout.trim().length > 0) {
      throw new Error(
        `lib/empressa-atom imports application code:\n${result.stdout}`,
      );
    }
    expect(result.status === 1 || result.stdout.trim().length === 0).toBe(true);
  });
});
