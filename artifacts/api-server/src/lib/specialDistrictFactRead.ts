/**
 * Inspect-card special-district READ from special-district-fact atoms.
 *
 * Writer seam `special-district-fact-writer.ts` stores
 * entity_id = `${parcelNodeId}:sd:${districtId}` (present) or
 * `${parcelNodeId}:sd:outside` (scoped absence). Q8b strips `:sd:{districtId}`
 * to reach a parcel. Dual grammar applies to the parcel PREFIX only.
 * Flood's `entity_id = ANY(parcel keys)` WILL MISS.
 *
 * mud is a `districtType` on this family (A-002), not a second atom. This
 * module never invents a type or a name and never emits a fake mud atom.
 *
 * Never SELECT bake / place_layer_snapshots / CAD / mud-pid for this field.
 *
 * TWO STORES. Atoms live in hauska_mcp (ATOMS_DATABASE_URL). The inspect
 * route's drizzle `db` is the deployment store. DATABASE_URL in api-server
 * means deployment, not atoms — this module does not read that name.
 */

import pg from "pg";

const PADDED_SUFFIX = ".00000000";
const SD_INFIX = ":sd:";
export const SPECIAL_DISTRICT_FACT_ENTITY_TYPE = "special-district-fact" as const;
export const SPECIAL_DISTRICT_FACT_SOURCE = "special-district-fact" as const;
const OUTSIDE_DISTRICT_ID = "outside";
const MUD_DISTRICT_TYPE = "MUD";

export interface AtomQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export type SpecialDistrictFactBindPrefixes = readonly [string, string];

/**
 * Both parcel-prefix grammars, always, in stable order: integer then padded.
 * Inbound `{fips}:{prop}.00000000` inverts to the integer prefix; inbound
 * integer appends the suffix. Never returns one prefix. Never appends :sd:.
 */
export function specialDistrictFactBindPrefixes(
  parcelNodeId: string,
): SpecialDistrictFactBindPrefixes {
  if (parcelNodeId.endsWith(PADDED_SUFFIX)) {
    const integerForm = parcelNodeId.slice(0, -PADDED_SUFFIX.length);
    return [integerForm, parcelNodeId];
  }
  return [parcelNodeId, `${parcelNodeId}${PADDED_SUFFIX}`];
}

export type SpecialDistrictFactPresent = {
  state: "present";
  source: typeof SPECIAL_DISTRICT_FACT_SOURCE;
  boundAs: string;
  tried: SpecialDistrictFactBindPrefixes;
  entityId: string;
  districtId: string;
  districtType: string | null;
  districtName: string | null;
  evaluatedAt: string | null;
};

export type SpecialDistrictFactTypedAbsence = {
  state: "absent";
  source: typeof SPECIAL_DISTRICT_FACT_SOURCE;
  boundAs: string;
  tried: SpecialDistrictFactBindPrefixes;
  entityId: string;
  absence: { kind: string; reason: string } | null;
  verifiedAbsence: unknown;
  sourceTier: string | null;
  sourceAdapter: string | null;
};

export type SpecialDistrictFactRefusal = {
  state: "refused";
  code:
    | "atom-miss"
    | "bind-conflict"
    | "atoms-store-not-configured"
    | "malformed-atom";
  source: typeof SPECIAL_DISTRICT_FACT_SOURCE;
  tried: SpecialDistrictFactBindPrefixes | [];
  reason: string;
};

export type SpecialDistrictFactRead =
  | SpecialDistrictFactPresent
  | SpecialDistrictFactTypedAbsence
  | SpecialDistrictFactRefusal;

type AtomRow = { entity_id: string; body: unknown };

/**
 * Prefix + :sd: suffix. $2 / $3 are LIKE patterns `{escapedPrefix}:sd:%`.
 * `_` is legal in parcelNodeId and is a LIKE any-char wildcard unless escaped.
 * Flood's parcel-key ANY-array lookup is deliberately not this query.
 */
const SELECT_SPECIAL_DISTRICT_FACT = `
SELECT entity_id, body
  FROM atoms
 WHERE entity_type = $1
   AND (
     entity_id LIKE $2 ESCAPE '\\'
     OR entity_id LIKE $3 ESCAPE '\\'
   )
`;

function escapeLike(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
}

/** LIKE pattern for one parcel prefix plus `:sd:%`. Escapes `\`, `%`, and `_`. */
export function specialDistrictFactLikePrefixPattern(prefix: string): string {
  return `${escapeLike(prefix)}${SD_INFIX}%`;
}

function prefixFromLikePattern(pattern: string): string | null {
  const suffix = `${SD_INFIX}%`;
  if (!pattern.endsWith(suffix)) return null;
  return pattern.slice(0, -suffix.length).replace(/\\([\\%_])/g, "$1");
}

let injectedQueryable: AtomQueryable | null | undefined;
let sharedPool: pg.Pool | null = null;

/** Test seam. `null` means store not configured. `undefined` (reset) means env. */
export function setSpecialDistrictFactAtomQueryableForTests(
  queryable: AtomQueryable | null,
): void {
  injectedQueryable = queryable;
}

export function resetSpecialDistrictFactAtomQueryableForTests(): void {
  injectedQueryable = undefined;
}

function atomsQueryableFromEnv(): AtomQueryable | null {
  const url = process.env.ATOMS_DATABASE_URL?.trim();
  if (!url) return null;
  if (!sharedPool) {
    sharedPool = new pg.Pool({
      connectionString: url,
      ssl: url.includes("sslmode=") ? undefined : { rejectUnauthorized: false },
      max: 2,
    });
  }
  return sharedPool;
}

function resolveQueryable(): AtomQueryable | null {
  if (injectedQueryable !== undefined) return injectedQueryable;
  return atomsQueryableFromEnv();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * entity_id is `${prefix}:sd:${districtId}`. Integer prefix is a string
 * prefix of the padded prefix, so the match requires `:sd:` immediately
 * after the chosen prefix (`48021:34137.00000000:sd:X` does not match
 * `48021:34137:sd:`).
 */
export function districtSuffixFromSpecialDistrictEntityId(
  entityId: string,
  prefixes: SpecialDistrictFactBindPrefixes,
): { prefix: string; districtId: string } | null {
  for (const prefix of prefixes) {
    const needle = `${prefix}${SD_INFIX}`;
    if (!entityId.startsWith(needle)) continue;
    const rest = entityId.slice(needle.length);
    if (!rest) continue;
    if (rest.includes(":")) continue;
    return { prefix, districtId: rest };
  }
  return null;
}

function claimFingerprint(body: Record<string, unknown>): string {
  const absence = asRecord(body.absence);
  return JSON.stringify({
    sourceTier: body.sourceTier ?? null,
    districtId: body.districtId ?? null,
    districtType: body.districtType ?? null,
    districtName: body.districtName ?? null,
    absenceKind: absence?.kind ?? null,
    absenceReason: absence?.reason ?? null,
  });
}

function bodyLooksAbsent(rec: Record<string, unknown>): boolean {
  return (
    Boolean(asRecord(rec.absence)) ||
    rec.sourceTier === "absent" ||
    rec.verifiedAbsence != null
  );
}

function interpretBody(
  entityId: string,
  body: unknown,
  tried: SpecialDistrictFactBindPrefixes,
  districtIdFromId: string,
):
  | SpecialDistrictFactPresent
  | SpecialDistrictFactTypedAbsence
  | SpecialDistrictFactRefusal {
  const rec = asRecord(body);
  if (!rec) {
    return {
      state: "refused",
      code: "malformed-atom",
      source: SPECIAL_DISTRICT_FACT_SOURCE,
      tried,
      reason: `special-district-fact entity_id ${entityId} has a non-object body. Refusing rather than inventing a district.`,
    };
  }
  if (
    rec.entityType != null &&
    rec.entityType !== SPECIAL_DISTRICT_FACT_ENTITY_TYPE
  ) {
    return {
      state: "refused",
      code: "malformed-atom",
      source: SPECIAL_DISTRICT_FACT_SOURCE,
      tried,
      reason: `special-district-fact entity_id ${entityId} body.entityType is ${String(rec.entityType)}, not special-district-fact.`,
    };
  }

  const isOutside = districtIdFromId === OUTSIDE_DISTRICT_ID;
  if (isOutside || bodyLooksAbsent(rec)) {
    const absence = asRecord(rec.absence);
    const kind = asNullableString(absence?.kind);
    const reason = asNullableString(absence?.reason);
    return {
      state: "absent",
      source: SPECIAL_DISTRICT_FACT_SOURCE,
      boundAs: entityId,
      tried,
      entityId,
      absence: kind && reason ? { kind, reason } : null,
      verifiedAbsence: rec.verifiedAbsence ?? null,
      sourceTier: asNullableString(rec.sourceTier),
      sourceAdapter: asNullableString(rec.sourceAdapter),
    };
  }

  const districtId = asNullableString(rec.districtId);
  if (!districtId) {
    return {
      state: "refused",
      code: "malformed-atom",
      source: SPECIAL_DISTRICT_FACT_SOURCE,
      tried,
      reason: `special-district-fact entity_id ${entityId} is neither a present districtId finding nor a typed absence.`,
    };
  }
  if (districtId !== districtIdFromId) {
    return {
      state: "refused",
      code: "malformed-atom",
      source: SPECIAL_DISTRICT_FACT_SOURCE,
      tried,
      reason: `special-district-fact entity_id ${entityId} body.districtId ${districtId} disagrees with entity_id suffix ${districtIdFromId}.`,
    };
  }

  return {
    state: "present",
    source: SPECIAL_DISTRICT_FACT_SOURCE,
    boundAs: entityId,
    tried,
    entityId,
    districtId,
    districtType: asNullableString(rec.districtType),
    districtName: asNullableString(rec.districtName),
    evaluatedAt: asNullableString(rec.evaluatedAt),
  };
}

function conflictAmong(
  rows: AtomRow[],
  tried: SpecialDistrictFactBindPrefixes,
  label: string,
): SpecialDistrictFactRefusal | null {
  if (rows.length < 2) return null;
  const fingerprints = new Set(
    rows.map((h) => {
      const rec = asRecord(h.body);
      return rec ? claimFingerprint(rec) : `non-object:${h.entity_id}`;
    }),
  );
  if (fingerprints.size <= 1) return null;
  return {
    state: "refused",
    code: "bind-conflict",
    source: SPECIAL_DISTRICT_FACT_SOURCE,
    tried,
    reason: `special-district-fact atoms at ${label} disagree. Refusing rather than picking a district.`,
  };
}

function pickPreferredPresent(
  hits: Array<{ row: AtomRow; prefix: string; districtId: string }>,
  tried: SpecialDistrictFactBindPrefixes,
): AtomRow {
  const mudHits = hits.filter((h) => {
    const rec = asRecord(h.row.body);
    return rec?.districtType === MUD_DISTRICT_TYPE;
  });
  const pool = mudHits.length > 0 ? mudHits : hits;
  const integerHits = pool.filter((h) => h.prefix === tried[0]);
  const ranked = (integerHits.length > 0 ? integerHits : pool).slice();
  ranked.sort((a, b) => a.row.entity_id.localeCompare(b.row.entity_id));
  return ranked[0].row;
}

/**
 * Interpret already-fetched atom rows. Pure. Tests drive this with fixtures
 * so a miss, a padded-prefix-only hit, an outside gold, and a conflict are
 * observed without a store.
 */
export function interpretSpecialDistrictFactRows(
  parcelNodeId: string,
  rows: ReadonlyArray<AtomRow>,
): SpecialDistrictFactRead {
  const tried = specialDistrictFactBindPrefixes(parcelNodeId);
  const parsedHits = rows
    .map((r) => {
      const parsed = districtSuffixFromSpecialDistrictEntityId(r.entity_id, tried);
      return parsed ? { row: r, ...parsed } : null;
    })
    .filter(
      (h): h is { row: AtomRow; prefix: string; districtId: string } =>
        Boolean(h),
    );
  if (parsedHits.length === 0) {
    return {
      state: "refused",
      code: "atom-miss",
      source: SPECIAL_DISTRICT_FACT_SOURCE,
      tried,
      reason: `No special-district-fact atom for ${tried[0]}:sd: or ${tried[1]}:sd:. Atom miss, not a district determination.`,
    };
  }

  const presentHits = parsedHits.filter((h) => {
    if (h.districtId === OUTSIDE_DISTRICT_ID) return false;
    const rec = asRecord(h.row.body);
    if (!rec) return true;
    return !bodyLooksAbsent(rec);
  });
  const absentHits = parsedHits.filter((h) => !presentHits.includes(h));

  if (presentHits.length > 0) {
    const chosen = pickPreferredPresent(presentHits, tried);
    const chosenParsed = districtSuffixFromSpecialDistrictEntityId(
      chosen.entity_id,
      tried,
    );
    if (!chosenParsed) {
      return {
        state: "refused",
        code: "atom-miss",
        source: SPECIAL_DISTRICT_FACT_SOURCE,
        tried,
        reason: `No special-district-fact atom for ${tried[0]}:sd: or ${tried[1]}:sd:. Atom miss, not a district determination.`,
      };
    }
    const sameDistrict = presentHits.filter(
      (h) => h.districtId === chosenParsed.districtId,
    );
    const conflict = conflictAmong(
      sameDistrict.map((h) => h.row),
      tried,
      `${tried[0]}${SD_INFIX}${chosenParsed.districtId} and ${tried[1]}${SD_INFIX}${chosenParsed.districtId}`,
    );
    if (conflict) return conflict;
    return interpretBody(
      chosen.entity_id,
      chosen.body,
      tried,
      chosenParsed.districtId,
    );
  }

  const integerOutside = `${tried[0]}${SD_INFIX}${OUTSIDE_DISTRICT_ID}`;
  const paddedOutside = `${tried[1]}${SD_INFIX}${OUTSIDE_DISTRICT_ID}`;
  const conflict = conflictAmong(
    absentHits.map((h) => h.row),
    tried,
    `${integerOutside} and ${paddedOutside}`,
  );
  if (conflict) return conflict;
  const chosen =
    absentHits.find((h) => h.row.entity_id === integerOutside)?.row ??
    absentHits.find((h) => h.row.entity_id === paddedOutside)?.row ??
    absentHits[0].row;
  const chosenParsed = districtSuffixFromSpecialDistrictEntityId(
    chosen.entity_id,
    tried,
  );
  return interpretBody(
    chosen.entity_id,
    chosen.body,
    tried,
    chosenParsed?.districtId ?? OUTSIDE_DISTRICT_ID,
  );
}

export async function loadSpecialDistrictFactAtom(
  parcelNodeId: string,
): Promise<SpecialDistrictFactRead> {
  const tried = specialDistrictFactBindPrefixes(parcelNodeId);
  const atoms = resolveQueryable();
  if (!atoms) {
    return {
      state: "refused",
      code: "atoms-store-not-configured",
      source: SPECIAL_DISTRICT_FACT_SOURCE,
      tried,
      reason:
        "special-district-fact lives in the ATOMS store (ATOMS_DATABASE_URL). That store is not configured. Refusing rather than reading place_layer_snapshots or emitting a silent null.",
    };
  }
  const result = await atoms.query<AtomRow>(SELECT_SPECIAL_DISTRICT_FACT, [
    SPECIAL_DISTRICT_FACT_ENTITY_TYPE,
    specialDistrictFactLikePrefixPattern(tried[0]),
    specialDistrictFactLikePrefixPattern(tried[1]),
  ]);
  return interpretSpecialDistrictFactRows(parcelNodeId, result.rows);
}

/** In-memory atoms table for tests. Refuses any query that is not this SELECT. */
export function memorySpecialDistrictFactAtoms(
  rows: ReadonlyArray<{ entityId: string; body: Record<string, unknown> }>,
): AtomQueryable {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }> {
      if (text.includes("cad_property")) {
        throw new Error(
          "memorySpecialDistrictFactAtoms: cad_property is not a special-district-fact source",
        );
      }
      if (text.includes("place_layer_snapshots")) {
        throw new Error(
          "memorySpecialDistrictFactAtoms: place_layer_snapshots is not a special-district-fact source",
        );
      }
      if (text.includes("mud-pid")) {
        throw new Error(
          "memorySpecialDistrictFactAtoms: mud-pid is not a special-district-fact source",
        );
      }
      if (text.includes("entity_id = ANY")) {
        throw new Error(
          "memorySpecialDistrictFactAtoms: flood-style entity_id = ANY(parcel keys) misses ${parcel}:sd:{districtId}",
        );
      }
      if (
        !text.includes("FROM atoms") ||
        !text.includes("entity_type") ||
        !text.includes("LIKE")
      ) {
        throw new Error(
          "memorySpecialDistrictFactAtoms: refusing a query that is not the special-district-fact prefix+:sd: SELECT",
        );
      }
      if (params?.[0] !== SPECIAL_DISTRICT_FACT_ENTITY_TYPE) {
        throw new Error(
          `memorySpecialDistrictFactAtoms: expected entity_type special-district-fact, got ${String(params?.[0])}`,
        );
      }
      const integerPattern = params?.[1];
      const paddedPattern = params?.[2];
      if (typeof integerPattern !== "string" || typeof paddedPattern !== "string") {
        throw new Error(
          "memorySpecialDistrictFactAtoms: expected LIKE patterns as $2 and $3",
        );
      }
      const integerPrefix = prefixFromLikePattern(integerPattern);
      const paddedPrefix = prefixFromLikePattern(paddedPattern);
      if (integerPrefix == null || paddedPrefix == null) {
        throw new Error(
          "memorySpecialDistrictFactAtoms: expected escaped-prefix:sd:% LIKE patterns as $2 and $3",
        );
      }
      const prefixes: SpecialDistrictFactBindPrefixes = [
        integerPrefix,
        paddedPrefix,
      ];
      return {
        rows: rows
          .filter(
            (r) =>
              districtSuffixFromSpecialDistrictEntityId(r.entityId, prefixes) !=
              null,
          )
          .map((r) => ({ entity_id: r.entityId, body: r.body })) as unknown as T[],
      };
    },
  };
}
