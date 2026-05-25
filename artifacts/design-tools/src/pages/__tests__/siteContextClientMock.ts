/** Leaflet-free stub barrel for `@workspace/site-context/client` in page tests. */
export async function siteContextClientMockExports() {
  const { extractBriefingSourceOverlays } = await import(
    "@workspace/site-context/client/overlays"
  );
  const { extractContoursGeoJsonOverlays, hasContoursGeoJson } = await import(
    "@workspace/site-context/client/topoContours"
  );
  const {
    filterOverlaysByLayerVisibility,
    isLayerRowVisible,
    layerRowIdForBriefingSource,
  } = await import("@workspace/site-context/client/layerVisibility");
  const { hasBriefingNarrativeContent } = await import(
    "@workspace/site-context/client/briefingNarrative"
  );
  const { resolveMapPinPosition } = await import(
    "@workspace/site-context/client/mapPin"
  );
  return {
    extractBriefingSourceOverlays,
    extractContoursGeoJsonOverlays,
    hasContoursGeoJson,
    filterOverlaysByLayerVisibility,
    isLayerRowVisible,
    layerRowIdForBriefingSource,
    hasBriefingNarrativeContent,
    resolveMapPinPosition,
    SiteMap: () => null,
  };
}
