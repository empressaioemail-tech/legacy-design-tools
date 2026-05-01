/**
 * Inline atom reference syntax.
 *
 * The chat layer embeds atom references in prose using the syntax
 * `{{atom|type|id|label}}`. This module ships a pure parser/serializer
 * pair that operates on strings only — no dependency on the registry.
 *
 * Delimiter is `|` (DA-PI-1F1). The previous shape used `:` as the
 * delimiter, which collided with Spec 51 entityId patterns that
 * themselves contain `:` (e.g. `parcel-briefing:{parcelId}:{intentHash}`).
 * `|` is collision-free against every registered entityType, every
 * idResolver-produced id, and every displayLabel produced today.
 * Backward compatibility with the old shape is intentionally NOT
 * supported — see the "old-shape … no dual-parse contract" test in
 * inline-reference.test.ts.
 */

import type { AtomMode, AtomReference } from "./registration";

/**
 * Source-of-truth regex. Captures: entityType (no `|`), entityId (no `|`),
 * displayLabel (no `}`). Greedy on the third group so labels with `|` or
 * `:` are accepted (e.g. "Decision: pick HVAC vendor").
 */
export const INLINE_ATOM_REGEX: RegExp = /\{\{atom\|([^|]+)\|([^|]+)\|([^}]+)\}\}/g;

/** A single text run between (or surrounding) inline atom references. */
export interface ParsedTextSegment {
  kind: "text";
  text: string;
}

/** A single parsed atom reference. */
export interface ParsedAtomSegment {
  kind: "atom";
  reference: AtomReference;
  /** The exact source text that produced this segment (for round-trip). */
  raw: string;
}

export type ParsedSegment = ParsedTextSegment | ParsedAtomSegment;

/**
 * Parse `text` into an alternating sequence of text and atom segments.
 * Empty text segments at the start, between atoms, or at the end are
 * preserved as zero-length text runs so a caller iterating segments can
 * always render in order.
 *
 * Malformed markers (missing fields, stray `{{`) are left as plain text.
 */
export function parseInlineReferences(text: string): ParsedSegment[] {
  const segments: ParsedSegment[] = [];
  // Reset state because the regex is `g`-flagged and module-scoped.
  INLINE_ATOM_REGEX.lastIndex = 0;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = INLINE_ATOM_REGEX.exec(text)) !== null) {
    const [raw, entityType, entityId, displayLabel] = match;
    if (entityType === undefined || entityId === undefined) continue;
    if (match.index > cursor) {
      segments.push({ kind: "text", text: text.slice(cursor, match.index) });
    }
    segments.push({
      kind: "atom",
      raw,
      reference: {
        kind: "atom",
        entityType,
        entityId,
        displayLabel,
      },
    });
    cursor = match.index + raw.length;
  }
  if (cursor < text.length) {
    segments.push({ kind: "text", text: text.slice(cursor) });
  }
  return segments;
}

/**
 * Serialize an {@link AtomReference} back to its `{{atom|type|id|label}}`
 * form. Round-trips with {@link parseInlineReferences}.
 *
 * If `mode` is set, it is intentionally **not** serialized — the inline
 * syntax has only three slots and the render binding decides on the mode
 * from chip-vs-expand UX context. If `displayLabel` is missing,
 * `entityId` is used so the syntax stays valid.
 */
export function serializeInlineReference(ref: AtomReference): string {
  const label = ref.displayLabel ?? ref.entityId;
  return `{{atom|${ref.entityType}|${ref.entityId}|${label}}}`;
}

/**
 * Re-export {@link AtomMode} so consumers parsing inline references can
 * narrow without a separate import — convenience only.
 */
export type { AtomMode };
