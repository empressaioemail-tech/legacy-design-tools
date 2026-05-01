/**
 * Client-side snapshot diff helpers (Task #54).
 *
 * Why a separate module from `lib/codes/src/promptFormatter.ts`?
 * `@workspace/codes` transitively depends on `@workspace/db` +
 * `drizzle-orm`, both of which are server-only and would balloon the
 * Vite bundle (and refuse to build) if imported into the React app.
 * The diff logic itself is pure data manipulation, so we duplicate the
 * small slice the compare page needs and let the prompt-side helper
 * stay the source of truth for the LLM prompt format.
 *
 * The two sides agree on the *semantics* of a diff (key fields per
 * entity, what counts as added/removed) but produce different output
 * shapes — the prompt side flattens to a text block, this side returns
 * a structured object the React component can render with rich UI.
 */

export interface EntityChange {
  /** Stable identity key (number / id / name — first non-empty wins). */
  key: string;
  /** Human-friendly label suitable for chip text (`<key> <name>` or just key). */
  label: string;
}

export interface EntityDiff {
  /** Display name of the bucket: "Rooms", "Sheets", "Levels", "Areas". */
  label: string;
  /** Total entries on the base snapshot (left side). */
  baseCount: number;
  /** Total entries on the head snapshot (right side). */
  headCount: number;
  /** Items present in head but missing from base. */
  added: EntityChange[];
  /** Items present in base but missing from head. */
  removed: EntityChange[];
}

export interface WallDiff {
  baseCount: number | null;
  headCount: number | null;
  /** `headCount - baseCount`; null when neither side has walls. */
  delta: number | null;
}

export interface SnapshotPayloadDiff {
  /** Per-bucket diffs, in stable display order. */
  entities: EntityDiff[];
  /** Walls collapse to a count delta — Revit walls have no stable user-facing id. */
  walls: WallDiff;
}

interface BucketSpec {
  payloadKey: string;
  label: string;
  keyFields: ReadonlyArray<string>;
  nameFields: ReadonlyArray<string>;
}

const BUCKET_SPECS: ReadonlyArray<BucketSpec> = [
  {
    payloadKey: "rooms",
    label: "Rooms",
    keyFields: ["number", "id", "uniqueId", "name"],
    nameFields: ["name"],
  },
  {
    payloadKey: "sheets",
    label: "Sheets",
    keyFields: ["sheetNumber", "number", "id", "uniqueId"],
    nameFields: ["sheetName", "name"],
  },
  {
    payloadKey: "levels",
    label: "Levels",
    keyFields: ["name", "id", "uniqueId"],
    nameFields: ["name"],
  },
  {
    payloadKey: "areas",
    label: "Areas",
    keyFields: ["number", "id", "uniqueId", "name"],
    nameFields: ["name"],
  },
];

function pickFirstStringy(
  item: unknown,
  fields: ReadonlyArray<string>,
): string | null {
  if (!item || typeof item !== "object") return null;
  const obj = item as Record<string, unknown>;
  for (const f of fields) {
    const v = obj[f];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  return null;
}

function entityLabel(
  item: unknown,
  keyFields: ReadonlyArray<string>,
  nameFields: ReadonlyArray<string>,
): { key: string; label: string } | null {
  const key = pickFirstStringy(item, keyFields);
  if (key === null) return null;
  const name = pickFirstStringy(item, nameFields);
  return {
    key,
    label: name && name !== key ? `${key} ${name}` : key,
  };
}

function getArrayField(payload: unknown, key: string): unknown[] | null {
  if (!payload || typeof payload !== "object") return null;
  const v = (payload as Record<string, unknown>)[key];
  return Array.isArray(v) ? v : null;
}

function countWalls(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const walls = (payload as Record<string, unknown>)["walls"];
  if (Array.isArray(walls)) return walls.length;
  if (walls && typeof walls === "object") {
    const wObj = walls as Record<string, unknown>;
    if (typeof wObj["count"] === "number") return wObj["count"] as number;
    if (Array.isArray(wObj["items"])) return (wObj["items"] as unknown[]).length;
  }
  return null;
}

/**
 * Compute the per-bucket added/removed diff between two snapshot payloads.
 *
 * Diff semantics mirror `lib/codes/src/promptFormatter.ts`:
 *   - identity is the first non-empty key field (rooms: `number` → `id`
 *     → `name`; sheets: `sheetNumber` → `number` → `id`; etc.).
 *   - items with no usable identity field are skipped (counted in
 *     baseCount/headCount but not in added/removed lists).
 *   - walls collapse to a count-only delta because Revit walls don't
 *     expose a stable user-visible id.
 *
 * Buckets are only included when at least one side carries the array.
 */
export function diffSnapshotPayloads(
  base: unknown,
  head: unknown,
): SnapshotPayloadDiff {
  const entities: EntityDiff[] = [];

  for (const spec of BUCKET_SPECS) {
    const baseArr = getArrayField(base, spec.payloadKey);
    const headArr = getArrayField(head, spec.payloadKey);
    if (baseArr === null && headArr === null) continue;
    const a = baseArr ?? [];
    const b = headArr ?? [];

    const aMap = new Map<string, EntityChange>();
    for (const item of a) {
      const lbl = entityLabel(item, spec.keyFields, spec.nameFields);
      if (lbl) aMap.set(lbl.key, lbl);
    }
    const bMap = new Map<string, EntityChange>();
    for (const item of b) {
      const lbl = entityLabel(item, spec.keyFields, spec.nameFields);
      if (lbl) bMap.set(lbl.key, lbl);
    }

    const added: EntityChange[] = [];
    const removed: EntityChange[] = [];
    for (const [key, change] of bMap) if (!aMap.has(key)) added.push(change);
    for (const [key, change] of aMap) if (!bMap.has(key)) removed.push(change);

    entities.push({
      label: spec.label,
      baseCount: a.length,
      headCount: b.length,
      added,
      removed,
    });
  }

  const baseWalls = countWalls(base);
  const headWalls = countWalls(head);
  const walls: WallDiff = {
    baseCount: baseWalls,
    headCount: headWalls,
    delta:
      baseWalls === null && headWalls === null
        ? null
        : (headWalls ?? 0) - (baseWalls ?? 0),
  };

  return { entities, walls };
}
