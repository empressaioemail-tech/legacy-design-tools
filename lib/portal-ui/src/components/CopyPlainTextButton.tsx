import { useEffect, useRef, useState, type CSSProperties } from "react";

export interface CopyPlainTextButtonProps {
  /**
   * Stable identifier used to (a) tag the per-row testids and (b)
   * drive the discriminated `copyResult` state so a fast row-swap
   * doesn't confirm the wrong row. In the existing surfaces this is
   * always the briefing run's `generationId`.
   */
  generationId: string;
  /**
   * The plain text payload that should land on the clipboard when
   * the button is clicked. Pre-computed by the caller so the
   * concatenation logic (e.g. the seven A–G section bodies) can stay
   * with the data that knows how to render them.
   */
  text: string;
  /**
   * Optional override for the data-testid prefix. Defaults to
   * `briefing-run-prior-narrative-copy` so both the Plan Review and
   * design-tools prior-narrative panels keep their existing testids
   * (`*-${id}`, `*-confirm-${id}`, `*-error-${id}`) byte-identical
   * with the pre-lift implementation. Other surfaces that adopt the
   * button can supply their own prefix without renaming it here.
   */
  testIdPrefix?: string;
}

const DEFAULT_TESTID_PREFIX = "briefing-run-prior-narrative-copy";

/**
 * How long the "Copied!" / "Couldn't copy" feedback pill stays in
 * the DOM before the button reverts to the default "Copy plain
 * text" label. Held as a single source of truth so the two surfaces
 * (and any future consumer) can never drift on the timing — the
 * mirror tests on both sides assert against this exact 2 s window.
 */
const COPY_FEEDBACK_MS = 2000;

type CopyState = "idle" | "success" | "error";

const STATE_STYLE: Record<
  CopyState,
  { color: string; border: string; background: string }
> = {
  idle: {
    color: "var(--text-default)",
    border: "1px solid var(--border-subtle)",
    background: "transparent",
  },
  success: {
    color: "var(--success-text)",
    border: "1px solid var(--success-text)",
    background: "var(--success-dim)",
  },
  error: {
    color: "var(--danger-text)",
    border: "1px solid var(--danger-text)",
    background: "var(--danger-dim)",
  },
};

const buttonStyleFor = (state: CopyState): CSSProperties => ({
  fontSize: 11,
  padding: "2px 8px",
  background: STATE_STYLE[state].background,
  border: STATE_STYLE[state].border,
  borderRadius: 4,
  cursor: "pointer",
  color: STATE_STYLE[state].color,
  whiteSpace: "nowrap",
});

/**
 * Shared "Copy plain text" button used by the prior-narrative block
 * on both the Plan Review reviewer surface and the design-tools
 * architect surface (Task #350).
 *
 * Lifts the previously-duplicated implementation that landed
 * piecemeal across Tasks #333 (the button itself), #338 (the
 * "Copied!" success pill), and #345 (the "Couldn't copy" error
 * pill). The two copies were already byte-identical and re-pinned
 * by mirror tests on each side; collapsing them into a single
 * component removes the drift risk those mirror tests existed to
 * catch.
 *
 * Behaviour the existing tests pin and that this component
 * preserves verbatim:
 *
 *   1. Default label is "Copy plain text" with the
 *      `${testIdPrefix}-${generationId}` testid on the button.
 *   2. Clicking the button writes `text` via the async Clipboard
 *      API. When the API isn't available (older browsers, locked-
 *      down contexts, no HTTPS) or the promise rejects, the button
 *      surfaces a "Couldn't copy" pill under the
 *      `${testIdPrefix}-error-${generationId}` testid instead of
 *      throwing inside the event handler.
 *   3. On a successful write the button flips to "Copied!" under
 *      the `${testIdPrefix}-confirm-${generationId}` testid for
 *      ~2 s, then reverts. Success and error states share a single
 *      discriminated value so only one of the two pills can ever be
 *      in the tree at a time — a back-to-back retry that flips
 *      error → success replaces the pill in place rather than
 *      briefly stacking both.
 *   4. The pending revert timer is cleared on unmount so a click
 *      that races the disclosure being collapsed (or the page being
 *      navigated away from) doesn't leak a setTimeout that fires
 *      against an already-unmounted tree.
 */
export function CopyPlainTextButton({
  generationId,
  text,
  testIdPrefix = DEFAULT_TESTID_PREFIX,
}: CopyPlainTextButtonProps) {
  const [copyResult, setCopyResult] = useState<{
    id: string;
    kind: "success" | "error";
  } | null>(null);
  const copyResultTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const flashCopyResult = (
    id: string,
    kind: "success" | "error",
  ): void => {
    if (copyResultTimerRef.current !== null) {
      clearTimeout(copyResultTimerRef.current);
    }
    setCopyResult({ id, kind });
    copyResultTimerRef.current = setTimeout(() => {
      setCopyResult(null);
      copyResultTimerRef.current = null;
    }, COPY_FEEDBACK_MS);
  };

  useEffect(() => {
    return () => {
      if (copyResultTimerRef.current !== null) {
        clearTimeout(copyResultTimerRef.current);
        copyResultTimerRef.current = null;
      }
    };
  }, []);

  const isCopied =
    copyResult?.id === generationId && copyResult.kind === "success";
  const hasCopyError =
    copyResult?.id === generationId && copyResult.kind === "error";
  // Task #351 — danger/success tokens make the outcome legible at
  // a glance. `data-copy-state` is also pinned for regression tests.
  const copyState: CopyState = isCopied
    ? "success"
    : hasCopyError
      ? "error"
      : "idle";

  return (
    <button
      type="button"
      data-testid={`${testIdPrefix}-${generationId}`}
      data-copy-state={copyState}
      onClick={() => {
        // Capture the id at click time so a fast row-swap doesn't
        // confirm or error the wrong row.
        const id = generationId;
        if (
          typeof navigator === "undefined" ||
          !navigator.clipboard ||
          typeof navigator.clipboard.writeText !== "function"
        ) {
          flashCopyResult(id, "error");
          return;
        }
        navigator.clipboard
          .writeText(text)
          .then(() => {
            flashCopyResult(id, "success");
          })
          .catch(() => {
            flashCopyResult(id, "error");
          });
      }}
      style={buttonStyleFor(copyState)}
    >
      {isCopied ? (
        <span
          data-testid={`${testIdPrefix}-confirm-${generationId}`}
          data-copy-state="success"
          aria-live="polite"
        >
          Copied!
        </span>
      ) : hasCopyError ? (
        <span
          data-testid={`${testIdPrefix}-error-${generationId}`}
          data-copy-state="error"
          aria-live="polite"
        >
          Couldn&apos;t copy
        </span>
      ) : (
        "Copy plain text"
      )}
    </button>
  );
}
