import { type ReactNode } from "react";
import { BookOpen } from "lucide-react";

/**
 * Inline pill rendered for `[[CODE:<atomId>]]` citation tokens.
 * Shared between design-tools (briefing narrative + chat transcript)
 * and plan-review (reviewer findings) so the visual treatment stays
 * identical across the portal.
 *
 * Each consuming app passes its own `codeLibraryBase` because the
 * artifacts route the Code Library at different paths
 * (`/design-tools/code-library` vs `/plan-review/code`). The optional
 * `testId` lets each call site keep its existing data-testid for
 * test stability.
 */
export interface CodeAtomPillProps {
  atomId: string;
  /** Full URL prefix for the Code Library page in the consuming app. */
  codeLibraryBase: string;
  /** Optional data-testid override. */
  testId?: string;
}

export function CodeAtomPill({ atomId, codeLibraryBase, testId }: CodeAtomPillProps) {
  const short = atomId.slice(0, 8);
  return (
    <a
      href={`${codeLibraryBase}?atom=${atomId}`}
      data-testid={testId}
      title={`Open atom ${atomId} in Code Library`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        background: "rgba(99, 152, 170, 0.18)",
        color: "var(--cyan)",
        fontSize: 10,
        letterSpacing: "0.04em",
        padding: "1px 6px",
        borderRadius: 3,
        textTransform: "uppercase",
        textDecoration: "none",
        verticalAlign: "baseline",
        marginInline: 2,
      }}
    >
      <BookOpen size={9} aria-hidden />
      CODE·{short}
    </a>
  );
}

/** Regex for the `[[CODE:<atomId>]]` citation token. /g and stateful — reset before iterating. */
export const CODE_SECTION_TOKEN_RE = /\[\[CODE:([^\]]+)\]\]/g;

export interface RenderCodeAtomTokensOptions {
  codeLibraryBase: string;
  /** Optional per-atom testid generator. */
  testIdForAtom?: (atomId: string) => string;
}

/**
 * Splits a body string on `[[CODE:atomId]]` tokens, replacing each
 * with a `<CodeAtomPill>` and returning the alternating text/pill
 * sequence as a ReactNode array. Body strings without tokens are
 * returned as `[body]`.
 */
export function splitOnCodeAtomTokens(
  body: string,
  opts: RenderCodeAtomTokensOptions,
): ReactNode[] {
  type Hit = { index: number; length: number; node: ReactNode };
  const hits: Hit[] = [];
  let m: RegExpExecArray | null;
  let key = 0;
  CODE_SECTION_TOKEN_RE.lastIndex = 0;
  while ((m = CODE_SECTION_TOKEN_RE.exec(body)) !== null) {
    const atomId = m[1];
    hits.push({
      index: m.index,
      length: m[0].length,
      node: (
        <CodeAtomPill
          key={`code-${key++}`}
          atomId={atomId}
          codeLibraryBase={opts.codeLibraryBase}
          testId={opts.testIdForAtom?.(atomId)}
        />
      ),
    });
  }
  if (hits.length === 0) return [body];
  hits.sort((a, b) => a.index - b.index);
  const out: ReactNode[] = [];
  let lastIdx = 0;
  for (const h of hits) {
    if (h.index < lastIdx) continue;
    if (h.index > lastIdx) out.push(body.slice(lastIdx, h.index));
    out.push(h.node);
    lastIdx = h.index + h.length;
  }
  if (lastIdx < body.length) out.push(body.slice(lastIdx));
  return out;
}
