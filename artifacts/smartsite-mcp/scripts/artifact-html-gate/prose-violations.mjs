/**
 * Customer prose of a rendered card. Fails on internal text.
 * The parcel id line may carry that parcel's node id. Every other entity id,
 * snake_case token, the words adapter and degraded, and an ISO timestamp are
 * violations. A planted main-card paragraph is the proof the check can fire.
 */

const SNAKE = /\b[a-z][a-z0-9]*_[a-z0-9_]+\b/;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const ENTITY = /\b\d{5}:(?:road:)?\d+\b/g;

export function customerProseViolations(text, parcelNodeId) {
  const violations = [];
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idOnly = parcelNodeId && trimmed === parcelNodeId;
    const body = parcelNodeId ? trimmed.split(parcelNodeId).join(" ") : trimmed;
    if (!idOnly && SNAKE.test(body)) violations.push({ kind: "snake_case", line: trimmed });
    if (/\badapter\b/i.test(body)) violations.push({ kind: "adapter", line: trimmed });
    if (/\bdegraded\b/i.test(body)) violations.push({ kind: "degraded", line: trimmed });
    if (ISO.test(body)) violations.push({ kind: "iso_timestamp", line: trimmed });
    if (!idOnly) {
      const ids = body.match(ENTITY) ?? [];
      if (ids.length > 0) violations.push({ kind: "entity_id", line: trimmed, ids });
    }
  }
  return violations;
}
