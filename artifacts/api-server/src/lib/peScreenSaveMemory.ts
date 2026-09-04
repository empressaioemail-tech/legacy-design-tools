/**
 * In-memory ScreenSaveStore for unit/integration tests. Applies the named
 * check constraints in process so a forbidden write fails without Neon.
 */

import { randomUUID } from "node:crypto";
import {
  CRM_STATUSES,
  SCREEN_RESOLUTIONS,
  SCREEN_SOURCES,
  type CrmStatus,
  type OwnerScope,
  type SavedCrmRow,
  type ScreenCandidate,
  type ScreenResolution,
  type ScreenSaveStore,
  type ScreenSource,
} from "./peScreenSave";

type ScreenRec = {
  id: string;
  tenantId: string;
  ownerUserId: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

type RowRec = {
  id: string;
  screenId: string;
  ordinal: number;
  query: string;
  parcelNodeId: string | null;
  resolution: ScreenResolution;
  source: ScreenSource;
  candidates: ScreenCandidate[] | null;
  createdAt: Date;
};

type SaveRec = {
  id: string;
  tenantId: string;
  ownerUserId: string;
  parcelNodeId: string;
  label: string | null;
  snapshot: Record<string, unknown>;
  crmStatus: CrmStatus | null;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function sameOwner(rec: { tenantId: string; ownerUserId: string }, scope: OwnerScope) {
  return rec.tenantId === scope.tenantId && rec.ownerUserId === scope.ownerUserId;
}

function assertRowChecks(row: {
  query: string;
  parcelNodeId: string | null;
  resolution: string;
  source: string;
  candidates: ScreenCandidate[] | null;
}): void {
  if (!(SCREEN_RESOLUTIONS as readonly string[]).includes(row.resolution)) {
    throw new Error("pe_screen_rows_resolution_chk");
  }
  if (!(SCREEN_SOURCES as readonly string[]).includes(row.source)) {
    throw new Error("pe_screen_rows_source_chk");
  }
  const resolved = row.resolution === "resolved";
  const hasNode = row.parcelNodeId != null;
  if (resolved !== hasNode) {
    throw new Error("pe_screen_rows_resolved_node_chk");
  }
  const ambiguous = row.resolution === "ambiguous";
  const hasCandidates =
    Array.isArray(row.candidates) && row.candidates.length > 0;
  if (ambiguous !== hasCandidates) {
    throw new Error("pe_screen_rows_ambiguous_candidates_chk");
  }
  if (row.query.trim().length === 0) {
    throw new Error("pe_screen_rows_query_present_chk");
  }
}

function assertCrmStatus(status: string | null): void {
  if (status == null) return;
  if (!(CRM_STATUSES as readonly string[]).includes(status)) {
    throw new Error("pe_saved_properties_crm_status_chk");
  }
}

function toSaved(rec: SaveRec): SavedCrmRow {
  return {
    id: rec.id,
    parcelNodeId: rec.parcelNodeId,
    crmStatus: rec.crmStatus,
    note: rec.note,
    snapshot: rec.snapshot,
    label: rec.label,
    updatedAt: rec.updatedAt.toISOString(),
  };
}

export class MemoryScreenSaveStore implements ScreenSaveStore {
  screens: ScreenRec[] = [];
  rows: RowRec[] = [];
  saves: SaveRec[] = [];

  seedSave(input: {
    scope: OwnerScope;
    parcelNodeId: string;
    snapshot?: Record<string, unknown>;
    crmStatus?: CrmStatus | null;
    note?: string | null;
    label?: string | null;
  }): SavedCrmRow {
    const now = new Date();
    const rec: SaveRec = {
      id: randomUUID(),
      tenantId: input.scope.tenantId,
      ownerUserId: input.scope.ownerUserId,
      parcelNodeId: input.parcelNodeId,
      label: input.label ?? null,
      snapshot: input.snapshot ?? {},
      crmStatus: input.crmStatus ?? null,
      note: input.note ?? null,
      createdAt: now,
      updatedAt: now,
    };
    assertCrmStatus(rec.crmStatus);
    this.saves.push(rec);
    return toSaved(rec);
  }

  async countSaves(scope: OwnerScope): Promise<number> {
    return this.saves.filter((s) => sameOwner(s, scope)).length;
  }

  async insertScreen(input: {
    scope: OwnerScope;
    name: string;
    createdAt: Date;
  }) {
    const rec: ScreenRec = {
      id: randomUUID(),
      tenantId: input.scope.tenantId,
      ownerUserId: input.scope.ownerUserId,
      name: input.name,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      deletedAt: null,
    };
    this.screens.push(rec);
    return rec;
  }

  async insertScreenRows(
    rows: Array<{
      screenId: string;
      ordinal: number;
      query: string;
      parcelNodeId: string | null;
      resolution: ScreenResolution;
      source: ScreenSource;
      candidates: ScreenCandidate[] | null;
    }>,
  ) {
    const out: Array<{ id: string }> = [];
    for (const row of rows) {
      assertRowChecks(row);
      if (row.parcelNodeId) {
        const dup = this.rows.find(
          (r) => r.screenId === row.screenId && r.parcelNodeId === row.parcelNodeId,
        );
        // Same shape pg raises for pe_screen_rows_screen_node_uidx, so the
        // write path's 23505 catch can be driven without Neon.
        if (dup) {
          throw Object.assign(new Error("pe_screen_rows_screen_node_uidx"), {
            code: "23505",
          });
        }
      }
      const rec: RowRec = {
        id: randomUUID(),
        createdAt: new Date(),
        ...row,
      };
      this.rows.push(rec);
      out.push({ id: rec.id });
    }
    return out;
  }

  async getScreen(scope: OwnerScope, screenId: string) {
    const rec = this.screens.find((s) => s.id === screenId && sameOwner(s, scope));
    return rec ?? null;
  }

  async listScreens(scope: OwnerScope) {
    return this.screens
      .filter((s) => sameOwner(s, scope) && s.deletedAt == null)
      .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())
      .map((s) => ({
        id: s.id,
        name: s.name,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        rowCount: this.rows.filter((r) => r.screenId === s.id).length,
      }));
  }

  async listScreenRows(screenId: string) {
    return this.rows
      .filter((r) => r.screenId === screenId)
      .sort((a, b) => a.ordinal - b.ordinal);
  }

  async findScreenRowByNode(screenId: string, parcelNodeId: string) {
    return (
      this.rows.find(
        (r) => r.screenId === screenId && r.parcelNodeId === parcelNodeId,
      ) ?? null
    );
  }

  async maxOrdinal(screenId: string) {
    const ords = this.rows
      .filter((r) => r.screenId === screenId)
      .map((r) => r.ordinal);
    return ords.length === 0 ? null : Math.max(...ords);
  }

  async insertScreenRow(row: {
    screenId: string;
    ordinal: number;
    query: string;
    parcelNodeId: string | null;
    resolution: ScreenResolution;
    source: ScreenSource;
    candidates: null;
  }) {
    const [inserted] = await this.insertScreenRows([row]);
    return inserted!;
  }

  async touchScreen(screenId: string, updatedAt: Date) {
    const rec = this.screens.find((s) => s.id === screenId);
    if (rec) rec.updatedAt = updatedAt;
  }

  async findSave(scope: OwnerScope, parcelNodeId: string) {
    const rec = this.saves.find(
      (s) => sameOwner(s, scope) && s.parcelNodeId === parcelNodeId,
    );
    return rec ? toSaved(rec) : null;
  }

  async insertSave(input: {
    scope: OwnerScope;
    parcelNodeId: string;
    crmStatus: CrmStatus;
    note: string | null;
  }) {
    assertCrmStatus(input.crmStatus);
    const now = new Date();
    const rec: SaveRec = {
      id: randomUUID(),
      tenantId: input.scope.tenantId,
      ownerUserId: input.scope.ownerUserId,
      parcelNodeId: input.parcelNodeId,
      label: null,
      snapshot: {},
      crmStatus: input.crmStatus,
      note: input.note,
      createdAt: now,
      updatedAt: now,
    };
    this.saves.push(rec);
    return toSaved(rec);
  }

  async updateSaveColumns(input: {
    id: string;
    crmStatus?: CrmStatus;
    note?: string | null;
  }) {
    const rec = this.saves.find((s) => s.id === input.id);
    if (!rec) throw new Error("saved_property_not_found");
    if (input.crmStatus !== undefined) {
      assertCrmStatus(input.crmStatus);
      rec.crmStatus = input.crmStatus;
    }
    if (input.note !== undefined) rec.note = input.note;
    rec.updatedAt = new Date();
    return toSaved(rec);
  }

  async deleteSave(scope: OwnerScope, parcelNodeId: string) {
    const idx = this.saves.findIndex(
      (s) => sameOwner(s, scope) && s.parcelNodeId === parcelNodeId,
    );
    if (idx < 0) return false;
    this.saves.splice(idx, 1);
    return true;
  }

  async transaction<T>(fn: (store: ScreenSaveStore) => Promise<T>): Promise<T> {
    const snap = {
      screens: this.screens.map((s) => ({ ...s })),
      rows: this.rows.map((r) => ({ ...r })),
      saves: this.saves.map((s) => ({ ...s, snapshot: { ...s.snapshot } })),
    };
    try {
      return await fn(this);
    } catch (err) {
      this.screens = snap.screens;
      this.rows = snap.rows;
      this.saves = snap.saves;
      throw err;
    }
  }
}
