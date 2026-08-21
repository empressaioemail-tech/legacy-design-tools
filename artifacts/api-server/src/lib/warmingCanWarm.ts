/**
 * Warm gate. Cotality is extinguished — never rotate, never require
 * `cotality:*` snapshots. Fail-closed public-record predicate: a non-empty
 * placeKey (caller already geocoded). Empty placeKey blocks.
 */
export function deriveCanWarm(
  _present: ReadonlySet<string>,
  placeKey: string,
): boolean {
  if (!placeKey.trim()) return false;
  return true;
}
