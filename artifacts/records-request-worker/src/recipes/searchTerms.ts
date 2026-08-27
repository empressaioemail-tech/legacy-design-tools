/**
 * Parse clerk search terms from job requestPayload (populated by cortex at enqueue).
 */

export interface RecordsSearchTerms {
  propId: string | null;
  ownerName: string | null;
  situsAddress: string | null;
  legalDescription: string | null;
  subdivision: string | null;
  block: string | null;
  lot: string | null;
}

function readString(payload: Record<string, unknown>, key: string): string | null {
  const raw = payload[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed || null;
}

function readNestedString(
  payload: Record<string, unknown>,
  parentKey: string,
  key: string,
): string | null {
  const parent = payload[parentKey];
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) return null;
  return readString(parent as Record<string, unknown>, key);
}

export function parseParcelKeyPropId(parcelKey: string): string | null {
  if (!parcelKey.startsWith("apn:")) return null;
  const rest = parcelKey.slice(4);
  const idx = rest.indexOf(":");
  if (idx <= 0) return null;
  const propId = rest.slice(idx + 1).trim();
  return propId || null;
}

export function resolveSearchTerms(
  ctx: { parcelKey: string; requestPayload: Record<string, unknown> },
): RecordsSearchTerms {
  const payload = ctx.requestPayload;
  const searchTerms = payload.searchTerms;
  const nested =
    searchTerms && typeof searchTerms === "object" && !Array.isArray(searchTerms)
      ? (searchTerms as Record<string, unknown>)
      : null;

  const from = (key: string): string | null =>
    (nested ? readString(nested, key) : null) ?? readString(payload, key);

  return {
    propId: from("propId") ?? parseParcelKeyPropId(ctx.parcelKey),
    ownerName: from("ownerName"),
    situsAddress: from("situsAddress"),
    legalDescription: from("legalDescription"),
    subdivision: from("subdivision"),
    block: from("block"),
    lot: from("lot"),
  };
}
