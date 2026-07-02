export const LAYOUTS: Record<string, string> = {
  "1": '"a"',
  "2h": '"a b"',
  "2v": '"a" / "b"',
  "3l": '"a b" / "a c"',
  "3r": '"a b" / "c b"',
  "4": '"a b" / "c d"',
  "6": '"a b c" / "d e f"',
};

const GRID_AREAS = ["a", "b", "c", "d", "e", "f"] as const;

/** Auto-select layout id from active tile count. */
export function layoutIdForTileCount(count: number): string {
  if (count <= 1) return "1";
  if (count === 2) return "2h";
  if (count === 3) return "3l";
  if (count === 4) return "4";
  if (count === 5) return "4";
  return "6";
}

export function gridAreasForTiles(tileIds: string[]): string[] {
  return tileIds.map((_, i) => GRID_AREAS[i] ?? `overflow-${i}`);
}

export function parseLayoutRows(layoutId: string): number {
  const spec = LAYOUTS[layoutId] ?? LAYOUTS["4"]!;
  return spec.split("/").length;
}

export function parseLayoutCols(layoutId: string): number {
  const spec = LAYOUTS[layoutId] ?? LAYOUTS["4"]!;
  const firstRow = spec.split("/")[0] ?? spec;
  return firstRow.trim().split(/\s+/).length;
}
