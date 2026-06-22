import { type ReactNode, useState } from "react";
import { FileText } from "lucide-react";
import {
  CodeAtomPill as PortalCodeAtomPill,
  splitOnCodeAtomTokens,
} from "@workspace/portal-ui";
import type { CodeReferenceEntry } from "@workspace/api-client-react";
import { formalReferenceLabel } from "./FormalReferenceBlock";

const BRIEFING_SOURCE_TOKEN_RE =
  /\{\{atom\|briefing-source\|([^|]+)\|([^}]+)\}\}/g;

const CODE_LIBRARY_BASE = `${import.meta.env.BASE_URL}code`;

const codeAtomTestId = (atomId: string) => `finding-code-citation-${atomId}`;

export function CodeAtomPill({
  atomId,
  reference,
}: {
  atomId: string;
  reference?: CodeReferenceEntry;
}) {
  const [open, setOpen] = useState(false);
  const label = reference ? formalReferenceLabel(reference) : undefined;

  if (reference) {
    return (
      <span style={{ display: "inline", position: "relative" }}>
        <button
          type="button"
          data-testid={codeAtomTestId(atomId)}
          title={label}
          onClick={() => setOpen((v) => !v)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 3,
            background: "rgba(99, 152, 170, 0.18)",
            color: "var(--cyan)",
            fontSize: 11,
            padding: "1px 6px",
            borderRadius: 3,
            verticalAlign: "baseline",
            marginInline: 2,
            border: "none",
            cursor: "pointer",
            font: "inherit",
          }}
        >
          {label ?? `CODE·${atomId.slice(0, 8)}`}
        </button>
        {open && (
          <span
            data-testid={`formal-reference-inline-${atomId}`}
            style={{
              display: "block",
              marginTop: 4,
              padding: "6px 8px",
              background: "var(--bg-default)",
              border: "1px solid var(--border-default)",
              borderRadius: 4,
              fontSize: 11,
              color: "var(--text-secondary)",
              fontFamily: "ui-monospace, monospace",
            }}
          >
            {label}
          </span>
        )}
      </span>
    );
  }

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

export interface RenderFindingBodyOptions {
  referenceByAtomId?: ReadonlyMap<string, CodeReferenceEntry>;
}

/**
 * Render a finding's body, splitting `[[CODE:atomId]]` and
 * `{{atom|briefing-source|id|label}}` tokens into inline pills.
 * When `referenceByAtomId` is supplied, code pills resolve to the
 * formal reference line (identifier + heading + edition only).
 */
export function renderFindingBody(
  body: string,
  opts: RenderFindingBodyOptions = {},
): ReactNode[] {
  const referenceByAtomId = opts.referenceByAtomId;
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

  const renderCodeSlice = (slice: string): ReactNode[] => {
    if (!referenceByAtomId || referenceByAtomId.size === 0) {
      return splitOnCodeAtomTokens(slice, {
        codeLibraryBase: CODE_LIBRARY_BASE,
        testIdForAtom: codeAtomTestId,
      });
    }
    const CODE_RE = /\[\[CODE:([^\]]+)\]\]/g;
    const codeHits: Hit[] = [];
    let cm: RegExpExecArray | null;
    CODE_RE.lastIndex = 0;
    while ((cm = CODE_RE.exec(slice)) !== null) {
      const atomId = cm[1]!;
      codeHits.push({
        index: cm.index,
        length: cm[0].length,
        node: (
          <CodeAtomPill
            key={`code-${key++}`}
            atomId={atomId}
            reference={referenceByAtomId.get(atomId)}
          />
        ),
      });
    }
    if (codeHits.length === 0) return [slice];
    codeHits.sort((a, b) => a.index - b.index);
    const out: ReactNode[] = [];
    let lastIdx = 0;
    for (const h of codeHits) {
      if (h.index > lastIdx) out.push(slice.slice(lastIdx, h.index));
      out.push(h.node);
      lastIdx = h.index + h.length;
    }
    if (lastIdx < slice.length) out.push(slice.slice(lastIdx));
    return out;
  };

  if (hits.length === 0) {
    return renderCodeSlice(body);
  }

  hits.sort((a, b) => a.index - b.index);
  const out: ReactNode[] = [];
  let lastIdx = 0;
  for (const h of hits) {
    if (h.index < lastIdx) continue;
    if (h.index > lastIdx) {
      out.push(...renderCodeSlice(body.slice(lastIdx, h.index)));
    }
    out.push(h.node);
    lastIdx = h.index + h.length;
  }
  if (lastIdx < body.length) {
    out.push(...renderCodeSlice(body.slice(lastIdx)));
  }
  return out;
}
