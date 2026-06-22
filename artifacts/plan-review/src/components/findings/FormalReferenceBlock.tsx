import { useMemo } from "react";
import type { CodeReferenceEntry as WireCodeReferenceEntry } from "@workspace/api-client-react";
import {
  formatReferenceLine,
  renderFormalReferenceBlock,
} from "@workspace/finding-engine";

export type CodeReferenceEntry = WireCodeReferenceEntry;

export function buildReferenceByAtomId(
  references: ReadonlyArray<WireCodeReferenceEntry>,
): Map<string, WireCodeReferenceEntry> {
  return new Map(references.map((ref) => [ref.atomId, ref]));
}

/** One formal reference line (identifier + heading + edition — no body). */
export function formalReferenceLabel(
  reference: WireCodeReferenceEntry,
): string {
  return formatReferenceLine({
    ...reference,
    codeTitle: reference.codeTitle ?? undefined,
  });
}

export function FormalReferenceBlock({
  references,
  heading = "References",
  "data-testid": testId = "formal-reference-block",
}: {
  references: ReadonlyArray<WireCodeReferenceEntry>;
  heading?: string;
  "data-testid"?: string;
}) {
  const normalized = references.map((ref) => ({
    ...ref,
    codeTitle: ref.codeTitle ?? undefined,
  }));
  const block = useMemo(
    () => renderFormalReferenceBlock(normalized, { heading }),
    [normalized, heading],
  );
  if (!block) return null;

  return (
    <pre
      data-testid={testId}
      style={{
        margin: 0,
        whiteSpace: "pre-wrap",
        fontFamily: "ui-monospace, monospace",
        fontSize: 11,
        lineHeight: 1.5,
        color: "var(--text-secondary)",
      }}
    >
      {block}
    </pre>
  );
}
