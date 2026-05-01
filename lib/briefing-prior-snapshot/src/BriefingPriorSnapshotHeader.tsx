import { formatBriefingActor } from "@workspace/briefing-diff";
import { CopyPlainTextButton } from "@workspace/portal-ui";

/**
 * The seven A–G briefing sections, in the canonical render order
 * both Plan Review and design-tools walk when laying out the
 * prior-narrative diff and when assembling the "Copy plain text"
 * payload. Lifted into the shared lib so the labels, ordering, and
 * pasted-snapshot shape stay in lock-step across the two surfaces
 * — divergence here is exactly the drift class Task #355 closes.
 */
export type BriefingSectionKey = "a" | "b" | "c" | "d" | "e" | "f" | "g";

export const SECTION_ORDER: ReadonlyArray<{
  key: BriefingSectionKey;
  label: string;
}> = [
  { key: "a", label: "A — Executive Summary" },
  { key: "b", label: "B — Threshold Issues" },
  { key: "c", label: "C — Regulatory Gates" },
  { key: "d", label: "D — Site Infrastructure" },
  { key: "e", label: "E — Buildable Envelope" },
  { key: "f", label: "F — Neighboring Context" },
  { key: "g", label: "G — Next-Step Checklist" },
];

/**
 * Minimal shape the prior-snapshot header needs from the wire-level
 * `priorNarrative` envelope. Mirrors the seven section_a..g columns
 * plus the per-row provenance fields. Fields are intentionally
 * permissive (`null` allowed everywhere) so legacy backups — where
 * `generatedAt` and/or `generatedBy` post-dated the section_*
 * columns on some installs — render only the half that's set
 * instead of "by null" / "Generated —".
 */
export interface PriorNarrativeSnapshot {
  sectionA: string | null;
  sectionB: string | null;
  sectionC: string | null;
  sectionD: string | null;
  sectionE: string | null;
  sectionF: string | null;
  sectionG: string | null;
  generatedAt: string | Date | null;
  generatedBy: string | null;
}

export function pickSection(
  narrative: PriorNarrativeSnapshot | null,
  key: BriefingSectionKey,
): string | null {
  if (!narrative) return null;
  switch (key) {
    case "a":
      return narrative.sectionA;
    case "b":
      return narrative.sectionB;
    case "c":
      return narrative.sectionC;
    case "d":
      return narrative.sectionD;
    case "e":
      return narrative.sectionE;
    case "f":
      return narrative.sectionF;
    case "g":
      return narrative.sectionG;
  }
}

export interface FormattedTimestamp {
  /** Visible text rendered next to "Generated ". */
  text: string;
  /** Optional `title=` attribute for hover-reveal of the precise instant. */
  title?: string;
}

/**
 * Per-surface timestamp formatter for the meta line's `generatedAt`.
 *
 * Design-tools renders the absolute locale stamp inline ("Generated
 * 4/2/2026, 10:00:02 AM") and has no tooltip. Plan Review renders the
 * relative-time bucket ("Generated 5 min ago") with the absolute
 * stamp surfaced via `title=`. Both behaviors are valid product
 * choices for their audience, so the shared component takes the
 * formatter as a prop and defaults to design-tools' historical
 * absolute-stamp behavior so an unconfigured caller doesn't silently
 * change the design-tools surface.
 */
export type FormatGeneratedAt = (raw: Date | string) => FormattedTimestamp;

const DEFAULT_FORMAT_GENERATED_AT: FormatGeneratedAt = (raw) => ({
  text: new Date(raw).toLocaleString(),
});

/**
 * Builds the "Copy plain text" payload — seven `Label\n\nbody`
 * blocks separated by blank lines so the pasted snapshot is
 * readable in Slack or a ticket without manual reformatting.
 * Empty sections render as "—" so the pasted output preserves
 * the panel's own placeholder rather than leaving the auditor
 * staring at a blank label.
 */
export function buildPriorSnapshotClipboardText(
  priorNarrative: PriorNarrativeSnapshot,
): string {
  return SECTION_ORDER.map(({ key, label }) => {
    const body = pickSection(priorNarrative, key) ?? "";
    return `${label}\n\n${body.trim() || "—"}`;
  }).join("\n\n");
}

/**
 * BriefingPriorSnapshotHeader — Task #355.
 *
 * Renders the title row, the "Generated <when> by <actor>" meta
 * line, and the "Copy plain text" button (with its 2 s "Copied!"
 * success / "Couldn't copy" failure feedback pill) for the prior-
 * snapshot disclosure on a single `BriefingRecentRunsPanel` row.
 * The parent panel owns the surrounding container
 * (`briefing-run-prior-narrative-${runId}`) and the per-section
 * diff blocks; this component owns just the header so the JSX,
 * testids, and 2 s revert timing stay byte-identical between the
 * Plan Review and design-tools surfaces without copy-pasting two
 * parallel subtrees.
 *
 * The Copy-plain-text button itself is delegated to
 * `<CopyPlainTextButton />` in `@workspace/portal-ui` (Task #350,
 * which landed on `main` in parallel with this header lift). That
 * component owns the discriminated success/error `copyResult`
 * state, the ~2 s revert timer, the unmount cleanup, the
 * `navigator.clipboard` presence + `writeText` resolve / reject
 * branches, and the `briefing-run-prior-narrative-copy-*` testids.
 * Delegating here means there is exactly one implementation of the
 * copy-button behavior across the whole repo — both this header
 * lift and Task #350's button lift survive without duplicating the
 * timer / state / failure logic in two libs.
 *
 * Testids it renders (the parent and tests pin these by name):
 *   - `briefing-run-prior-narrative-meta-${runGenerationId}`
 *   - `briefing-run-prior-narrative-generated-at-${runGenerationId}`
 *   - `briefing-run-prior-narrative-generated-by-${runGenerationId}`
 *   - `briefing-run-prior-narrative-copy-${runGenerationId}`         (CopyPlainTextButton default prefix)
 *   - `briefing-run-prior-narrative-copy-confirm-${runGenerationId}` (CopyPlainTextButton default prefix)
 *   - `briefing-run-prior-narrative-copy-error-${runGenerationId}`   (CopyPlainTextButton default prefix)
 *
 * Behavior pinned by the existing test suites on both surfaces:
 *   - The meta line renders only the half that's present so legacy
 *     backups with one of `generatedAt` / `generatedBy` null never
 *     show "by null" or "Generated —".
 *   - "system:briefing-engine" is rewritten to "Briefing engine
 *     (mock)" via `formatBriefingActor` so the auditor sees the
 *     friendly label, identically on both surfaces.
 *   - Copy-button success / failure / 2 s revert / unmount cleanup
 *     behavior is whatever `<CopyPlainTextButton />` provides —
 *     the surface tests still pass because the testids and
 *     payload are unchanged.
 */
export function BriefingPriorSnapshotHeader({
  runGenerationId,
  priorNarrative,
  formatGeneratedAt = DEFAULT_FORMAT_GENERATED_AT,
}: {
  runGenerationId: string;
  priorNarrative: PriorNarrativeSnapshot;
  formatGeneratedAt?: FormatGeneratedAt;
}) {
  const formattedGeneratedAt =
    priorNarrative.generatedAt !== null
      ? formatGeneratedAt(priorNarrative.generatedAt)
      : null;
  const friendlyActor =
    priorNarrative.generatedBy !== null
      ? (formatBriefingActor(priorNarrative.generatedBy) ??
        priorNarrative.generatedBy)
      : null;
  const hasMeta = formattedGeneratedAt !== null || friendlyActor !== null;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "space-between",
        gap: 12,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
          minWidth: 0,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: "var(--text-default)",
            textTransform: "uppercase",
            letterSpacing: 0.3,
          }}
        >
          Narrative on screen before this run was overwritten
        </div>
        {hasMeta && (
          <div
            data-testid={`briefing-run-prior-narrative-meta-${runGenerationId}`}
            style={{
              fontSize: 11,
              color: "var(--text-muted)",
            }}
          >
            {formattedGeneratedAt !== null && (
              <span
                data-testid={`briefing-run-prior-narrative-generated-at-${runGenerationId}`}
                title={formattedGeneratedAt.title}
              >
                Generated {formattedGeneratedAt.text}
              </span>
            )}
            {friendlyActor !== null && (
              <>
                {formattedGeneratedAt !== null ? " " : ""}
                <span
                  data-testid={`briefing-run-prior-narrative-generated-by-${runGenerationId}`}
                >
                  by {friendlyActor}
                </span>
              </>
            )}
          </div>
        )}
      </div>
      <CopyPlainTextButton
        generationId={runGenerationId}
        text={buildPriorSnapshotClipboardText(priorNarrative)}
      />
    </div>
  );
}
