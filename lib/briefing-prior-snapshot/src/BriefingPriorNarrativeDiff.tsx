import { diffWords } from "@workspace/briefing-diff";

import {
  SECTION_ORDER,
  pickSection,
  type PriorNarrativeSnapshot,
} from "./BriefingPriorSnapshotHeader";

/**
 * BriefingPriorNarrativeDiff — Task #374.
 *
 * Renders the seven A–G word-level diff rows that sit directly
 * underneath the `<BriefingPriorSnapshotHeader />` (Task #355) on
 * the prior-snapshot disclosure of a `BriefingRecentRunsPanel` row.
 * Each row labels the section, prefixes a "(unchanged)" pill when
 * the prior body equals the current body, and otherwise renders
 * `diffWords(priorBody, currentBody)` with surviving tokens plain,
 * dropped tokens strikethrough/red, and inserted tokens
 * underlined/green so an auditor sees both sides of the edit
 * inline. Empty prior bodies render as the panel's "—" placeholder.
 *
 * Lifted out of the byte-identical ~140-line JSX subtrees that
 * used to live in
 *   `lib/portal-ui/src/components/BriefingRecentRunsPanel.tsx`
 *     (mounted by Plan Review's `EngagementDetail`)
 *   `artifacts/design-tools/src/pages/EngagementDetail.tsx`
 * because both copies were pinned by mirror integration tests on
 * each surface — exactly the drift signal this lift removes. A
 * tweak to the diff token styling or testid shape on one surface
 * would otherwise only surface as an integration-test failure on
 * the *other* one.
 *
 * Testids it renders (the parent surfaces and existing mirror
 * tests pin these by name — kept byte-identical with the inline
 * copies that lived in the two surfaces before this lift):
 *   - `briefing-run-prior-section-${key}-${runGenerationId}`
 *   - `briefing-run-prior-section-unchanged-${key}-${runGenerationId}`
 *   - `briefing-run-prior-section-diff-${key}-${runGenerationId}`
 *   - `briefing-run-prior-section-diff-removed-${key}-${runGenerationId}`
 *   - `briefing-run-prior-section-diff-added-${key}-${runGenerationId}`
 *
 * Props are deliberately structural — both surfaces' wire-level
 * `EngagementBriefingNarrative` shape is a superset of
 * `PriorNarrativeSnapshot` (same seven `section_a..g` columns plus
 * the per-row provenance fields), so the existing call-site values
 * flow through without per-surface adapter shims. `currentNarrative`
 * is allowed to be `null` so the panel can mount the diff before
 * the current narrative read has resolved without crashing.
 *
 * Behavior pinned by the existing test suites on both surfaces:
 *   - When the prior body is missing/empty, the row renders "—"
 *     instead of attempting a diff (no `briefing-run-prior-section-
 *     diff-*` testid is mounted and `diffWords` is never called).
 *   - When the current body is `null` OR `undefined`, the row falls
 *     through to the verbatim prior body — never to `diffWords`,
 *     which would crash on `undefined.split(...)`. The wire schema
 *     marks `section_*` optional and some test fixtures omit the
 *     field entirely, so both falsy shapes have to be handled.
 *   - When prior === current, the row renders the "(unchanged)"
 *     pill on its mirrored testid and the prior body verbatim
 *     (no diff render, so the auditor isn't asked to re-read
 *     identical paragraphs).
 *   - Otherwise the row mounts the diff span with the
 *     strikethrough-red removed / underline-green added tokens and
 *     plain equal tokens.
 */
export function BriefingPriorNarrativeDiff({
  runGenerationId,
  priorNarrative,
  currentNarrative,
}: {
  runGenerationId: string;
  priorNarrative: PriorNarrativeSnapshot;
  currentNarrative: PriorNarrativeSnapshot | null;
}) {
  return (
    <>
      {SECTION_ORDER.map(({ key, label }) => {
        const priorBody = pickSection(priorNarrative, key);
        const currentBody = pickSection(currentNarrative, key);
        const priorIsEmpty = !priorBody || priorBody.trim().length === 0;
        // pickSection returns the raw column value, which can be
        // `null` (column is NULL) OR `undefined` (the wire schema
        // marks the field optional and the test fixture omitted
        // it). Treat both as "no current body to diff against" —
        // comparing a string to undefined would otherwise propagate
        // through to `diffWords` and crash on `undefined.split(...)`.
        const currentBodyStr =
          typeof currentBody === "string" ? currentBody : null;
        const sameAsCurrent =
          !priorIsEmpty &&
          currentBodyStr !== null &&
          priorBody === currentBodyStr;
        const shouldDiff =
          !priorIsEmpty && currentBodyStr !== null && !sameAsCurrent;
        return (
          <div
            key={key}
            data-testid={`briefing-run-prior-section-${key}-${runGenerationId}`}
            style={{
              fontSize: 12,
              color: priorIsEmpty
                ? "var(--text-muted)"
                : "var(--text-default)",
            }}
          >
            <span
              style={{
                fontWeight: 600,
                marginRight: 6,
              }}
            >
              {label}
            </span>
            {sameAsCurrent && (
              <span
                data-testid={`briefing-run-prior-section-unchanged-${key}-${runGenerationId}`}
                style={{
                  fontSize: 10,
                  padding: "1px 6px",
                  borderRadius: 4,
                  background: "var(--surface-2, transparent)",
                  color: "var(--text-muted)",
                  marginRight: 6,
                  textTransform: "uppercase",
                  letterSpacing: 0.3,
                }}
              >
                unchanged
              </span>
            )}
            <span
              style={{
                whiteSpace: "pre-wrap",
                lineHeight: 1.5,
              }}
            >
              {priorIsEmpty ? (
                "—"
              ) : shouldDiff ? (
                // Word-level diff: render surviving tokens plain,
                // dropped tokens strikethrough/red, and inserted
                // tokens underlined/green so the auditor sees both
                // sides of the edit inline. The diff is wrapped in
                // a single span so the white-space rule above
                // still applies.
                <span
                  data-testid={`briefing-run-prior-section-diff-${key}-${runGenerationId}`}
                >
                  {diffWords(priorBody, currentBodyStr as string).map(
                    (op, idx) => {
                      if (op.type === "equal") {
                        return <span key={idx}>{op.text}</span>;
                      }
                      if (op.type === "removed") {
                        return (
                          <span
                            key={idx}
                            data-testid={`briefing-run-prior-section-diff-removed-${key}-${runGenerationId}`}
                            style={{
                              textDecoration: "line-through",
                              color: "var(--danger-text)",
                              background: "var(--danger-dim)",
                            }}
                          >
                            {op.text}
                          </span>
                        );
                      }
                      return (
                        <span
                          key={idx}
                          data-testid={`briefing-run-prior-section-diff-added-${key}-${runGenerationId}`}
                          style={{
                            textDecoration: "underline",
                            color: "var(--success-text)",
                            background: "var(--success-dim)",
                          }}
                        >
                          {op.text}
                        </span>
                      );
                    },
                  )}
                </span>
              ) : (
                priorBody
              )}
            </span>
          </div>
        );
      })}
    </>
  );
}
