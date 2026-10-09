/**
 * `lib/source-registry` -- the provider registry for `source_feature`
 * (P-499, OPS-16 A-382/A-383; design
 * `_design/2026-10-09_P-499_source_shape_and_address_from_record.md`
 * sections 3 and 5; migration `lib/db/drizzle/0111_source_feature.sql`).
 *
 * One entry per provider: how its rows are keyed within (provider,
 * county_fips), where gate 1 (factory) gets the expected row count it
 * reconciles the stage against, and which indexes its partition needs.
 * `scripts/check-source-shape.mjs` refuses an entry whose `keyRule` is
 * not one of the two legitimate shapes below (positional, bigserial, or
 * missing) -- see that script and `validateRegistry`/`validateRegistryEntry`
 * here, which it calls into.
 *
 * Seeded with exactly the two providers the design names (section 2 G2,
 * G5; section 3): `txgio.address-points` (card B's loader target) and
 * `txgio.parcels` (documented, NOT consumed by any loader yet -- that is
 * card D, behind its own identity-preservation proof).
 */

export type ProviderKey = string;

/**
 * How a provider's rows are keyed within (provider, county_fips).
 *
 * `provider-id`: the provider publishes its own stable per-feature id
 * (`attribute` names the field in the raw payload, e.g. `objectid`).
 * Never positional (a row's position/index in a tile or shapefile) and
 * never a bigserial (a sequence this repo invented) -- both of those are
 * exactly the shapes G2 found wrong in `txgio_parcel`'s old key, and
 * `validateRegistryEntry` refuses any `keyRule.kind` other than the two
 * listed here for that reason.
 *
 * `declared`: the provider has no usable id (G2's TxGIO parcels today),
 * so the registry declares a content-derived rule instead -- `rule` is
 * the rule's text (documentation, not executable code in this package);
 * it must be stable across a re-fetch of the SAME vintage and must never
 * be positional or a bigserial either.
 */
export type KeyRule =
  | { readonly kind: "provider-id"; readonly attribute: string }
  | { readonly kind: "declared"; readonly name: string; readonly rule: string };

/** Where gate 1's reconciliation (factory) gets the count it checks the stage against. Documentation, not a live binding -- the function named in `fnSignature`, if any, lives in the loader/factory side, not in this package. */
export interface ExpectedCountSource {
  readonly description: string;
  readonly fnSignature?: string;
}

export type PartitionIndexKind = "gist" | "btree" | "expression";

/** One index a provider's `source_feature` partition needs, consumed by {@link partitionDdlForProvider}. */
export interface PartitionIndexSpec {
  readonly name: string;
  readonly kind: PartitionIndexKind;
  /** A plain column name (e.g. `geom`), or a SQL expression (e.g. `normalized_full_addr(payload->>'full_addr')`) for `kind: "expression"`. */
  readonly on: string;
  /** Optional partial-index predicate, e.g. `geom IS NOT NULL`. */
  readonly where?: string;
  readonly note?: string;
}

export interface SourceRegistryEntry {
  readonly provider: ProviderKey;
  readonly description: string;
  readonly keyRule: KeyRule;
  readonly expectedCountSource: ExpectedCountSource;
  readonly partitionIndexes: readonly PartitionIndexSpec[];
}

export const SOURCE_REGISTRY: readonly SourceRegistryEntry[] = [
  {
    provider: "txgio.address-points",
    description:
      "TxGIO/StratMap statewide Address Points program " +
      "(feature.geographic.texas.gov .../Address_Points/stratmap_address_points_48_most_recent). " +
      "Card B's loader target: the first `source_feature` partition, replacing " +
      "`txgio_address` (migration 0110 keyed it (county_fips, object_id) as the " +
      "short-term fix; card B moves the loader onto this shape).",
    keyRule: { kind: "provider-id", attribute: "objectid" },
    expectedCountSource: {
      description:
        "The service's own paginated result total for the county's ArcGIS REST " +
        "query (resultOffset pagination), measured by the loader before it writes " +
        "the stage -- same measurement 0110's header already took live for Burnet.",
      fnSignature: "countAddressPointsForCounty(countyFips: string): Promise<number>",
    },
    partitionIndexes: [
      {
        name: "source_feature_txgio_address_points_geom_gist_idx",
        kind: "gist",
        on: "geom",
        where: "geom IS NOT NULL",
        note:
          "Serves the `parcel-address-bind` job's point-in-parcel containment bind " +
          "(design section 4) and any bbox/viewport read.",
      },
      {
        name: "source_feature_txgio_address_points_full_addr_norm_idx",
        kind: "expression",
        on: "normalized_full_addr(payload ->> 'full_addr')",
        note:
          "Mirrors today's `txgio_address_fulladdr_norm_idx` (migration 0058): the " +
          "join surface to CAD situs, via the SAME normalization expression the " +
          "resolver already uses so search and record agree (design section 4.4).",
      },
    ],
  },
  {
    provider: "txgio.parcels",
    description:
      "TxGIO/StratMap statewide Land Parcels program (stratmap25 vintage). " +
      "NOT consumed by any loader in this card -- documented per design section " +
      "3's 'providers with no usable id' case (G2). Card D (behind its own " +
      "identity-preservation proof) moves `txgio_parcel` onto this shape.",
    keyRule: {
      kind: "declared",
      name: "county-propid-geom-sha256",
      rule:
        "sha256(county_fips || '|' || (payload ->> 'prop_id') || '|' || ST_AsBinary(geom)) " +
        "-- content-derived, stable across a re-fetch of the SAME vintage; never the " +
        "positional (county_fips, tile_key, feature_index) key txgio_parcel uses today.",
    },
    expectedCountSource: {
      description:
        "Shapefile feature count for the county's StratMap parcel download, " +
        "measured by the loader before it writes the stage. Not implemented in " +
        "this card -- no loader targets this provider yet.",
    },
    partitionIndexes: [
      {
        name: "source_feature_txgio_parcels_geom_gist_idx",
        kind: "gist",
        on: "geom",
        where: "geom IS NOT NULL",
        note: "Parcel polygon containment/bbox reads -- same shape as today's `txgio_parcel_geom_gist_idx`.",
      },
    ],
  },
];

export interface RegistryValidationIssue {
  readonly provider: string | null;
  readonly reason: string;
}

export interface RegistryValidationResult {
  readonly valid: boolean;
  readonly issues: readonly RegistryValidationIssue[];
}

const VALID_KEY_RULE_KINDS = new Set(["provider-id", "declared"]);
const VALID_INDEX_KINDS = new Set(["gist", "btree", "expression"]);
/** `<namespace>.<layer>`, lowercase, hyphen-separated within each half -- e.g. `txgio.address-points`, `fema.nfhl.fld-haz-ar`. */
const PROVIDER_KEY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

/**
 * Structural validation of ONE entry, callable on arbitrary (possibly
 * malformed) data -- not just on values that already satisfy the
 * {@link SourceRegistryEntry} TS type -- so `scripts/check-source-shape.mjs`
 * can feed it a deliberately bad fixture for its `--selftest`.
 *
 * Refuses (returns one or more issues for) a `keyRule` that is positional,
 * bigserial, or missing: the only two kinds this function accepts are
 * `"provider-id"` and `"declared"` (see {@link KeyRule}'s doc comment for
 * why those are the only legitimate shapes).
 */
export function validateRegistryEntry(entry: unknown): RegistryValidationIssue[] {
  const issues: RegistryValidationIssue[] = [];
  const e = (entry ?? {}) as Partial<SourceRegistryEntry> & Record<string, unknown>;
  const provider = typeof e.provider === "string" ? e.provider : null;

  if (!provider || !PROVIDER_KEY_PATTERN.test(provider)) {
    issues.push({
      provider,
      reason: `provider must be a "<namespace>.<layer>" key (lowercase, hyphen-separated), got ${JSON.stringify(e.provider)}`,
    });
  }
  if (!isNonEmptyString(e.description)) {
    issues.push({ provider, reason: "description must be a non-empty string" });
  }

  const keyRule = e.keyRule as (Partial<KeyRule> & Record<string, unknown>) | undefined | null;
  if (!keyRule || typeof keyRule !== "object") {
    issues.push({ provider, reason: "keyRule is missing" });
  } else if (!VALID_KEY_RULE_KINDS.has(keyRule.kind as string)) {
    issues.push({
      provider,
      reason:
        `keyRule.kind must be "provider-id" or "declared" (refusing positional/bigserial/unknown), ` +
        `got ${JSON.stringify(keyRule.kind)}`,
    });
  } else if (keyRule.kind === "provider-id") {
    if (!isNonEmptyString(keyRule.attribute)) {
      issues.push({ provider, reason: "keyRule.attribute must be a non-empty string for kind=provider-id" });
    }
  } else if (keyRule.kind === "declared") {
    if (!isNonEmptyString(keyRule.name)) {
      issues.push({ provider, reason: "keyRule.name must be a non-empty string for kind=declared" });
    }
    if (!isNonEmptyString(keyRule.rule)) {
      issues.push({ provider, reason: "keyRule.rule must be a non-empty string for kind=declared" });
    }
  }

  const expectedCountSource = e.expectedCountSource as Partial<ExpectedCountSource> | undefined | null;
  if (!expectedCountSource || !isNonEmptyString(expectedCountSource.description)) {
    issues.push({ provider, reason: "expectedCountSource.description must be a non-empty string" });
  }

  const partitionIndexes = e.partitionIndexes;
  if (!Array.isArray(partitionIndexes)) {
    issues.push({ provider, reason: "partitionIndexes must be an array (may be empty)" });
  } else {
    partitionIndexes.forEach((raw, i) => {
      const ix = (raw ?? {}) as Partial<PartitionIndexSpec> & Record<string, unknown>;
      if (!isNonEmptyString(ix.name)) {
        issues.push({ provider, reason: `partitionIndexes[${i}].name must be a non-empty string` });
      }
      if (!VALID_INDEX_KINDS.has(ix.kind as string)) {
        issues.push({ provider, reason: `partitionIndexes[${i}].kind must be one of gist/btree/expression, got ${JSON.stringify(ix.kind)}` });
      }
      if (!isNonEmptyString(ix.on)) {
        issues.push({ provider, reason: `partitionIndexes[${i}].on must be a non-empty string` });
      }
    });
  }

  return issues;
}

/** Validates every entry plus cross-entry rules (no duplicate provider keys). */
export function validateRegistry(entries: readonly unknown[]): RegistryValidationResult {
  const issues: RegistryValidationIssue[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    issues.push(...validateRegistryEntry(entry));
    const provider = (entry as { provider?: unknown } | null)?.provider;
    if (typeof provider === "string") {
      if (seen.has(provider)) {
        issues.push({ provider, reason: `duplicate provider key ${JSON.stringify(provider)}` });
      }
      seen.add(provider);
    }
  }
  return { valid: issues.length === 0, issues };
}

/** Throws with every issue listed if {@link SOURCE_REGISTRY} (or a supplied entry list) is invalid. Called at module load in consumers that want to fail fast rather than check a boolean. */
export function assertValidRegistry(entries: readonly unknown[] = SOURCE_REGISTRY): void {
  const result = validateRegistry(entries);
  if (!result.valid) {
    throw new Error(
      `source-registry: invalid registry:\n` +
        result.issues.map((i) => `  - [${i.provider ?? "(no provider)"}] ${i.reason}`).join("\n"),
    );
  }
}

export function getRegistryEntry(provider: ProviderKey): SourceRegistryEntry | undefined {
  return SOURCE_REGISTRY.find((e) => e.provider === provider);
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** `txgio.address-points` -> `source_feature_txgio_address_points`. */
export function partitionTableName(provider: ProviderKey): string {
  const slug = provider
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `source_feature_${slug}`;
}

function indexTargetSql(on: string): string {
  // A plain identifier is quoted as a column reference; anything else is
  // treated as a raw SQL expression and parenthesized (Postgres's required
  // syntax for an expression index, e.g. `((payload ->> 'full_addr'))`).
  return /^[a-z_][a-z0-9_]*$/i.test(on) ? `"${on}"` : `(${on})`;
}

function partitionIndexDdl(partitionTable: string, idx: PartitionIndexSpec): string {
  const using = idx.kind === "gist" ? " USING GIST" : "";
  const where = idx.where ? ` WHERE ${idx.where}` : "";
  return `CREATE INDEX IF NOT EXISTS "${idx.name}" ON "${partitionTable}"${using} (${indexTargetSql(idx.on)})${where};`;
}

/**
 * Generates the DDL text for adding ONE provider's partition to
 * `source_feature`: `CREATE TABLE ... PARTITION OF ... FOR VALUES IN (...)`
 * plus one `CREATE INDEX` per {@link SourceRegistryEntry.partitionIndexes}.
 *
 * This is a TEXT GENERATOR ONLY -- it runs no SQL and holds no database
 * connection. The intended use is a future migration file (card B for
 * `txgio.address-points`): paste this function's output into that
 * migration's `.sql` file so every partition gets the exact index shape
 * its registry entry promised, rather than a hand-written one-off. Throws
 * if `entry` fails {@link validateRegistryEntry} -- there is no DDL to
 * generate for an entry this package itself would refuse.
 */
export function partitionDdlForProvider(entry: SourceRegistryEntry): string[] {
  const issues = validateRegistryEntry(entry);
  if (issues.length > 0) {
    throw new Error(
      `partitionDdlForProvider: invalid registry entry for ${JSON.stringify(entry.provider)}:\n` +
        issues.map((i) => `  - ${i.reason}`).join("\n"),
    );
  }
  const table = partitionTableName(entry.provider);
  const statements = [
    `CREATE TABLE IF NOT EXISTS "${table}" PARTITION OF "source_feature" FOR VALUES IN (${sqlStringLiteral(entry.provider)});`,
  ];
  for (const idx of entry.partitionIndexes) {
    statements.push(partitionIndexDdl(table, idx));
  }
  return statements;
}
