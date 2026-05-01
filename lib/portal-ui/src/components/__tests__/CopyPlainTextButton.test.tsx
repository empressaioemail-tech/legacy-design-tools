/**
 * Standalone unit coverage for the shared `<CopyPlainTextButton />`.
 *
 * Task #350 lifted this button out of the two prior-narrative panels
 * (Plan Review reviewer surface and design-tools architect surface)
 * into `lib/portal-ui` so they can't drift on the discriminated
 * success/error pill state, the ~2 s revert window, the unmount
 * cleanup, and the `*-copy-confirm-*` / `*-copy-error-*` testids.
 *
 * Behaviour is also pinned indirectly by the surface-level
 * integration tests on each consumer
 * (`artifacts/plan-review/src/components/__tests__/BriefingRecentRunsPanel.test.tsx`
 * and `artifacts/design-tools/src/pages/__tests__/BriefingRecentRunsPanel.test.tsx`).
 * Those tests have to mount the whole panel + mock react-query +
 * seed a prior-narrative row before they can click the button —
 * slow to run and noisy when they fail. Task #360 adds this direct
 * unit test so future tweaks (icon swap, tooltip, timing change)
 * fail here first, fast and focused, instead of waiting for both
 * integration suites to flake.
 *
 * Pinned here:
 *   1. Default label is "Copy plain text" with the
 *      `${testIdPrefix}-${generationId}` testid; neither pill is in
 *      the tree before a click.
 *   2. A successful clipboard write flips to "Copied!" under the
 *      `*-copy-confirm-${id}` testid, calls `writeText` exactly
 *      once with the supplied payload, and reverts after the ~2 s
 *      feedback window.
 *   3. The early-return branch (no `navigator.clipboard`) surfaces
 *      "Couldn't copy" under the `*-copy-error-${id}` testid, never
 *      a stray success pill, and reverts after the same ~2 s window.
 *   4. A rejected `writeText` promise hits the same error branch
 *      with the same testid + revert behaviour (no false success).
 *   5. The `testIdPrefix` override is honoured on all three states
 *      (default / confirm / error) so a non-default prefix doesn't
 *      silently fall back to the briefing-run default.
 *   6. The pending revert timer is cleared on unmount so a click
 *      that races the disclosure being collapsed (or the page
 *      navigating away) doesn't fire a setTimeout against an
 *      already-unmounted tree.
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
  waitFor,
  act,
} from "@testing-library/react";

import { CopyPlainTextButton } from "../CopyPlainTextButton";

// ── Clipboard descriptor save/restore ─────────────────────────────
//
// happy-dom may or may not ship `navigator.clipboard`. Each test
// installs the descriptor it needs (resolving spy, rejecting spy,
// or `undefined`) and `afterEach` restores whatever was there
// before so a failing-clipboard branch can't leak into the next
// test and silently turn its assertions green.
let originalClipboardDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
    navigator,
    "clipboard",
  );
});

afterEach(() => {
  if (originalClipboardDescriptor) {
    Object.defineProperty(
      navigator,
      "clipboard",
      originalClipboardDescriptor,
    );
  } else {
    // The property didn't exist before — best-effort delete so a
    // descriptor we installed during the test doesn't leak.
    delete (navigator as unknown as { clipboard?: unknown }).clipboard;
  }
});

function installClipboard(value: unknown): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value,
  });
}

describe("CopyPlainTextButton", () => {
  it("renders the default label and testid with neither pill in the tree", () => {
    render(<CopyPlainTextButton generationId="gen-1" text="payload" />);
    const button = screen.getByTestId(
      "briefing-run-prior-narrative-copy-gen-1",
    );
    // Default label is "Copy plain text" — the surface-level mirror
    // tests on both consumers spell this out verbatim, so any
    // future copy change must be made here too.
    expect(button).toHaveTextContent("Copy plain text");
    // Neither pill is in the tree before the button is clicked —
    // proves the discriminated `copyResult` state starts at `null`
    // and that nothing about merely mounting the component races
    // the auditor into a stale pill.
    expect(
      screen.queryByTestId(
        "briefing-run-prior-narrative-copy-confirm-gen-1",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(
        "briefing-run-prior-narrative-copy-error-gen-1",
      ),
    ).not.toBeInTheDocument();
  });

  it("flips to 'Copied!' for ~2 s on a successful write and calls writeText with the payload", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard({ writeText });
    render(
      <CopyPlainTextButton generationId="gen-1" text="hello clipboard" />,
    );
    const button = screen.getByTestId(
      "briefing-run-prior-narrative-copy-gen-1",
    );
    // Sanity check before the click — the revert path is gated on
    // a state flip, not on the initial render, so the pill should
    // not be in the tree yet.
    expect(
      screen.queryByTestId(
        "briefing-run-prior-narrative-copy-confirm-gen-1",
      ),
    ).not.toBeInTheDocument();

    fireEvent.click(button);

    // The confirmation pill mounts once the writeText promise
    // resolves on the next microtask flush. The component preserves
    // the captured-id-at-click-time invariant by tagging the pill
    // with the same generationId the click captured.
    expect(
      await screen.findByTestId(
        "briefing-run-prior-narrative-copy-confirm-gen-1",
      ),
    ).toHaveTextContent(/copied/i);
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith("hello clipboard");

    // After the ~2 s revert window the pill is unmounted and the
    // default label is back. waitFor's default 1 s budget is too
    // tight for the 2 s revert, so bump it to give a small margin
    // for scheduler jitter (mirrors the integration tests).
    await waitFor(
      () => {
        expect(
          screen.queryByTestId(
            "briefing-run-prior-narrative-copy-confirm-gen-1",
          ),
        ).not.toBeInTheDocument();
      },
      { timeout: 2500 },
    );
    expect(button).toHaveTextContent("Copy plain text");
  });

  it("surfaces 'Couldn't copy' (not 'Copied!') when navigator.clipboard is unavailable", async () => {
    // Force the Clipboard API to look unavailable so the early-
    // return branch fires. The `.then(...)` chain must NOT run, so
    // a stray success pill on this path would be a false positive
    // (the auditor's whole signal is that the copy did not land).
    installClipboard(undefined);
    render(<CopyPlainTextButton generationId="gen-1" text="payload" />);
    const button = screen.getByTestId(
      "briefing-run-prior-narrative-copy-gen-1",
    );

    fireEvent.click(button);

    const errorPill = await screen.findByTestId(
      "briefing-run-prior-narrative-copy-error-gen-1",
    );
    expect(errorPill).toHaveTextContent(/couldn.?t copy/i);
    // Mutually-exclusive invariant — the discriminated state can
    // only ever hold one of the two pills.
    expect(
      screen.queryByTestId(
        "briefing-run-prior-narrative-copy-confirm-gen-1",
      ),
    ).not.toBeInTheDocument();

    await waitFor(
      () => {
        expect(
          screen.queryByTestId(
            "briefing-run-prior-narrative-copy-error-gen-1",
          ),
        ).not.toBeInTheDocument();
      },
      { timeout: 2500 },
    );
    expect(button).toHaveTextContent("Copy plain text");
  });

  it("surfaces 'Couldn't copy' when navigator.clipboard.writeText rejects", async () => {
    // Reject with a real Error so the production `.catch(() =>
    // ...)` branch runs as it would in a browser that refused the
    // write (focus loss, sandbox denial, OS-level permission
    // refusal, etc.).
    const writeText = vi
      .fn()
      .mockRejectedValue(new Error("clipboard write refused"));
    installClipboard({ writeText });
    render(<CopyPlainTextButton generationId="gen-1" text="payload" />);
    const button = screen.getByTestId(
      "briefing-run-prior-narrative-copy-gen-1",
    );

    fireEvent.click(button);
    expect(writeText).toHaveBeenCalledTimes(1);

    expect(
      await screen.findByTestId(
        "briefing-run-prior-narrative-copy-error-gen-1",
      ),
    ).toHaveTextContent(/couldn.?t copy/i);
    // Same mutually-exclusive invariant — a rejected write must
    // never leave a stray "Copied!" pill in the tree.
    expect(
      screen.queryByTestId(
        "briefing-run-prior-narrative-copy-confirm-gen-1",
      ),
    ).not.toBeInTheDocument();

    await waitFor(
      () => {
        expect(
          screen.queryByTestId(
            "briefing-run-prior-narrative-copy-error-gen-1",
          ),
        ).not.toBeInTheDocument();
      },
      { timeout: 2500 },
    );
    expect(button).toHaveTextContent("Copy plain text");
  });

  it("honours the testIdPrefix override on the default, confirm, and error states", async () => {
    // A non-default prefix must be threaded through all three
    // testid shapes — `${prefix}-${id}` on the button,
    // `${prefix}-confirm-${id}` on the success pill, and
    // `${prefix}-error-${id}` on the error pill. If the override
    // silently falls back to the briefing-run default, the
    // off-surface consumer's test IDs would split between two
    // namespaces (some custom, some default) and surface-level
    // queries would miss the rendered nodes.
    const writeText = vi.fn().mockResolvedValue(undefined);
    installClipboard({ writeText });
    const { unmount } = render(
      <CopyPlainTextButton
        generationId="gen-1"
        text="payload"
        testIdPrefix="custom-copy"
      />,
    );

    // Default state honours the override.
    const button = screen.getByTestId("custom-copy-gen-1");
    expect(button).toHaveTextContent("Copy plain text");
    // The default-prefixed testid must NOT be in the tree —
    // proves the override fully replaces the prefix and doesn't
    // double-emit under both namespaces.
    expect(
      screen.queryByTestId("briefing-run-prior-narrative-copy-gen-1"),
    ).not.toBeInTheDocument();

    // Success pill honours the override.
    fireEvent.click(button);
    expect(
      await screen.findByTestId("custom-copy-confirm-gen-1"),
    ).toHaveTextContent(/copied/i);
    expect(
      screen.queryByTestId(
        "briefing-run-prior-narrative-copy-confirm-gen-1",
      ),
    ).not.toBeInTheDocument();

    // Wait for the success pill to revert before flipping the
    // clipboard into the failure mode — the discriminated state
    // is single-slot, so we want a clean transition rather than
    // a back-to-back error replacing an in-flight success.
    await waitFor(
      () => {
        expect(
          screen.queryByTestId("custom-copy-confirm-gen-1"),
        ).not.toBeInTheDocument();
      },
      { timeout: 2500 },
    );

    // Error pill honours the override.
    installClipboard(undefined);
    fireEvent.click(button);
    expect(
      await screen.findByTestId("custom-copy-error-gen-1"),
    ).toHaveTextContent(/couldn.?t copy/i);
    expect(
      screen.queryByTestId(
        "briefing-run-prior-narrative-copy-error-gen-1",
      ),
    ).not.toBeInTheDocument();

    unmount();
  });

  it("clears the pending revert timer on unmount so no setTimeout fires against the unmounted tree", async () => {
    // Hold the promise open so the click flips to a success pill
    // (which schedules the 2 s revert timeout) before we unmount.
    // A real promise with a manually-controlled resolver gives us
    // deterministic control over the .then(...) flush without
    // mocking setTimeout (which the integration tests note can
    // deadlock react-query in surface tests; not a concern here,
    // but keeping the same approach makes a future lift painless).
    let resolveWrite: (() => void) | undefined;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    installClipboard({ writeText });

    // Spy on clearTimeout so we can assert the unmount cleanup
    // actually called it. Spying directly on the global preserves
    // every other call path (vitest's own scheduler etc.) so we
    // only need to verify our handle made it through.
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

    const { unmount } = render(
      <CopyPlainTextButton generationId="gen-1" text="payload" />,
    );
    fireEvent.click(
      screen.getByTestId("briefing-run-prior-narrative-copy-gen-1"),
    );

    // Flush the queued resolution so the .then(...) callback runs
    // and the component schedules its 2 s revert via setTimeout.
    // `act` keeps React's state updates batched cleanly so the
    // setTimeout call lands before we unmount.
    await act(async () => {
      resolveWrite?.();
    });

    // Sanity check: the success pill is in the tree (so the
    // revert timer is definitely scheduled — otherwise we'd be
    // testing a no-op cleanup path).
    expect(
      screen.getByTestId(
        "briefing-run-prior-narrative-copy-confirm-gen-1",
      ),
    ).toBeInTheDocument();

    // Capture the timer handle the component scheduled. The
    // setTimeout spy records every call — there may be others
    // from React/scheduler internals, but the component's own
    // setTimeout returns a handle that should appear in the
    // clearTimeout call list after unmount.
    const componentTimerHandle = setTimeoutSpy.mock.results
      .map((r) => r.value as ReturnType<typeof setTimeout>)
      .find((handle) => handle !== undefined);
    expect(componentTimerHandle).toBeDefined();

    // Unmount mid-flight. Track which clearTimeout calls land
    // during the unmount so we can prove the component's cleanup
    // ran (the unmount-effect calls clearTimeout on the live
    // handle stored in `copyResultTimerRef`).
    const clearCallsBeforeUnmount = clearTimeoutSpy.mock.calls.length;
    unmount();
    const clearedHandles = clearTimeoutSpy.mock.calls
      .slice(clearCallsBeforeUnmount)
      .map((call) => call[0]);
    expect(clearedHandles).toContain(componentTimerHandle);

    // Now wait past the 2 s revert window. If the cleanup did
    // NOT clear the timer, the queued setState would fire against
    // an unmounted tree — React 18+ surfaces that as a console
    // error / warning. Spy on console.error and assert the
    // window passes silently.
    const consoleErrorSpy = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(consoleErrorSpy).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
    clearTimeoutSpy.mockRestore();
    setTimeoutSpy.mockRestore();
  });
});
