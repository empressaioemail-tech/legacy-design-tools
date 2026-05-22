/**
 * Codex Reviewer QA — jurisdiction resolution helpers (CDX-5).
 *
 * CDX-5 is an engagement/submission switcher. Jurisdiction is NOT a
 * runtime override — the planner ruling (2026-05-21) scoped it to
 * follow the engagement: the finding-generation route resolves the
 * code corpus from the engagement server-side, with no per-run
 * jurisdiction-override parameter. These helpers surface *which*
 * jurisdiction that is, so a reviewer can see what corpus a pass was
 * judged against and catch a stale submission snapshot.
 *
 * Pure — no React, no network — so the matching rules unit-test on
 * their own.
 */
import type {
  EngagementSubmissionSummary,
  EngagementSummary,
  JurisdictionSummary,
} from "@workspace/api-client-react";

/** Trim a free-text label to `null` when it carries nothing meaningful. */
function cleanLabel(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/** Fold a jurisdiction label to a comparable key — lowercase, alnum only. */
export function normalizeJurisdiction(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The jurisdiction context for the engagement/submission in view. */
export interface JurisdictionContext {
  /** The engagement's recorded jurisdiction — what a new pass judges
   *  against. `null` when the engagement records none. */
  engagementLabel: string | null;
  /** The jurisdiction snapshot captured on the selected submission at
   *  filing time. `null` when no submission is selected, or the
   *  submission predates the snapshot column. */
  submissionLabel: string | null;
  /** True when the submission was filed under a different jurisdiction
   *  than the engagement now records — a QA-relevant divergence: a new
   *  pass will not judge against the filed jurisdiction. */
  snapshotDiverged: boolean;
}

/**
 * Resolve the jurisdiction context from the selected engagement and
 * submission. The engagement label is authoritative for a *new* pass;
 * the submission label is the denormalized snapshot cortex-api stamped
 * at filing time.
 */
export function resolveJurisdictionContext(
  engagement: Pick<EngagementSummary, "jurisdiction"> | null,
  submission: Pick<EngagementSubmissionSummary, "jurisdiction"> | null,
): JurisdictionContext {
  const engagementLabel = cleanLabel(engagement?.jurisdiction);
  const submissionLabel = cleanLabel(submission?.jurisdiction);
  const snapshotDiverged =
    engagementLabel !== null &&
    submissionLabel !== null &&
    normalizeJurisdiction(engagementLabel) !==
      normalizeJurisdiction(submissionLabel);
  return { engagementLabel, submissionLabel, snapshotDiverged };
}

/**
 * Best-effort match of a free-text jurisdiction label against the
 * indexed code corpora. cortex-api resolves the real corpus key
 * server-side from structured location fields the L-surface does not
 * expose, so this is a label match only — it degrades to `null`
 * rather than guessing when nothing lines up.
 */
export function matchJurisdiction(
  label: string | null,
  jurisdictions: ReadonlyArray<JurisdictionSummary>,
): JurisdictionSummary | null {
  const clean = cleanLabel(label);
  if (clean === null) return null;
  const norm = normalizeJurisdiction(clean);
  if (norm === "") return null;
  return (
    jurisdictions.find(
      (j) =>
        normalizeJurisdiction(j.key) === norm ||
        normalizeJurisdiction(j.displayName) === norm,
    ) ?? null
  );
}

/** Compact corpus descriptor — e.g. "1,240 indexed code atoms". */
export function describeCorpus(jurisdiction: JurisdictionSummary): string {
  const noun = jurisdiction.atomCount === 1 ? "atom" : "atoms";
  return `${jurisdiction.atomCount.toLocaleString()} indexed code ${noun}`;
}
