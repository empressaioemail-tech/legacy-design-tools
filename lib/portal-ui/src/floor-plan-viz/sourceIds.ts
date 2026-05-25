/** Stable source id for a snapshot sheet row (matches design-tools deep links). */
export function floorPlanSheetSourceId(
  engagementId: string,
  sheetId: string,
): string {
  return `${engagementId}-sheet-${sheetId}`;
}

export function floorPlanUploadSourceId(engagementId: string): string {
  return `${engagementId}-upload-${Date.now()}`;
}

export function parseFloorPlanSheetSourceId(
  sourceId: string,
): { engagementId: string; sheetId: string } | null {
  const marker = "-sheet-";
  const idx = sourceId.lastIndexOf(marker);
  if (idx <= 0) return null;
  return {
    engagementId: sourceId.slice(0, idx),
    sheetId: sourceId.slice(idx + marker.length),
  };
}
