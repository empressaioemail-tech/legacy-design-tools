import type { SheetSummary } from "@workspace/api-client-react";

/** Heuristic: floor-plan sheets only (QA-54). */
export function isFloorPlanSheet(
  sheet: Pick<SheetSummary, "sheetNumber" | "sheetName">,
): boolean {
  const name = sheet.sheetName.toLowerCase();
  const number = sheet.sheetNumber.toLowerCase();
  if (/floor\s*plan|floorplan|\bflp\b/.test(name)) return true;
  if (
    /^a[\d.-]*/.test(number) &&
    /floor|level|story|\bplan\b/.test(name) &&
    !/elev|section|detail|schedule|roof|site|cover/.test(name)
  ) {
    return true;
  }
  return false;
}
