/**
 * P-91 / P-92 Wave B write path. A screen is an intake record. A save is a
 * CRM record. One write path cannot serve both.
 *
 * create_screen writes pe_screens + pe_screen_rows only.
 * save_property / set_property_status write pe_saved_properties columns only
 * and never touch snapshot or screen tables.
 */

import { isPunctuationOnlySitus } from "./situsCompose";

export const SCREEN_RESOLUTIONS = [
  "resolved",
  "ambiguous",
  "unresolved",
] as const;
export type ScreenResolution = (typeof SCREEN_RESOLUTIONS)[number];

export const SCREEN_SOURCES = [
  "pasted",
  "chrome",
  "gmail",
  "file",
  "walk",
  "saved",
] as const;
export type ScreenSource = (typeof SCREEN_SOURCES)[number];

export const CRM_STATUSES = ["New", "Watching", "Chasing", "Passed"] as const;
export type CrmStatus = (typeof CRM_STATUSES)[number];

export const CREATE_SCREEN_QUERY_CAP = 50;
export const NOTE_MAX_CHARS = 4000;
export const PARCEL_NODE_ID_MAX = 128;
/** Named parallelism for create_screen resolver fan-out. */
export const CREATE_SCREEN_RESOLVE_CONCURRENCY = 8;
/** Per-query timeout. A hang writes unresolved; it must not drop the row. */
export const CREATE_SCREEN_RESOLVE_TIMEOUT_MS = 8_000;
export const CREATE_SCREEN_V1_SOURCES = ["pasted"] as const;
export const ADD_TO_SCREEN_V1_SOURCES = ["walk", "saved", "pasted"] as const;
export const V2_INTAKE_SOURCES = ["chrome", "gmail", "file"] as const;

const LISTING_KEYS = [
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
] as const;

export type ScreenCandidate = { parcelNodeId: string; label: string };

export type ScreenRow = {
  id: string;
  ordinal: number;
  parcelNodeId: string | null;
  query: string;
  resolution: ScreenResolution;
  source: ScreenSource;
  candidates?: ScreenCandidate[];
};

export type Screen = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  rows: ScreenRow[];
};

export type ScreenSummary = {
  id: string;
  name: string;
  rowCount: number;
  createdAt: string;
  updatedAt: string;
};

export type SavedCrmRow = {
  id: string;
  parcelNodeId: string;
  crmStatus: CrmStatus | null;
  note: string | null;
  snapshot: Record<string, unknown>;
  label: string | null;
  updatedAt: string;
};

export type OwnerScope = { tenantId: string; ownerUserId: string };

export type ScreenSaveError = {
  error: string;
  cap?: number;
};

export type ResolveHit = { parcelNodeId: string; label: string };

export type QueryResolver = (query: string) => Promise<ResolveHit[]>;

export type ScreenSaveStore = {
  countSaves(scope: OwnerScope): Promise<number>;
  insertScreen(input: {
    scope: OwnerScope;
    name: string;
    createdAt: Date;
  }): Promise<{ id: string; name: string; createdAt: Date; updatedAt: Date }>;
  insertScreenRows(
    rows: Array<{
      screenId: string;
      ordinal: number;
      query: string;
      parcelNodeId: string | null;
      resolution: ScreenResolution;
      source: ScreenSource;
      candidates: ScreenCandidate[] | null;
    }>,
  ): Promise<Array<{ id: string }>>;
  getScreen(
    scope: OwnerScope,
    screenId: string,
  ): Promise<{
    id: string;
    name: string;
    createdAt: Date;
    updatedAt: Date;
    deletedAt: Date | null;
  } | null>;
  listScreens(scope: OwnerScope): Promise<
    Array<{
      id: string;
      name: string;
      createdAt: Date;
      updatedAt: Date;
      rowCount: number;
    }>
  >;
  listScreenRows(screenId: string): Promise<
    Array<{
      id: string;
      ordinal: number;
      query: string;
      parcelNodeId: string | null;
      resolution: ScreenResolution;
      source: ScreenSource;
      candidates: ScreenCandidate[] | null;
    }>
  >;
  findScreenRowByNode(
    screenId: string,
    parcelNodeId: string,
  ): Promise<{
    id: string;
    ordinal: number;
    query: string;
    parcelNodeId: string | null;
    resolution: ScreenResolution;
    source: ScreenSource;
    candidates: ScreenCandidate[] | null;
  } | null>;
  maxOrdinal(screenId: string): Promise<number | null>;
  insertScreenRow(row: {
    screenId: string;
    ordinal: number;
    query: string;
    parcelNodeId: string;
    resolution: "resolved";
    source: ScreenSource;
    candidates: null;
  }): Promise<{ id: string }>;
  touchScreen(screenId: string, updatedAt: Date): Promise<void>;
  findSave(
    scope: OwnerScope,
    parcelNodeId: string,
  ): Promise<SavedCrmRow | null>;
  insertSave(input: {
    scope: OwnerScope;
    parcelNodeId: string;
    crmStatus: CrmStatus;
    note: string | null;
  }): Promise<SavedCrmRow>;
  updateSaveColumns(input: {
    id: string;
    crmStatus?: CrmStatus;
    note?: string | null;
  }): Promise<SavedCrmRow>;
  deleteSave(scope: OwnerScope, parcelNodeId: string): Promise<boolean>;
  transaction<T>(fn: (store: ScreenSaveStore) => Promise<T>): Promise<T>;
};

export function isScreenSource(value: unknown): value is ScreenSource {
  return (
    typeof value === "string" &&
    (SCREEN_SOURCES as readonly string[]).includes(value)
  );
}

export function isCrmStatus(value: unknown): value is CrmStatus {
  return (
    typeof value === "string" &&
    (CRM_STATUSES as readonly string[]).includes(value)
  );
}

export function refuseSource(
  source: unknown,
  allowed: readonly string[],
): ScreenSaveError | null {
  if (!isScreenSource(source)) {
    return { error: "unknown_source" };
  }
  if ((V2_INTAKE_SOURCES as readonly string[]).includes(source)) {
    return { error: "intake_not_implemented" };
  }
  if (!allowed.includes(source)) {
    return { error: "unknown_source" };
  }
  return null;
}

export function autoScreenName(createdAt: Date): string {
  const ymd = createdAt.toISOString().slice(0, 10);
  return `Screen ${ymd}`;
}

export function resolveScreenName(
  name: string | undefined,
  createdAt: Date,
): string {
  if (name == null || isPunctuationOnlySitus(name)) {
    return autoScreenName(createdAt);
  }
  const trimmed = name.trim();
  if (trimmed === "" || isPunctuationOnlySitus(trimmed)) {
    return autoScreenName(createdAt);
  }
  return trimmed;
}

export function validateCandidates(
  candidates: unknown,
): ScreenCandidate[] | ScreenSaveError {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return { error: "invalid_candidates" };
  }
  const out: ScreenCandidate[] = [];
  for (const item of candidates) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { error: "invalid_candidates" };
    }
    const rec = item as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (keys.some((k) => k !== "parcelNodeId" && k !== "label")) {
      return { error: "invalid_candidates" };
    }
    if (
      typeof rec.parcelNodeId !== "string" ||
      rec.parcelNodeId.trim() === "" ||
      typeof rec.label !== "string"
    ) {
      return { error: "invalid_candidates" };
    }
    if (LISTING_KEYS.some((k) => k in rec)) {
      return { error: "invalid_candidates" };
    }
    out.push({ parcelNodeId: rec.parcelNodeId, label: rec.label });
  }
  return out;
}

function toIso(d: Date): string {
  return d.toISOString();
}

function wireRow(row: {
  id: string;
  ordinal: number;
  query: string;
  parcelNodeId: string | null;
  resolution: ScreenResolution;
  source: ScreenSource;
  candidates: ScreenCandidate[] | null;
}): ScreenRow {
  const wired: ScreenRow = {
    id: row.id,
    ordinal: row.ordinal,
    parcelNodeId: row.parcelNodeId,
    query: row.query,
    resolution: row.resolution,
    source: row.source,
  };
  if (row.resolution === "ambiguous" && row.candidates) {
    wired.candidates = row.candidates;
  }
  return wired;
}

async function mapPool<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (next < items.length) {
        const i = next;
        next += 1;
        results[i] = await fn(items[i]!, i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race([
      work.then((value) => ({ ok: true as const, value })),
      new Promise<{ ok: false }>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false }), ms);
      }),
    ]);
    return raced;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function resolveQueryRow(
  query: string,
  source: ScreenSource,
  ordinal: number,
  resolver: QueryResolver,
): Promise<{
  ordinal: number;
  query: string;
  parcelNodeId: string | null;
  resolution: ScreenResolution;
  source: ScreenSource;
  candidates: ScreenCandidate[] | null;
}> {
  if (isPunctuationOnlySitus(query)) {
    return {
      ordinal,
      query,
      parcelNodeId: null,
      resolution: "unresolved",
      source,
      candidates: null,
    };
  }
  const trimmed = query.trim();
  const timed = await withTimeout(resolver(trimmed), CREATE_SCREEN_RESOLVE_TIMEOUT_MS);
  if (!timed.ok) {
    return {
      ordinal,
      query,
      parcelNodeId: null,
      resolution: "unresolved",
      source,
      candidates: null,
    };
  }
  const hits = timed.value.filter(
    (h) => typeof h.parcelNodeId === "string" && h.parcelNodeId.trim() !== "",
  );
  if (hits.length === 0) {
    return {
      ordinal,
      query,
      parcelNodeId: null,
      resolution: "unresolved",
      source,
      candidates: null,
    };
  }
  if (hits.length === 1) {
    return {
      ordinal,
      query,
      parcelNodeId: hits[0]!.parcelNodeId,
      resolution: "resolved",
      source,
      candidates: null,
    };
  }
  const candidates = hits.map((h) => ({
    parcelNodeId: h.parcelNodeId,
    label: h.label,
  }));
  const checked = validateCandidates(candidates);
  if ("error" in checked) {
    return {
      ordinal,
      query,
      parcelNodeId: null,
      resolution: "unresolved",
      source,
      candidates: null,
    };
  }
  return {
    ordinal,
    query,
    parcelNodeId: null,
    resolution: "ambiguous",
    source,
    candidates: checked,
  };
}

export async function createScreen(
  store: ScreenSaveStore,
  scope: OwnerScope,
  input: { name?: string; queries: string[]; source: unknown },
  resolver: QueryResolver,
): Promise<{ ok: true; screen: Screen } | { ok: false; error: ScreenSaveError }> {
  const sourceErr = refuseSource(input.source, CREATE_SCREEN_V1_SOURCES);
  if (sourceErr) return { ok: false, error: sourceErr };
  const source = input.source as ScreenSource;
  if (!Array.isArray(input.queries)) {
    return { ok: false, error: { error: "invalid_input" } };
  }
  if (input.queries.length > CREATE_SCREEN_QUERY_CAP) {
    return {
      ok: false,
      error: { error: "query_batch_cap", cap: CREATE_SCREEN_QUERY_CAP },
    };
  }
  for (const q of input.queries) {
    if (typeof q !== "string") {
      return { ok: false, error: { error: "invalid_input" } };
    }
    if (q.trim().length === 0) {
      return { ok: false, error: { error: "query_empty" } };
    }
  }

  const createdAt = new Date();
  const name = resolveScreenName(input.name, createdAt);
  const planned = await mapPool(
    input.queries,
    CREATE_SCREEN_RESOLVE_CONCURRENCY,
    (query, ordinal) => resolveQueryRow(query, source, ordinal, resolver),
  );

  try {
    const screen = await store.transaction(async (tx) => {
      const savesBefore = await tx.countSaves(scope);
      const created = await tx.insertScreen({ scope, name, createdAt });
      if (planned.length > 0) {
        await tx.insertScreenRows(
          planned.map((row) => ({
            screenId: created.id,
            ...row,
          })),
        );
      }
      const savesAfter = await tx.countSaves(scope);
      if (savesAfter !== savesBefore) {
        throw new Error("create_screen_wrote_saves");
      }
      return created;
    });
    const storedRows = await store.listScreenRows(screen.id);
    return {
      ok: true,
      screen: {
        id: screen.id,
        name: screen.name,
        createdAt: toIso(screen.createdAt),
        updatedAt: toIso(screen.updatedAt),
        rows: storedRows.map(wireRow),
      },
    };
  } catch (err) {
    if (err instanceof Error && err.message === "create_screen_wrote_saves") {
      throw err;
    }
    throw err;
  }
}

export async function addToScreen(
  store: ScreenSaveStore,
  scope: OwnerScope,
  input: { screenId: string; parcelNodeId: string; source: unknown },
): Promise<
  | { ok: true; screenId: string; row: ScreenRow }
  | { ok: false; error: ScreenSaveError }
> {
  const sourceErr = refuseSource(input.source, ADD_TO_SCREEN_V1_SOURCES);
  if (sourceErr) return { ok: false, error: sourceErr };
  const source = input.source as ScreenSource;
  const parcelNodeId = input.parcelNodeId?.trim() ?? "";
  if (!parcelNodeId || parcelNodeId.length > PARCEL_NODE_ID_MAX) {
    return { ok: false, error: { error: "invalid_parcel_node_id" } };
  }
  const screen = await store.getScreen(scope, input.screenId);
  if (!screen || screen.deletedAt) {
    return { ok: false, error: { error: "not_found" } };
  }
  const existing = await store.findScreenRowByNode(screen.id, parcelNodeId);
  if (existing) {
    return {
      ok: true,
      screenId: screen.id,
      row: wireRow(existing),
    };
  }
  const max = await store.maxOrdinal(screen.id);
  const ordinal = max == null ? 0 : max + 1;
  const inserted = await store.insertScreenRow({
    screenId: screen.id,
    ordinal,
    query: parcelNodeId,
    parcelNodeId,
    resolution: "resolved",
    source,
    candidates: null,
  });
  await store.touchScreen(screen.id, new Date());
  return {
    ok: true,
    screenId: screen.id,
    row: {
      id: inserted.id,
      ordinal,
      parcelNodeId,
      query: parcelNodeId,
      resolution: "resolved",
      source,
    },
  };
}

export async function listScreens(
  store: ScreenSaveStore,
  scope: OwnerScope,
  screenId?: string,
): Promise<
  | { ok: true; screens: ScreenSummary[] }
  | { ok: true; screen: Screen }
  | { ok: false; error: ScreenSaveError }
> {
  if (screenId != null && screenId !== "") {
    const screen = await store.getScreen(scope, screenId);
    if (!screen || screen.deletedAt) {
      return { ok: false, error: { error: "not_found" } };
    }
    const rows = await store.listScreenRows(screen.id);
    return {
      ok: true,
      screen: {
        id: screen.id,
        name: screen.name,
        createdAt: toIso(screen.createdAt),
        updatedAt: toIso(screen.updatedAt),
        rows: rows.map(wireRow),
      },
    };
  }
  const screens = await store.listScreens(scope);
  return {
    ok: true,
    screens: screens.map((s) => ({
      id: s.id,
      name: s.name,
      rowCount: s.rowCount,
      createdAt: toIso(s.createdAt),
      updatedAt: toIso(s.updatedAt),
    })),
  };
}

export async function saveProperty(
  store: ScreenSaveStore,
  scope: OwnerScope,
  input: { parcelNodeId: string; status?: unknown; note?: unknown },
): Promise<
  | { ok: true; parcelNodeId: string; status: CrmStatus; note: string | null }
  | { ok: false; error: ScreenSaveError }
> {
  const parcelNodeId = input.parcelNodeId?.trim() ?? "";
  if (!parcelNodeId || parcelNodeId.length > PARCEL_NODE_ID_MAX) {
    return { ok: false, error: { error: "invalid_parcel_node_id" } };
  }
  if (input.status !== undefined && !isCrmStatus(input.status)) {
    return { ok: false, error: { error: "unknown_status" } };
  }
  if (input.note !== undefined) {
    if (typeof input.note !== "string") {
      return { ok: false, error: { error: "invalid_input" } };
    }
    if (input.note.length > NOTE_MAX_CHARS) {
      return { ok: false, error: { error: "note_too_long" } };
    }
  }

  const existing = await store.findSave(scope, parcelNodeId);
  if (!existing) {
    const crmStatus = input.status === undefined ? "New" : input.status;
    const note = input.note === undefined ? null : input.note;
    const row = await store.insertSave({
      scope,
      parcelNodeId,
      crmStatus,
      note,
    });
    return {
      ok: true,
      parcelNodeId: row.parcelNodeId,
      status: row.crmStatus ?? crmStatus,
      note: row.note,
    };
  }

  const patch: { id: string; crmStatus?: CrmStatus; note?: string | null } = {
    id: existing.id,
  };
  if (input.status !== undefined) patch.crmStatus = input.status;
  if (input.note !== undefined) patch.note = input.note;
  const row =
    patch.crmStatus !== undefined || patch.note !== undefined
      ? await store.updateSaveColumns(patch)
      : existing;
  return {
    ok: true,
    parcelNodeId: row.parcelNodeId,
    status: row.crmStatus ?? existing.crmStatus ?? "New",
    note: row.note,
  };
}

export async function setPropertyStatus(
  store: ScreenSaveStore,
  scope: OwnerScope,
  input: { parcelNodeId: string; status: unknown },
): Promise<
  | { ok: true; parcelNodeId: string; status: CrmStatus }
  | { ok: false; error: ScreenSaveError }
> {
  const parcelNodeId = input.parcelNodeId?.trim() ?? "";
  if (!parcelNodeId || parcelNodeId.length > PARCEL_NODE_ID_MAX) {
    return { ok: false, error: { error: "invalid_parcel_node_id" } };
  }
  if (!isCrmStatus(input.status)) {
    return { ok: false, error: { error: "unknown_status" } };
  }
  const existing = await store.findSave(scope, parcelNodeId);
  if (!existing) {
    return { ok: false, error: { error: "saved_property_not_found" } };
  }
  const row = await store.updateSaveColumns({
    id: existing.id,
    crmStatus: input.status,
  });
  return {
    ok: true,
    parcelNodeId: row.parcelNodeId,
    status: row.crmStatus ?? input.status,
  };
}

export async function deleteSavedProperty(
  store: ScreenSaveStore,
  scope: OwnerScope,
  parcelNodeId: string,
): Promise<{ ok: true } | { ok: false; error: ScreenSaveError }> {
  const trimmed = parcelNodeId.trim();
  if (!trimmed) return { ok: false, error: { error: "invalid_parcel_node_id" } };
  const deleted = await store.deleteSave(scope, trimmed);
  if (!deleted) return { ok: false, error: { error: "saved_property_not_found" } };
  return { ok: true };
}

export function snapshotScreenMembership(screen: Screen): {
  rowCount: number;
  ordinals: number[];
  queries: string[];
} {
  return {
    rowCount: screen.rows.length,
    ordinals: screen.rows.map((r) => r.ordinal),
    queries: screen.rows.map((r) => r.query),
  };
}
