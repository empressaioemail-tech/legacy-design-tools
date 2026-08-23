/**
 * Inspect-card owner READ from owner-fact atoms.
 *
 * Writer seam `owner-fact-writer.ts` stores
 * entity_id = `${parcelNodeId}:${taxYear}`. Dual grammar applies to the
 * parcel PREFIX only; taxYear comes from the atom row. Flood's
 * `entity_id = ANY(parcel keys)` WILL MISS. Edge `:boundary:` prefix-range
 * is not this family. Special-district `:sd:` picker is not this family.
 *
 * Closest bind is landUseFactRead (same CAD-year key family).
 *
 * cad-parcel-roll / bake / the CAD roll table / GIS ParcelCardData.owner
 * are never a source for this field. The writer reads the CAD roll at
 * apply time. Serve reads atoms only.
 *
 * TWO STORES. Atoms live in hauska_mcp (ATOMS_DATABASE_URL). The inspect
 * route's drizzle `db` is the deployment store. DATABASE_URL in api-server
 * means deployment, not atoms — this module does not read that name.
 *
 * Identified vs anonymous is decided by the route using the existing
 * brokerage session signal (`authenticatedBrokerageUserId`). This module
 * is the atom read. Anonymous callers must not receive ownerName or mailing.
 */

import pg from "pg";

const PADDED_SUFFIX = ".00000000";
const TAX_YEAR_SUFFIX = /^[0-9]{4}$/;
export const OWNER_FACT_ENTITY_TYPE = "owner-fact" as const;
export const OWNER_FACT_SOURCE = "owner-fact" as const;

export interface AtomQueryable {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export type OwnerFactBindPrefixes = readonly [string, string];

/**
 * Both parcel-prefix grammars, always, in stable order: integer then padded.
 * Inbound `{fips}:{prop}.00000000` inverts to the integer prefix; inbound
 * integer appends the suffix. Never returns one prefix. Never appends a year.
 * Year is not invented here.
 */
export function ownerFactBindPrefixes(
  parcelNodeId: string,
): OwnerFactBindPrefixes {
  if (parcelNodeId.endsWith(PADDED_SUFFIX)) {
    const integerForm = parcelNodeId.slice(0, -PADDED_SUFFIX.length);
    return [integerForm, parcelNodeId];
  }
  return [parcelNodeId, `${parcelNodeId}${PADDED_SUFFIX}`];
}

export type OwnerExemptionFlagsRead = {
  homestead: boolean | null;
  seniorOrDisability: boolean | null;
  agricultural: boolean | null;
  veteran: boolean | null;
};

export type OwnerFactPresent = {
  state: "present";
  source: typeof OWNER_FACT_SOURCE;
  boundAs: string;
  tried: OwnerFactBindPrefixes;
  entityId: string;
  taxYear: number;
  ownerName: string;
  ownerMailingAddress: string | null;
  exemptionFlags: OwnerExemptionFlagsRead | null;
  sourceAdapter: string | null;
  sourceVintage: string | null;
  evaluatedAt: string | null;
};

export type OwnerFactTypedAbsence = {
  state: "absent";
  source: typeof OWNER_FACT_SOURCE;
  boundAs: string;
  tried: OwnerFactBindPrefixes;
  entityId: string;
  taxYear: number;
  absence: { kind: string; reason: string } | null;
  verifiedAbsence: unknown;
  sourceTier: string | null;
  sourceAdapter: string | null;
};

export type OwnerFactRefusal = {
  state: "refused";
  code:
    | "atom-miss"
    | "bind-conflict"
    | "atoms-store-not-configured"
    | "malformed-atom"
    | "identified-session-required";
  source: typeof OWNER_FACT_SOURCE;
  tried: OwnerFactBindPrefixes | [];
  reason: string;
};

export type OwnerFactRead =
  | OwnerFactPresent
  | OwnerFactTypedAbsence
  | OwnerFactRefusal;

type AtomRow = { entity_id: string; body: unknown };

/**
 * Prefix + year suffix. $2 / $3 are LIKE patterns `{escapedPrefix}:%`,
 * never raw prefixes. `_` is legal in parcelNodeId (PARCEL_NODE_ID_RE) and
 * is a LIKE any-char wildcard unless escaped. Flood's parcel-key ANY-array
 * lookup is deliberately not this query.
 */
const SELECT_OWNER_FACT = `
SELECT entity_id, body
  FROM atoms
 WHERE entity_type = $1
   AND (
     entity_id LIKE $2 ESCAPE '\\'
     OR entity_id LIKE $3 ESCAPE '\\'
   )
`;

/** LIKE pattern for one parcel prefix plus `:%`. Escapes `\`, `%`, and `_`. */
export function ownerFactLikePrefixPattern(prefix: string): string {
  return `${prefix.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}:%`;
}

function prefixFromLikePattern(pattern: string): string | null {
  if (!pattern.endsWith(":%")) return null;
  return pattern.slice(0, -2).replace(/\\([\\%_])/g, "$1");
}

let injectedQueryable: AtomQueryable | null | undefined;
let sharedPool: pg.Pool | null = null;

/** Test seam. `null` means store not configured. `undefined` (reset) means env. */
export function setOwnerFactAtomQueryableForTests(
  queryable: AtomQueryable | null,
): void {
  injectedQueryable = queryable;
}

export function resetOwnerFactAtomQueryableForTests(): void {
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

function asExemptionFlags(value: unknown): OwnerExemptionFlagsRead | null {
  const rec = asRecord(value);
  if (!rec) return null;
  return {
    homestead: typeof rec.homestead === "boolean" ? rec.homestead : null,
    seniorOrDisability:
      typeof rec.seniorOrDisability === "boolean"
        ? rec.seniorOrDisability
        : null,
    agricultural:
      typeof rec.agricultural === "boolean" ? rec.agricultural : null,
    veteran: typeof rec.veteran === "boolean" ? rec.veteran : null,
  };
}

/**
 * entity_id is `${prefix}:${taxYear}`. Integer prefix is a string prefix of
 * the padded prefix, so the match requires the colon immediately after the
 * chosen prefix (`48021:34137.00000000:2025` does not match `48021:34137:`).
 */
export function taxYearFromOwnerFactEntityId(
  entityId: string,
  prefixes: OwnerFactBindPrefixes,
): { prefix: string; taxYear: number } | null {
  for (const prefix of prefixes) {
    const needle = `${prefix}:`;
    if (!entityId.startsWith(needle)) continue;
    const rest = entityId.slice(needle.length);
    if (!TAX_YEAR_SUFFIX.test(rest)) continue;
    return { prefix, taxYear: Number(rest) };
  }
  return null;
}

function claimFingerprint(body: Record<string, unknown>): string {
  const absence = asRecord(body.absence);
  const flags = asRecord(body.exemptionFlags);
  return JSON.stringify({
    sourceTier: body.sourceTier ?? null,
    taxYear: body.taxYear ?? null,
    ownerName: body.ownerName ?? null,
    ownerMailingAddress: body.ownerMailingAddress ?? null,
    homestead: flags?.homestead ?? null,
    seniorOrDisability: flags?.seniorOrDisability ?? null,
    agricultural: flags?.agricultural ?? null,
    veteran: flags?.veteran ?? null,
    absenceKind: absence?.kind ?? null,
    absenceReason: absence?.reason ?? null,
  });
}

function interpretBody(
  entityId: string,
  body: unknown,
  tried: OwnerFactBindPrefixes,
  taxYearFromId: number,
): OwnerFactPresent | OwnerFactTypedAbsence | OwnerFactRefusal {
  const rec = asRecord(body);
  if (!rec) {
    return {
      state: "refused",
      code: "malformed-atom",
      source: OWNER_FACT_SOURCE,
      tried,
      reason: `owner-fact entity_id ${entityId} has a non-object body. Refusing rather than inventing an owner.`,
    };
  }
  if (rec.entityType != null && rec.entityType !== OWNER_FACT_ENTITY_TYPE) {
    return {
      state: "refused",
      code: "malformed-atom",
      source: OWNER_FACT_SOURCE,
      tried,
      reason: `owner-fact entity_id ${entityId} body.entityType is ${String(rec.entityType)}, not owner-fact.`,
    };
  }

  let taxYear = taxYearFromId;
  if (typeof rec.taxYear === "number" && Number.isInteger(rec.taxYear)) {
    if (rec.taxYear !== taxYearFromId) {
      return {
        state: "refused",
        code: "malformed-atom",
        source: OWNER_FACT_SOURCE,
        tried,
        reason: `owner-fact entity_id ${entityId} body.taxYear ${rec.taxYear} disagrees with entity_id year ${taxYearFromId}.`,
      };
    }
    taxYear = rec.taxYear;
  }

  const absence = asRecord(rec.absence);
  const hasAbsence =
    Boolean(absence) ||
    rec.sourceTier === "absent" ||
    rec.verifiedAbsence != null;

  if (hasAbsence) {
    const kind = asNullableString(absence?.kind);
    const reason = asNullableString(absence?.reason);
    return {
      state: "absent",
      source: OWNER_FACT_SOURCE,
      boundAs: entityId,
      tried,
      entityId,
      taxYear,
      absence: kind && reason ? { kind, reason } : null,
      verifiedAbsence: rec.verifiedAbsence ?? null,
      sourceTier: asNullableString(rec.sourceTier),
      sourceAdapter: asNullableString(rec.sourceAdapter),
    };
  }

  const ownerName = asNullableString(rec.ownerName);
  if (!ownerName) {
    return {
      state: "refused",
      code: "malformed-atom",
      source: OWNER_FACT_SOURCE,
      tried,
      reason: `owner-fact entity_id ${entityId} is neither a present ownerName finding nor a typed absence.`,
    };
  }

  return {
    state: "present",
    source: OWNER_FACT_SOURCE,
    boundAs: entityId,
    tried,
    entityId,
    taxYear,
    ownerName,
    ownerMailingAddress: asNullableString(rec.ownerMailingAddress),
    exemptionFlags: asExemptionFlags(rec.exemptionFlags),
    sourceAdapter: asNullableString(rec.sourceAdapter),
    sourceVintage: asNullableString(rec.sourceVintage),
    evaluatedAt: asNullableString(rec.evaluatedAt),
  };
}

function pickPreferredRow(
  yearHits: AtomRow[],
  integerEntityId: string,
  paddedEntityId: string,
): AtomRow {
  return (
    yearHits.find((r) => r.entity_id === integerEntityId) ??
    yearHits.find((r) => r.entity_id === paddedEntityId) ??
    yearHits[0]
  );
}

/**
 * Interpret already-fetched atom rows. Pure. Tests drive this with fixtures
 * so a miss, a padded-prefix-only hit, a year preference, and a conflict are
 * observed without a store.
 */
export function interpretOwnerFactRows(
  parcelNodeId: string,
  rows: ReadonlyArray<AtomRow>,
): OwnerFactRead {
  const tried = ownerFactBindPrefixes(parcelNodeId);
  const parsedHits = rows
    .map((r) => {
      const parsed = taxYearFromOwnerFactEntityId(r.entity_id, tried);
      return parsed ? { row: r, ...parsed } : null;
    })
    .filter((h): h is { row: AtomRow; prefix: string; taxYear: number } =>
      Boolean(h),
    );
  if (parsedHits.length === 0) {
    return {
      state: "refused",
      code: "atom-miss",
      source: OWNER_FACT_SOURCE,
      tried,
      reason: `No owner-fact atom for ${tried[0]}:taxYear or ${tried[1]}:taxYear. Atom miss, not a CAD-roll owner.`,
    };
  }
  const maxYear = Math.max(...parsedHits.map((h) => h.taxYear));
  const yearHits = parsedHits.filter((h) => h.taxYear === maxYear).map((h) => h.row);
  const integerEntityId = `${tried[0]}:${maxYear}`;
  const paddedEntityId = `${tried[1]}:${maxYear}`;
  if (yearHits.length > 1) {
    const fingerprints = new Set(
      yearHits.map((h) => {
        const rec = asRecord(h.body);
        return rec ? claimFingerprint(rec) : `non-object:${h.entity_id}`;
      }),
    );
    if (fingerprints.size > 1) {
      return {
        state: "refused",
        code: "bind-conflict",
        source: OWNER_FACT_SOURCE,
        tried,
        reason: `owner-fact atoms at ${integerEntityId} and ${paddedEntityId} disagree. Refusing rather than picking an owner.`,
      };
    }
  }
  const chosen = pickPreferredRow(yearHits, integerEntityId, paddedEntityId);
  return interpretBody(chosen.entity_id, chosen.body, tried, maxYear);
}

export function anonymousOwnerFactRefusal(
  parcelNodeId: string,
): OwnerFactRefusal {
  const tried = ownerFactBindPrefixes(parcelNodeId);
  return {
    state: "refused",
    code: "identified-session-required",
    source: OWNER_FACT_SOURCE,
    tried,
    reason:
      "owner-fact is identified-session only. Anonymous GET has no owner body.",
  };
}

export async function loadOwnerFactAtom(
  parcelNodeId: string,
): Promise<OwnerFactRead> {
  const tried = ownerFactBindPrefixes(parcelNodeId);
  const atoms = resolveQueryable();
  if (!atoms) {
    return {
      state: "refused",
      code: "atoms-store-not-configured",
      source: OWNER_FACT_SOURCE,
      tried,
      reason:
        "owner-fact lives in the ATOMS store (ATOMS_DATABASE_URL). That store is not configured. Refusing rather than reading cad_property or emitting a silent null.",
    };
  }
  const result = await atoms.query<AtomRow>(SELECT_OWNER_FACT, [
    OWNER_FACT_ENTITY_TYPE,
    ownerFactLikePrefixPattern(tried[0]),
    ownerFactLikePrefixPattern(tried[1]),
  ]);
  return interpretOwnerFactRows(parcelNodeId, result.rows);
}

/** In-memory atoms table for tests. Refuses any query that is not this SELECT. */
export function memoryOwnerFactAtoms(
  rows: ReadonlyArray<{ entityId: string; body: Record<string, unknown> }>,
): AtomQueryable {
  return {
    async query<T extends Record<string, unknown> = Record<string, unknown>>(
      text: string,
      params?: unknown[],
    ): Promise<{ rows: T[] }> {
      if (text.includes("cad_property")) {
        throw new Error(
          "memoryOwnerFactAtoms: cad_property is not an owner-fact source",
        );
      }
      if (text.includes("place_layer_snapshots")) {
        throw new Error(
          "memoryOwnerFactAtoms: place_layer_snapshots is not an owner-fact source",
        );
      }
      if (text.includes("cad-parcel-roll")) {
        throw new Error(
          "memoryOwnerFactAtoms: cad-parcel-roll is not an owner-fact source",
        );
      }
      if (/gis/i.test(text) || text.includes("ParcelCardData")) {
        throw new Error(
          "memoryOwnerFactAtoms: GIS ParcelCardData.owner is not an owner-fact source",
        );
      }
      if (text.includes(":sd:")) {
        throw new Error(
          "memoryOwnerFactAtoms: special-district :sd: picker is not the owner-fact bind",
        );
      }
      if (text.includes(":boundary:")) {
        throw new Error(
          "memoryOwnerFactAtoms: edge :boundary: prefix-range is not the owner-fact bind",
        );
      }
      if (text.includes("entity_id = ANY")) {
        throw new Error(
          "memoryOwnerFactAtoms: flood-style entity_id = ANY(parcel keys) misses ${parcel}:${taxYear}",
        );
      }
      if (
        !text.includes("FROM atoms") ||
        !text.includes("entity_type") ||
        !text.includes("LIKE")
      ) {
        throw new Error(
          "memoryOwnerFactAtoms: refusing a query that is not the owner-fact prefix+taxYear SELECT",
        );
      }
      if (params?.[0] !== OWNER_FACT_ENTITY_TYPE) {
        throw new Error(
          `memoryOwnerFactAtoms: expected entity_type owner-fact, got ${String(params?.[0])}`,
        );
      }
      const integerPattern = params?.[1];
      const paddedPattern = params?.[2];
      if (typeof integerPattern !== "string" || typeof paddedPattern !== "string") {
        throw new Error(
          "memoryOwnerFactAtoms: expected LIKE patterns as $2 and $3",
        );
      }
      const integerPrefix = prefixFromLikePattern(integerPattern);
      const paddedPrefix = prefixFromLikePattern(paddedPattern);
      if (integerPrefix == null || paddedPrefix == null) {
        throw new Error(
          "memoryOwnerFactAtoms: expected escaped-prefix:% LIKE patterns as $2 and $3",
        );
      }
      const prefixes: OwnerFactBindPrefixes = [integerPrefix, paddedPrefix];
      return {
        rows: rows
          .filter((r) => taxYearFromOwnerFactEntityId(r.entityId, prefixes) != null)
          .map((r) => ({ entity_id: r.entityId, body: r.body })) as unknown as T[],
      };
    },
  };
}
