/**
 * Production gate for the precedence engine (S1 / ADR-019).
 * Enabled by default; set PRECEDENCE_ENGINE_PRODUCTION=0 to disable.
 */
export function isPrecedenceEngineProductionEnabled(): boolean {
  const raw = process.env.PRECEDENCE_ENGINE_PRODUCTION?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  return true;
}
