/**
 * P-91 / P-92 Wave B write-path fixtures. These fail the forbidden designs
 * (create writes a save; save mutates screen rows; status on a screen-only
 * id; MCP save wipes snapshot). A12 is the four-sentence isolation fixture.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  CREATE_SCREEN_RESOLVE_TIMEOUT_MS,
  SCREEN_STUB_BUDGET_MS,
  SCREEN_STUB_CONCURRENCY,
  addToScreen,
  attachScreenStubs,
  createScreen,
  deleteSavedProperty,
  isUniqueViolation,
  listScreens,
  saveProperty,
  setPropertyStatus,
  snapshotScreenMembership,
  type NodeLookup,
  type QueryResolver,
  type Screen,
  type ScreenRow,
  type ScreenRowStub,
  type ScreenStubAssembler,
} from "./peScreenSave";
import { MemoryScreenSaveStore } from "./peScreenSaveMemory";

const SCOPE = { tenantId: "default", ownerUserId: "user-a12" };
const GOLD = "48021:34137";
const NEIGHBOR = "48021:34169";
const ABSENT = "48021:900099";
const CV = "111 Rainmaker Cv, Bastrop TX";
const COVE = "111 Rainmaker Cove, Bastrop TX 78602";

function neighborLookup(): NodeLookup {
  return async (id) =>
    id === NEIGHBOR ? { parcelNodeId: NEIGHBOR, label: NEIGHBOR } : null;
}

const A5_UNRESOLVED = [
  ", ,",
  "...",
  ";;;",
  "no-such-situs-zzz-99999",
  "invented 1 Fake Blvd Nowhere TX",
  CV,
] as const;

function a5Queries(): string[] {
  const resolved = Array.from({ length: 34 }, (_, i) => `resolved-${i + 1} Main St`);
  return [...resolved, ...A5_UNRESOLVED];
}

function a5Resolver(): QueryResolver {
  return async (query: string) => {
    if (A5_UNRESOLVED.includes(query as (typeof A5_UNRESOLVED)[number])) {
      return [];
    }
    const match = /^resolved-(\d+)/.exec(query);
    if (match) {
      return [{ parcelNodeId: `48021:r${match[1]}`, label: query }];
    }
    return [];
  };
}

describe("A12 save and unsave leave the screen", () => {
  it("four sentences: create forty, save one, unsave, screen bytes identical", async () => {
    const store = new MemoryScreenSaveStore();
    const created = await createScreen(
      store,
      SCOPE,
      { name: "A12 board", queries: a5Queries(), source: "pasted" },
      a5Resolver(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = snapshotScreenMembership(created.screen);
    expect(before.rowCount).toBe(40);
    expect(created.screen.rows.filter((r) => r.resolution === "unresolved")).toHaveLength(6);
    expect(await store.countSaves(SCOPE)).toBe(0);

    const resolved = created.screen.rows.find((r) => r.resolution === "resolved");
    expect(resolved?.parcelNodeId).toBeTruthy();
    const saved = await saveProperty(store, SCOPE, {
      parcelNodeId: resolved!.parcelNodeId!,
      status: "Watching",
    });
    expect(saved.ok).toBe(true);

    const afterSave = await listScreens(store, SCOPE, created.screen.id);
    expect(afterSave.ok).toBe(true);
    if (!("screen" in afterSave)) return;
    expect(snapshotScreenMembership(afterSave.screen)).toEqual(before);
    expect(store.saves).toHaveLength(1);
    expect(store.saves[0]?.parcelNodeId).toBe(resolved!.parcelNodeId);

    const unsaved = await deleteSavedProperty(
      store,
      SCOPE,
      resolved!.parcelNodeId!,
    );
    expect(unsaved.ok).toBe(true);
    const afterUnsave = await listScreens(store, SCOPE, created.screen.id);
    expect(afterUnsave.ok).toBe(true);
    if (!("screen" in afterUnsave)) return;
    expect(snapshotScreenMembership(afterUnsave.screen)).toEqual(before);
    expect(store.saves).toHaveLength(0);
  });
});

describe("forbidden designs fail", () => {
  it("create_screen writing a save is refused by the unchanged-count assert", async () => {
    const store = new MemoryScreenSaveStore();
    const orig = store.insertScreen.bind(store);
    store.insertScreen = async (input) => {
      await store.insertSave({
        scope: input.scope,
        parcelNodeId: GOLD,
        crmStatus: "New",
        note: null,
      });
      return orig(input);
    };
    await expect(
      createScreen(
        store,
        SCOPE,
        { queries: ["resolved-1 Main St"], source: "pasted" },
        a5Resolver(),
      ),
    ).rejects.toThrow("create_screen_wrote_saves");
    expect(store.saves).toHaveLength(0);
    expect(store.screens).toHaveLength(0);
  });

  it("save_property changing screen ordinals or queries is a defect", async () => {
    const store = new MemoryScreenSaveStore();
    const created = await createScreen(
      store,
      SCOPE,
      { queries: a5Queries(), source: "pasted" },
      a5Resolver(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = snapshotScreenMembership(created.screen);
    const node = created.screen.rows.find((r) => r.resolution === "resolved")
      ?.parcelNodeId;
    const result = await saveProperty(store, SCOPE, { parcelNodeId: node! });
    expect(result.ok).toBe(true);
    const after = await listScreens(store, SCOPE, created.screen.id);
    expect(after.ok && "screen" in after).toBe(true);
    if (!("screen" in after)) return;
    expect(snapshotScreenMembership(after.screen)).toEqual(before);
  });

  it("set_property_status on a screen-only id refuses saved_property_not_found", async () => {
    const store = new MemoryScreenSaveStore();
    const created = await createScreen(
      store,
      SCOPE,
      { queries: ["resolved-1 Main St"], source: "pasted" },
      a5Resolver(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const node = created.screen.rows[0]?.parcelNodeId;
    expect(node).toBeTruthy();
    expect(created.screen.rows[0]).not.toHaveProperty("status");
    const result = await setPropertyStatus(store, SCOPE, {
      parcelNodeId: node!,
      status: "Chasing",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBe("saved_property_not_found");
    expect(store.saves).toHaveLength(0);
    const reloaded = await listScreens(store, SCOPE, created.screen.id);
    expect(reloaded.ok && "screen" in reloaded).toBe(true);
    if (!("screen" in reloaded)) return;
    expect(reloaded.screen.rows[0]).not.toHaveProperty("status");
  });

  it("MCP save_property leaves snapshot untouched", async () => {
    const store = new MemoryScreenSaveStore();
    const snapshot = { status: "researching", notes: "keep me", dossier: { a: 1 } };
    store.seedSave({
      scope: SCOPE,
      parcelNodeId: GOLD,
      snapshot,
      crmStatus: null,
    });
    const result = await saveProperty(store, SCOPE, {
      parcelNodeId: GOLD,
      status: "Watching",
      note: "mcp note",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("Watching");
    expect(result.note).toBe("mcp note");
    expect(store.saves[0]?.snapshot).toEqual(snapshot);
    expect(store.saves[0]?.snapshot).not.toEqual({});
  });
});

describe("A5 create forty keep six / A14 verbatim / A13 walk / I6", () => {
  it("A5: forty rows, six unresolved, save count unchanged, query verbatim", async () => {
    const store = new MemoryScreenSaveStore();
    store.seedSave({ scope: SCOPE, parcelNodeId: "48021:preexisting" });
    const before = await store.countSaves(SCOPE);
    const created = await createScreen(
      store,
      SCOPE,
      { queries: a5Queries(), source: "pasted" },
      a5Resolver(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.screen.rows).toHaveLength(40);
    expect(created.screen.rows.every((r) => r.source === "pasted")).toBe(true);
    const unresolved = created.screen.rows.filter((r) => r.resolution === "unresolved");
    expect(unresolved).toHaveLength(6);
    for (const row of unresolved) {
      expect(row.parcelNodeId).toBeNull();
      expect(A5_UNRESOLVED).toContain(row.query);
    }
    expect(await store.countSaves(SCOPE)).toBe(before);
    // Every resolver answered inside the budget: no degradation is declared.
    expect(created.screen).not.toHaveProperty("degraded");
    for (const row of created.screen.rows) {
      expect(row).not.toHaveProperty("resolveTimedOut");
    }
  });

  it("create_screen declares a resolver timeout on the row and the screen, persisting nothing extra", async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryScreenSaveStore();
      const pending = createScreen(
        store,
        SCOPE,
        { name: "slow", queries: ["resolved-1 Main St", CV], source: "pasted" },
        async (query) => {
          if (query === CV) return new Promise<never>(() => {});
          return [{ parcelNodeId: "48021:r1", label: query }];
        },
      );
      await vi.advanceTimersByTimeAsync(CREATE_SCREEN_RESOLVE_TIMEOUT_MS + 1);
      const created = await pending;
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.screen.degraded).toEqual({ timedOut: [CV] });
      expect(created.screen.rows[0]).not.toHaveProperty("resolveTimedOut");
      expect(created.screen.rows[1]).toMatchObject({
        query: CV,
        resolution: "unresolved",
        parcelNodeId: null,
        resolveTimedOut: true,
      });
      // The rows table is unchanged: the timeout is declared, never stored.
      expect(store.rows).toHaveLength(2);
      for (const stored of store.rows) {
        expect(stored).not.toHaveProperty("resolveTimedOut");
      }
      // A reload reads only the store, so it cannot and does not declare it.
      const reloaded = await listScreens(store, SCOPE, created.screen.id);
      expect(reloaded.ok && "screen" in reloaded).toBe(true);
      if (!("screen" in reloaded)) return;
      expect(reloaded.screen).not.toHaveProperty("degraded");
      expect(reloaded.screen.rows[1]).not.toHaveProperty("resolveTimedOut");
      expect(reloaded.screen.rows[1]?.resolution).toBe("unresolved");
    } finally {
      vi.useRealTimers();
    }
  });

  it("create_screen refuses two queries that resolve to the same node", async () => {
    const store = new MemoryScreenSaveStore();
    const result = await createScreen(
      store,
      SCOPE,
      {
        name: "same-node",
        queries: ["908 Pine, Bastrop TX", GOLD],
        source: "pasted",
      },
      async (query) => [{ parcelNodeId: GOLD, label: query }],
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.error).toBe("duplicate_resolved_node");
    expect(result.error.node).toBe(GOLD);
    expect(result.error.queries).toEqual(["908 Pine, Bastrop TX", GOLD]);
    expect(store.screens).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  it("A14: Cv is stored as Cv and never rewritten to Cove", async () => {
    const store = new MemoryScreenSaveStore();
    const created = await createScreen(
      store,
      SCOPE,
      { queries: [CV, COVE], source: "pasted" },
      async () => [],
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.screen.rows.map((r) => r.query)).toEqual([CV, COVE]);
    expect(created.screen.rows[0]?.query).toContain("Cv");
    expect(created.screen.rows[0]?.query).not.toContain("Cove");
  });

  it("A13: walk add does not write a save", async () => {
    const store = new MemoryScreenSaveStore();
    const created = await createScreen(
      store,
      SCOPE,
      { name: "walk", queries: [], source: "pasted" },
      a5Resolver(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const added = await addToScreen(
      store,
      SCOPE,
      {
        screenId: created.screen.id,
        parcelNodeId: NEIGHBOR,
        source: "walk",
      },
      neighborLookup(),
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.row.source).toBe("walk");
    expect(added.row.resolution).toBe("resolved");
    expect(added.row.parcelNodeId).toBe(NEIGHBOR);
    expect(await store.countSaves(SCOPE)).toBe(0);
    const again = await addToScreen(
      store,
      SCOPE,
      {
        screenId: created.screen.id,
        parcelNodeId: NEIGHBOR,
        source: "walk",
      },
      neighborLookup(),
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.row.id).toBe(added.row.id);
    expect(again.row.ordinal).toBe(added.row.ordinal);
  });

  it("add_to_screen writes unresolved when the parcel row is absent", async () => {
    const store = new MemoryScreenSaveStore();
    const created = await createScreen(
      store,
      SCOPE,
      { name: "walk", queries: [], source: "pasted" },
      a5Resolver(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const added = await addToScreen(
      store,
      SCOPE,
      {
        screenId: created.screen.id,
        parcelNodeId: ABSENT,
        source: "walk",
      },
      async () => null,
    );
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.row.resolution).toBe("unresolved");
    expect(added.row.parcelNodeId).toBeNull();
    expect(added.row.query).toBe(ABSENT);
    expect(added.row.source).toBe("walk");
    expect(await store.countSaves(SCOPE)).toBe(0);
    const again = await addToScreen(
      store,
      SCOPE,
      {
        screenId: created.screen.id,
        parcelNodeId: ABSENT,
        source: "walk",
      },
      async () => {
        throw new Error("lookup must not run on the query-idempotent path");
      },
    );
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.row.id).toBe(added.row.id);
    expect(again.row.resolution).toBe("unresolved");
  });

  it("add_to_screen refuses lookup_unavailable when the lookup throws and writes nothing", async () => {
    const store = new MemoryScreenSaveStore();
    const created = await createScreen(
      store,
      SCOPE,
      { name: "walk", queries: [], source: "pasted" },
      a5Resolver(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const updatedBefore = store.screens[0]?.updatedAt;
    const threw = await addToScreen(
      store,
      SCOPE,
      {
        screenId: created.screen.id,
        parcelNodeId: ABSENT,
        source: "walk",
      },
      async () => {
        throw new Error("pool exhausted");
      },
    );
    // The store did not answer. That is not an absence; nothing is written,
    // so the next add re-runs the lookup instead of reading a false miss.
    expect(threw.ok).toBe(false);
    if (threw.ok) return;
    expect(threw.error).toEqual({ error: "lookup_unavailable", node: ABSENT });
    expect(store.rows).toHaveLength(0);
    expect(store.screens[0]?.updatedAt).toBe(updatedBefore);

    const retried = await addToScreen(
      store,
      SCOPE,
      {
        screenId: created.screen.id,
        parcelNodeId: ABSENT,
        source: "walk",
      },
      async () => null,
    );
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.row.resolution).toBe("unresolved");
    expect(store.rows).toHaveLength(1);
  });

  it("add_to_screen returns the existing row when a concurrent add wins the unique index", async () => {
    const store = new MemoryScreenSaveStore();
    const created = await createScreen(
      store,
      SCOPE,
      { name: "walk", queries: [], source: "pasted" },
      a5Resolver(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    // The race: the pre-check saw no row, then a competing add lands between
    // maxOrdinal and insertScreenRow. The memory store raises 23505 exactly
    // as pe_screen_rows_screen_node_uidx does.
    let competingId: string | undefined;
    const origMax = store.maxOrdinal.bind(store);
    store.maxOrdinal = async (screenId) => {
      const max = await origMax(screenId);
      const [row] = await store.insertScreenRows([
        {
          screenId,
          ordinal: (max ?? -1) + 1,
          query: NEIGHBOR,
          parcelNodeId: NEIGHBOR,
          resolution: "resolved",
          source: "walk",
          candidates: null,
        },
      ]);
      competingId = row?.id;
      return max;
    };
    const added = await addToScreen(
      store,
      SCOPE,
      {
        screenId: created.screen.id,
        parcelNodeId: NEIGHBOR,
        source: "walk",
      },
      neighborLookup(),
    );
    expect(competingId).toBeTruthy();
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.row.id).toBe(competingId);
    expect(added.row.parcelNodeId).toBe(NEIGHBOR);
    expect(added.row.resolution).toBe("resolved");
    expect(store.rows).toHaveLength(1);
  });

  it("create_screen refuses lookup_unavailable when a node-id lookup throws and writes no screen", async () => {
    const store = new MemoryScreenSaveStore();
    const result = await createScreen(
      store,
      SCOPE,
      {
        name: "walk",
        queries: ["908 Pine, Bastrop TX", GOLD],
        source: "pasted",
      },
      async (query) => {
        if (query === GOLD) throw new Error("statement timeout");
        return [{ parcelNodeId: "48021:r1", label: query }];
      },
    );
    // A partial screen that marks a real parcel absent is worse than no screen.
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toEqual({ error: "lookup_unavailable", query: GOLD });
    expect(store.screens).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  it("create_screen never writes a situs-search throw as an absence", async () => {
    const store = new MemoryScreenSaveStore();
    await expect(
      createScreen(
        store,
        SCOPE,
        { queries: ["908 Pine, Bastrop TX"], source: "pasted" },
        async () => {
          throw new Error("search down");
        },
      ),
    ).rejects.toThrow("search down");
    expect(store.screens).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  it("add_to_screen writes unresolved when the lookup answers with a different id", async () => {
    const store = new MemoryScreenSaveStore();
    const created = await createScreen(
      store,
      SCOPE,
      { name: "walk", queries: [], source: "pasted" },
      a5Resolver(),
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const rebound = await addToScreen(
      store,
      SCOPE,
      {
        screenId: created.screen.id,
        parcelNodeId: "48021:900098",
        source: "walk",
      },
      async () => ({ parcelNodeId: GOLD, label: GOLD }),
    );
    expect(rebound.ok).toBe(true);
    if (!rebound.ok) return;
    expect(rebound.row.resolution).toBe("unresolved");
    expect(rebound.row.parcelNodeId).toBeNull();
    expect(rebound.row.query).toBe("48021:900098");
  });

  it("I6: save works on a node not on any screen", async () => {
    const store = new MemoryScreenSaveStore();
    const result = await saveProperty(store, SCOPE, { parcelNodeId: GOLD });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe("New");
    expect(store.screens).toHaveLength(0);
    expect(store.rows).toHaveLength(0);
  });

  it("v1 create_screen chrome/gmail/file refuse intake_not_implemented", async () => {
    const store = new MemoryScreenSaveStore();
    for (const source of ["chrome", "gmail", "file"] as const) {
      const result = await createScreen(
        store,
        SCOPE,
        { queries: ["x"], source },
        a5Resolver(),
      );
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.error).toBe("intake_not_implemented");
    }
    expect(store.screens).toHaveLength(0);
  });

  it("researching/offer/lowercase passed refuse as unknown_status", async () => {
    const store = new MemoryScreenSaveStore();
    for (const status of ["researching", "offer", "passed"]) {
      const result = await saveProperty(store, SCOPE, {
        parcelNodeId: GOLD,
        status,
      });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.error).toBe("unknown_status");
    }
    expect(store.saves).toHaveLength(0);
  });
});

describe("I6 get_smart_site does not SELECT screen or save tables", () => {
  it("assembleNodeBriefBody and assembleStubBody never name those tables", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(
      join(here, "../routes/propertyExplorer.ts"),
      "utf8",
    );
    const start = src.indexOf("async function assembleNodeBriefBody");
    const stub = src.indexOf("async function assembleStubBody");
    const afterStub = src.indexOf("\nfunction manifestLayers");
    const assemblers = src.slice(start, afterStub);
    expect(assemblers).toContain("assembleNodeBriefBody");
    expect(assemblers).toContain("assembleStubBody");
    expect(assemblers).not.toMatch(/pe_screens|pe_screen_rows|peSavedProperties|pe_saved_properties/);
  });
});

describe("isUniqueViolation", () => {
  it("recognises pg's code on the error and drizzle's on the cause, nothing else", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
    expect(
      isUniqueViolation(Object.assign(new Error("dup"), { code: "23505" })),
    ).toBe(true);
    expect(isUniqueViolation({ code: "23503" })).toBe(false);
    expect(isUniqueViolation({ cause: { code: "23503" } })).toBe(false);
    expect(isUniqueViolation(new Error("pe_screen_rows_screen_node_uidx"))).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
    expect(isUniqueViolation(undefined)).toBe(false);
    expect(isUniqueViolation("23505")).toBe(false);
  });
});

describe("I5 no listing columns", () => {
  it("migration and drizzle schema omit listing-feed keys", () => {
    const root = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../lib/db",
    );
    const sql = readFileSync(
      join(root, "drizzle/0088_pe_screens_and_saved_crm.sql"),
      "utf8",
    );
    const screens = readFileSync(join(root, "src/schema/peScreens.ts"), "utf8");
    const saves = readFileSync(
      join(root, "src/schema/peSavedProperties.ts"),
      "utf8",
    );
    const blob = `${sql}\n${screens}\n${saves}`;
    for (const key of [
      "listPrice",
      "askingPrice",
      "daysOnMarket",
      "mlsId",
      "mls_id",
      "listingId",
      "listingUrl",
      "zillow",
      "snippet",
      "webSearch",
      "searchCache",
    ]) {
      expect(blob).not.toContain(key);
    }
  });
});

/**
 * P-91 4.3 rails at first paint. The stub pass is a read-only projection
 * onto the response: nothing here may reach the store, and the three
 * non-answers (measured miss, throw, not started) stay three states.
 */
describe("4.3 rails at first paint: attachScreenStubs", () => {
  const OK_NODE = "48021:34137";
  const MISS_NODE = "48021:900099";
  const DOWN_NODE = "48021:900098";
  const STAMP = "2026-08-29T15:00:00.000Z";

  function allRails(state: ScreenRowStub["situs"]): ScreenRowStub {
    return {
      situs: state,
      zoning: state,
      landUse: state,
      flood: state,
      drainage: state,
      envelope: state,
    };
  }

  function resolvedRow(ordinal: number, parcelNodeId: string): ScreenRow {
    return {
      id: `r${ordinal}`,
      ordinal,
      parcelNodeId,
      query: parcelNodeId,
      resolution: "resolved",
      source: "pasted",
    };
  }

  function screenOf(rows: ScreenRow[]): Screen {
    return {
      id: "screen-1",
      name: "walk",
      createdAt: STAMP,
      updatedAt: STAMP,
      rows,
    };
  }

  function mixedScreen(): Screen {
    return screenOf([
      resolvedRow(0, OK_NODE),
      resolvedRow(1, MISS_NODE),
      resolvedRow(2, DOWN_NODE),
      {
        id: "r3",
        ordinal: 3,
        parcelNodeId: null,
        query: "no-such-situs-zzz-99999",
        resolution: "unresolved",
        source: "pasted",
      },
      {
        id: "r4",
        ordinal: 4,
        parcelNodeId: null,
        query: "111 Rainmaker Cv, Bastrop TX",
        resolution: "ambiguous",
        source: "pasted",
        candidates: [
          { parcelNodeId: "48021:c1", label: "111 Rainmaker Cv" },
          { parcelNodeId: "48021:c2", label: "111 Rainmaker Cove" },
        ],
      },
    ]);
  }

  /** The real assembler's body: extra keys, drainage never attempted, flood atom-miss. */
  function okBody(parcelNodeId: string) {
    return {
      parcelNodeId,
      label: "910 PINE, BASTROP, TX 78602",
      url: `https://smartsite.cloud/parcel/${parcelNodeId}`,
      situs: "present" as const,
      zoning: "present" as const,
      landUse: "unknown" as const,
      flood: "unknown" as const,
      drainage: "unread" as const,
      envelope: "refused" as const,
    };
  }

  function mixedAssembler(): ScreenStubAssembler {
    return async (id) => {
      if (id === OK_NODE) return okBody(id);
      if (id === DOWN_NODE) throw new Error("statement timeout");
      return null;
    };
  }

  it("a body carries its six rails with stubRead ok; a throw is unread + error; unresolved and ambiguous rows carry neither key; the screen declares stubsDegraded", async () => {
    const errors: Array<[string, unknown]> = [];
    const out = await attachScreenStubs(mixedScreen(), mixedAssembler(), {
      onReadError: (id, err) => errors.push([id, err]),
    });
    const byNode = new Map(out.rows.map((r) => [r.query, r]));

    const ok = byNode.get(OK_NODE)!;
    expect(ok.stubRead).toBe("ok");
    expect(ok.stub).toEqual({
      situs: "present",
      zoning: "present",
      landUse: "unknown",
      flood: "unknown",
      drainage: "unread",
      envelope: "refused",
    });
    // Only the six rails travel; label/url/parcelNodeId from the body do not.
    expect(Object.keys(ok.stub!).sort()).toEqual(
      ["drainage", "envelope", "flood", "landUse", "situs", "zoning"],
    );

    const down = byNode.get(DOWN_NODE)!;
    expect(down.stubRead).toBe("error");
    expect(down.stub).toEqual(allRails("unread"));
    expect(errors).toHaveLength(1);
    expect(errors[0]![0]).toBe(DOWN_NODE);
    expect((errors[0]![1] as Error).message).toBe("statement timeout");

    for (const query of ["no-such-situs-zzz-99999", "111 Rainmaker Cv, Bastrop TX"]) {
      const row = byNode.get(query)!;
      expect(row).not.toHaveProperty("stub");
      expect(row).not.toHaveProperty("stubRead");
    }
    expect(out.stubsDegraded).toBe(true);
  });

  it("falsifier (WDLL 5): a null body is a measured bake miss and maps every rail to unknown, never unread", async () => {
    const out = await attachScreenStubs(mixedScreen(), mixedAssembler());
    const miss = out.rows.find((r) => r.query === MISS_NODE)!;
    expect(miss.stubRead).toBe("ok");
    expect(miss.stub).toEqual(allRails("unknown"));
    expect(Object.values(miss.stub!)).not.toContain("unread");
  });

  it("all rows ok omits stubsDegraded", async () => {
    const out = await attachScreenStubs(
      screenOf([resolvedRow(0, OK_NODE), resolvedRow(1, MISS_NODE)]),
      async (id) => (id === OK_NODE ? okBody(id) : null),
    );
    expect(out).not.toHaveProperty("stubsDegraded");
    expect(out.rows.map((r) => r.stubRead)).toEqual(["ok", "ok"]);
  });

  it("a screen with no resolved rows calls the assembler zero times and is not degraded", async () => {
    const assembler = vi.fn<ScreenStubAssembler>(async () => null);
    const out = await attachScreenStubs(
      screenOf([
        {
          id: "r0",
          ordinal: 0,
          parcelNodeId: null,
          query: ", ,",
          resolution: "unresolved",
          source: "pasted",
        },
      ]),
      assembler,
    );
    expect(assembler).not.toHaveBeenCalled();
    expect(out).not.toHaveProperty("stubsDegraded");
    expect(out.rows[0]).not.toHaveProperty("stub");
  });

  it("does not mutate the input screen; the store-shaped rows never gain a stub key", async () => {
    const input = mixedScreen();
    const before = JSON.stringify(input);
    const out = await attachScreenStubs(input, mixedAssembler());
    expect(JSON.stringify(input)).toBe(before);
    expect(out).not.toBe(input);
    expect(out.rows).not.toBe(input.rows);
    for (const row of input.rows) {
      expect(row).not.toHaveProperty("stub");
      expect(row).not.toHaveProperty("stubRead");
    }
    expect(out.updatedAt).toBe(STAMP);
  });

  it("a rail outside the five-state vocabulary is a read that did not complete: row error, rails unread, onReadError named", async () => {
    const errors: Array<[string, unknown]> = [];
    const out = await attachScreenStubs(
      screenOf([resolvedRow(0, OK_NODE)]),
      async (id) =>
        ({ ...okBody(id), zoning: "maybe" }) as unknown as ReturnType<
          typeof okBody
        >,
      { onReadError: (id, err) => errors.push([id, err]) },
    );
    expect(out.rows[0]!.stubRead).toBe("error");
    expect(out.rows[0]!.stub).toEqual(allRails("unread"));
    expect(out.stubsDegraded).toBe(true);
    expect(errors).toHaveLength(1);
    expect(String((errors[0]![1] as Error).message)).toContain("zoning");
  });

  it("rows not started inside SCREEN_STUB_BUDGET_MS are skipped; rows already started finish", async () => {
    expect(SCREEN_STUB_BUDGET_MS).toBe(6_000);
    expect(SCREEN_STUB_CONCURRENCY).toBe(8);
    vi.useFakeTimers();
    try {
      const rows = Array.from({ length: 20 }, (_, i) =>
        resolvedRow(i, `48021:b${i}`),
      );
      const started: string[] = [];
      const finished: string[] = [];
      const READ_MS = 4_000;
      const assembler: ScreenStubAssembler = async (id) => {
        started.push(id);
        await new Promise<void>((resolve) => setTimeout(resolve, READ_MS));
        finished.push(id);
        return okBody(id);
      };
      const pending = attachScreenStubs(screenOf(rows), assembler);
      // t=0: eight start. t=4000: eight finish, eight more start (under budget).
      // t=8000: those finish; the four never started are past the budget.
      await vi.advanceTimersByTimeAsync(READ_MS);
      expect(started).toHaveLength(16);
      await vi.advanceTimersByTimeAsync(READ_MS);
      // Asserted before awaiting: with the budget check removed the last four
      // rows start here, and this fails by assertion instead of by a hang.
      expect(started).toHaveLength(16);
      const out = await pending;
      expect(started).toHaveLength(16);
      expect(finished).toHaveLength(16);
      const reads = out.rows.map((r) => r.stubRead);
      expect(reads.filter((s) => s === "ok")).toHaveLength(16);
      expect(reads.filter((s) => s === "skipped")).toHaveLength(4);
      for (const row of out.rows.slice(16)) {
        expect(row.stubRead).toBe("skipped");
        expect(row.stub).toEqual(allRails("unread"));
      }
      // A row started at t=4000 finished at t=8000, past the budget, and is ok.
      expect(out.rows[15]!.stubRead).toBe("ok");
      expect(out.stubsDegraded).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
