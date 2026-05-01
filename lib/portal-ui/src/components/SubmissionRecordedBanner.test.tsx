/**
 * Component-level tests for the shared `SubmissionRecordedBanner`.
 *
 * Lives next to the component (Task #377, following Tasks #362 / #367
 * for the rest of the portal-ui sibling-test set) so the relative-
 * time formatter, the absolute-time hover title, the jurisdiction
 * fallback, the dismiss affordance, and the testid contract
 * (`submit-jurisdiction-success-banner` /
 * `submit-jurisdiction-success-dismiss`) are exercised against the
 * rendered DOM without standing up either consumer's
 * `EngagementDetail` page scaffolding around it.
 *
 * The duplicated coverage on
 * `artifacts/plan-review/src/pages/__tests__/EngagementDetail.test.tsx`
 * (Task #112) and
 * `artifacts/design-tools/src/pages/__tests__/EngagementDetail.test.tsx`
 * (Task #126) stays valid as integration cover from the consumer
 * side, but a refactor that touches only the shared banner can no
 * longer ship without ever running a portal-ui-scoped test.
 *
 * The banner is presentational — no `useQuery` hooks and no module-
 * level state to mock. We just pin the `Date.now()` reference via
 * `vi.useFakeTimers()` + `vi.setSystemTime(...)` so the relative-
 * time output is deterministic across the bucket boundaries
 * (just-now / seconds / minutes / hours / days / locale-date
 * fallback) the formatter branches on.
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { SubmissionRecordedBanner } from "./SubmissionRecordedBanner";

// Pin "now" to a fixed UTC instant so every relative-time assertion
// below has a stable anchor regardless of where the suite runs. The
// chosen instant is well past the dawn of the project so the
// >30-day branch can subtract a real chunk of time without going
// negative.
const NOW_ISO = "2026-04-15T12:00:00.000Z";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_ISO));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SubmissionRecordedBanner", () => {
  it("renders the success testid, the jurisdiction snapshot in <strong>, and the role=status live-region", () => {
    // The banner is the only post-submit affordance reassuring the
    // user that the package was actually recorded — the dialog
    // closes on success, so the success testid + the live-region
    // are how surface tests / accessibility tooling pin the
    // confirmation surface.
    render(
      <SubmissionRecordedBanner
        submittedAt={NOW_ISO}
        jurisdiction="Moab, UT"
        onDismiss={vi.fn()}
      />,
    );
    const banner = screen.getByTestId("submit-jurisdiction-success-banner");
    expect(banner).toBeInTheDocument();
    // role=status / aria-live=polite is the screen-reader contract:
    // the banner replaces the dialog as the post-submit surface so
    // it must announce itself instead of vanishing silently.
    expect(banner).toHaveAttribute("role", "status");
    expect(banner).toHaveAttribute("aria-live", "polite");
    // Jurisdiction must land inside a <strong> so the surface
    // visually emphasises *where* the package was sent — the
    // surrounding sentence ("Submitted to … · just now") relies on
    // the <strong> to break up the three pieces of metadata.
    const strong = banner.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong).toHaveTextContent("Moab, UT");
    // The "Submitted to" lead-in must literally appear so the
    // banner reads as a sentence; a future copy tweak that drops
    // it would silently regress both surfaces.
    expect(banner).toHaveTextContent(/Submitted to/i);
  });

  it("renders 'just now' for a sub-5-second delta", () => {
    // Deltas under 5 s land in the special "just now" bucket — a
    // freshly-submitted package shouldn't read "0s ago" or "1s
    // ago" because the banner often beats the network round-trip
    // by a hair.
    render(
      <SubmissionRecordedBanner
        submittedAt={NOW_ISO}
        jurisdiction="Moab, UT"
        onDismiss={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId("submit-jurisdiction-success-banner"),
    ).toHaveTextContent(/just now/i);
  });

  it("renders the bucketed relative time across the seconds / minutes / hours / days branches", () => {
    // Walk the formatter's bucket boundaries. Each call mounts a
    // fresh banner against the same pinned "now" so we exercise
    // the branch independent of the previous render's residual
    // DOM. The exact strings are part of the contract surface
    // tests on plan-review / design-tools key off (the relative-
    // time helper on each artifact mirrors this same shape).
    const cases: Array<{ deltaMs: number; expected: RegExp }> = [
      { deltaMs: 30_000, expected: /30s ago/ },
      { deltaMs: 5 * 60_000, expected: /5 min ago/ },
      { deltaMs: 2 * 3_600_000, expected: /2 hr ago/ },
      { deltaMs: 3 * 86_400_000, expected: /3d ago/ },
    ];
    for (const { deltaMs, expected } of cases) {
      const stamp = new Date(
        new Date(NOW_ISO).getTime() - deltaMs,
      ).toISOString();
      const { unmount } = render(
        <SubmissionRecordedBanner
          submittedAt={stamp}
          jurisdiction="Moab, UT"
          onDismiss={vi.fn()}
        />,
      );
      expect(
        screen.getByTestId("submit-jurisdiction-success-banner"),
      ).toHaveTextContent(expected);
      unmount();
    }
  });

  it("falls back to the locale date string for deltas of 30+ days", () => {
    // Past the 30-day cliff the formatter drops the "ago" phrasing
    // and surfaces an absolute locale date instead — long-tail
    // banners (a re-opened tab from last quarter) shouldn't read
    // "120d ago", which wraps awkwardly in the banner's narrow
    // strip and is hard to compare against a calendar.
    const stamp = new Date(
      new Date(NOW_ISO).getTime() - 60 * 86_400_000,
    ).toISOString();
    const localeDate = new Date(stamp).toLocaleDateString();
    render(
      <SubmissionRecordedBanner
        submittedAt={stamp}
        jurisdiction="Moab, UT"
        onDismiss={vi.fn()}
      />,
    );
    const banner = screen.getByTestId("submit-jurisdiction-success-banner");
    expect(banner).toHaveTextContent(localeDate);
    // The "ago" phrasing must NOT appear once we're past the
    // cliff — pin the absence so a future tweak that loosens the
    // bucket (e.g. swaps to >365d) doesn't silently double-render
    // the relative + absolute output.
    expect(banner.textContent).not.toMatch(/\bago\b/);
  });

  it("exposes the absolute timestamp as the title attribute on the relative-time span", () => {
    // The relative time is the human glance value; the absolute
    // timestamp lives behind a hover so a teammate can verify
    // exactly when the submission landed without losing the
    // glanceable copy. The `title` is on the inner span — surface
    // tests on both consumers walk through `[title]` to assert
    // the absolute output, so pin the contract here.
    const stamp = new Date(
      new Date(NOW_ISO).getTime() - 5 * 60_000,
    ).toISOString();
    const expectedTitle = new Date(stamp).toLocaleString();
    render(
      <SubmissionRecordedBanner
        submittedAt={stamp}
        jurisdiction="Moab, UT"
        onDismiss={vi.fn()}
      />,
    );
    const titledSpan = screen
      .getByTestId("submit-jurisdiction-success-banner")
      .querySelector(`span[title="${expectedTitle}"]`);
    expect(titledSpan).not.toBeNull();
    expect(titledSpan).toHaveTextContent(/5 min ago/);
  });

  it("accepts a Date instance for `submittedAt` (parity with plan-review's snapshot shape)", () => {
    // The plan-review surface snapshots the receipt as-is, which
    // means `submittedAt` may arrive as a real Date object rather
    // than an ISO string. The formatter must accept either; if
    // the Date branch silently fell through to `String(input)`,
    // the banner would read "Mon Apr 13 2026 …" instead of the
    // bucketed relative time.
    const stamp = new Date(new Date(NOW_ISO).getTime() - 2 * 3_600_000);
    render(
      <SubmissionRecordedBanner
        submittedAt={stamp}
        jurisdiction="Moab, UT"
        onDismiss={vi.fn()}
      />,
    );
    expect(
      screen.getByTestId("submit-jurisdiction-success-banner"),
    ).toHaveTextContent(/2 hr ago/);
  });

  it("falls back to the literal word 'jurisdiction' when no jurisdiction is provided", () => {
    // The receipt for an engagement without a bound jurisdiction
    // still fires this banner — the parent passes `null` and the
    // sentence must still read. Falling through to "to ." or "to
    // null" would be a real surprise on the surface.
    render(
      <SubmissionRecordedBanner
        submittedAt={NOW_ISO}
        jurisdiction={null}
        onDismiss={vi.fn()}
      />,
    );
    const banner = screen.getByTestId("submit-jurisdiction-success-banner");
    expect(banner).toHaveTextContent(/Submitted to\s+jurisdiction/i);
    // Pin the exact <strong>jurisdiction</strong> swap — a future
    // tweak that drops the <strong> on the fallback branch would
    // visually flatten the sentence and lose the "where it went"
    // emphasis the banner relies on.
    expect(banner.querySelector("strong")).toHaveTextContent("jurisdiction");
  });

  it("invokes onDismiss exactly once when the dismiss button is clicked, and not on banner clicks", () => {
    // The dismiss handler is parent-owned (the parent decides
    // whether to fade the banner out, snooze auto-dismiss, etc).
    // Surface tests assert the handler fires; we additionally pin
    // that a stray click on the banner body does NOT trigger the
    // handler — otherwise a teammate trying to copy the timestamp
    // text would dismiss the banner mid-read.
    const onDismiss = vi.fn();
    render(
      <SubmissionRecordedBanner
        submittedAt={NOW_ISO}
        jurisdiction="Moab, UT"
        onDismiss={onDismiss}
      />,
    );
    const banner = screen.getByTestId("submit-jurisdiction-success-banner");
    fireEvent.click(banner);
    expect(onDismiss).not.toHaveBeenCalled();

    const dismiss = screen.getByTestId("submit-jurisdiction-success-dismiss");
    expect(dismiss).toHaveAttribute(
      "aria-label",
      "Dismiss submission confirmation",
    );
    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("falls through to String(input) for an unparseable timestamp without crashing", () => {
    // Defensive coverage for the `Number.isNaN(date.getTime())`
    // branch — if a future server refactor ever shipped a
    // non-ISO string in the receipt, the banner must not throw
    // (it's the post-submit success surface — losing it would
    // leave the user with no confirmation at all). The fallback
    // copy isn't pretty but it MUST land in the DOM rather than
    // raising.
    expect(() =>
      render(
        <SubmissionRecordedBanner
          submittedAt="not-a-real-timestamp"
          jurisdiction="Moab, UT"
          onDismiss={vi.fn()}
        />,
      ),
    ).not.toThrow();
    const banner = screen.getByTestId("submit-jurisdiction-success-banner");
    // Both the relative-time span and the title fall back to the
    // raw input string when parsing fails, so the literal value
    // must appear in the rendered output.
    expect(banner).toHaveTextContent("not-a-real-timestamp");
  });
});
