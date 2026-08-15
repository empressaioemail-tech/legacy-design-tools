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
 *   G-34 HAS NOW LANDED and it DID reshape the shape, exactly as predicted:
 *   the read path's return type changed from `SmartFileReadView | null` to a
 *   discriminated union with no null member. The promotion VERDICT for this
 *   row is recorded in `_inbox/2026-08-15_a2_close.json`; the promotion itself
 *   is deliberately NOT performed here.
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

/* ------------------------------------------------------------------ *
 * TYPED ABSENCE (OPS-17 PLAN-ROW G-34)
 * ------------------------------------------------------------------ */

/**
 * The status set for a Smart Files read.
 *
 * DERIVED for the document layer, not copied from the spine. The spine carries
 * six `displayState` values plus an `isPartial` boolean
 * (`countyLedgerCompute.ts:38-46`), of which only three are STORED
 * (`countyFacetCoverage.ts:133-141`). Those are jurisdiction-layer states over
 * a population of parcels; a document is a single thing, so the axes differ.
 *
 * The five, and why each exists:
 *
 *   `held`
 *     The document is held and the requested version resolved. Carries content
 *     plus the full stamp. (Spine analogue: `satisfied-present`.)
 *
 *   `absent-verified`
 *     We LOOKED and positively determined the document does not exist. A REAL
 *     ANSWER, renderable as one — "Bastrop has no short-term-rental ordinance"
 *     is a finding, not a coverage hole. Producible ONLY from a recorded
 *     determination row, never from an empty query.
 *     (Spine analogue: `satisfied-absent`.)
 *
 *   `not-sought`
 *     We have never looked. An honest statement about OUR COVERAGE, making no
 *     claim about the world either way. This is where an empty lookup lands,
 *     which is precisely what keeps an empty lookup from becoming an absence.
 *     (Spine analogue: `not-yet`.)
 *
 *   `lookup-failed`
 *     We tried to look and the ATTEMPT failed. We know nothing about whether
 *     the document exists. Distinct from `absent-verified` because a probe
 *     failure wearing the costume of a data gap is the exact defect the spine
 *     taxonomy was built to kill. (Spine analogue: `derivation-indeterminate`.)
 *
 *   `held-version-absent`
 *     The document IS held; the specific version requested is not. NO SPINE
 *     ANALOGUE — the spine has no version axis. This exists because the G-14
 *     store returned the identical `null` from two different sites
 *     (`smartFileStore.ts:307` document-missing and `:322` version-missing),
 *     conflating "we do not have this document" with "we have it but not that
 *     revision". The second is not an absence at all.
 *
 * DELIBERATELY NOT CARRIED from the spine, each because nothing at this layer
 * could ever produce it — and a status nobody can produce is dead weight:
 *   `no-atom`   — "does an atom family exist for this subject": a registry
 *                 question about the writer fleet. Smart Files is one declared
 *                 family; there is no per-document family-existence axis.
 *   `no-writer` — "the family exists but nothing produces coverage for this
 *                 cell": a capture-pipeline question (G-44), invisible from
 *                 the store, and permanently unset if carried here.
 *   `isPartial` — a RATIO over a population against a coverage threshold. A
 *                 single document is not partially held: the version row is
 *                 there or it is not. Corpus-level partiality is G-20, and it
 *                 belongs on a corpus, never on a single read.
 */
export const SMART_FILE_READ_STATUSES = [
  "held",
  "absent-verified",
  "not-sought",
  "lookup-failed",
  "held-version-absent",
] as const;

export type SmartFileReadStatus = (typeof SMART_FILE_READ_STATUSES)[number];

/**
 * The statuses that represent an ABSENCE of servable content. Exhaustive by
 * construction: it is every status except `held`, derived rather than
 * hand-listed, so adding a sixth status cannot silently omit it here.
 */
export type SmartFileAbsentStatus = Exclude<SmartFileReadStatus, "held">;

/**
 * WHY a document is not being served. Carried by every absence.
 *
 * `basis` is REQUIRED and is a non-empty string. "Not found" is not a basis;
 * WHY it is not found is. An absence without its citation is unfalsifiable —
 * a later reader cannot distinguish a real determination from a placeholder.
 *
 * For `absent-verified` and `lookup-failed` this is copied from the recorded
 * determination row, whose own `basis` column is NOT NULL and check-constrained
 * non-empty at the DATABASE, so the requirement survives a caller that bypasses
 * this type entirely.
 */
export interface SmartFileAbsenceBasis {
  /** WHY, in words a reader can act on. Never "not found". */
  basis: string;
  /**
   * What established this — a CLI name, a sweep id, an operator handle. Null
   * ONLY for `not-sought`, where by definition no instrument has run.
   */
  determinedBy: string | null;
  /**
   * When the determination was made. Null ONLY for `not-sought`: never having
   * looked has no timestamp, and inventing one would fabricate a freshness
   * claim about a lookup that did not happen.
   */
  determinedAt: string | null;
  /**
   * The source consulted, when there is a URL for it. Null is a POSITIVE "no
   * single source URL" (e.g. a phone call to a clerk), not "unknown".
   */
  sourceUri: string | null;
}

export const SMART_FILE_ABSENCE_BASIS_SCHEMA = z.object({
  basis: z.string().min(1),
  determinedBy: z.string().min(1).nullable(),
  determinedAt: z.string().min(1).nullable(),
  sourceUri: z.string().min(1).nullable(),
});

/**
 * A typed, provenanced absence.
 *
 * Note what is NOT optional: `status`, `basis`, and `freshness`. An absence
 * carries a freshness stamp for the same reason a presence does — a VERIFIED
 * ABSENCE DECAYS. "We checked in 2019 and there was no STR ordinance" is not
 * evidence about today, and an absence served without a stamp invites exactly
 * that misreading.
 *
 * For `not-sought` the freshness stamp is deliberately ABSENT (null) rather
 * than synthesized: there is no determination event to age. A stamp there would
 * be a fabricated measurement, which is worse than none.
 */
export interface SmartFileAbsence {
  status: SmartFileAbsentStatus;
  /** The entityId asked for, echoed so a caller never re-derives it. */
  entityId: string;
  jurisdictionFips: string;
  docSlug: string;
  /** WHY this is not being served. */
  absence: SmartFileAbsenceBasis;
  /**
   * Freshness of the DETERMINATION. Null for `not-sought` only (nothing to
   * age). Non-null for every other absence status, so a stale determination is
   * visibly stale rather than quietly authoritative.
   */
  freshness: SmartFileFreshness | null;
  /**
   * For `held-version-absent` only: the document IS held, so its identity and
   * the versions that DO exist travel with the absence — a caller asking for
   * version 7 of a 3-version document should learn it can have 1, 2 or 3.
   * Null for every other status.
   */
  heldDocument: {
    title: string;
    accessPolicy: SmartFileAccessPolicy;
    currentVersion: number;
    requestedVersion: number;
  } | null;
}

export const SMART_FILE_ABSENCE_SCHEMA = z.object({
  status: z.enum(["absent-verified", "not-sought", "lookup-failed", "held-version-absent"]),
  entityId: z.string().min(1),
  jurisdictionFips: z.string().min(1),
  docSlug: z.string().min(1),
  absence: SMART_FILE_ABSENCE_BASIS_SCHEMA,
  freshness: SMART_FILE_FRESHNESS_SCHEMA.nullable(),
  heldDocument: z
    .object({
      title: z.string().min(1),
      accessPolicy: SMART_FILE_ACCESS_POLICY_SCHEMA,
      currentVersion: z.number().int().positive(),
      requestedVersion: z.number().int().positive(),
    })
    .nullable(),
});

/**
 * A PRESENT read — the `held` arm of the union.
 *
 * Structurally identical to `SmartFileRead` plus the discriminant. The
 * discriminant is what lets a caller narrow with `if (r.status === "held")`
 * instead of a truthiness check that a null could pass.
 */
export interface SmartFilePresent extends SmartFileRead {
  status: "held";
}

/**
 * THE READ RESULT — a discriminated union with NO null member.
 *
 * This is the G-34 deliverable in one line. The G-14 read path returned
 * `SmartFileReadView | null`, and "do not render that null as a data gap" was a
 * DOC COMMENT — a rule a caller in another file never sees. DEV_PROCESS: a
 * guardrail that does not survive a clone is not a guardrail.
 *
 * Because `null` and `undefined` are not members of this union, a read path
 * that tries to return a bare null is a COMPILE ERROR, and a caller cannot
 * reach content without first narrowing on `status`. The rule moved from
 * reminder to mechanism.
 */
export type SmartFileReadResult = SmartFilePresent | SmartFileAbsence;

/** Narrowing helper. `result.status === "held"` inline works identically. */
export function isSmartFileHeld(
  result: SmartFileReadResult,
): result is SmartFilePresent {
  return result.status === "held";
}

/**
 * True when this absence is a REAL ANSWER about the world rather than a
 * statement about our own coverage.
 *
 * The distinction a surface needs: `absent-verified` renders as "there is no
 * such document, and here is how we know", while `not-sought` and
 * `lookup-failed` render as "we cannot tell you". Getting this backwards in
 * either direction is a customer-visible lie, which is why it is a named
 * function rather than left to each caller to re-derive.
 */
export function isSmartFileVerifiedAbsent(
  result: SmartFileReadResult,
): boolean {
  return result.status === "absent-verified";
}

export function validateSmartFileAbsence(input: unknown): SmartFileAbsence {
  return SMART_FILE_ABSENCE_SCHEMA.parse(input) as SmartFileAbsence;
}

export const SMART_FILE_ENTITY_TYPES = [
  "smart-file-document",
  "smart-file-version",
  "smart-file-placement",
] as const;

export type SmartFileEntityType = (typeof SMART_FILE_ENTITY_TYPES)[number];

export function validateSmartFileRead(input: unknown): SmartFileRead {
  return SMART_FILE_READ_SCHEMA.parse(input) as SmartFileRead;
}
