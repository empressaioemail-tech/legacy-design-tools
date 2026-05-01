import { type ReactNode } from "react";
import { FileText } from "lucide-react";
import {
  CodeAtomPill as PortalCodeAtomPill,
  splitOnCodeAtomTokens,
} from "@workspace/portal-ui";

const BRIEFING_SOURCE_TOKEN_RE =
  /\{\{atom\|briefing-source\|([^|]+)\|([^}]+)\}\}/g;

const CODE_LIBRARY_BASE = `${import.meta.env.BASE_URL}code`;

const codeAtomTestId = (atomId: string) => `finding-code-citation-${atomId}`;

export function CodeAtomPill({ atomId }: { atomId: string }) {
  return (
    <PortalCodeAtomPill
      atomId={atomId}
      codeLibraryBase={CODE_LIBRARY_BASE}
      testId={codeAtomTestId(atomId)}
    />
  );
}

export function SourceCitationPill({
  sourceId,
  label,
}: {
  sourceId: string;
  label: string;
}) {
  return (
    <span
      data-testid={`finding-source-citation-${sourceId}`}
      title={`Briefing source: ${label}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        background: "rgba(99, 152, 170, 0.12)",
        color: "var(--cyan)",
        fontSize: 11,
        padding: "1px 6px",
        borderRadius: 3,
        verticalAlign: "baseline",
        marginInline: 2,
      }}
    >
      <FileText size={10} aria-hidden />
      {label}
    </span>
  );
}

/**
 * Render a finding's body, splitting `[[CODE:atomId]]` and
 * `{{atom|briefing-source|id|label}}` tokens into inline pills.
 * Code-section pill rendering is delegated to the shared portal-ui
 * helper; the briefing-source token is local because the source
 * grammar lives in the design-tools briefing surface.
 */
export function renderFindingBody(body: string): ReactNode[] {
  type Hit = { index: number; length: number; node: ReactNode };
  const hits: Hit[] = [];
  let key = 0;
  let m: RegExpExecArray | null;

  BRIEFING_SOURCE_TOKEN_RE.lastIndex = 0;
  while ((m = BRIEFING_SOURCE_TOKEN_RE.exec(body)) !== null) {
    hits.push({
      index: m.index,
      length: m[0].length,
      node: (
        <SourceCitationPill
          key={`bsrc-${key++}`}
          sourceId={m[1]}
          label={m[2]}
        />
      ),
    });
  }

  if (hits.length === 0) {
    return splitOnCodeAtomTokens(body, {
      codeLibraryBase: CODE_LIBRARY_BASE,
      testIdForAtom: codeAtomTestId,
    });
  }

  hits.sort((a, b) => a.index - b.index);
  const out: ReactNode[] = [];
  let lastIdx = 0;
  for (const h of hits) {
    if (h.index < lastIdx) continue;
    if (h.index > lastIdx) {
      const slice = body.slice(lastIdx, h.index);
      const subNodes = splitOnCodeAtomTokens(slice, {
        codeLibraryBase: CODE_LIBRARY_BASE,
        testIdForAtom: codeAtomTestId,
      });
      out.push(...subNodes);
    }
    out.push(h.node);
    lastIdx = h.index + h.length;
  }
  if (lastIdx < body.length) {
    const tail = body.slice(lastIdx);
    const subNodes = splitOnCodeAtomTokens(tail, {
      codeLibraryBase: CODE_LIBRARY_BASE,
      testIdForAtom: codeAtomTestId,
    });
    out.push(...subNodes);
  }
  return out;
}
