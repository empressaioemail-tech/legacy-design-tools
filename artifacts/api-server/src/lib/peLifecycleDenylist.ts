/**
 * Only counts, dates, plan and source leave the product. A note body, an
 * owner-of-record name, or a parcel field in a GHL or Meta payload is a
 * sovereignty breach (`_decisions/2026-09-24_smart_site_lifecycle_pipeline_in_ghl.md`).
 *
 * This scans the outbound JSON. A hit refuses the send.
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
  "nodeId",
  "node_id",
  "grantId",
  "grant_id",
  "shareToken",
  "share_token",
  "apn",
  "situs",
  "address",
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
