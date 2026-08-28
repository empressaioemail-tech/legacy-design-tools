/**
 * P-91 / P-92 Wave B write-path fixtures. These fail the forbidden designs
 * (create writes a save; save mutates screen rows; status on a screen-only
 * id; MCP save wipes snapshot). A12 is the four-sentence isolation fixture.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  addToScreen,
  createScreen,
  deleteSavedProperty,
  listScreens,
  saveProperty,
  setPropertyStatus,
  snapshotScreenMembership,
  type QueryResolver,
} from "./peScreenSave";
import { MemoryScreenSaveStore } from "./peScreenSaveMemory";

const SCOPE = { tenantId: "default", ownerUserId: "user-a12" };
const GOLD = "48021:34137";
const NEIGHBOR = "48021:34169";
const CV = "111 Rainmaker Cv, Bastrop TX";
const COVE = "111 Rainmaker Cove, Bastrop TX 78602";

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
    const added = await addToScreen(store, SCOPE, {
      screenId: created.screen.id,
      parcelNodeId: NEIGHBOR,
      source: "walk",
    });
    expect(added.ok).toBe(true);
    if (!added.ok) return;
    expect(added.row.source).toBe("walk");
    expect(added.row.resolution).toBe("resolved");
    expect(added.row.parcelNodeId).toBe(NEIGHBOR);
    expect(await store.countSaves(SCOPE)).toBe(0);
    const again = await addToScreen(store, SCOPE, {
      screenId: created.screen.id,
      parcelNodeId: NEIGHBOR,
      source: "walk",
    });
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.row.id).toBe(added.row.id);
    expect(again.row.ordinal).toBe(added.row.ordinal);
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
