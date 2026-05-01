/**
 * Inline citation pill renderers for the A–G briefing narrative
 * (Task #176).
 *
 * The briefing engine emits two kinds of inline tokens (see
 * `lib/briefing-engine/src/citationValidator.ts`):
 *
 *   - `{{atom|briefing-source|<id>|<displayLabel>}}` — cites an
 *     uploaded briefing source. Rendered as a clickable pill that
 *     scrolls to and briefly highlights the matching source row in
 *     the Briefing Sources list above the narrative panel.
 *   - `[[CODE:<atomId>]]` — cites a code-section atom. Rendered as
 *     a chip that links to the Code Library detail view (we reuse
 *     the existing chip from `atomChips.tsx` so the visual treatment
 *     is identical to the chat surface).
 *
 * Invalid tokens (validator stripped them) are surfaced separately
 * via {@link BriefingInvalidCitationPill} on the warning banner —
 * the same pill style with a strikethrough so the architect can see
 * which sources were referenced but no longer exist.
 *
 * The token regexes are intentionally local rather than re-imported
 * from the validator because the validator's regexes are `/g` and
 * stateful (`lastIndex`); we need fresh, side-effect-free scans on
 * every render call.
 */
import { type ReactNode } from "react";
import { FileText, AlertTriangle } from "lucide-react";
import { CodeAtomPill as PortalCodeAtomPill } from "@workspace/portal-ui";

const BRIEFING_SOURCE_TOKEN_RE =
  /\{\{atom\|briefing-source\|([^|]+)\|([^}]+)\}\}/g;
const CODE_SECTION_TOKEN_RE = /\[\[CODE:([^\]]+)\]\]/g;

const CODE_LIBRARY_BASE = `${import.meta.env.BASE_URL}code-library`;

/**
 * Pill rendered for a valid `{{atom|briefing-source|<id>|<label>}}`
 * token. Clicking the pill calls `onJump` so the parent can scroll
 * the matching `BriefingSourceRow` into view + flash a highlight on
 * it; the parent owns the highlight state because the row that
 * needs to flash lives in a sibling component subtree.
 */
export function BriefingSourceCitationPill({
  sourceId,
  label,
  onJump,
}: {
  sourceId: string;
  label: string;
  onJump: (id: string) => void;
}) {
  return (
    <button
      type="button"
      data-testid={`briefing-citation-pill-${sourceId}`}
      onClick={(ev) => {
        ev.preventDefault();
        onJump(sourceId);
      }}
      title={`Jump to source: ${label}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        background: "rgba(99, 152, 170, 0.18)",
        color: "var(--cyan)",
        fontSize: 11,
        padding: "1px 6px",
        borderRadius: 3,
        border: "none",
        cursor: "pointer",
        verticalAlign: "baseline",
        marginInline: 2,
        fontFamily: "inherit",
        lineHeight: "inherit",
      }}
    >
      <FileText size={10} aria-hidden />
      {label}
    </button>
  );
}

/**
 * Pill rendered for a valid `[[CODE:<atomId>]]` token. Renders the
 * same shape as `CodeAtomChip` from `atomChips.tsx` but uses an
 * anchor so the architect's middle-click + open-in-new-tab gestures
 * work — the briefing surface is a "reading" view, not a chat
 * stream, so deep-linking to the Code Library matters more.
 */
export function BriefingCodeAtomPill({ atomId }: { atomId: string }) {
  return (
    <PortalCodeAtomPill
      atomId={atomId}
      codeLibraryBase={CODE_LIBRARY_BASE}
      testId={`briefing-code-citation-${atomId}`}
    />
  );
}

/**
 * Muted pill rendered for a stripped (invalid) citation token. The
 * label/id is surfaced so the architect can audit which sources
 * the engine wanted to cite but the validator dropped — gives them
 * the same trace-the-claim affordance as a valid pill, just one
 * that admits "this source isn't here anymore."
 */
export function BriefingInvalidCitationPill({ token }: { token: string }) {
  // Try to extract a useful label from the token itself. Briefing-
  // source tokens carry the `<displayLabel>` after the third pipe;
  // CODE tokens carry just the atom id; deprecated `{{atom:...}}`
  // tokens fall through to the raw token text.
  let label = token;
  let idHint: string | null = null;
  const briefingMatch =
    /\{\{atom\|briefing-source\|([^|]+)\|([^}]+)\}\}/.exec(token);
  if (briefingMatch) {
    idHint = briefingMatch[1];
    label = briefingMatch[2];
  } else {
    const codeMatch = /\[\[CODE:([^\]]+)\]\]/.exec(token);
    if (codeMatch) {
      idHint = codeMatch[1];
      label = `CODE·${codeMatch[1].slice(0, 8)}`;
    }
  }
  const tooltip = idHint
    ? `Stripped citation — id ${idHint} no longer resolves to a known source.`
    : `Stripped citation — token shape was not recognised: ${token}`;
  return (
    <span
      data-testid="briefing-invalid-citation-pill"
      title={tooltip}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 3,
        background: "var(--warning-dim)",
        color: "var(--warning-text)",
        fontSize: 11,
        padding: "1px 6px",
        borderRadius: 3,
        verticalAlign: "baseline",
        marginInline: 2,
        textDecoration: "line-through",
      }}
    >
      <AlertTriangle size={10} aria-hidden />
      {label}
    </span>
  );
}

/**
 * Walk a single section body string and split it into a sequence of
 * plain-text fragments + citation pills. The two regexes can both
 * appear in the same body so we collect every hit, sort by index,
 * and stitch the output in one pass.
 *
 * `knownSourceIds` is consulted to decide whether a briefing-source
 * token should render as a clickable pill (it's still in the current
 * sources list) or as plain label text (the row was superseded after
 * the narrative was written but before the validator ran on this
 * read — extremely rare today, but cheap to handle defensively).
 */
export function renderBriefingBody(
  body: string,
  knownSourceIds: ReadonlySet<string>,
  onJump: (id: string) => void,
): ReactNode[] {
  type Hit = {
    index: number;
    length: number;
    node: ReactNode;
  };
  const hits: Hit[] = [];
  let key = 0;
  let m: RegExpExecArray | null;

  BRIEFING_SOURCE_TOKEN_RE.lastIndex = 0;
  while ((m = BRIEFING_SOURCE_TOKEN_RE.exec(body)) !== null) {
    const id = m[1];
    const label = m[2];
    const node = knownSourceIds.has(id) ? (
      <BriefingSourceCitationPill
        key={`bsrc-${key++}`}
        sourceId={id}
        label={label}
        onJump={onJump}
      />
    ) : (
      // Rare: token survived the server-side validator (because the
      // source existed at generation time) but the row has since
      // been removed from the current view. Render the label as
      // plain text rather than a dead button.
      <span key={`bsrc-${key++}`}>{label}</span>
    );
    hits.push({ index: m.index, length: m[0].length, node });
  }

  CODE_SECTION_TOKEN_RE.lastIndex = 0;
  while ((m = CODE_SECTION_TOKEN_RE.exec(body)) !== null) {
    hits.push({
      index: m.index,
      length: m[0].length,
      node: <BriefingCodeAtomPill key={`code-${key++}`} atomId={m[1]} />,
    });
  }

  if (hits.length === 0) return [body];
  hits.sort((a, b) => a.index - b.index);

  const out: ReactNode[] = [];
  let lastIdx = 0;
  for (const h of hits) {
    if (h.index < lastIdx) continue; // shouldn't happen; defensive
    if (h.index > lastIdx) out.push(body.slice(lastIdx, h.index));
    out.push(h.node);
    lastIdx = h.index + h.length;
  }
  if (lastIdx < body.length) out.push(body.slice(lastIdx));
  return out;
}

/**
 * Imperative scroll-and-flash helper used by the narrative panel's
 * citation pills. Looks the row up by the stable
 * `data-testid="briefing-source-<id>"` attribute the SiteContextTab
 * stamps on every row, scrolls it into the viewport center, and
 * returns whether the row was found so the caller can short-circuit
 * the highlight effect when there's nothing to flash.
 *
 * The highlight itself is React state managed by SiteContextTab —
 * this helper only handles the scroll because that has to be
 * imperative anyway (no React API for scrollIntoView).
 */
export function scrollToBriefingSource(sourceId: string): boolean {
  if (typeof document === "undefined") return false;
  const el = document.querySelector<HTMLElement>(
    `[data-testid="briefing-source-${cssEscape(sourceId)}"]`,
  );
  if (!el) return false;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  return true;
}

/**
 * Minimal subset of `CSS.escape` for the id values we actually
 * generate (UUIDs / slugs). The browser global is preferred when
 * available; the fallback handles the characters that show up in
 * source ids without pulling in a polyfill.
 */
function cssEscape(value: string): string {
  if (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { CSS?: { escape?: (s: string) => string } }).CSS
      ?.escape === "function"
  ) {
    return (
      globalThis as unknown as { CSS: { escape: (s: string) => string } }
    ).CSS.escape(value);
  }
  return value.replace(/[^a-zA-Z0-9_-]/g, (ch) => `\\${ch}`);
}
