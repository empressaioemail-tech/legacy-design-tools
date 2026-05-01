/**
 * BriefingPriorNarrativeDiff — lib-level unit suite (Task #389).
 *
 * Pins the behaviour Task #374 lifted into this shared lib so a
 * regression on the diff component surfaces against the lib itself
 * rather than cross-firing in both surface integration suites
 * (`lib/portal-ui/src/components/__tests__/BriefingRecentRunsPanel.test.tsx`
 * and `artifacts/design-tools/src/pages/__tests__/BriefingRecentRunsPanel.test.tsx`).
 *
 * Mirrors the style and structure of the sibling
 * `BriefingPriorSnapshotHeader.test.tsx` suite (Task #361). Drives the
 * real `<BriefingPriorNarrativeDiff />` against the real `diffWords`
 * helper from `@workspace/briefing-diff` — no mocks — so the seam
 * between the two libs is part of what's pinned, not stubbed away.
 *
 * What this suite locks down:
 *   1. All seven A–G rows render with the canonical labels and the
 *      mirrored `briefing-run-prior-section-{key}-{runId}` testids.
 *   2. Empty/whitespace-only prior bodies render the "—" placeholder
 *      and never mount the diff/unchanged children — the placeholder
 *      protects the auditor from staring at a blank label.
 *   3. `null` AND `undefined` current bodies fall through to the
 *      verbatim prior body without crashing inside `diffWords` (which
 *      would blow up on `undefined.split(...)`). The wire schema
 *      marks `section_*` optional and some fixtures omit the field
 *      entirely, so both falsy shapes have to be handled.
 *   4. `prior === current` renders the "(unchanged)" pill on its
 *      mirrored testid and the prior body verbatim — no diff render,
 *      so the auditor isn't asked to re-read identical paragraphs.
 *   5. Genuine edits render the strikethrough-red removed and
 *      underline-green added tokens on their respective mirrored
 *      testids, with surviving tokens plain.
 */
import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { BriefingPriorNarrativeDiff } from "./BriefingPriorNarrativeDiff";
import {
  SECTION_ORDER,
  type PriorNarrativeSnapshot,
} from "./BriefingPriorSnapshotHeader";

const RUN_ID = "gen-prior";

function makeSnapshot(
  overrides: Partial<PriorNarrativeSnapshot> = {},
): PriorNarrativeSnapshot {
  return {
    sectionA: "Prior A body.",
    sectionB: "Prior B body.",
    sectionC: "Prior C body.",
    sectionD: "Prior D body.",
    sectionE: "Prior E body.",
    sectionF: "Prior F body.",
    sectionG: "Prior G body.",
    generatedAt: "2026-04-02T17:00:02.000Z",
    generatedBy: "system:briefing-engine",
    ...overrides,
  };
}

describe("BriefingPriorNarrativeDiff — section row layout", () => {
  it("renders all seven A–G rows with canonical labels and mirrored testids", () => {
    render(
      <BriefingPriorNarrativeDiff
        runGenerationId={RUN_ID}
        priorNarrative={makeSnapshot()}
        currentNarrative={null}
      />,
    );
    // Every section in `SECTION_ORDER` must mount its row and carry
    // the canonical label — the seven rows are the auditor's whole
    // mental map of the prior snapshot, so a missing or relabelled
    // row would silently change the disclosure's contract.
    SECTION_ORDER.forEach(({ key, label }) => {
      const row = screen.getByTestId(
        `briefing-run-prior-section-${key}-${RUN_ID}`,
      );
      expect(row).toHaveTextContent(label);
    });
    // Spot-check the canonical bookend labels match the ones the
    // sibling header suite pins for the clipboard payload — drift
    // between the diff rows and the copy payload would mean the
    // pasted snapshot no longer matches what the auditor sees on
    // screen.
    expect(
      screen.getByTestId(`briefing-run-prior-section-a-${RUN_ID}`),
    ).toHaveTextContent("A — Executive Summary");
    expect(
      screen.getByTestId(`briefing-run-prior-section-g-${RUN_ID}`),
    ).toHaveTextContent("G — Next-Step Checklist");
  });
});

describe("BriefingPriorNarrativeDiff — empty/whitespace prior bodies", () => {
  it("renders the '—' placeholder and never mounts diff/unchanged children when the prior body is null", () => {
    render(
      <BriefingPriorNarrativeDiff
        runGenerationId={RUN_ID}
        priorNarrative={makeSnapshot({ sectionA: null })}
        // Even though the current body is set, the empty prior
        // short-circuits the diff branch — there's nothing on the
        // prior side to strike through.
        currentNarrative={makeSnapshot({ sectionA: "Some current body." })}
      />,
    );
    const row = screen.getByTestId(
      `briefing-run-prior-section-a-${RUN_ID}`,
    );
    expect(row).toHaveTextContent("—");
    expect(
      screen.queryByTestId(`briefing-run-prior-section-diff-a-${RUN_ID}`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(
        `briefing-run-prior-section-unchanged-a-${RUN_ID}`,
      ),
    ).not.toBeInTheDocument();
  });

  it("renders the '—' placeholder for whitespace-only prior bodies (and skips the diff)", () => {
    render(
      <BriefingPriorNarrativeDiff
        runGenerationId={RUN_ID}
        priorNarrative={makeSnapshot({ sectionB: "   \n\t  " })}
        currentNarrative={makeSnapshot({ sectionB: "Some current B body." })}
      />,
    );
    const row = screen.getByTestId(
      `briefing-run-prior-section-b-${RUN_ID}`,
    );
    expect(row).toHaveTextContent("—");
    expect(
      screen.queryByTestId(`briefing-run-prior-section-diff-b-${RUN_ID}`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(
        `briefing-run-prior-section-unchanged-b-${RUN_ID}`,
      ),
    ).not.toBeInTheDocument();
  });
});

describe("BriefingPriorNarrativeDiff — missing current body", () => {
  it("renders the prior body verbatim and skips the diff when currentNarrative is null", () => {
    render(
      <BriefingPriorNarrativeDiff
        runGenerationId={RUN_ID}
        priorNarrative={makeSnapshot({ sectionA: "Verbatim prior body." })}
        currentNarrative={null}
      />,
    );
    const row = screen.getByTestId(
      `briefing-run-prior-section-a-${RUN_ID}`,
    );
    expect(row).toHaveTextContent("Verbatim prior body.");
    // No diff (current half is missing entirely) and no unchanged
    // pill (we have nothing to compare against).
    expect(
      screen.queryByTestId(`briefing-run-prior-section-diff-a-${RUN_ID}`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(
        `briefing-run-prior-section-unchanged-a-${RUN_ID}`,
      ),
    ).not.toBeInTheDocument();
  });

  it("renders the prior body verbatim and never crashes inside diffWords when an individual current section is null", () => {
    render(
      <BriefingPriorNarrativeDiff
        runGenerationId={RUN_ID}
        priorNarrative={makeSnapshot({ sectionA: "Prior body present." })}
        // Other sections set, but `sectionA` is explicitly null —
        // `diffWords` would crash on `null.split(...)` if the
        // component didn't guard the type.
        currentNarrative={makeSnapshot({ sectionA: null })}
      />,
    );
    const row = screen.getByTestId(
      `briefing-run-prior-section-a-${RUN_ID}`,
    );
    expect(row).toHaveTextContent("Prior body present.");
    expect(
      screen.queryByTestId(`briefing-run-prior-section-diff-a-${RUN_ID}`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(
        `briefing-run-prior-section-unchanged-a-${RUN_ID}`,
      ),
    ).not.toBeInTheDocument();
  });

  it("renders the prior body verbatim and never crashes inside diffWords when an individual current section is undefined (omitted)", () => {
    // The wire schema marks `section_*` optional, so some fixtures
    // omit the field entirely and `pickSection` reads back
    // `undefined` rather than `null`. The component has to handle
    // both falsy shapes — comparing a string to `undefined` would
    // otherwise propagate through to `diffWords` and crash on
    // `undefined.split(...)`. The cast bypasses the stricter
    // `string | null` type to mimic the wire-level shape.
    const currentWithMissingA = makeSnapshot();
    delete (currentWithMissingA as Partial<PriorNarrativeSnapshot>).sectionA;

    render(
      <BriefingPriorNarrativeDiff
        runGenerationId={RUN_ID}
        priorNarrative={makeSnapshot({ sectionA: "Prior body present." })}
        currentNarrative={currentWithMissingA}
      />,
    );
    const row = screen.getByTestId(
      `briefing-run-prior-section-a-${RUN_ID}`,
    );
    expect(row).toHaveTextContent("Prior body present.");
    expect(
      screen.queryByTestId(`briefing-run-prior-section-diff-a-${RUN_ID}`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(
        `briefing-run-prior-section-unchanged-a-${RUN_ID}`,
      ),
    ).not.toBeInTheDocument();
  });
});

describe("BriefingPriorNarrativeDiff — unchanged section", () => {
  it("renders the '(unchanged)' pill and the prior body verbatim when prior === current, without mounting the diff", () => {
    render(
      <BriefingPriorNarrativeDiff
        runGenerationId={RUN_ID}
        priorNarrative={makeSnapshot({ sectionA: "Identical body." })}
        currentNarrative={makeSnapshot({ sectionA: "Identical body." })}
      />,
    );
    const row = screen.getByTestId(
      `briefing-run-prior-section-a-${RUN_ID}`,
    );
    // The unchanged pill mounts on its mirrored testid…
    const pill = within(row).getByTestId(
      `briefing-run-prior-section-unchanged-a-${RUN_ID}`,
    );
    expect(pill).toHaveTextContent(/unchanged/i);
    // …the prior body still renders verbatim alongside it…
    expect(row).toHaveTextContent("Identical body.");
    // …and the diff span is NOT mounted (the auditor isn't asked
    // to re-read an identical paragraph wrapped in equal-tokens).
    expect(
      within(row).queryByTestId(
        `briefing-run-prior-section-diff-a-${RUN_ID}`,
      ),
    ).not.toBeInTheDocument();
  });

  it("detects the unchanged state per-section, not as a global flag", () => {
    render(
      <BriefingPriorNarrativeDiff
        runGenerationId={RUN_ID}
        priorNarrative={makeSnapshot({
          sectionA: "Identical body.",
          sectionG: "Different prior G.",
        })}
        currentNarrative={makeSnapshot({
          sectionA: "Identical body.",
          sectionG: "Different current G.",
        })}
      />,
    );
    // Section A has the unchanged pill (and no diff span)…
    expect(
      screen.getByTestId(
        `briefing-run-prior-section-unchanged-a-${RUN_ID}`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(`briefing-run-prior-section-diff-a-${RUN_ID}`),
    ).not.toBeInTheDocument();
    // …while section G keeps the diff span (and no unchanged pill).
    expect(
      screen.getByTestId(`briefing-run-prior-section-diff-g-${RUN_ID}`),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(
        `briefing-run-prior-section-unchanged-g-${RUN_ID}`,
      ),
    ).not.toBeInTheDocument();
  });
});

describe("BriefingPriorNarrativeDiff — genuine edit diff tokens", () => {
  it("renders the strikethrough-red removed and underline-green added tokens on their mirrored testids", () => {
    render(
      <BriefingPriorNarrativeDiff
        runGenerationId={RUN_ID}
        priorNarrative={makeSnapshot({
          sectionA: "The buildable area is 4500 square feet.",
        })}
        currentNarrative={makeSnapshot({
          sectionA: "The buildable area is 5200 square feet.",
        })}
      />,
    );
    const diff = screen.getByTestId(
      `briefing-run-prior-section-diff-a-${RUN_ID}`,
    );
    // The dropped "4500" token survives on the prior side wrapped
    // in a strike-through span; the inserted "5200" token shows up
    // in the same diff span. Together they tell the auditor exactly
    // what the regeneration changed.
    expect(diff).toHaveTextContent(/4500/);
    expect(diff).toHaveTextContent(/5200/);

    const removed = within(diff).getByTestId(
      `briefing-run-prior-section-diff-removed-a-${RUN_ID}`,
    );
    expect(removed).toHaveTextContent("4500");
    // Strikethrough is the auditor's primary visual signal that the
    // token was dropped — pin the inline style so a refactor that
    // drops the styling regresses against this suite rather than
    // the surface mirrors. (We pin only the text-decoration here
    // because happy-dom collapses CSS-variable values in inline
    // styles, so a `color: var(--danger-text)` assertion would
    // false-fail on the runner without telling us anything useful.)
    expect(removed).toHaveStyle({ textDecoration: "line-through" });

    const added = within(diff).getByTestId(
      `briefing-run-prior-section-diff-added-a-${RUN_ID}`,
    );
    expect(added).toHaveTextContent("5200");
    // Underline mirrors the removed-token contract on the inserted
    // side.
    expect(added).toHaveStyle({ textDecoration: "underline" });

    // The unchanged pill is mutually exclusive with the diff render.
    expect(
      screen.queryByTestId(
        `briefing-run-prior-section-unchanged-a-${RUN_ID}`,
      ),
    ).not.toBeInTheDocument();
  });

  it("preserves the surviving equal tokens between the removed/added pair", () => {
    render(
      <BriefingPriorNarrativeDiff
        runGenerationId={RUN_ID}
        priorNarrative={makeSnapshot({
          sectionA: "The buildable area is 4500 square feet.",
        })}
        currentNarrative={makeSnapshot({
          sectionA: "The buildable area is 5200 square feet.",
        })}
      />,
    );
    const diff = screen.getByTestId(
      `briefing-run-prior-section-diff-a-${RUN_ID}`,
    );
    // The shared prefix and suffix survive into the diff render so
    // the auditor reads a single sentence rather than two parallel
    // ones — proves the equal-token branch is hit alongside the
    // removed/added branches.
    expect(diff).toHaveTextContent(/The buildable area is/);
    expect(diff).toHaveTextContent(/square feet\./);
  });
});
