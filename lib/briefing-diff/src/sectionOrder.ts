/**
 * Canonical A–G briefing section ordering and the column-router both
 * Plan Review and design-tools walk when laying out the prior-narrative
 * diff and when assembling the "Copy plain text" payload.
 *
 * Lifted out of `@workspace/briefing-prior-snapshot` (Task #388) to
 * break the workspace dependency cycle that arose when Task #373
 * added `briefing-prior-snapshot` as a dep of `@workspace/portal-ui`
 * so the panel could import `SECTION_ORDER` / `pickSection` directly:
 * `briefing-prior-snapshot` already depends on `portal-ui` (for
 * `CopyPlainTextButton`), so `pnpm install` started warning about the
 * cycle. These four exports are pure data + a pure function with no
 * React dependency, so they sit naturally in `briefing-diff` — a
 * leaf lib both `portal-ui` and `briefing-prior-snapshot` already
 * consume — instead of forming the closing edge of a cycle.
 *
 * `briefing-prior-snapshot` continues to re-export the same names so
 * existing artifact-side imports keep working unchanged.
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
