/**
 * Inline atom chip renderers used by the chat transcript.
 *
 * Extracted from `ClaudeChat.tsx` so the same renderer can be exercised
 * from a non-React-heavy entrypoint — specifically the chat round-trip
 * integration test in `artifacts/api-server/src/__tests__/chat-roundtrip.test.ts`,
 * which mounts the real api-server route + the design-tools store and
 * needs to assert that streamed `{{atom|snapshot|<id>|focus}}` markers
 * land as snapshot citation chips without dragging in ReactMarkdown,
 * sidebar-state, or the chat composer's full UI tree.
 */
import { type ReactNode } from "react";
import { Camera } from "lucide-react";
import { CodeAtomPill as PortalCodeAtomPill } from "@workspace/portal-ui";
import type { SnapshotSummary } from "@workspace/api-client-react";
import { relativeTime } from "../lib/relativeTime";

// [[CODE:atomId]] markers in assistant messages render as inline chips that
// link to the Code Library detail view. The atomId is a UUID — restrict the
// regex to that shape so we don't accidentally match unrelated double-bracket
// constructs the model might emit.
export const ATOM_TOKEN_RE = /\[\[CODE:([0-9a-fA-F-]{8,})\]\]/g;
const CODE_LIBRARY_BASE = `${import.meta.env.BASE_URL}code-library`;
const ENGAGEMENT_BASE = `${import.meta.env.BASE_URL}engagements`;

// `{{atom|snapshot|<uuid>|focus}}` markers in assistant messages render as
// snapshot attribution chips (Task #48). The model is instructed by the
// chat prompt's snapshot-focus citation rule (see
// `lib/codes/src/promptFormatter.ts`) to cite each snapshot it draws from
// with this exact form, so the regex is anchored to the `focus` mode.
// Hex-id length matches the CODE chip to keep stale or malformed ids from
// rendering as chips. Delimiter is `|` (DA-PI-1F1) — see
// `lib/empressa-atom/src/inline-reference.ts` for the canonical token shape.
export const SNAPSHOT_FOCUS_TOKEN_RE =
  /\{\{atom\|snapshot\|([0-9a-fA-F-]{8,})\|focus\}\}/g;

/**
 * Per-assistant-message comparison context (Task #54). When a user turn was
 * sent with 2+ snapshots picked in the comparison picker, the assistant's
 * `{{atom|snapshot|<id>|focus}}` chips should deep-link to a compare view
 * for the cited snapshot vs. another snapshot in the picked set, rather
 * than to the snapshot's static detail page.
 *
 * We carry the engagement id alongside the picked id set so the chip can
 * build the URL without reading from any global. Single-snapshot turns
 * (or assistants whose chips cite ids outside the picked set) get
 * `comparePartnerIds.length < 2` and the chip falls back to the
 * engagement detail link.
 */
export interface SnapshotChipCompareContext {
  engagementId: string;
  comparePartnerIds: ReadonlyArray<string>;
}

/**
 * Given the chip's own snapshot id and the per-turn comparison context,
 * pick the URL the chip should link to. Returns the engagement-list href
 * when there's no useful destination (e.g. no engagement context plumbed
 * through, which shouldn't happen in production but is the safe fallback
 * for tests that exercise the chip helper in isolation).
 *
 * Two-snapshot picker: `a=<chip-id>&b=<other-id>`. The chip's own id is
 * always pinned to `a` so users always see "I clicked snap-X → compare
 * lands with snap-X on the left", which matches the principle of
 * least surprise. For 3+ picks we still use the chip as `a` and pick
 * the *first non-chip* id from the picker order as `b` — a reasonable
 * default that respects the order the user staged the snapshots in.
 */
export function buildSnapshotChipHref(
  snapshotId: string,
  ctx: SnapshotChipCompareContext | null,
): string {
  if (!ctx) return `${ENGAGEMENT_BASE}`;
  const { engagementId, comparePartnerIds } = ctx;
  const partners = comparePartnerIds.filter((id) => id !== snapshotId);
  if (
    comparePartnerIds.length >= 2 &&
    comparePartnerIds.includes(snapshotId) &&
    partners.length >= 1
  ) {
    const other = partners[0];
    return `${ENGAGEMENT_BASE}/${engagementId}/compare?a=${encodeURIComponent(
      snapshotId,
    )}&b=${encodeURIComponent(other)}`;
  }
  return `${ENGAGEMENT_BASE}/${engagementId}`;
}

function CodeAtomChip({ atomId }: { atomId: string }) {
  return (
    <PortalCodeAtomPill atomId={atomId} codeLibraryBase={CODE_LIBRARY_BASE} />
  );
}

/**
 * Inline chip rendered for `{{atom|snapshot|<id>|focus}}` markers Claude
 * embeds when answering comparison-style questions (Task #48). The chip's
 * tooltip carries the snapshot's "captured X ago" timestamp when the
 * caller can resolve the id through {@link snapshotLookup}; ids that
 * aren't in the engagement's snapshot list still render as a chip but
 * with a generic tooltip — that's the expected degraded path for
 * archived/older snapshots whose summaries are no longer in memory.
 *
 * When a per-turn `compareContext` is supplied (Task #54) the chip
 * deep-links to `/engagements/<id>/compare?a=<chip>&b=<other>` so users
 * can jump from the citation to the side-by-side compare view. Without
 * a compare context (or when the chip's id isn't in the picked set)
 * the chip falls back to the engagement detail page.
 */
export function SnapshotFocusChip({
  snapshotId,
  snapshotLookup,
  compareContext,
}: {
  snapshotId: string;
  snapshotLookup?: ReadonlyMap<string, SnapshotSummary>;
  compareContext?: SnapshotChipCompareContext | null;
}) {
  const short = snapshotId.slice(0, 8);
  const meta = snapshotLookup?.get(snapshotId);
  const ctx = compareContext ?? null;
  const href = buildSnapshotChipHref(snapshotId, ctx);
  const isCompareLink =
    ctx !== null &&
    ctx.comparePartnerIds.length >= 2 &&
    ctx.comparePartnerIds.includes(snapshotId);
  const tooltip = meta
    ? `Snapshot ${short} — captured ${relativeTime(meta.receivedAt)}${isCompareLink ? " · compare snapshots" : ""}`
    : `Snapshot ${snapshotId}${isCompareLink ? " · compare snapshots" : ""}`;
  return (
    <a
      href={href}
      data-testid={`snapshot-citation-${snapshotId}`}
      title={tooltip}
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
      <Camera size={9} />
      SNAP·{short}
    </a>
  );
}

/**
 * Walks the children produced by ReactMarkdown and rewrites text nodes that
 * contain `[[CODE:atomId]]` or `{{atom|snapshot|<id>|focus}}` markers into
 * a mix of plain text and chip elements. Non-string children (e.g. nested
 * elements like <strong>, <code>) pass through untouched.
 *
 * Both regexes are scanned in a single pass over the string — the snapshot
 * marker uses curly braces so it can't overlap the square-bracket CODE
 * marker, but driving them off the same offset keeps the output ordering
 * stable when both kinds appear in the same paragraph.
 */
export function renderWithAtomChips(
  children: ReactNode,
  snapshotLookup?: ReadonlyMap<string, SnapshotSummary>,
  compareContext?: SnapshotChipCompareContext | null,
): ReactNode {
  if (typeof children === "string") {
    const text = children;
    type Hit = { index: number; length: number; node: ReactNode };
    const hits: Hit[] = [];
    let m: RegExpExecArray | null;
    let key = 0;
    // Both regexes are /g + module-scoped, so their `lastIndex` survives
    // across calls. Always reset immediately before iterating to keep
    // every render call deterministic — never rely on a precheck `.test`
    // because `.test` advances `lastIndex` on a /g regex too.
    ATOM_TOKEN_RE.lastIndex = 0;
    while ((m = ATOM_TOKEN_RE.exec(text)) !== null) {
      hits.push({
        index: m.index,
        length: m[0].length,
        node: <CodeAtomChip key={`code-${key++}`} atomId={m[1]} />,
      });
    }
    SNAPSHOT_FOCUS_TOKEN_RE.lastIndex = 0;
    while ((m = SNAPSHOT_FOCUS_TOKEN_RE.exec(text)) !== null) {
      hits.push({
        index: m.index,
        length: m[0].length,
        node: (
          <SnapshotFocusChip
            key={`snap-${key++}`}
            snapshotId={m[1]}
            snapshotLookup={snapshotLookup}
            compareContext={compareContext}
          />
        ),
      });
    }
    if (hits.length === 0) return text;
    hits.sort((a, b) => a.index - b.index);

    const out: ReactNode[] = [];
    let lastIdx = 0;
    for (const h of hits) {
      if (h.index < lastIdx) continue; // shouldn't happen, defensive
      if (h.index > lastIdx) out.push(text.slice(lastIdx, h.index));
      out.push(h.node);
      lastIdx = h.index + h.length;
    }
    if (lastIdx < text.length) out.push(text.slice(lastIdx));
    return out;
  }
  if (Array.isArray(children)) {
    return children.map((c, i) => (
      <span key={`mc-${i}`}>
        {renderWithAtomChips(c, snapshotLookup, compareContext)}
      </span>
    ));
  }
  return children;
}
