/**
 * Grid-relative flow-accumulation threshold for site-drainage hydrology.
 *
 * Kept free of `@workspace/db` so unit tests can import without DATABASE_URL.
 */

export const DEFAULT_ACCUMULATION_THRESHOLD = 50;

/** Floor for grid-relative threshold — keeps channels on tight urban parcels. */
export const MIN_ACCUMULATION_THRESHOLD = 3;

/**
 * Derive a flow-accumulation cutoff from catchment DEM dimensions.
 *
 * Fixed thresholds (e.g. 50) exceed the maximum D8 accumulation on small
 * parcel clips (max acc ≈ min(width, height) on a simple plane). Scale
 * with √cellCount so 10×10 clips get threshold 5 while 100×100+ grids
 * stay at the legacy 50 cap.
 *
 * Explicit `override` (route/body) wins — used for operator tuning.
 */
export function resolveAccumulationThreshold(
  widthPx: number,
  heightPx: number,
  override?: number,
): number {
  if (
    typeof override === "number" &&
    Number.isFinite(override) &&
    override > 0
  ) {
    return Math.floor(override);
  }
  const w = Math.max(1, Math.floor(widthPx));
  const h = Math.max(1, Math.floor(heightPx));
  const derived = Math.floor(Math.sqrt(w * h) * 0.5);
  return Math.max(
    MIN_ACCUMULATION_THRESHOLD,
    Math.min(DEFAULT_ACCUMULATION_THRESHOLD, derived),
  );
}
