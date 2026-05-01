/**
 * BriefingPriorSnapshotHeader — lib-level unit suite (Task #361).
 *
 * Pins the behaviour Task #355 lifted into this shared lib so a
 * regression here surfaces against the lib itself instead of
 * cross-firing in both artifact-side integration suites
 * (`artifacts/plan-review/src/components/__tests__/BriefingRecentRunsPanel.test.tsx`
 * and `artifacts/design-tools/src/pages/__tests__/BriefingRecentRunsPanel.test.tsx`).
 *
 * What this suite locks down:
 *   1. Meta-line conditional rendering — only the half (`generatedAt`
 *      or `generatedBy`) that's set is shown so legacy backups never
 *      render "by null" or "Generated —", and the meta line is
 *      omitted entirely when both are null.
 *   2. `formatBriefingActor` rewrite — the mock "system:briefing-engine"
 *      token is rendered as the friendly "Briefing engine (mock)"
 *      label both surfaces share.
 *   3. Default `formatGeneratedAt` falls through to
 *      `new Date(raw).toLocaleString()` so an unconfigured caller
 *      doesn't silently change the design-tools surface's historical
 *      absolute-stamp behaviour.
 *   4. `buildPriorSnapshotClipboardText` produces the seven A–G
 *      `Label\n\nbody` blocks separated by blank lines, with empty
 *      sections rendered as "—" so the pasted output preserves the
 *      panel's placeholder.
 *   5. Silent fall-back when `navigator.clipboard` is missing — the
 *      button must NOT show "Copied!" (no false positive) and must
 *      NOT throw inside the click handler; instead it surfaces the
 *      "Couldn't copy" pill on the mirrored testid.
 *   6. The 2 s "Copied!" success pill reverts after the
 *      `COPY_FEEDBACK_MS` window via fake timers, leaving the
 *      button back at its idle "Copy plain text" label.
 *
 * The header delegates the actual button behaviour to
 * `<CopyPlainTextButton />` from `@workspace/portal-ui`; the suite
 * intentionally drives the button through the real component so the
 * shared seam between the two libs is part of what's pinned, not
 * mocked away.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import {
  render,
  screen,
  fireEvent,
  act,
  waitFor,
  within,
} from "@testing-library/react";

import {
  BriefingPriorSnapshotHeader,
  buildPriorSnapshotClipboardText,
  pickSection,
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

// Restoring the `navigator.clipboard` descriptor between tests is
// critical — a leaked override (rejecting / undefined) would silently
// flip a sibling test's success-path assertion into the failure
// branch. We snapshot the original descriptor in `beforeEach` and
// reinstate it in `afterEach` regardless of whether the test mutated
// it, mirroring the pattern used in the two artifact integration
// suites (Task #345).
let originalClipboardDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
    navigator,
    "clipboard",
  );
});

afterEach(() => {
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
  } else {
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  }
});

describe("BriefingPriorSnapshotHeader — meta line", () => {
  it("rewrites the system:briefing-engine actor to the friendly 'Briefing engine (mock)' label", () => {
    render(
      <BriefingPriorSnapshotHeader
        runGenerationId={RUN_ID}
        priorNarrative={makeSnapshot({
          generatedBy: "system:briefing-engine",
        })}
      />,
    );
    const meta = screen.getByTestId(
      `briefing-run-prior-narrative-meta-${RUN_ID}`,
    );
    expect(
      within(meta).getByTestId(
        `briefing-run-prior-narrative-generated-by-${RUN_ID}`,
      ),
    ).toHaveTextContent(/by Briefing engine \(mock\)/);
    // The raw token must NOT leak into the rendered label.
    expect(meta).not.toHaveTextContent("system:briefing-engine");
  });

  it("renders only the 'Generated …' half when generatedBy is null (legacy backup)", () => {
    render(
      <BriefingPriorSnapshotHeader
        runGenerationId={RUN_ID}
        priorNarrative={makeSnapshot({ generatedBy: null })}
      />,
    );
    const meta = screen.getByTestId(
      `briefing-run-prior-narrative-meta-${RUN_ID}`,
    );
    expect(
      within(meta).getByTestId(
        `briefing-run-prior-narrative-generated-at-${RUN_ID}`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId(
        `briefing-run-prior-narrative-generated-by-${RUN_ID}`,
      ),
    ).not.toBeInTheDocument();
    // The bare word "by" must not be rendered as a stray suffix.
    expect(meta).not.toHaveTextContent(/\bby\b/);
  });

  it("renders only the 'by …' half when generatedAt is null (legacy backup)", () => {
    render(
      <BriefingPriorSnapshotHeader
        runGenerationId={RUN_ID}
        priorNarrative={makeSnapshot({
          generatedAt: null,
          generatedBy: "Jane Reviewer",
        })}
      />,
    );
    const meta = screen.getByTestId(
      `briefing-run-prior-narrative-meta-${RUN_ID}`,
    );
    expect(
      within(meta).getByTestId(
        `briefing-run-prior-narrative-generated-by-${RUN_ID}`,
      ),
    ).toHaveTextContent("by Jane Reviewer");
    expect(
      screen.queryByTestId(
        `briefing-run-prior-narrative-generated-at-${RUN_ID}`,
      ),
    ).not.toBeInTheDocument();
    // The literal placeholder "Generated " must not be rendered when
    // the timestamp half is missing.
    expect(meta).not.toHaveTextContent(/^Generated /);
  });

  it("omits the meta line entirely when both halves are null", () => {
    render(
      <BriefingPriorSnapshotHeader
        runGenerationId={RUN_ID}
        priorNarrative={makeSnapshot({
          generatedAt: null,
          generatedBy: null,
        })}
      />,
    );
    expect(
      screen.queryByTestId(`briefing-run-prior-narrative-meta-${RUN_ID}`),
    ).not.toBeInTheDocument();
  });

  it("falls back to new Date(raw).toLocaleString() when no formatter is supplied", () => {
    const raw = "2026-04-02T17:00:02.000Z";
    render(
      <BriefingPriorSnapshotHeader
        runGenerationId={RUN_ID}
        priorNarrative={makeSnapshot({
          generatedAt: raw,
          generatedBy: null,
        })}
      />,
    );
    const stamp = screen.getByTestId(
      `briefing-run-prior-narrative-generated-at-${RUN_ID}`,
    );
    // The default formatter is the design-tools surface's historical
    // behaviour — render the absolute locale stamp inline. Computing
    // the expected string the same way the implementation does
    // sidesteps timezone drift between the test runner and CI.
    expect(stamp).toHaveTextContent(
      `Generated ${new Date(raw).toLocaleString()}`,
    );
    // No tooltip is set on the default-formatter path (the design-
    // tools surface has none; the `title` attribute is only used by
    // the Plan Review surface's relative-time formatter).
    expect(stamp).not.toHaveAttribute("title");
  });

  it("uses the supplied formatGeneratedAt for both the visible text and the title attribute", () => {
    render(
      <BriefingPriorSnapshotHeader
        runGenerationId={RUN_ID}
        priorNarrative={makeSnapshot({
          generatedAt: "2026-04-02T17:00:02.000Z",
          generatedBy: null,
        })}
        formatGeneratedAt={() => ({
          text: "5 min ago",
          title: "April 2, 2026 5:00 PM",
        })}
      />,
    );
    const stamp = screen.getByTestId(
      `briefing-run-prior-narrative-generated-at-${RUN_ID}`,
    );
    expect(stamp).toHaveTextContent("Generated 5 min ago");
    expect(stamp).toHaveAttribute("title", "April 2, 2026 5:00 PM");
  });
});

describe("buildPriorSnapshotClipboardText — copy payload shape", () => {
  it("produces seven 'Label\\n\\nbody' blocks separated by blank lines, in canonical A–G order", () => {
    const payload = buildPriorSnapshotClipboardText(makeSnapshot());
    // Splitting on the inter-block separator gives one entry per
    // section in the panel's render order. Anything other than seven
    // entries means a section was dropped or duplicated.
    const blocks = payload.split("\n\n");
    expect(blocks).toHaveLength(SECTION_ORDER.length * 2);
    // Walk the canonical order and verify each label/body pair is in
    // its expected slot. Pairs are stored as `[label, body, label,
    // body, …]` after splitting on the blank line.
    SECTION_ORDER.forEach(({ label }, idx) => {
      expect(blocks[idx * 2]).toBe(label);
      // Each body half is the matching `Prior X body.` from the seed.
      expect(blocks[idx * 2 + 1]).toMatch(/^Prior [A-G] body\.$/);
    });
    // The labels themselves are the canonical "A — Executive Summary"
    // through "G — Next-Step Checklist" set, in order.
    expect(payload.startsWith("A — Executive Summary")).toBe(true);
    expect(payload.endsWith("Prior G body.")).toBe(true);
  });

  it("renders empty / whitespace-only sections as the '—' placeholder", () => {
    const payload = buildPriorSnapshotClipboardText(
      makeSnapshot({
        sectionB: null,
        sectionC: "",
        sectionD: "   \n\t  ",
      }),
    );
    // The three empty sections are still labelled and still occupy
    // their canonical slot — the placeholder protects the auditor
    // from staring at a blank label.
    expect(payload).toMatch(/B — Threshold Issues\n\n—/);
    expect(payload).toMatch(/C — Regulatory Gates\n\n—/);
    expect(payload).toMatch(/D — Site Infrastructure\n\n—/);
    // The populated sections still render their actual body.
    expect(payload).toMatch(/A — Executive Summary\n\nPrior A body\./);
    expect(payload).toMatch(/G — Next-Step Checklist\n\nPrior G body\./);
  });

  it("pickSection returns the matching column for each canonical key", () => {
    const snapshot = makeSnapshot();
    expect(pickSection(snapshot, "a")).toBe("Prior A body.");
    expect(pickSection(snapshot, "g")).toBe("Prior G body.");
    expect(pickSection(null, "a")).toBeNull();
  });
});

describe("BriefingPriorSnapshotHeader — copy button behaviour", () => {
  it("hands the seven-section payload to navigator.clipboard.writeText on click", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <BriefingPriorSnapshotHeader
        runGenerationId={RUN_ID}
        priorNarrative={makeSnapshot()}
      />,
    );
    fireEvent.click(
      screen.getByTestId(`briefing-run-prior-narrative-copy-${RUN_ID}`),
    );
    expect(writeText).toHaveBeenCalledTimes(1);
    // The payload is the same string `buildPriorSnapshotClipboardText`
    // produces — the header delegates that concatenation to the
    // exported helper so this equality is the single contract.
    expect(writeText.mock.calls[0][0]).toBe(
      buildPriorSnapshotClipboardText(makeSnapshot()),
    );
  });

  it("silently surfaces the 'Couldn't copy' pill (and never 'Copied!') when navigator.clipboard is missing", async () => {
    // Force the Clipboard API to look unavailable so the button's
    // early-return branch fires. The header must NOT throw, and
    // must NOT show the success pill (the auditor's whole signal is
    // that the copy did not land).
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    render(
      <BriefingPriorSnapshotHeader
        runGenerationId={RUN_ID}
        priorNarrative={makeSnapshot()}
      />,
    );
    const button = screen.getByTestId(
      `briefing-run-prior-narrative-copy-${RUN_ID}`,
    );
    expect(() => fireEvent.click(button)).not.toThrow();
    const errorPill = await screen.findByTestId(
      `briefing-run-prior-narrative-copy-error-${RUN_ID}`,
    );
    expect(errorPill).toHaveTextContent(/couldn.?t copy/i);
    expect(
      screen.queryByTestId(
        `briefing-run-prior-narrative-copy-confirm-${RUN_ID}`,
      ),
    ).not.toBeInTheDocument();
  });

  it("flips the button to 'Copied!' on a successful write, then reverts ~2 s later via fake timers", async () => {
    vi.useFakeTimers();
    try {
      // A real (microtask-resolving) promise so the production
      // `.then(...)` chain fires; fake timers only intercept the
      // 2 s revert `setTimeout`, not the microtask queue.
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      render(
        <BriefingPriorSnapshotHeader
          runGenerationId={RUN_ID}
          priorNarrative={makeSnapshot()}
        />,
      );
      const button = screen.getByTestId(
        `briefing-run-prior-narrative-copy-${RUN_ID}`,
      );
      // Sanity check: idle state and default label before the click.
      expect(button).toHaveTextContent("Copy plain text");
      expect(
        screen.queryByTestId(
          `briefing-run-prior-narrative-copy-confirm-${RUN_ID}`,
        ),
      ).not.toBeInTheDocument();

      fireEvent.click(button);
      // Drain the microtask queue so the writeText promise's
      // `.then(...)` callback runs and the success pill mounts.
      // `act` wraps the React state updates that result so the
      // assertion below sees the post-flush DOM.
      await act(async () => {
        await Promise.resolve();
      });
      const confirmPill = screen.getByTestId(
        `briefing-run-prior-narrative-copy-confirm-${RUN_ID}`,
      );
      expect(confirmPill).toHaveTextContent(/copied/i);

      // Just before the 2 s window elapses the pill is still in
      // the tree — proves the revert is gated on the real timer
      // value rather than firing on the next tick.
      act(() => {
        vi.advanceTimersByTime(1999);
      });
      expect(
        screen.getByTestId(
          `briefing-run-prior-narrative-copy-confirm-${RUN_ID}`,
        ),
      ).toBeInTheDocument();

      // Crossing the 2 s boundary reverts the button to its idle
      // label and tears the success pill out of the DOM. We can't
      // use `waitFor` here — it polls via real `setTimeout`, which
      // is mocked out by `vi.useFakeTimers()` and would deadlock.
      // The `act` block flushes the React state update synchronously
      // so the next assertion can read the post-revert DOM.
      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });
      expect(
        screen.queryByTestId(
          `briefing-run-prior-narrative-copy-confirm-${RUN_ID}`,
        ),
      ).not.toBeInTheDocument();
      expect(
        screen.getByTestId(`briefing-run-prior-narrative-copy-${RUN_ID}`),
      ).toHaveTextContent("Copy plain text");
    } finally {
      vi.useRealTimers();
    }
  });
});
