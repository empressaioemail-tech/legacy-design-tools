/**
 * Drizzle adapter for ScreenSaveStore. MCP save/status UPDATE columns only.
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db, peSavedProperties, peScreenRows, peScreens } from "@workspace/db";
import type {
  CrmStatus,
  OwnerScope,
  SavedCrmRow,
  ScreenCandidate,
  ScreenResolution,
  ScreenSaveStore,
  ScreenSource,
} from "./peScreenSave";

type DbHandle = typeof db;

function asCandidates(value: unknown): ScreenCandidate[] | null {
  if (!Array.isArray(value)) return null;
  const out: ScreenCandidate[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const rec = item as Record<string, unknown>;
    if (typeof rec.parcelNodeId !== "string" || typeof rec.label !== "string") {
      return null;
    }
    out.push({ parcelNodeId: rec.parcelNodeId, label: rec.label });
  }
  return out;
}

function toSaved(row: {
  id: string;
  parcelNodeId: string;
  crmStatus: string | null;
  note: string | null;
  snapshot: unknown;
  label: string | null;
  updatedAt: Date;
}): SavedCrmRow {
  return {
    id: row.id,
    parcelNodeId: row.parcelNodeId,
    crmStatus: (row.crmStatus as CrmStatus | null) ?? null,
    note: row.note,
    snapshot:
      row.snapshot && typeof row.snapshot === "object" && !Array.isArray(row.snapshot)
        ? (row.snapshot as Record<string, unknown>)
        : {},
    label: row.label,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createDrizzleScreenSaveStore(handle: DbHandle = db): ScreenSaveStore {
  const store: ScreenSaveStore = {
    async countSaves(scope: OwnerScope) {
      const rows = await handle
        .select({ id: peSavedProperties.id })
        .from(peSavedProperties)
        .where(
          and(
            eq(peSavedProperties.tenantId, scope.tenantId),
            eq(peSavedProperties.ownerUserId, scope.ownerUserId),
          ),
        );
      return rows.length;
    },

    async insertScreen(input) {
      const [row] = await handle
        .insert(peScreens)
        .values({
          tenantId: input.scope.tenantId,
          ownerUserId: input.scope.ownerUserId,
          name: input.name,
          createdAt: input.createdAt,
          updatedAt: input.createdAt,
        })
        .returning();
      if (!row) throw new Error("insert_screen_failed");
      return row;
    },

    async insertScreenRows(rows) {
      if (rows.length === 0) return [];
      const inserted = await handle
        .insert(peScreenRows)
        .values(
          rows.map((row) => ({
            screenId: row.screenId,
            ordinal: row.ordinal,
            query: row.query,
            parcelNodeId: row.parcelNodeId,
            resolution: row.resolution,
            source: row.source,
            candidates: row.candidates,
          })),
        )
        .returning({ id: peScreenRows.id });
      return inserted;
    },

    async getScreen(scope, screenId) {
      const [row] = await handle
        .select()
        .from(peScreens)
        .where(
          and(
            eq(peScreens.id, screenId),
            eq(peScreens.tenantId, scope.tenantId),
            eq(peScreens.ownerUserId, scope.ownerUserId),
          ),
        )
        .limit(1);
      return row ?? null;
    },

    async listScreens(scope) {
      const screens = await handle
        .select()
        .from(peScreens)
        .where(
          and(
            eq(peScreens.tenantId, scope.tenantId),
            eq(peScreens.ownerUserId, scope.ownerUserId),
            isNull(peScreens.deletedAt),
          ),
        )
        .orderBy(desc(peScreens.updatedAt));
      const out = [];
      for (const s of screens) {
        const rows = await handle
          .select({ id: peScreenRows.id })
          .from(peScreenRows)
          .where(eq(peScreenRows.screenId, s.id));
        out.push({
          id: s.id,
          name: s.name,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          rowCount: rows.length,
        });
      }
      return out;
    },

    async listScreenRows(screenId) {
      const rows = await handle
        .select()
        .from(peScreenRows)
        .where(eq(peScreenRows.screenId, screenId))
        .orderBy(peScreenRows.ordinal);
      return rows.map((r) => ({
        id: r.id,
        ordinal: r.ordinal,
        query: r.query,
        parcelNodeId: r.parcelNodeId,
        resolution: r.resolution as ScreenResolution,
        source: r.source as ScreenSource,
        candidates: asCandidates(r.candidates),
      }));
    },

    async findScreenRowByNode(screenId, parcelNodeId) {
      const [row] = await handle
        .select()
        .from(peScreenRows)
        .where(
          and(
            eq(peScreenRows.screenId, screenId),
            eq(peScreenRows.parcelNodeId, parcelNodeId),
          ),
        )
        .limit(1);
      if (!row) return null;
      return {
        id: row.id,
        ordinal: row.ordinal,
        query: row.query,
        parcelNodeId: row.parcelNodeId,
        resolution: row.resolution as ScreenResolution,
        source: row.source as ScreenSource,
        candidates: asCandidates(row.candidates),
      };
    },

    async maxOrdinal(screenId) {
      const [row] = await handle
        .select({ max: sql<number>`max(${peScreenRows.ordinal})` })
        .from(peScreenRows)
        .where(eq(peScreenRows.screenId, screenId));
      return row?.max == null ? null : Number(row.max);
    },

    async insertScreenRow(row) {
      const [inserted] = await handle
        .insert(peScreenRows)
        .values({
          screenId: row.screenId,
          ordinal: row.ordinal,
          query: row.query,
          parcelNodeId: row.parcelNodeId,
          resolution: row.resolution,
          source: row.source,
          candidates: row.candidates,
        })
        .returning({ id: peScreenRows.id });
      if (!inserted) throw new Error("insert_screen_row_failed");
      return inserted;
    },

    async touchScreen(screenId, updatedAt) {
      await handle
        .update(peScreens)
        .set({ updatedAt })
        .where(eq(peScreens.id, screenId));
    },

    async findSave(scope, parcelNodeId) {
      const [row] = await handle
        .select()
        .from(peSavedProperties)
        .where(
          and(
            eq(peSavedProperties.tenantId, scope.tenantId),
            eq(peSavedProperties.ownerUserId, scope.ownerUserId),
            eq(peSavedProperties.parcelNodeId, parcelNodeId),
          ),
        )
        .limit(1);
      return row ? toSaved(row) : null;
    },

    async insertSave(input) {
      const [row] = await handle
        .insert(peSavedProperties)
        .values({
          tenantId: input.scope.tenantId,
          ownerUserId: input.scope.ownerUserId,
          parcelNodeId: input.parcelNodeId,
          crmStatus: input.crmStatus,
          note: input.note,
          snapshot: {},
        })
        .returning();
      if (!row) throw new Error("insert_save_failed");
      return toSaved(row);
    },

    async updateSaveColumns(input) {
      const set: { crmStatus?: string; note?: string | null; updatedAt: Date } = {
        updatedAt: new Date(),
      };
      if (input.crmStatus !== undefined) set.crmStatus = input.crmStatus;
      if (input.note !== undefined) set.note = input.note;
      const [row] = await handle
        .update(peSavedProperties)
        .set(set)
        .where(eq(peSavedProperties.id, input.id))
        .returning();
      if (!row) throw new Error("saved_property_not_found");
      return toSaved(row);
    },

    async deleteSave(scope, parcelNodeId) {
      const deleted = await handle
        .delete(peSavedProperties)
        .where(
          and(
            eq(peSavedProperties.tenantId, scope.tenantId),
            eq(peSavedProperties.ownerUserId, scope.ownerUserId),
            eq(peSavedProperties.parcelNodeId, parcelNodeId),
          ),
        )
        .returning({ id: peSavedProperties.id });
      return deleted.length > 0;
    },

    async transaction(fn) {
      return handle.transaction(async (tx) => {
        return fn(createDrizzleScreenSaveStore(tx as unknown as DbHandle));
      });
    },
  };
  return store;
}
