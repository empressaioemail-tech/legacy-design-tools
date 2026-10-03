/**
 * Only counts, dates, plan, stage, source and first name leave the product.
 * A note body, an owner-of-record name, or a parcel field in a lifecycle
 * payload is a sovereignty breach
 * (`_decisions/2026-10-03_ghl_retired_lifecycle_to_resend.md`, structural
 * commitment check; the 2026-09-24 "kept" list, item 4).
 *
 * Two checks, both run BEFORE the outbox insert:
 *   - a DENYLIST of known parcel- and person-shaped keys, at any depth, which
 *     also guards the outbound Resend and Meta bodies;
 *   - an ALLOWLIST of the keys an enqueue payload may carry at all, so a new
 *     parcel-shaped field cannot slip past a list of known-bad names.
 */

const FORBIDDEN_KEYS = [
  "note",
  "notes",
  "noteText",
  "note_text",
  "owner",
  "ownerName",
  "owner_name",
  "ownerOfRecord",
  "legalDescription",
  "legal_description",
  "parcelNodeId",
  "parcel_node_id",
  "parcelId",
  "parcel_id",
  "nodeId",
  "node_id",
  "grantId",
  "grant_id",
  "shareToken",
  "share_token",
  "apn",
  "situs",
  "situs_address",
  "situsAddress",
  "address",
  "screenName",
  "screen_name",
  "reportContent",
  "report_content",
] as const;

/** The only keys an enqueue payload may carry (contract v2 needs nothing else). */
export const ALLOWED_PAYLOAD_KEYS = [
  "event",
  "email",
  "displayName",
  "campaign",
  "savedLots",
  "shares",
  "lastActive",
  "plan",
  "billing",
  "value",
  "currency",
] as const;

export type DenylistHit = { path: string; key: string };

export function findForbiddenLifecycleFields(
  value: unknown,
  path = "$",
): DenylistHit[] {
  const hits: DenylistHit[] = [];
  walk(value, path, hits);
  return hits;
}

function walk(value: unknown, path: string, hits: DenylistHit[]): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, `${path}[${i}]`, hits));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if ((FORBIDDEN_KEYS as readonly string[]).includes(key)) {
      hits.push({ path: `${path}.${key}`, key });
    }
    walk(child, `${path}.${key}`, hits);
  }
}

export function assertLifecyclePayloadSafe(value: unknown): void {
  const hits = findForbiddenLifecycleFields(value);
  if (hits.length > 0) {
    throw new Error(
      `lifecycle_payload_denied: ${hits.map((h) => h.path).join(",")}`,
    );
  }
}

/**
 * Enqueue-time check: denylist first (names the breach), then the allowlist,
 * and every allowed value must be a scalar (no nested object can smuggle a
 * parcel record under an allowed key).
 */
export function assertEnqueuePayloadAllowed(payload: Record<string, unknown>): void {
  assertLifecyclePayloadSafe(payload);
  const unknownKeys = Object.keys(payload).filter(
    (k) => !(ALLOWED_PAYLOAD_KEYS as readonly string[]).includes(k),
  );
  if (unknownKeys.length > 0) {
    throw new Error(`lifecycle_payload_key_not_allowed: ${unknownKeys.join(",")}`);
  }
  for (const [key, v] of Object.entries(payload)) {
    if (v !== null && v !== undefined && typeof v === "object") {
      throw new Error(`lifecycle_payload_value_not_scalar: ${key}`);
    }
  }
}
