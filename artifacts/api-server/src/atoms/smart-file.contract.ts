/**
 * Smart Files — the city-file-system artifact family (OPS-17 PLAN-ROW G-14).
 *
 * A NEW atom family. It does NOT extend `brokerage_workspaces` (OPS-17
 * amendment A-012): that family is a brokerage feature whose attachment table
 * cannot carry this family's promise, and its rename is a separate backlogged
 * lane. Nothing here touches it.
 *
 * WHY A NEW FAMILY — the structural facts this shape exists to fix, verified at
 * source on `origin/main` @ 4dfb118c in
 * `lib/db/src/schema/brokerageWorkspaces.ts:54-76`:
 * `brokerage_workspace_attachments` defines 8 columns (`id`, `workspace_id`,
 * `kind`, `uri`, `body`, `title`, `created_by_install_id`, `created_at`) with a
 * single `notNull` FK to ONE workspace on cascade delete, and no `updated_at`,
 * no `version`, no `cid`, no `access_policy`. Consequently:
 *   - "a document lives once and appears everywhere it belongs" is structurally
 *     impossible there: one attachment belongs to exactly one workspace, so N
 *     placements means N copies — the exact problem Smart Files solves;
 *   - "revise once, current everywhere, prior version still there" has no
 *     schema there at all: only insert and delete exist.
 *
 * AUTHORED LOCALLY ON PURPOSE (operator ruling OR-A1, 2026-08-15). This type is
 * NOT in `@empressaio/atom-contract` yet. The contract is consumed by more than
 * this lane, and once a type ships there every consumer inherits it and changing
 * it becomes a coordinated multi-repo migration. This shape WILL move: G-34
 * (typed absence) and G-44 (corpus capture) both push on it.
 *
 *   PROMOTION CRITERION (operator-set, so "named step" is not a euphemism for
 *   never): this type promotes to `@empressaio/atom-contract` WHEN G-34 CLOSES
 *   — typed absence is the last thing that reshapes the shape. If a second
 *   consumer needs it before then, that forces promotion early and is a
 *   FINDING, not a violation. Record it; do not quietly copy this file.
 *
 * The five-value access-policy union is IMPORTED, never re-declared here
 * (finding A-CP1-F3: `ACCESS_POLICY_SCHEMA` is already re-literalled in three
 * subtrees of the contract source with no divergence test — DEV_PROCESS 2.4).
 * A fourth copy would make that worse. The import resolves against the
 * vendored `@hauska/atom-contract` 1.6.0 tarball this repo actually consumes
 * (`artifacts/api-server/package.json:19`), whose root export declares
 * `AccessPolicy` as the same five values as published 1.22.0.
 */

import { z } from "zod";

import { type AccessPolicy } from "@hauska/atom-contract";

/**
 * The five-value access-policy union, IMPORTED from the atom contract rather
 * than re-literalled (A-CP1-F3). Re-exported so Smart Files consumers get it
 * without a second import path, exactly as document-ingest re-exports the
 * storage-relation rule.
 */
export type SmartFileAccessPolicy = AccessPolicy;

export const SMART_FILE_ACCESS_POLICY_VALUES = [
  "public-free",
  "public-paid",
  "platform-internal",
  "tenant-private",
  "tenant-shared",
] as const satisfies ReadonlyArray<AccessPolicy>;

/**
 * `as const satisfies ReadonlyArray<AccessPolicy>` is the divergence control,
 * not decoration: if the contract's union ever gains, loses, or renames a
 * value, this array stops satisfying it and the BUILD FAILS. That is a
 * compile-time divergence test standing in for the runtime one the contract
 * repo lacks. It is deliberately not a hand-maintained duplicate.
 */
export const SMART_FILE_ACCESS_POLICY_SCHEMA = z.enum(
  SMART_FILE_ACCESS_POLICY_VALUES,
);

/* ------------------------------------------------------------------ *
 * entityId shape — DECLARED, never reconstructed
 * ------------------------------------------------------------------ */

/**
 * The city-file node class entityId shape (OPS-17 G-10 / S-6, the half A-012
 * left open: A-012 ruled the family placement but states no shape).
 *
 * Constraint 6 and AGENT_CONTRACT 5 both say entityId shapes are NOT uniform
 * across writers and must never be reconstructed from parts — a wrong
 * reconstruction silently matches zero rows and reads as an honest absence.
 * So the shape is DECLARED here, in one place, with one builder and one parser,
 * and storage persists exactly what the builder returns.
 *
 * A document twin is NOT the parcel-keyed shape. A city file is scoped to a
 * JURISDICTION, not to a parcel: most city documents (an ordinance, a council
 * packet, a budget) have no parcel at all. Parcel-scoped documents express that
 * as a PLACEMENT, never by keying the document itself.
 *
 *   smartfile:<jurisdictionFips>:<docSlug>
 *
 * `jurisdictionFips` — the jurisdiction the document belongs to, as the FIPS
 * string storage persists (e.g. `48021` for Bastrop County). Not a name: names
 * are unstable and collide.
 * `docSlug` — a stable, caller-supplied identifier for the document WITHIN that
 * jurisdiction. It identifies the DOCUMENT, not a version and not a placement:
 * revisions share it (that is what makes revise-once work) and placements
 * reference it.
 *
 * Deliberately NOT the content CID. A CID identifies BYTES, so it necessarily
 * changes on every revision; keying the document by CID would make revision
 * create a new document, defeating the entire family. The CID is carried on the
 * VERSION (`contentCid`), where changing per revision is correct.
 */
export const SMART_FILE_ENTITY_ID_PREFIX = "smartfile" as const;

export interface SmartFileEntityIdParts {
  jurisdictionFips: string;
  docSlug: string;
}

const JURISDICTION_FIPS_RE = /^[0-9]{5,10}$/;
const DOC_SLUG_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** Build the declared entityId. The ONLY sanctioned way to produce one. */
export function buildSmartFileEntityId(parts: SmartFileEntityIdParts): string {
  const { jurisdictionFips, docSlug } = parts;
  if (!JURISDICTION_FIPS_RE.test(jurisdictionFips)) {
    throw new Error(
      `smart-file entityId: jurisdictionFips must be numeric FIPS, got ${JSON.stringify(jurisdictionFips)}`,
    );
  }
  if (!DOC_SLUG_RE.test(docSlug)) {
    throw new Error(
      `smart-file entityId: docSlug must match ${DOC_SLUG_RE}, got ${JSON.stringify(docSlug)}`,
    );
  }
  return `${SMART_FILE_ENTITY_ID_PREFIX}:${jurisdictionFips}:${docSlug}`;
}

/**
 * Parse a declared entityId back to its parts, or return null.
 *
 * Returns null rather than throwing, and returns null rather than
 * best-effort-guessing a malformed value: a silent partial parse is the
 * reconstruction failure this declaration exists to prevent. Callers that need
 * a hard failure use `buildSmartFileEntityId` on the way in.
 */
export function parseSmartFileEntityId(
  entityId: string,
): SmartFileEntityIdParts | null {
  const segments = entityId.split(":");
  if (segments.length !== 3) return null;
  const [prefix, jurisdictionFips, docSlug] = segments;
  if (prefix !== SMART_FILE_ENTITY_ID_PREFIX) return null;
  if (!JURISDICTION_FIPS_RE.test(jurisdictionFips)) return null;
  if (!DOC_SLUG_RE.test(docSlug)) return null;
  return { jurisdictionFips, docSlug };
}

/* ------------------------------------------------------------------ *
 * Provenance and freshness
 * ------------------------------------------------------------------ */

/**
 * Where an artifact came from. Inherited spine constraint 4: every served
 * artifact carries source, `computedAt`, and `servedAt`. An artifact store is a
 * cache, and a cache without a stamp is a liar waiting for load.
 *
 * `sourceUri` and `retrievedAt` are REQUIRED, not optional. An unsourced city
 * document is not a Smart File — it is a rumor. Making them optional is how an
 * absent provenance becomes indistinguishable from a provenance nobody set.
 */
export interface SmartFileProvenance {
  /** Where the bytes came from — a public-record URL or portal reference. */
  sourceUri: string;
  /** Human-readable origin (e.g. "Bastrop County Clerk"). */
  sourceLabel: string;
  /** When the source was retrieved. ISO-8601. */
  retrievedAt: string;
  /**
   * The document's own vintage as the SOURCE states it (adoption date,
   * revision date), when the source states one. Distinct from `retrievedAt`:
   * a 2019 ordinance retrieved today is fresh to us and old in the world.
   * Null is a POSITIVE determination that the source states no vintage, not
   * "unknown" (DEV_PROCESS 4.3).
   */
  sourceVintage: string | null;
}

export const SMART_FILE_PROVENANCE_SCHEMA = z.object({
  sourceUri: z.string().min(1),
  sourceLabel: z.string().min(1),
  retrievedAt: z.string().min(1),
  sourceVintage: z.string().min(1).nullable(),
});

/**
 * The freshness stamp carried on every READ of a Smart File.
 *
 * `computedAt` is when this artifact's content was established; `servedAt` is
 * when THIS read happened. They are different clocks and both are required:
 * `computedAt` alone cannot tell a reader whether it is looking at something
 * stale, and `servedAt` alone cannot tell it how old the content is.
 */
export interface SmartFileFreshness {
  computedAt: string;
  servedAt: string;
  /**
   * Age in seconds at serve time — `servedAt - computedAt`. Carried explicitly
   * so a consumer never has to re-derive it (and never derives it differently).
   */
  ageSeconds: number;
  /**
   * Whether this artifact is past its freshness threshold.
   *
   * Computed by `evaluateSmartFileFreshness`, whose ability to FIRE and to stay
   * SILENT are both proven by test before anything relies on it
   * (DEV_PROCESS 2.2 — a test that cannot fail for the right reason is a
   * defect, not a test; a one-directional test passes a permanently-firing
   * indicator).
   */
  isStale: boolean;
  /** The threshold this verdict was reached against, in seconds. */
  stalenessThresholdSeconds: number;
}

export const SMART_FILE_FRESHNESS_SCHEMA = z.object({
  computedAt: z.string().min(1),
  servedAt: z.string().min(1),
  ageSeconds: z.number(),
  isStale: z.boolean(),
  stalenessThresholdSeconds: z.number().positive(),
});

/**
 * Default staleness threshold: 30 days.
 *
 * A city document is not a market price. Ordinances and council packets change
 * on the order of months, so a threshold in minutes would make every artifact
 * permanently stale and the indicator would be ignored — DEV_PROCESS 2.0, a
 * permanently-red gate is a dead gate. Callers override per class.
 */
export const SMART_FILE_DEFAULT_STALENESS_SECONDS = 30 * 24 * 60 * 60;

/**
 * Evaluate freshness. Pure, and takes `servedAt` as an ARGUMENT rather than
 * reading a clock internally — that is what makes the backdate test possible
 * and keeps the indicator provable in both directions.
 */
export function evaluateSmartFileFreshness(input: {
  computedAt: string;
  servedAt: string;
  stalenessThresholdSeconds?: number;
}): SmartFileFreshness {
  const threshold =
    input.stalenessThresholdSeconds ?? SMART_FILE_DEFAULT_STALENESS_SECONDS;
  if (!(threshold > 0)) {
    throw new Error(
      `smart-file freshness: stalenessThresholdSeconds must be > 0, got ${threshold}`,
    );
  }
  const computedMs = Date.parse(input.computedAt);
  const servedMs = Date.parse(input.servedAt);
  if (Number.isNaN(computedMs)) {
    throw new Error(
      `smart-file freshness: unparseable computedAt ${JSON.stringify(input.computedAt)}`,
    );
  }
  if (Number.isNaN(servedMs)) {
    throw new Error(
      `smart-file freshness: unparseable servedAt ${JSON.stringify(input.servedAt)}`,
    );
  }
  const ageSeconds = (servedMs - computedMs) / 1000;
  return {
    computedAt: input.computedAt,
    servedAt: input.servedAt,
    ageSeconds,
    isStale: ageSeconds > threshold,
    stalenessThresholdSeconds: threshold,
  };
}

/* ------------------------------------------------------------------ *
 * The family: document, version, placement
 * ------------------------------------------------------------------ */

/**
 * Placement target classes — WHERE a document can appear.
 *
 * A closed set, because an open string is how a placement target becomes
 * unqueryable. Extended deliberately by amendment, never by a caller passing a
 * new string.
 */
export const SMART_FILE_PLACEMENT_TARGET_TYPES = [
  "folder",
  "parcel",
  "project",
  "asset",
  "permit",
  "meeting",
] as const;

export type SmartFilePlacementTargetType =
  (typeof SMART_FILE_PLACEMENT_TARGET_TYPES)[number];

/**
 * The DOCUMENT — identity only, deliberately carrying no content.
 *
 * This is the "lives once" half of the promise. Content lives on VERSIONS and
 * location lives on PLACEMENTS, so a document appearing in five places is one
 * of these plus five placements, never five of these.
 */
export interface SmartFileDocument {
  entityType: "smart-file-document";
  /** The declared entityId. Built by `buildSmartFileEntityId`, never by hand. */
  entityId: string;
  jurisdictionFips: string;
  docSlug: string;
  title: string;
  /** Resolved at READ time, per ADR-017. */
  accessPolicy: SmartFileAccessPolicy;
  /** Version identity of the version that is CURRENT for this document. */
  currentVersion: number;
  createdAt: string;
  updatedAt: string;
}

export const SMART_FILE_DOCUMENT_SCHEMA = z.object({
  entityType: z.literal("smart-file-document"),
  entityId: z.string().min(1),
  jurisdictionFips: z.string().min(1),
  docSlug: z.string().min(1),
  title: z.string().min(1),
  accessPolicy: SMART_FILE_ACCESS_POLICY_SCHEMA,
  currentVersion: z.number().int().positive(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

/**
 * One VERSION of a document. Append-only by contract.
 *
 * This is the "prior version is still there" half. A revision INSERTS a new
 * version and moves the document's `currentVersion` pointer; it never updates
 * or deletes an existing version row. Nothing is silently overwritten.
 *
 * `contentCid` is the content-addressed identifier of the bytes, minted by the
 * engine's existing document-ingest blob-pin mechanism (operator ruling OR-A2:
 * reuse the mechanism, new parent table). It changes per revision, which is
 * correct — and is exactly why the DOCUMENT is not keyed by it.
 */
export interface SmartFileVersion {
  entityType: "smart-file-version";
  /** The owning document's declared entityId. */
  documentEntityId: string;
  /** Monotonic version identity, starting at 1. */
  version: number;
  /** Content-addressed CID of the pinned bytes. */
  contentCid: string;
  contentType: string;
  byteSize: number;
  provenance: SmartFileProvenance;
  /** When this version's content was established. */
  computedAt: string;
  /**
   * Set when a LATER version supersedes this one; null while current.
   * A positive record of supersession, not an inference from the pointer.
   */
  supersededAt: string | null;
}

export const SMART_FILE_VERSION_SCHEMA = z.object({
  entityType: z.literal("smart-file-version"),
  documentEntityId: z.string().min(1),
  version: z.number().int().positive(),
  contentCid: z.string().min(1),
  contentType: z.string().min(1),
  byteSize: z.number().int().nonnegative(),
  provenance: SMART_FILE_PROVENANCE_SCHEMA,
  computedAt: z.string().min(1),
  supersededAt: z.string().min(1).nullable(),
});

/**
 * A PLACEMENT — one location where a document appears.
 *
 * Many-to-many by construction: many placements per document, many documents
 * per target. This is what makes "appears everywhere it belongs" true without
 * copying, and it is the precise structural difference from
 * `brokerage_workspace_attachments`, whose single `notNull` workspace FK forces
 * one attachment to belong to exactly one parent.
 *
 * A placement references the DOCUMENT, never a version — which is what makes
 * revise-once-current-everywhere fall out structurally rather than needing a
 * fan-out update across placements.
 */
export interface SmartFilePlacement {
  entityType: "smart-file-placement";
  documentEntityId: string;
  targetType: SmartFilePlacementTargetType;
  /**
   * The target's own identifier AS THAT TARGET'S WRITER PERSISTS IT.
   * Shapes are not uniform across writers (AGENT_CONTRACT 5), so this is
   * stored opaquely and never parsed or reconstructed by this family.
   */
  targetId: string;
  placedAt: string;
  /** Null is a positive "no actor recorded", not "unknown". */
  placedBy: string | null;
}

export const SMART_FILE_PLACEMENT_SCHEMA = z.object({
  entityType: z.literal("smart-file-placement"),
  documentEntityId: z.string().min(1),
  targetType: z.enum(SMART_FILE_PLACEMENT_TARGET_TYPES),
  targetId: z.string().min(1),
  placedAt: z.string().min(1),
  placedBy: z.string().min(1).nullable(),
});

/**
 * What a READ of a Smart File returns: the document, the resolved version, its
 * provenance, its freshness stamp, and where it appears.
 *
 * Freshness is on the READ, not on the stored row, because `servedAt` is a
 * property of the serving event. There is deliberately no shape here that can
 * carry content without a stamp.
 */
export interface SmartFileRead {
  document: SmartFileDocument;
  version: SmartFileVersion;
  provenance: SmartFileProvenance;
  freshness: SmartFileFreshness;
  placements: ReadonlyArray<SmartFilePlacement>;
}

export const SMART_FILE_READ_SCHEMA = z.object({
  document: SMART_FILE_DOCUMENT_SCHEMA,
  version: SMART_FILE_VERSION_SCHEMA,
  provenance: SMART_FILE_PROVENANCE_SCHEMA,
  freshness: SMART_FILE_FRESHNESS_SCHEMA,
  placements: z.array(SMART_FILE_PLACEMENT_SCHEMA).readonly(),
});

export const SMART_FILE_ENTITY_TYPES = [
  "smart-file-document",
  "smart-file-version",
  "smart-file-placement",
] as const;

export type SmartFileEntityType = (typeof SMART_FILE_ENTITY_TYPES)[number];

export function validateSmartFileRead(input: unknown): SmartFileRead {
  return SMART_FILE_READ_SCHEMA.parse(input) as SmartFileRead;
}
