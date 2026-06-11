/**
 * Engine spine routing — C3 BFF cut.
 *
 * All four reasoning engines are unconditionally served via gate-front
 * engine-api. Local lib/*-engine fallbacks were removed; these names
 * remain for logging snapshots and deploy env documentation.
 */

export const ENGINE_SPINE_FLAGS = {
  briefing: "ENGINE_SPINE_BRIEFING",
  findings: "ENGINE_SPINE_FINDINGS",
  findingsOrchestrated: "ENGINE_SPINE_FINDINGS_ORCHESTRATED",
  hydrology: "ENGINE_SPINE_HYDROLOGY",
  topography: "ENGINE_SPINE_TOPOGRAPHY",
} as const;

/** Snapshot for operator QA logs — always spine-routed after C3. */
export function engineSpineFlagSnapshot(): Record<string, boolean> {
  return {
    [ENGINE_SPINE_FLAGS.briefing]: true,
    [ENGINE_SPINE_FLAGS.findings]: true,
    [ENGINE_SPINE_FLAGS.findingsOrchestrated]: true,
    [ENGINE_SPINE_FLAGS.hydrology]: true,
    [ENGINE_SPINE_FLAGS.topography]: true,
  };
}
