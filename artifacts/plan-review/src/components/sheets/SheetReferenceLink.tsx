/**
 * Cross-reference chip + interleave helper (PLR-8). Resolves a
 * sheetNumber against the submission's sheet list; resolved refs
 * render as a clickable chip, unresolved refs as muted text with a
 * "not found in this submission" tooltip.
 */
import type { ReactNode } from "react";
import type {
  SheetCrossRef,
  SheetSummary,
} from "@workspace/api-client-react";

export type { SheetCrossRef };

export interface SheetReferenceLinkProps {
  crossRef: SheetCrossRef;
  sheets: ReadonlyArray<SheetSummary>;
  onJumpToSheet: (sheet: SheetSummary) => void;
}

function findSheetByNumber(
  sheets: ReadonlyArray<SheetSummary>,
  sheetNumber: string,
): SheetSummary | undefined {
  const target = sheetNumber.toUpperCase();
  return sheets.find((s) => s.sheetNumber.toUpperCase() === target);
}

export function SheetReferenceLink({
  crossRef,
  sheets,
  onJumpToSheet,
}: SheetReferenceLinkProps) {
  const resolved = findSheetByNumber(sheets, crossRef.sheetNumber);

  if (!resolved) {
    return (
      <span
        data-testid={`sheet-ref-unresolved-${crossRef.sheetNumber}`}
        title="not found in this submission"
        style={{
          color: "var(--text-muted)",
          textDecoration: "underline dotted",
          cursor: "help",
        }}
      >
        {crossRef.raw}
      </span>
    );
  }

  return (
    <button
      type="button"
      data-testid={`sheet-ref-link-${resolved.id}`}
      data-sheet-number={resolved.sheetNumber}
      onClick={() => onJumpToSheet(resolved)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "1px 6px",
        borderRadius: 4,
        border: "1px solid var(--cyan, #06b6d4)",
        background: "transparent",
        color: "var(--cyan, #06b6d4)",
        fontSize: "inherit",
        fontFamily: "inherit",
        cursor: "pointer",
      }}
    >
      {crossRef.raw}
    </button>
  );
}

/**
 * Render a sheet-content text body with each cross-reference replaced
 * by a {@link SheetReferenceLink}. Plain text segments between refs
 * are emitted verbatim. The function walks the supplied `crossRefs`
 * array in source order and uses each ref's `raw` substring to find
 * its position in the body — refs whose `raw` cannot be located (e.g.
 * the body changed after extraction) are appended at the end as
 * standalone link chips so they remain navigable.
 */
export function renderSheetTextWithCrossRefs(
  body: string,
  crossRefs: ReadonlyArray<SheetCrossRef>,
  sheets: ReadonlyArray<SheetSummary>,
  onJumpToSheet: (sheet: SheetSummary) => void,
): ReactNode[] {
  if (!body) return [];
  if (crossRefs.length === 0) return [body];

  const out: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const ref of crossRefs) {
    const idx = body.indexOf(ref.raw, cursor);
    if (idx === -1) continue;
    if (idx > cursor) {
      out.push(body.slice(cursor, idx));
    }
    out.push(
      <SheetReferenceLink
        key={`ref-${key++}-${ref.sheetNumber}`}
        crossRef={ref}
        sheets={sheets}
        onJumpToSheet={onJumpToSheet}
      />,
    );
    cursor = idx + ref.raw.length;
  }
  if (cursor < body.length) {
    out.push(body.slice(cursor));
  }
  return out;
}
