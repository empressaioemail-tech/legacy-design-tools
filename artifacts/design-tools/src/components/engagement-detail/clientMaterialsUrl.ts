/**
 * Deep-link params for Client Materials preselection.
 * Example: ?view=deliver&segment=client-materials&canvaAssets=render:abc,floorplan:def
 */
const CANVA_ASSETS_PARAM = "canvaAssets";

export function readCanvaAssetPreselectFromUrl(): string[] {
  if (typeof window === "undefined") return [];
  const raw = new URLSearchParams(window.location.search).get(CANVA_ASSETS_PARAM);
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function writeCanvaAssetPreselectToUrl(assetIds: string[]): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (assetIds.length === 0) {
    url.searchParams.delete(CANVA_ASSETS_PARAM);
  } else {
    url.searchParams.set(CANVA_ASSETS_PARAM, assetIds.join(","));
  }
  window.history.replaceState(null, "", url.toString());
}

/** Parse `kind:id` tokens from entry-point deep links. */
export function parseCanvaAssetTokens(tokens: string[]): string[] {
  const ids: string[] = [];
  for (const token of tokens) {
    const parts = token.split(":");
    if (parts.length >= 2) {
      ids.push(parts.slice(1).join(":"));
    } else {
      ids.push(token);
    }
  }
  return ids;
}
